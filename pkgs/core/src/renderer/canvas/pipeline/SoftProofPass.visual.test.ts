import { beforeAll, describe, expect, it } from "vitest";
import {
	captureTexturePixels,
	ensureWebGPUGlobals,
} from "../../../testUtils/visualRegression";
import { SoftProofPass } from "./SoftProofPass";

const LUT_SIZE = 17;
const FORMAT: GPUTextureFormat = "rgba8unorm";

// Premultiplied RGBA source pixels (4x1).
// Covers: LUT grid extremes (black/white), a saturated primary, and the
// unpremultiply path (semi-transparent green).
const SOURCE_PIXELS = new Uint8Array([
	0,
	0,
	0,
	255, // opaque black
	255,
	255,
	255,
	255, // opaque white
	255,
	0,
	0,
	255, // opaque red
	0,
	128,
	0,
	128, // 50% alpha green (premultiplied)
]);
const WIDTH = 4;
const HEIGHT = 1;

let device: GPUDevice;

beforeAll(async () => {
	const gpu = await ensureWebGPUGlobals();
	const adapter = await gpu.requestAdapter();
	if (!adapter) throw new Error("Failed to get GPU adapter for test");
	device = await adapter.requestDevice();
});

describe("SoftProofPass", () => {
	it("should leave the image unchanged when an identity LUT is applied", async () => {
		const pass = new SoftProofPass(device, FORMAT);
		pass.setLut(createIdentityLut(LUT_SIZE), LUT_SIZE);

		const result = await applyPass(pass);

		// Identity LUT roundtrip error: 8-bit LUT quantization + trilinear
		// interpolation + 8-bit target rounding. Black/white must hold exactly
		// up to that tolerance thanks to the half-texel correction.
		for (let i = 0; i < SOURCE_PIXELS.length; i++) {
			expect(Math.abs(result[i] - SOURCE_PIXELS[i])).toBeLessThanOrEqual(3);
		}

		pass.destroy();
	});

	it("should shift colors when a desaturating LUT is applied", async () => {
		const pass = new SoftProofPass(device, FORMAT);
		pass.setLut(createDesaturateLut(LUT_SIZE), LUT_SIZE);

		const result = await applyPass(pass);

		// Black and white are fixed points of desaturation — unchanged.
		expect(Math.abs(result[0] - 0)).toBeLessThanOrEqual(3);
		expect(Math.abs(result[4] - 255)).toBeLessThanOrEqual(3);

		// Opaque red (255,0,0) → mixed 50% toward its gray (85,85,85):
		// expected ≈ (170, 43, 43).
		expect(Math.abs(result[8] - 170)).toBeLessThanOrEqual(4);
		expect(Math.abs(result[9] - 43)).toBeLessThanOrEqual(4);
		expect(Math.abs(result[10] - 43)).toBeLessThanOrEqual(4);
		expect(result[11]).toBe(255);

		// 50% alpha green: unpremultiplied (0,255,0) → desaturated (43,170,43)
		// → re-premultiplied at α=128 → ≈ (21, 85, 21, 128).
		expect(Math.abs(result[12] - 21)).toBeLessThanOrEqual(4);
		expect(Math.abs(result[13] - 85)).toBeLessThanOrEqual(4);
		expect(Math.abs(result[14] - 21)).toBeLessThanOrEqual(4);
		expect(Math.abs(result[15] - 128)).toBeLessThanOrEqual(2);

		pass.destroy();
	});

	it("should write nothing when no LUT is set", async () => {
		const pass = new SoftProofPass(device, FORMAT);

		const source = createSourceTexture();
		const target = createTargetTexture();
		const encoder = device.createCommandEncoder();
		pass.apply(encoder, source.createView(), target.createView());
		device.queue.submit([encoder.finish()]);

		// apply() is a no-op without a LUT — the target stays zero-initialized.
		const result = await captureTexturePixels(device, target, WIDTH, HEIGHT);
		expect(result.every((v) => v === 0)).toBe(true);

		source.destroy();
		target.destroy();
		pass.destroy();
	});
});

async function applyPass(pass: SoftProofPass): Promise<Uint8Array> {
	const source = createSourceTexture();
	const target = createTargetTexture();

	const encoder = device.createCommandEncoder();
	pass.apply(encoder, source.createView(), target.createView());
	device.queue.submit([encoder.finish()]);

	const pixels = await captureTexturePixels(device, target, WIDTH, HEIGHT);
	source.destroy();
	target.destroy();
	return pixels;
}

function createSourceTexture(): GPUTexture {
	const texture = device.createTexture({
		size: { width: WIDTH, height: HEIGHT },
		format: FORMAT,
		usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
	});
	device.queue.writeTexture(
		{ texture },
		SOURCE_PIXELS,
		{ bytesPerRow: WIDTH * 4 },
		{ width: WIDTH, height: HEIGHT },
	);
	return texture;
}

function createTargetTexture(): GPUTexture {
	return device.createTexture({
		size: { width: WIDTH, height: HEIGHT },
		format: FORMAT,
		usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
	});
}

/** RGBA size^3 LUT mapping every grid point to itself. */
function createIdentityLut(size: number): Uint8Array {
	const data = new Uint8Array(size ** 3 * 4);
	let i = 0;
	for (let b = 0; b < size; b++) {
		for (let g = 0; g < size; g++) {
			for (let r = 0; r < size; r++) {
				data[i++] = Math.round((r / (size - 1)) * 255);
				data[i++] = Math.round((g / (size - 1)) * 255);
				data[i++] = Math.round((b / (size - 1)) * 255);
				data[i++] = 255;
			}
		}
	}
	return data;
}

/** RGBA size^3 LUT mixing every grid point 50% toward its gray value. */
function createDesaturateLut(size: number): Uint8Array {
	const data = new Uint8Array(size ** 3 * 4);
	let i = 0;
	for (let b = 0; b < size; b++) {
		for (let g = 0; g < size; g++) {
			for (let r = 0; r < size; r++) {
				const rv = (r / (size - 1)) * 255;
				const gv = (g / (size - 1)) * 255;
				const bv = (b / (size - 1)) * 255;
				const gray = (rv + gv + bv) / 3;
				data[i++] = Math.round((rv + gray) / 2);
				data[i++] = Math.round((gv + gray) / 2);
				data[i++] = Math.round((bv + gray) / 2);
				data[i++] = 255;
			}
		}
	}
	return data;
}
