import { getTestDevice } from "../testUtils/shaderTestHarness";
import { generateMipmaps, mipLevelCountFor } from "./wgpu-utils";

describe("mipLevelCountFor", () => {
	it("should return the full mip chain length for the larger dimension", () => {
		expect(mipLevelCountFor(1, 1)).toBe(1);
		expect(mipLevelCountFor(4, 4)).toBe(3);
		expect(mipLevelCountFor(256, 64)).toBe(9);
		expect(mipLevelCountFor(100, 30)).toBe(7);
	});
});

describe("generateMipmaps", () => {
	async function readMipLevel(
		device: GPUDevice,
		texture: GPUTexture,
		mipLevel: number,
		width: number,
		height: number,
		layer = 0,
	): Promise<Uint8Array> {
		const bytesPerRow = Math.max(256, width * 4);
		const buffer = device.createBuffer({
			size: bytesPerRow * height,
			usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
		});
		const encoder = device.createCommandEncoder();
		encoder.copyTextureToBuffer(
			{ texture, mipLevel, origin: { x: 0, y: 0, z: layer } },
			{ buffer, bytesPerRow },
			{ width, height, depthOrArrayLayers: 1 },
		);
		device.queue.submit([encoder.finish()]);
		await buffer.mapAsync(GPUMapMode.READ);
		const raw = new Uint8Array(buffer.getMappedRange()).slice();
		buffer.unmap();
		buffer.destroy();
		const out = new Uint8Array(width * height * 4);
		for (let y = 0; y < height; y++) {
			out.set(
				raw.subarray(y * bytesPerRow, y * bytesPerRow + width * 4),
				y * width * 4,
			);
		}
		return out;
	}

	function makeHalfWhiteTexture(
		device: GPUDevice,
		arrayLayers = 1,
	): GPUTexture {
		const texture = device.createTexture({
			size: { width: 4, height: 4, depthOrArrayLayers: arrayLayers },
			format: "rgba8unorm",
			mipLevelCount: 3,
			usage:
				GPUTextureUsage.TEXTURE_BINDING |
				GPUTextureUsage.RENDER_ATTACHMENT |
				GPUTextureUsage.COPY_DST |
				GPUTextureUsage.COPY_SRC,
		});
		// Left two columns white, right two black (fully opaque).
		const level0 = new Uint8Array(4 * 4 * 4);
		for (let y = 0; y < 4; y++) {
			for (let x = 0; x < 4; x++) {
				const idx = (y * 4 + x) * 4;
				const v = x < 2 ? 255 : 0;
				level0[idx] = v;
				level0[idx + 1] = v;
				level0[idx + 2] = v;
				level0[idx + 3] = 255;
			}
		}
		for (let layer = 0; layer < arrayLayers; layer++) {
			device.queue.writeTexture(
				{ texture, origin: { x: 0, y: 0, z: layer } },
				level0,
				{ bytesPerRow: 16 },
				{ width: 4, height: 4, depthOrArrayLayers: 1 },
			);
		}
		return texture;
	}

	it("should box-filter each level from the previous one", async () => {
		const device = await getTestDevice();
		const texture = makeHalfWhiteTexture(device);
		generateMipmaps(device, texture);

		const mip1 = await readMipLevel(device, texture, 1, 2, 2);
		// Each mip1 texel averages a 2x2 block of mip0.
		expect(mip1[0]).toBe(255);
		expect(mip1[4]).toBe(0);
		expect(mip1[8]).toBe(255);
		expect(mip1[12]).toBe(0);

		const mip2 = await readMipLevel(device, texture, 2, 1, 1);
		// The 1x1 tail averages everything: half white, half black.
		expect(Math.abs(mip2[0] - 128)).toBeLessThanOrEqual(1);
		expect(mip2[3]).toBe(255);
	});

	it("should generate mips for every layer of an array texture", async () => {
		const device = await getTestDevice();
		const texture = makeHalfWhiteTexture(device, 2);
		generateMipmaps(device, texture);

		for (const layer of [0, 1]) {
			const mip1 = await readMipLevel(device, texture, 1, 2, 2, layer);
			expect(mip1[0]).toBe(255);
			expect(mip1[4]).toBe(0);
		}
	});
});
