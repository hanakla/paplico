import fs from "node:fs";
import path from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { onTestFinished } from "vitest";
import { CanvasTarget } from "../renderer/CanvasTarget";
import { RenderOrchestrator } from "../renderer/RenderOrchestrator";
import type { Artboard, Document, RawRGBA, Viewport } from "../schema";

let cachedGpu: globalThis.GPU | null = null;

/**
 * Get Node.js WebGPU GPU instance (cached) and inject globals.
 * Called from vitest.setup.ts and createTestRenderer().
 */
export async function ensureWebGPUGlobals(): Promise<globalThis.GPU> {
	if (cachedGpu) return cachedGpu;

	const webgpuModule = await import("webgpu");

	// On Linux CI, use Lavapipe software renderer
	const flags: string[] = [];
	if (process.platform === "linux") {
		flags.push("adapter=llvmpipe");
	}

	cachedGpu = webgpuModule.create(flags);
	Object.assign(globalThis, webgpuModule.globals);
	return cachedGpu;
}

/**
 * Create a fully initialized RenderOrchestrator with a CanvasTarget.
 * The renderer owns its own GPUDevice via initDevice().
 */
export async function createTestRenderer({
	lifetime = "test",
}: {
	lifetime?: "test" | "suite";
} = {}): Promise<{
	renderer: RenderOrchestrator;
	canvas: CanvasTarget;
}> {
	const gpu = await ensureWebGPUGlobals();

	const originalGpu = (globalThis as any).navigator?.gpu;
	Object.defineProperty(globalThis.navigator, "gpu", {
		value: gpu,
		writable: true,
		configurable: true,
	});

	const renderer = new RenderOrchestrator();
	let success = false;
	try {
		success = await renderer.initDevice();
	} finally {
		Object.defineProperty(globalThis.navigator, "gpu", {
			value: originalGpu,
			writable: true,
			configurable: true,
		});
	}

	if (!success) {
		renderer.destroy();
		throw new Error("Failed to initialize test renderer");
	}
	if (lifetime === "test") {
		onTestFinished(() => {
			if (renderer.getDevice()) renderer.destroy();
		});
	}

	const canvas = createCanvasTarget();
	await renderer.initCanvasTarget(canvas);
	renderer.setCanvasTarget(canvas);

	return { renderer, canvas };
}

function createCanvasTarget(): CanvasTarget {
	const mockCanvas: any = {
		width: 800,
		height: 600,
		getContext: (contextType: string) => {
			if (contextType === "webgpu") {
				return mockContext;
			}
			return null;
		},
		getBoundingClientRect: () => ({
			width: 800,
			height: 600,
			x: 0,
			y: 0,
			top: 0,
			left: 0,
			right: 800,
			bottom: 600,
			toJSON: () => ({}),
		}),
	};

	const mockContext = {
		canvas: mockCanvas,
		configure: () => {},
		unconfigure: () => {},
		getCurrentTexture: () => {
			throw new Error(
				"getCurrentTexture should not be called in test environment",
			);
		},
	} as any as GPUCanvasContext;

	return new CanvasTarget(mockCanvas as HTMLCanvasElement, {
		id: "test-canvas",
		pixelRatio: 1,
	});
}

/**
 * Render a document with the specified viewport (including rotation) to a GPUTexture.
 * Use this for visual regression tests that require viewport-aware rendering,
 * such as testing brush stroke positions under a rotated viewport.
 */
export async function renderWithViewport(
	renderer: RenderOrchestrator,
	_canvas: CanvasTarget,
	document: Document,
	viewport: Viewport,
	backgroundColor: RawRGBA = {
		r: 1,
		g: 1,
		b: 1,
		a: 1,
	},
): Promise<GPUTexture> {
	const texture = await renderer.renderViewportToTexture(
		viewport,
		document,
		800,
		600,
		backgroundColor,
	);
	if (!texture) throw new Error("renderWithViewport returned null");
	return texture;
}

/**
 * Render an artboard to an rgba8unorm GPUTexture for visual regression testing.
 */
export async function renderArtboardForTest(
	renderer: RenderOrchestrator,
	artboard: Artboard,
	document: Document,
	scale = 1,
	backgroundColor: RawRGBA = { r: 1, g: 1, b: 1, a: 1 },
): Promise<GPUTexture> {
	const result = await renderer.renderArtboardToTexture(
		artboard,
		document,
		scale,
		backgroundColor,
	);
	if (!result) throw new Error("renderArtboardForTest returned null");
	return result.texture;
}

/**
 * Visual regression test helper.
 * Renders texture to PNG via the renderer's device and compares against baseline.
 */
export async function expectVisualMatch(
	renderer: RenderOrchestrator,
	texture: GPUTexture,
	width: number,
	height: number,
	testName: string,
	{
		threshold,
		maxDiffPercentage,
		updateBaseline,
		allowEmpty = false,
	}: {
		threshold?: number;
		maxDiffPercentage?: number;
		updateBaseline?: boolean;
		/** Allow rendered image are all tranparent or white */
		allowEmpty?: boolean;
	} = {},
): Promise<void> {
	const device = renderer.getDevice()!;
	const baselineDir = path.join(__dirname, "../../__visual_baselines__");
	const diffDir = path.join(__dirname, "../../__visual_diffs__");
	const baselinePath = path.join(baselineDir, `${testName}.png`);
	const diffPath = path.join(diffDir, `${testName}.diff.png`);

	const actual = await captureTextureToBuffer(device, texture, width, height);
	const actualBitmap = await new Promise<Buffer<ArrayBufferLike>>((res) => {
		new PNG().parse(actual).on("parsed", function () {
			res(this.data);
		});
	});

	if (!allowEmpty) {
		let isNotEmpty = false;

		for (let i = 0; i < actualBitmap.byteLength; i += 4) {
			const [r, g, b, a] = actualBitmap.subarray(i, i + 4);

			// biome-ignore format: readability
			isNotEmpty ||=
				!(r === 0 && g === 0 && b === 0 && a === 0) &&
				!(r === 255 && g === 255 && b === 255 && a === 255);

			if (isNotEmpty) break;
		}

		if (!isNotEmpty) {
			throw new Error("Visual Regression: actual image are unexpected empty");
		}
	}

	const shouldUpdate =
		updateBaseline || process.env.UPDATE_BASELINES === "true";

	if (shouldUpdate || !fs.existsSync(baselinePath)) {
		fs.mkdirSync(baselineDir, { recursive: true });
		fs.writeFileSync(baselinePath, actual);
		console.log(`Baseline updated: ${baselinePath}`);
		return;
	}

	const expected = fs.readFileSync(baselinePath);
	const { diffPixels, totalPixels, diffPercentage } = compareImages(
		actual,
		expected,
		{
			threshold: threshold ?? 0.1,
			diffPath,
		},
	);

	const maxDiff = maxDiffPercentage ?? 0.1;

	if (diffPercentage > maxDiff) {
		throw new Error(
			`Visual regression detected: ${diffPixels}/${totalPixels} pixels differ (${diffPercentage.toFixed(2)}% > ${maxDiff}%)\n` +
				`Diff saved to: ${diffPath}\n` +
				`To update baseline, run with UPDATE_BASELINES=true`,
		);
	}

	if (fs.existsSync(diffPath)) {
		fs.unlinkSync(diffPath);
	}
}

/**
 * Read GPU texture pixels into a raw Uint8Array (RGBA, row-packed).
 * Exported so tests can compare texture output against ImageData directly.
 */
export async function captureTexturePixels(
	device: GPUDevice,
	texture: GPUTexture,
	width: number,
	height: number,
): Promise<Uint8Array> {
	const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
	const bufferSize = bytesPerRow * height;

	const buffer = device.createBuffer({
		size: bufferSize,
		usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
	});

	const encoder = device.createCommandEncoder();
	encoder.copyTextureToBuffer(
		{ texture },
		{ buffer, bytesPerRow },
		{ width, height },
	);
	device.queue.submit([encoder.finish()]);

	await buffer.mapAsync(GPUMapMode.READ);
	const raw = new Uint8Array(buffer.getMappedRange());

	const pixels = new Uint8Array(width * height * 4);
	for (let y = 0; y < height; y++) {
		const src = y * bytesPerRow;
		const dst = y * width * 4;
		pixels.set(raw.subarray(src, src + width * 4), dst);
	}

	buffer.unmap();
	buffer.destroy();
	return pixels;
}

async function captureTextureToBuffer(
	device: GPUDevice,
	texture: GPUTexture,
	width: number,
	height: number,
): Promise<Buffer> {
	const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
	const bufferSize = bytesPerRow * height;

	const buffer = device.createBuffer({
		size: bufferSize,
		usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
	});

	const encoder = device.createCommandEncoder();
	encoder.copyTextureToBuffer(
		{ texture },
		{ buffer, bytesPerRow },
		{ width, height },
	);
	device.queue.submit([encoder.finish()]);

	await buffer.mapAsync(GPUMapMode.READ);
	const arrayBuffer = buffer.getMappedRange();
	const data = new Uint8Array(arrayBuffer);

	const png = new PNG({ width, height });

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const srcIdx = y * bytesPerRow + x * 4;
			const dstIdx = (y * width + x) * 4;

			png.data[dstIdx] = data[srcIdx];
			png.data[dstIdx + 1] = data[srcIdx + 1];
			png.data[dstIdx + 2] = data[srcIdx + 2];
			png.data[dstIdx + 3] = data[srcIdx + 3];
		}
	}

	buffer.unmap();
	buffer.destroy();

	return PNG.sync.write(png);
}

function compareImages(
	actual: Buffer,
	expected: Buffer,
	options?: {
		threshold?: number;
		diffPath?: string;
	},
): { diffPixels: number; totalPixels: number; diffPercentage: number } {
	const actualPng = PNG.sync.read(actual);
	const expectedPng = PNG.sync.read(expected);

	if (
		actualPng.width !== expectedPng.width ||
		actualPng.height !== expectedPng.height
	) {
		throw new Error(
			`Image dimensions mismatch: actual(${actualPng.width}x${actualPng.height}) vs expected(${expectedPng.width}x${expectedPng.height})`,
		);
	}

	const { width, height } = actualPng;
	const diff = new PNG({ width, height });

	const diffPixels = pixelmatch(
		actualPng.data,
		expectedPng.data,
		diff.data,
		width,
		height,
		{
			threshold: options?.threshold ?? 0.1,
		},
	);

	if (options?.diffPath) {
		fs.mkdirSync(path.dirname(options.diffPath), { recursive: true });
		fs.writeFileSync(options.diffPath, PNG.sync.write(diff));
	}

	const totalPixels = width * height;
	const diffPercentage = (diffPixels / totalPixels) * 100;

	return { diffPixels, totalPixels, diffPercentage };
}
