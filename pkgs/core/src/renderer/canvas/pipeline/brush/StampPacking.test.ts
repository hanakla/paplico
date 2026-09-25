import { describe, expect, it } from "vitest";
import {
	packStampPathIndex,
	replaceStampPathIndex,
	STAMP_META_INDEX_MASK,
	STAMP_TEXTURE_LAYER_SHIFT,
} from "./StampPacking";

describe("stamp path-index packing", () => {
	it("should preserve the meta index at and above the former 65,536 boundary", () => {
		const textureLayer = 37;
		for (const metaIndex of [65_535, 65_536, 65_537]) {
			const packed = packStampPathIndex(metaIndex, textureLayer);
			expect(packed & STAMP_META_INDEX_MASK).toBe(metaIndex);
			expect(packed >>> STAMP_TEXTURE_LAYER_SHIFT).toBe(textureLayer);
		}
	});

	it("should replace only the meta bits in a generated stamp", () => {
		const generated = packStampPathIndex(12, 9);
		const resident = replaceStampPathIndex(generated, 65_536);

		expect(resident & STAMP_META_INDEX_MASK).toBe(65_536);
		expect(resident >>> STAMP_TEXTURE_LAYER_SHIFT).toBe(9);
	});
});
