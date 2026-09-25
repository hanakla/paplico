import { beforeAll, describe, expect, it } from "vitest";
import { ensureWebGPUGlobals } from "../../../testUtils/visualRegression";
import { BackdropCaptureManager } from "./BackdropCaptureManager";
import {
	BackdropEffectCoordinator,
	type BackdropEffectRequest,
} from "./BackdropEffectCoordinator";
import type { FilterRenderer } from "./FilterRenderer";
import { TexturePool } from "./TexturePool";

const SIZE = 128;
const VIEWPORT = { x: 0, y: 0, zoom: 1 };
const FULL_BOUNDS = bounds(-SIZE / 2, -SIZE / 2, SIZE / 2, SIZE / 2);
const DIRTY_BOUNDS = bounds(-2, -2, 2, 2);

let device: GPUDevice;

beforeAll(async () => {
	const gpu = await ensureWebGPUGlobals();
	const adapter = await gpu.requestAdapter();
	if (!adapter) throw new Error("Failed to get GPU adapter for test");
	device = await adapter.requestDevice();
});

describe("BackdropEffectCoordinator dirty pyramid updates", () => {
	it("should run a fused partial pyramid update without a GPU validation error", async () => {
		const texturePool = new TexturePool(device);
		const coordinator = new BackdropEffectCoordinator(
			device,
			texturePool,
			new BackdropCaptureManager(device, null as unknown as FilterRenderer),
		);
		const target = createTexture();
		const patch = createTexture();
		const request: BackdropEffectRequest = {
			bounds: FULL_BOUNDS,
			blurSigma: 2,
		};
		const blue = new Uint8Array(SIZE * SIZE * 4);
		for (let index = 0; index < SIZE * SIZE; index++) {
			blue[index * 4 + 2] = 255;
			blue[index * 4 + 3] = 255;
		}
		device.queue.writeTexture(
			{ texture: patch },
			blue,
			{ bytesPerRow: SIZE * 4 },
			{ width: SIZE, height: SIZE },
		);

		coordinator.beginFrame();
		coordinator.planFrame([request, request]);
		device.pushErrorScope("validation");
		const encoder = device.createCommandEncoder();
		const first = coordinator.acquireSample(
			encoder,
			target,
			VIEWPORT,
			SIZE,
			SIZE,
			request,
		);
		if (!first) throw new Error("Expected first backdrop sample");
		encoder.copyTextureToTexture(
			{ texture: patch },
			{ texture: target, origin: { x: SIZE / 2 - 2, y: SIZE / 2 - 2 } },
			{ width: 4, height: 4 },
		);
		coordinator.noteDraw(DIRTY_BOUNDS);
		const second = coordinator.acquireSample(
			encoder,
			target,
			VIEWPORT,
			SIZE,
			SIZE,
			request,
		);
		if (!second) throw new Error("Expected updated backdrop sample");
		device.queue.submit([encoder.finish()]);
		await device.queue.onSubmittedWorkDone();

		expect(await device.popErrorScope()).toBeNull();

		coordinator.releaseFrame((texture) => {
			if (!texturePool.release(texture)) texture.destroy();
		});
		coordinator.destroy();
		texturePool.destroy();
		target.destroy();
		patch.destroy();
	});
});

function bounds(minX: number, minY: number, maxX: number, maxY: number) {
	return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

function createTexture(): GPUTexture {
	return device.createTexture({
		label: "Backdrop Coordinator Visual Test Texture",
		size: { width: SIZE, height: SIZE },
		format: "rgba8unorm",
		usage:
			GPUTextureUsage.RENDER_ATTACHMENT |
			GPUTextureUsage.TEXTURE_BINDING |
			GPUTextureUsage.COPY_SRC |
			GPUTextureUsage.COPY_DST,
	});
}
