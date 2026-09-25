import { beforeAll, describe, expect, it } from "vitest";
import {
	captureTexturePixels,
	ensureWebGPUGlobals,
} from "../../../testUtils/visualRegression";
import { EXPOSURE_BLIT_SHADER } from "../../shaders/blit.wgsl";

const FORMAT: GPUTextureFormat = "rgba8unorm";
const ALPHAS = [0, 0.25, 0.5, 1] as const;
const EXPOSURES = [-2, 0, 2] as const;
const STRAIGHT_RGB = [0.4, 0.2, 0.1] as const;
const MAX_NITS = 203;
const EDR_HEADROOM = 4;
const SOURCE_PIXELS = createSourcePixels();

let device: GPUDevice;
let pipeline: GPURenderPipeline;
let bindGroupLayout: GPUBindGroupLayout;
let sampler: GPUSampler;

beforeAll(async () => {
	const gpu = await ensureWebGPUGlobals();
	const adapter = await gpu.requestAdapter();
	if (!adapter) throw new Error("Failed to get GPU adapter for test");
	device = await adapter.requestDevice();
	bindGroupLayout = device.createBindGroupLayout({
		entries: [
			{
				binding: 0,
				visibility: GPUShaderStage.FRAGMENT,
				buffer: { type: "uniform" },
			},
			{
				binding: 1,
				visibility: GPUShaderStage.FRAGMENT,
				sampler: { type: "non-filtering" },
			},
			{
				binding: 2,
				visibility: GPUShaderStage.FRAGMENT,
				texture: { sampleType: "float" },
			},
		],
	});
	const module = device.createShaderModule({ code: EXPOSURE_BLIT_SHADER });
	pipeline = device.createRenderPipeline({
		layout: device.createPipelineLayout({
			bindGroupLayouts: [bindGroupLayout],
		}),
		vertex: { module, entryPoint: "vertexMain" },
		fragment: {
			module,
			entryPoint: "fragmentMain",
			targets: [{ format: FORMAT }],
		},
		primitive: { topology: "triangle-list" },
	});
	sampler = device.createSampler({
		magFilter: "nearest",
		minFilter: "nearest",
	});
});

describe("Exposure blit premultiplied alpha", () => {
	it.each(
		EXPOSURES,
	)("should transform straight RGB and restore premultiplied alpha at EV %i", async (exposure) => {
		const result = await renderExposure(exposure);

		for (let pixel = 0; pixel < ALPHAS.length; pixel++) {
			const offset = pixel * 4;
			const expected = referencePixel(offset, exposure);
			for (let channel = 0; channel < 4; channel++) {
				expect(
					Math.abs(result[offset + channel] - expected[channel]),
					`pixel ${pixel}, channel ${channel}`,
				).toBeLessThanOrEqual(2);
			}
		}
	});
});

async function renderExposure(exposure: number): Promise<Uint8Array> {
	const source = device.createTexture({
		size: { width: ALPHAS.length, height: 1 },
		format: FORMAT,
		usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
	});
	device.queue.writeTexture(
		{ texture: source },
		SOURCE_PIXELS,
		{ bytesPerRow: ALPHAS.length * 4 },
		{ width: ALPHAS.length, height: 1 },
	);
	const target = device.createTexture({
		size: { width: ALPHAS.length, height: 1 },
		format: FORMAT,
		usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
	});
	const uniformBuffer = device.createBuffer({
		size: 16,
		usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
	});
	device.queue.writeBuffer(
		uniformBuffer,
		0,
		new Float32Array([exposure, MAX_NITS, EDR_HEADROOM, 0]),
	);
	const bindGroup = device.createBindGroup({
		layout: bindGroupLayout,
		entries: [
			{ binding: 0, resource: { buffer: uniformBuffer } },
			{ binding: 1, resource: sampler },
			{ binding: 2, resource: source.createView() },
		],
	});
	const encoder = device.createCommandEncoder();
	const pass = encoder.beginRenderPass({
		colorAttachments: [
			{
				view: target.createView(),
				clearValue: { r: 0, g: 0, b: 0, a: 0 },
				loadOp: "clear",
				storeOp: "store",
			},
		],
	});
	pass.setPipeline(pipeline);
	pass.setBindGroup(0, bindGroup);
	pass.draw(6);
	pass.end();
	device.queue.submit([encoder.finish()]);

	const result = await captureTexturePixels(device, target, ALPHAS.length, 1);
	uniformBuffer.destroy();
	source.destroy();
	target.destroy();
	return result;
}

function createSourcePixels(): Uint8Array {
	return Uint8Array.from(
		ALPHAS.flatMap((alpha) => {
			const alphaByte = Math.round(alpha * 255);
			return [
				...STRAIGHT_RGB.map((channel) => Math.round(channel * alphaByte)),
				alphaByte,
			];
		}),
	);
}

function referencePixel(offset: number, exposure: number): number[] {
	const alpha = SOURCE_PIXELS[offset + 3] / 255;
	if (alpha === 0) return [0, 0, 0, 0];

	const scale = 2 ** exposure;
	const rgb = [0, 1, 2].map((channel) => {
		const premultiplied = SOURCE_PIXELS[offset + channel] / 255;
		const straight = premultiplied / alpha;
		const linear = srgbEotf(straight) * scale;
		const converted = pqRoundtripLinear(linear, MAX_NITS, EDR_HEADROOM);
		return toByte(srgbOetf(converted) * alpha);
	});
	return [...rgb, SOURCE_PIXELS[offset + 3]];
}

function srgbEotf(value: number): number {
	if (value <= 0.04045) return value / 12.92;
	return ((value + 0.055) / 1.055) ** 2.4;
}

function srgbOetf(value: number): number {
	if (value <= 0.0031308) return 12.92 * value;
	return 1.055 * value ** (1 / 2.4) - 0.055;
}

function pqRoundtripLinear(
	linear: number,
	maxNits: number,
	headroom: number,
): number {
	const pqM1 = 0.1593017578125;
	const pqM2 = 78.84375;
	const pqC1 = 0.8359375;
	const pqC2 = 18.8515625;
	const pqC3 = 18.6875;
	const normalized = Math.min(linear, headroom) * maxNits;
	const yPow = Math.max(normalized / 10_000, 0) ** pqM1;
	const pq = ((pqC1 + pqC2 * yPow) / (1 + pqC3 * yPow)) ** pqM2;
	const quantized = Math.round(pq * 1_023) / 1_023;
	const pqPow = Math.max(quantized, 0) ** (1 / pqM2);
	const decoded =
		10_000 * (Math.max(pqPow - pqC1, 0) / (pqC2 - pqC3 * pqPow)) ** (1 / pqM1);
	return decoded / maxNits;
}

function toByte(value: number): number {
	return Math.round(Math.min(Math.max(value, 0), 1) * 255);
}
