import { describe, expect, it } from "vitest";
import { BUILTIN_BRUSH_IDS } from "../../../schema";
import { readV1BrushSettings } from "./readV1";

describe("readV1BrushSettings", () => {
	describe("legacy flat shape (no `type` field)", () => {
		it("should map the svg texture to a geometric stroke brush", () => {
			const result = readV1BrushSettings({
				textureFileUid: BUILTIN_BRUSH_IDS.svg,
				size: 4,
			});

			expect(result.type).toBe("stroke");
			expect(result.size).toBe(4);
		});

		it("should map renderMode 'ribbon' to a pattern brush", () => {
			const result = readV1BrushSettings({
				textureFileUid: "tex-a",
				renderMode: "ribbon",
				ribbonStretch: 0.5,
				ribbonOffset: 0.25,
			});

			expect(result.type).toBe("pattern");
			if (result.type !== "pattern") throw new Error("expected pattern");
			expect(result.source).toEqual({ kind: "file", fileUid: "tex-a" });
			// tileScale = 1 + ribbonStretch
			expect(result.tileScale).toBe(1.5);
			expect(result.uvOffset).toBe(0.25);
		});

		it("should map a plain textured brush to a scatter brush", () => {
			const result = readV1BrushSettings({
				textureFileUid: "tex-b",
				spacing: 0.3,
			});

			expect(result.type).toBe("scatter");
			if (result.type !== "scatter") throw new Error("expected scatter");
			expect(result.source).toEqual({ kind: "file", fileUid: "tex-b" });
			expect(result.spacing).toBe(0.3);
		});

		it("should convert legacy scatterTextureUids into scatterSources", () => {
			const result = readV1BrushSettings({
				textureFileUid: "tex-main",
				scatterTextureUids: ["tex-1", "tex-2"],
				startTextureUid: "tex-start",
				endTextureUid: "tex-end",
			});

			if (result.type !== "scatter") throw new Error("expected scatter");
			expect(result.scatterSources).toEqual([
				{ kind: "file", fileUid: "tex-1" },
				{ kind: "file", fileUid: "tex-2" },
			]);
			expect(result.startSource).toEqual({
				kind: "file",
				fileUid: "tex-start",
			});
			expect(result.endSource).toEqual({ kind: "file", fileUid: "tex-end" });
		});

		it("should discard the removed vectorBrushSourceId field", () => {
			const result = readV1BrushSettings({
				textureFileUid: "tex-c",
				vectorBrushSourceId: "should-be-dropped",
			});

			expect(result).not.toHaveProperty("vectorBrushSourceId");
		});
	});

	describe("union shape (with `type` field)", () => {
		it("should pass through a scatter brush", () => {
			const result = readV1BrushSettings({
				type: "scatter",
				source: { kind: "file", fileUid: "tex-d" },
				size: 12,
				spacing: 0.1,
			});

			expect(result.type).toBe("scatter");
			if (result.type !== "scatter") throw new Error("expected scatter");
			expect(result.source).toEqual({ kind: "file", fileUid: "tex-d" });
			expect(result.size).toBe(12);
		});

		it("should pass through an art brush", () => {
			const result = readV1BrushSettings({
				type: "art",
				source: { kind: "file", fileUid: "tex-art" },
				flow: 0.8,
				flip: true,
			});

			expect(result.type).toBe("art");
			if (result.type !== "art") throw new Error("expected art");
			expect(result.source).toEqual({ kind: "file", fileUid: "tex-art" });
			expect(result.flow).toBe(0.8);
			expect(result.flip).toBe(true);
		});

		it("should pass through a pattern brush", () => {
			const result = readV1BrushSettings({
				type: "pattern",
				source: { kind: "file", fileUid: "tex-pattern" },
				tileScale: 1.5,
				tileSpacing: 0.2,
			});

			expect(result.type).toBe("pattern");
			if (result.type !== "pattern") throw new Error("expected pattern");
			expect(result.source).toEqual({ kind: "file", fileUid: "tex-pattern" });
			expect(result.tileScale).toBe(1.5);
			expect(result.tileSpacing).toBe(0.2);
		});

		it("should pass through a calligraphy brush", () => {
			const result = readV1BrushSettings({
				type: "calligraphy",
				nibAngle: 30,
				roundness: 0.6,
				angleMode: "tangent",
			});

			expect(result.type).toBe("calligraphy");
			if (result.type !== "calligraphy")
				throw new Error("expected calligraphy");
			expect(result.nibAngle).toBe(30);
			expect(result.roundness).toBe(0.6);
			expect(result.angleMode).toBe("tangent");
		});

		it("should preserve a def source on scatter/art/pattern brushes", () => {
			for (const type of ["scatter", "art", "pattern"] as const) {
				const result = readV1BrushSettings({
					type,
					source: { kind: "def", defId: "def-1" },
				});
				if (result.type !== type) throw new Error(`expected ${type}`);
				expect(result.source).toEqual({ kind: "def", defId: "def-1" });
			}
		});

		it("should ignore a malformed source and fall back to the softCircle texture", () => {
			const result = readV1BrushSettings({
				type: "scatter",
				source: { kind: "def" }, // missing defId
			});
			if (result.type !== "scatter") throw new Error("expected scatter");
			expect(result.source).toEqual({
				kind: "file",
				fileUid: BUILTIN_BRUSH_IDS.softCircle,
			});
		});
	});

	describe("stroking normalization", () => {
		it("should default lineCap/lineJoin/miterLimit for an empty stroking object", () => {
			const result = readV1BrushSettings({ type: "stroke", stroking: {} });
			if (result.type !== "stroke") throw new Error("expected stroke");
			expect(result.stroking).toEqual({
				lineCap: "round",
				lineJoin: "round",
				miterLimit: 4,
			});
		});

		it("should preserve valid lineCap/lineJoin/miterLimit values", () => {
			const result = readV1BrushSettings({
				type: "stroke",
				stroking: { lineCap: "square", lineJoin: "bevel", miterLimit: 8 },
			});
			if (result.type !== "stroke") throw new Error("expected stroke");
			expect(result.stroking).toEqual({
				lineCap: "square",
				lineJoin: "bevel",
				miterLimit: 8,
			});
		});

		it("should fall back to 'round' for invalid lineCap/lineJoin values", () => {
			const result = readV1BrushSettings({
				type: "stroke",
				stroking: { lineCap: "not-a-cap", lineJoin: "not-a-join" },
			});
			if (result.type !== "stroke") throw new Error("expected stroke");
			expect(result.stroking?.lineCap).toBe("round");
			expect(result.stroking?.lineJoin).toBe("round");
		});

		it("should preserve a valid dashArray/dashOffset and drop an invalid dashArray", () => {
			const valid = readV1BrushSettings({
				type: "stroke",
				stroking: { dashArray: [2, 4], dashOffset: 1 },
			});
			if (valid.type !== "stroke") throw new Error("expected stroke");
			expect(valid.stroking?.dashArray).toEqual([2, 4]);
			expect(valid.stroking?.dashOffset).toBe(1);

			const invalid = readV1BrushSettings({
				type: "stroke",
				stroking: { dashArray: ["not", "numbers"] },
			});
			if (invalid.type !== "stroke") throw new Error("expected stroke");
			expect(invalid.stroking?.dashArray).toBeUndefined();
		});

		it("should return undefined stroking when no stroking object is present", () => {
			const result = readV1BrushSettings({ type: "stroke" });
			if (result.type !== "stroke") throw new Error("expected stroke");
			expect(result.stroking).toBeUndefined();
		});
	});
});

describe("readV1BrushSettings — wetInk (Task#22)", () => {
	it("should default wetInk to undefined for legacy data", () => {
		const result = readV1BrushSettings({ type: "scatter", size: 4 });
		expect(result.type).toBe("scatter");
		if (result.type !== "scatter") throw new Error("expected scatter");
		expect(result.wetInk).toBeUndefined();
	});

	it("should read wetInk on scatter brushes when provided", () => {
		const result = readV1BrushSettings({
			type: "scatter",
			size: 4,
			wetInk: {
				enabled: true,
				bleedWidth: 0.3,
				wetness: 0.5,
			},
		});
		expect(result.type).toBe("scatter");
		if (result.type !== "scatter") throw new Error("expected scatter");
		expect(result.wetInk?.enabled).toBe(true);
		expect(result.wetInk?.bleedWidth).toBe(0.3);
		expect(result.wetInk?.wetness).toBe(0.5);
		// Missing fields fall back to documented defaults.
		expect(result.wetInk?.edgeDarkening).toBe(0.4);
		expect(result.wetInk?.diffusion).toBe(0.35);
		expect(result.wetInk?.pigmentLoad).toBe(0.85);
		expect(result.wetInk?.absorption).toBe(0.35);
		expect(result.wetInk?.granulation).toBe(0.25);
		expect(result.wetInk?.pickupUnderlyingColor).toBe(false);
		expect(result.wetInk?.pickupStrength).toBe(0.35);
	});

	it("should read wetInk on calligraphy brushes when provided", () => {
		const result = readV1BrushSettings({
			type: "calligraphy",
			size: 8,
			roundness: 0.5,
			angleMode: "tangent",
			wetInk: { enabled: true, diffusion: 0.25 },
		});
		expect(result.type).toBe("calligraphy");
		if (result.type !== "calligraphy") throw new Error("expected calligraphy");
		expect(result.wetInk?.enabled).toBe(true);
		expect(result.wetInk?.diffusion).toBe(0.25);
	});

	it("should drop wetInk objects without `enabled`", () => {
		const result = readV1BrushSettings({
			type: "scatter",
			size: 4,
			wetInk: { bleedWidth: 0.5 },
		});
		expect(result.type).toBe("scatter");
		if (result.type !== "scatter") throw new Error("expected scatter");
		expect(result.wetInk).toBeUndefined();
	});
});

describe("readV1BrushSettings — v2 awareness", () => {
	it("should keep the v1 legacy-flat path unchanged for non-v2 input", () => {
		const result = readV1BrushSettings({ size: 8 });
		expect(result.type).toBe("scatter");
		expect(result.size).toBe(8);
	});
});
