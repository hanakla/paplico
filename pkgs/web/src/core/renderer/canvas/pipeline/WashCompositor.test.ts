import { getTestDevice } from "../../../testUtils/shaderTestHarness";
import { TexturePool } from "./TexturePool";
import { WashCompositor } from "./WashCompositor";

/**
 * Direct GPU test of the wet-edge pass: a 64x64 opaque red square (16..48)
 * gets a 4px rim; the rim's straight color darkens while the center keeps
 * its color. Reads pixels back from the texture after apply.
 */
describe("WashCompositor.applyWetEdge", () => {
	it("should darken the rim band and keep the interior color", async () => {
		const device = await getTestDevice();
		const pool = new TexturePool(device);
		const compositor = new WashCompositor(device, pool, "rgba8unorm");

		const size = 64;
		const texture = device.createTexture({
			size: [size, size],
			format: "rgba8unorm",
			usage:
				GPUTextureUsage.TEXTURE_BINDING |
				GPUTextureUsage.COPY_DST |
				GPUTextureUsage.COPY_SRC |
				GPUTextureUsage.RENDER_ATTACHMENT,
		});
		const data = new Uint8Array(size * size * 4);
		for (let y = 16; y < 48; y++) {
			for (let x = 16; x < 48; x++) {
				const i = (y * size + x) * 4;
				data[i] = 255; // premultiplied red, alpha 1
				data[i + 3] = 255;
			}
		}
		device.queue.writeTexture({ texture }, data, { bytesPerRow: size * 4 }, [
			size,
			size,
		]);

		const encoder = device.createCommandEncoder();
		const scratch = compositor.applyWetEdge(
			encoder,
			texture,
			{ width: 4, intensity: 0.5, darkening: 0.6, blur: 0 },
			1,
			100,
		);
		const readback = device.createBuffer({
			size: size * size * 4,
			usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
		});
		encoder.copyTextureToBuffer(
			{ texture },
			{ buffer: readback, bytesPerRow: size * 4 },
			[size, size],
		);
		device.queue.submit([encoder.finish()]);
		await readback.mapAsync(GPUMapMode.READ);
		const pixels = new Uint8Array(readback.getMappedRange()).slice();
		readback.unmap();

		const at = (x: number, y: number) => pixels[(y * size + x) * 4];
		// Interior (32,32): untouched red.
		expect(at(32, 32)).toBeGreaterThan(240);
		// Rim (17,32): straight color darkened by ~0.6.
		expect(at(17, 32)).toBeLessThan(160);

		for (const t of scratch) pool.release(t);
		compositor.destroy();
		pool.destroy();
	});
});
