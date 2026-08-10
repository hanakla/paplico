import { ensureWebGPUGlobals } from "@/core/testUtils/visualRegression";
import {
	compileShaderModule,
	type StructuredView,
} from "@/core/utils/wgpu-utils";

let cachedDevice: GPUDevice | null = null;

export async function getTestDevice(): Promise<GPUDevice> {
	if (cachedDevice) return cachedDevice;

	const gpu = await ensureWebGPUGlobals();
	const adapter = await gpu.requestAdapter();
	if (!adapter) throw new Error("No WebGPU adapter available");

	cachedDevice = await adapter.requestDevice({
		requiredFeatures: ["float32-filterable" as GPUFeatureName],
	});
	return cachedDevice;
}

export interface ComputeShaderTestSetup {
	device: GPUDevice;
	pipeline: GPUComputePipeline;
	uniformViews: Record<string, StructuredView>;
	dispatch: (
		bindings: GPUBindGroupEntry[],
		workgroups: [number, number, number],
	) => Promise<void>;
	readBuffer: (buffer: GPUBuffer) => Promise<Float32Array>;
	createStorageBuffer: (data: Float32Array) => GPUBuffer;
	createReadbackBuffer: (byteLength: number) => GPUBuffer;
	createUniformBuffer: (view: StructuredView) => GPUBuffer;
	createUniformBufferRaw: (data: ArrayBuffer) => GPUBuffer;
	createTexture: (opts: {
		width: number;
		height: number;
		format?: GPUTextureFormat;
		data?: Float32Array;
		usage?: GPUTextureUsageFlags;
	}) => GPUTexture;
	readTexture: (
		texture: GPUTexture,
		width: number,
		height: number,
	) => Promise<Float32Array>;
}

export async function setupComputeShaderTest(
	code: string,
	entryPoint = "main",
): Promise<ComputeShaderTestSetup> {
	const device = await getTestDevice();

	const { module, uniformViews } = compileShaderModule(device, {
		code,
		label: "Shader Test",
	});
	const pipeline = device.createComputePipeline({
		layout: "auto",
		compute: { module, entryPoint },
	});

	const createStorageBuffer = (data: Float32Array): GPUBuffer => {
		const buf = device.createBuffer({
			size: data.byteLength,
			usage:
				GPUBufferUsage.STORAGE |
				GPUBufferUsage.COPY_SRC |
				GPUBufferUsage.COPY_DST,
		});
		device.queue.writeBuffer(buf, 0, data);
		return buf;
	};

	const createReadbackBuffer = (byteLength: number): GPUBuffer =>
		device.createBuffer({
			size: byteLength,
			usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
		});

	const createUniformBuffer = (view: StructuredView): GPUBuffer => {
		const buf = device.createBuffer({
			size: view.arrayBuffer.byteLength,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		});
		device.queue.writeBuffer(buf, 0, view.arrayBuffer);
		return buf;
	};

	const createUniformBufferRaw = (data: ArrayBuffer): GPUBuffer => {
		const buf = device.createBuffer({
			size: data.byteLength,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		});
		device.queue.writeBuffer(buf, 0, data);
		return buf;
	};

	const createTexture = (opts: {
		width: number;
		height: number;
		format?: GPUTextureFormat;
		data?: Float32Array;
		usage?: GPUTextureUsageFlags;
	}): GPUTexture => {
		const format = opts.format ?? "rgba16float";
		const texture = device.createTexture({
			size: [opts.width, opts.height],
			format,
			usage:
				opts.usage ??
				GPUTextureUsage.TEXTURE_BINDING |
					GPUTextureUsage.STORAGE_BINDING |
					GPUTextureUsage.COPY_SRC |
					GPUTextureUsage.COPY_DST,
		});
		if (opts.data) {
			if (format === "rgba16float") {
				const half = new Uint16Array(opts.data.length);
				for (let i = 0; i < opts.data.length; i++) {
					half[i] = float32ToFloat16(opts.data[i]);
				}
				device.queue.writeTexture(
					{ texture },
					half,
					{ bytesPerRow: opts.width * 4 * 2 },
					[opts.width, opts.height],
				);
			} else {
				const bpp = format === "rgba32float" ? 16 : 4;
				device.queue.writeTexture(
					{ texture },
					opts.data,
					{ bytesPerRow: opts.width * bpp },
					[opts.width, opts.height],
				);
			}
		}
		return texture;
	};

	const readBuffer = async (buffer: GPUBuffer): Promise<Float32Array> => {
		const readback = createReadbackBuffer(buffer.size);
		const encoder = device.createCommandEncoder();
		encoder.copyBufferToBuffer(buffer, 0, readback, 0, buffer.size);
		device.queue.submit([encoder.finish()]);

		await readback.mapAsync(GPUMapMode.READ);
		const result = new Float32Array(readback.getMappedRange().slice(0));
		readback.unmap();
		readback.destroy();
		return result;
	};

	const readTexture = async (
		texture: GPUTexture,
		width: number,
		height: number,
	): Promise<Float32Array> => {
		const bytesPerPixel =
			texture.format === "rgba32float"
				? 16
				: texture.format === "rgba16float"
					? 8
					: 4;
		const bytesPerRow = Math.ceil((width * bytesPerPixel) / 256) * 256;
		const bufferSize = bytesPerRow * height;

		const readback = device.createBuffer({
			size: bufferSize,
			usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
		});

		const encoder = device.createCommandEncoder();
		encoder.copyTextureToBuffer(
			{ texture },
			{ buffer: readback, bytesPerRow },
			[width, height],
		);
		device.queue.submit([encoder.finish()]);

		await readback.mapAsync(GPUMapMode.READ);
		const mapped = readback.getMappedRange();

		if (texture.format === "rgba32float") {
			const raw = new Float32Array(mapped);
			const pixels = new Float32Array(width * height * 4);
			const rowFloats = bytesPerRow / 4;
			for (let y = 0; y < height; y++) {
				pixels.set(
					raw.subarray(y * rowFloats, y * rowFloats + width * 4),
					y * width * 4,
				);
			}
			readback.unmap();
			readback.destroy();
			return pixels;
		}

		if (texture.format === "rgba16float") {
			const raw = new Uint16Array(mapped);
			const pixels = new Float32Array(width * height * 4);
			const rowHalfs = bytesPerRow / 2;
			for (let y = 0; y < height; y++) {
				for (let x = 0; x < width * 4; x++) {
					pixels[y * width * 4 + x] = float16ToFloat32(raw[y * rowHalfs + x]);
				}
			}
			readback.unmap();
			readback.destroy();
			return pixels;
		}

		const raw = new Uint8Array(mapped);
		const pixels = new Float32Array(width * height * 4);
		const rowBytes = bytesPerRow;
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width * 4; x++) {
				pixels[y * width * 4 + x] = raw[y * rowBytes + x] / 255;
			}
		}
		readback.unmap();
		readback.destroy();
		return pixels;
	};

	const dispatch = async (
		bindings: GPUBindGroupEntry[],
		workgroups: [number, number, number],
	): Promise<void> => {
		const bindGroup = device.createBindGroup({
			layout: pipeline.getBindGroupLayout(0),
			entries: bindings,
		});

		const encoder = device.createCommandEncoder();
		const pass = encoder.beginComputePass();
		pass.setPipeline(pipeline);
		pass.setBindGroup(0, bindGroup);
		pass.dispatchWorkgroups(...workgroups);
		pass.end();
		device.queue.submit([encoder.finish()]);
		await device.queue.onSubmittedWorkDone();
	};

	return {
		device,
		pipeline,
		uniformViews,
		dispatch,
		readBuffer,
		createStorageBuffer,
		createReadbackBuffer,
		createUniformBuffer,
		createUniformBufferRaw,
		createTexture,
		readTexture,
	};
}

export type RGBA = [number, number, number, number];

export function fillTexture(
	width: number,
	height: number,
	fillPixel: RGBA,
): Float32Array {
	const data = new Float32Array(width * height * 4);
	for (let i = 0; i < width * height; i++) {
		data[i * 4] = fillPixel[0];
		data[i * 4 + 1] = fillPixel[1];
		data[i * 4 + 2] = fillPixel[2];
		data[i * 4 + 3] = fillPixel[3];
	}
	return data;
}

export function centerDotTexture(
	width: number,
	height: number,
	pixel: RGBA,
): Float32Array {
	const data = new Float32Array(width * height * 4);
	const cx = Math.floor(width / 2);
	const cy = Math.floor(height / 2);
	const idx = (cy * width + cx) * 4;
	data[idx] = pixel[0];
	data[idx + 1] = pixel[1];
	data[idx + 2] = pixel[2];
	data[idx + 3] = pixel[3];
	return data;
}

function float32ToFloat16(f: number): number {
	const buf = new ArrayBuffer(4);
	new DataView(buf).setFloat32(0, f);
	const bits = new DataView(buf).getUint32(0);

	const sign = (bits >>> 31) & 1;
	const exp = (bits >>> 23) & 0xff;
	const frac = bits & 0x7fffff;

	if (exp === 0) return sign << 15;
	if (exp === 0xff)
		return (sign << 15) | 0x7c00 | (frac ? (frac >>> 13) | 1 : 0);

	const newExp = exp - 127 + 15;
	if (newExp >= 31) return (sign << 15) | 0x7c00;
	if (newExp <= 0) {
		if (newExp < -10) return sign << 15;
		const m = (frac | 0x800000) >>> (1 - newExp + 13);
		return (sign << 15) | m;
	}
	return (sign << 15) | (newExp << 10) | (frac >>> 13);
}

function float16ToFloat32(h: number): number {
	const sign = (h >>> 15) & 1;
	const exp = (h >>> 10) & 0x1f;
	const frac = h & 0x3ff;

	if (exp === 0) {
		if (frac === 0) return sign ? -0 : 0;
		const v = (frac / 1024) * (1 / 16384);
		return sign ? -v : v;
	}
	if (exp === 0x1f) {
		return frac ? Number.NaN : sign ? -Infinity : Infinity;
	}

	const v = (1 + frac / 1024) * 2 ** (exp - 15);
	return sign ? -v : v;
}
