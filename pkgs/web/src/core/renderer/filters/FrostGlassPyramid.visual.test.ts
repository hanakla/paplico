import { describe, expect, it } from "vitest";
import { getTestDevice } from "../../testUtils/shaderTestHarness";
import { BackdropCaptureManager } from "../canvas/pipeline/BackdropCaptureManager";
import {
	BackdropEffectCoordinator,
	type BackdropEffectRequest,
} from "../canvas/pipeline/BackdropEffectCoordinator";
import { FilterRenderer } from "../canvas/pipeline/FilterRenderer";
import { TexturePool } from "../canvas/pipeline/TexturePool";
import {
	type FrostGlassFilter,
	FrostGlassFilterProcessor,
} from "./FrostGlassFilterProcessor";

const CANVAS_SIZE = 256;
const VIEWPORT = { x: 0, y: 0, zoom: 1 };
const REGION_SIZE = 96;
const REGION_BOUNDS = {
	minX: -48,
	minY: -48,
	maxX: 48,
	maxY: 48,
	width: 96,
	height: 96,
};
// 24 world px at R=1 → sigma 12 texels: the pyramid serves it from a lerp of
// levels 3 and 4, exercising multi-level selection.
const FILTER = {
	uid: "frost-test",
	processor: "frost-glass",
	enabled: true,
	paramData: { enabled: true, params: { radius: 24 } },
} as unknown as FrostGlassFilter;

describe("FrostGlass shared-pyramid blur", () => {
	it("should closely match the self-contained separable Gaussian on a checkerboard", async () => {
		const device = await getTestDevice();
		const filterRenderer = new FilterRenderer(device);
		const frost = new FrostGlassFilterProcessor();
		await frost.initialize(device, "rgba8unorm");
		filterRenderer.registerHandler("frost-glass", frost);
		const coordinator = new BackdropEffectCoordinator(
			device,
			new TexturePool(device),
			new BackdropCaptureManager(device, filterRenderer),
		);
		const prebuf = createCheckerboard(device);

		const run = async (usePyramid: boolean) => {
			frost.startFrame();
			coordinator.beginFrame();
			const request: BackdropEffectRequest = {
				bounds: REGION_BOUNDS,
				blurSigma: usePyramid ? frost.getBackdropBlurSigma(FILTER, 1) : 0,
				rasterScale: 1,
			};
			coordinator.planFrame([request]);
			const encoder = device.createCommandEncoder();
			const region = coordinator.acquireFixedRRegion(
				encoder,
				prebuf,
				VIEWPORT,
				CANVAS_SIZE,
				CANVAS_SIZE,
				request,
			);
			if (!region) throw new Error("acquireFixedRRegion returned null");
			filterRenderer.applyFilters(
				region.texture,
				[FILTER],
				encoder,
				undefined,
				1,
				undefined,
				undefined,
				undefined,
				usePyramid ? region.sampleBlur : undefined,
			);
			device.queue.submit([encoder.finish()]);
			await device.queue.onSubmittedWorkDone();
			const pixels = await readRgba8(device, region.texture);
			coordinator.releaseFrame((texture) => texture.destroy());
			return pixels;
		};

		const pyramidPixels = await run(true);
		const fallbackPixels = await run(false);

		// Interior comparison — a sigma-sized margin is excluded because the
		// two paths clamp region edges at different granularities.
		const margin = 24;
		let sumDiff = 0;
		let maxDiff = 0;
		let count = 0;
		let minLevel = 1;
		let maxLevel = 0;
		for (let y = margin; y < REGION_SIZE - margin; y++) {
			for (let x = margin; x < REGION_SIZE - margin; x++) {
				const index = (y * REGION_SIZE + x) * 4;
				for (let channel = 0; channel < 3; channel++) {
					const diff = Math.abs(
						pyramidPixels[index + channel] - fallbackPixels[index + channel],
					);
					sumDiff += diff;
					maxDiff = Math.max(maxDiff, diff);
					count++;
				}
				minLevel = Math.min(minLevel, pyramidPixels[index]);
				maxLevel = Math.max(maxLevel, pyramidPixels[index]);
			}
		}
		const meanDiff = sumDiff / count;

		// The sigma-12 blur must collapse the 16-px checkerboard contrast —
		// an unblurred sharp sample would still swing ~0.8.
		expect(
			maxLevel - minLevel,
			`pyramid output contrast ${maxLevel - minLevel}`,
		).toBeLessThan(0.3);

		expect(
			meanDiff,
			`pyramid vs gaussian: mean ${meanDiff}, max ${maxDiff}`,
		).toBeLessThan(0.02);
		expect(
			maxDiff,
			`pyramid vs gaussian: mean ${meanDiff}, max ${maxDiff}`,
		).toBeLessThan(0.08);
	});
});

// Helpers

/** 16-px checkerboard (0.1 / 0.9 grey, opaque) prebuf stand-in. */
function createCheckerboard(device: GPUDevice): GPUTexture {
	const data = new Uint8Array(CANVAS_SIZE * CANVAS_SIZE * 4);
	for (let y = 0; y < CANVAS_SIZE; y++) {
		for (let x = 0; x < CANVAS_SIZE; x++) {
			const value = (((x >> 4) ^ (y >> 4)) & 1) === 1 ? 230 : 26;
			const index = (y * CANVAS_SIZE + x) * 4;
			data[index] = value;
			data[index + 1] = value;
			data[index + 2] = value;
			data[index + 3] = 255;
		}
	}
	const texture = device.createTexture({
		label: "FrostGlass Pyramid Test Prebuf",
		size: { width: CANVAS_SIZE, height: CANVAS_SIZE },
		format: "rgba8unorm",
		usage:
			GPUTextureUsage.TEXTURE_BINDING |
			GPUTextureUsage.COPY_SRC |
			GPUTextureUsage.COPY_DST |
			GPUTextureUsage.RENDER_ATTACHMENT,
	});
	device.queue.writeTexture(
		{ texture },
		data,
		{ bytesPerRow: CANVAS_SIZE * 4 },
		{ width: CANVAS_SIZE, height: CANVAS_SIZE },
	);
	return texture;
}

async function readRgba8(
	device: GPUDevice,
	texture: GPUTexture,
): Promise<Float32Array> {
	const { width, height } = texture;
	const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
	const readback = device.createBuffer({
		size: bytesPerRow * height,
		usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
	});
	const encoder = device.createCommandEncoder();
	encoder.copyTextureToBuffer({ texture }, { buffer: readback, bytesPerRow }, [
		width,
		height,
	]);
	device.queue.submit([encoder.finish()]);
	await readback.mapAsync(GPUMapMode.READ);
	const raw = new Uint8Array(readback.getMappedRange());
	const pixels = new Float32Array(width * height * 4);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width * 4; x++) {
			pixels[y * width * 4 + x] = raw[y * bytesPerRow + x] / 255;
		}
	}
	readback.unmap();
	readback.destroy();
	return pixels;
}
