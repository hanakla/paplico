import { BUILTIN_BRUSH_IDS } from "../../../../schema";
import { getTestDevice } from "../../../../testUtils/shaderTestHarness";
import { mipLevelCountFor } from "../../../../utils/wgpu-utils";
import { BrushTextureArrayBuilder } from "./BrushTextureArrayBuilder";
import { BrushTextureManager } from "./BrushTextureManager";

describe("BrushTextureManager mipmaps", () => {
	it("should create builtin tip textures with a populated full mip chain", async () => {
		const device = await getTestDevice();
		const manager = new BrushTextureManager(device);
		await manager.loadDefaultTextures();

		const texture = manager.getTexture(BUILTIN_BRUSH_IDS.hardCircle);
		if (!texture) throw new Error("hard circle texture missing");
		expect(texture.mipLevelCount).toBe(mipLevelCountFor(128, 128));

		// The disc center of mip 1 must carry the downsampled content.
		const bytesPerRow = 256;
		const buffer = device.createBuffer({
			size: bytesPerRow * 64,
			usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
		});
		const encoder = device.createCommandEncoder();
		encoder.copyTextureToBuffer(
			{ texture, mipLevel: 1 },
			{ buffer, bytesPerRow },
			{ width: 64, height: 64, depthOrArrayLayers: 1 },
		);
		device.queue.submit([encoder.finish()]);
		await buffer.mapAsync(GPUMapMode.READ);
		const pixels = new Uint8Array(buffer.getMappedRange()).slice();
		buffer.unmap();
		buffer.destroy();
		expect(pixels[32 * bytesPerRow + 32 * 4]).toBe(255);

		manager.destroy();
	});

	it("should expose a mip-filtering sampler separate from the legacy one", async () => {
		const device = await getTestDevice();
		const manager = new BrushTextureManager(device);
		expect(manager.getMipSampler()).not.toBe(manager.getSampler());
		manager.destroy();
	});
});

describe("BrushTextureArrayBuilder mipmaps", () => {
	it("should build array textures with a full mip chain", async () => {
		const device = await getTestDevice();
		const manager = new BrushTextureManager(device);
		await manager.loadDefaultTextures();
		const builder = new BrushTextureArrayBuilder(device, manager);

		const result = builder.build([
			BUILTIN_BRUSH_IDS.hardCircle,
			BUILTIN_BRUSH_IDS.softCircle,
		]);
		if (!result) throw new Error("array build failed");
		expect(result.texture.mipLevelCount).toBe(mipLevelCountFor(128, 128));

		builder.destroy();
		manager.destroy();
	});
});
