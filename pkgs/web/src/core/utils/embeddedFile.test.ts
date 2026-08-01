import { describe, expect, it } from "vitest";
import { normalizeBrushTextureMaskInPlace } from "./embeddedFile";

describe("normalizeBrushTextureMaskInPlace", () => {
	it("uses alpha mask when source image contains transparency", () => {
		const pixels = new Uint8ClampedArray([
			0,
			0,
			0,
			255, // opaque black
			255,
			255,
			255,
			0, // transparent white
		]);

		normalizeBrushTextureMaskInPlace(pixels);

		expect(Array.from(pixels)).toEqual([
			255,
			255,
			255,
			255, // opaque black -> visible mask
			0,
			0,
			0,
			255, // transparent pixel stays invisible in luminance channel
		]);
	});

	it("uses luminance mask when image is fully opaque", () => {
		const pixels = new Uint8ClampedArray([
			10,
			20,
			30,
			255, // luminance = 20
			100,
			50,
			0,
			255, // luminance = 50
		]);

		normalizeBrushTextureMaskInPlace(pixels);

		expect(Array.from(pixels)).toEqual([20, 20, 20, 255, 50, 50, 50, 255]);
	});

	it("inverts luminance for opaque black-on-white brush images", () => {
		// 2x2 image:
		// [white, white]
		// [white, black]
		const pixels = new Uint8ClampedArray([
			255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 0, 0, 0, 255,
		]);

		normalizeBrushTextureMaskInPlace(pixels, 2, 2);

		expect(Array.from(pixels)).toEqual([
			0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255, 255,
		]);
	});
});
