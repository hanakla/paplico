import { describe, expect, it } from "vitest";
import { type BrushSettings, BUILTIN_BRUSH_IDS } from "../schema";
import {
	type DefSourceResolver,
	resolveBrushTextureUid,
	resolveOptionalSourceUid,
	resolveScatterSourceUids,
	withTextureFileUid,
} from "./brushSource";
import { normalizeBrushSettings } from "./normalize";

describe("withTextureFileUid", () => {
	it("should re-point the source for a scatter brush", () => {
		const settings = normalizeBrushSettings({
			type: "scatter",
			source: { kind: "file", fileUid: "old" },
		});
		const result = withTextureFileUid(settings, "new");
		if (result.type !== "scatter") throw new Error("expected scatter");
		expect(result.source).toEqual({ kind: "file", fileUid: "new" });
	});

	it("should re-point the source for an art brush", () => {
		const settings = normalizeBrushSettings({
			type: "art",
			source: { kind: "file", fileUid: "old" },
		});
		const result = withTextureFileUid(settings, "new");
		if (result.type !== "art") throw new Error("expected art");
		expect(result.source).toEqual({ kind: "file", fileUid: "new" });
	});

	it("should re-point the source for a pattern brush", () => {
		const settings = normalizeBrushSettings({
			type: "pattern",
			source: { kind: "file", fileUid: "old" },
		});
		const result = withTextureFileUid(settings, "new");
		if (result.type !== "pattern") throw new Error("expected pattern");
		expect(result.source).toEqual({ kind: "file", fileUid: "new" });
	});

	it("should return stroke brushes unchanged (no texture source)", () => {
		const settings = normalizeBrushSettings({ type: "stroke" });
		const result = withTextureFileUid(settings, "new");
		expect(result).toEqual(settings);
	});

	it("should return calligraphy brushes unchanged (no texture source)", () => {
		const settings = normalizeBrushSettings({ type: "calligraphy" });
		const result = withTextureFileUid(settings, "new");
		expect(result).toEqual(settings);
	});

	it("should return legacy flat records unchanged rather than undefined", () => {
		// Simulates unnormalized data reaching this function at runtime (e.g.
		// from an IndexedDB record written before the BrushSettings union was
		// introduced). The `type` discriminator is absent, so the switch falls
		// through every case — this must not silently return `undefined`.
		const legacy = {
			textureFileUid: "old",
			size: 10,
			opacity: 1,
		} as unknown as BrushSettings;

		const result = withTextureFileUid(legacy, "new");
		expect(result).toBe(legacy);
	});
});

describe("resolveBrushTextureUid", () => {
	it("should return null for a stroke brush", () => {
		const settings = normalizeBrushSettings({ type: "stroke" });
		expect(resolveBrushTextureUid(settings)).toBeNull();
	});

	it("should return the source file uid for scatter/art/pattern brushes", () => {
		for (const type of ["scatter", "art", "pattern"] as const) {
			const settings = normalizeBrushSettings({
				type,
				source: { kind: "file", fileUid: `tex-${type}` },
			});
			expect(resolveBrushTextureUid(settings)).toBe(`tex-${type}`);
		}
	});

	it("should return the hard-circle texture for a calligraphy brush", () => {
		const settings = normalizeBrushSettings({ type: "calligraphy" });
		expect(resolveBrushTextureUid(settings)).toBe(BUILTIN_BRUSH_IDS.hardCircle);
	});

	it("should resolve a def source via the provided resolver", () => {
		const settings = normalizeBrushSettings({
			type: "scatter",
			source: { kind: "def", defId: "def-1" },
		});
		const resolver: DefSourceResolver = {
			resolveDefTextureUid: (defId) =>
				defId === "def-1" ? "def:def-1:rasterized" : null,
		};
		expect(resolveBrushTextureUid(settings, resolver)).toBe(
			"def:def-1:rasterized",
		);
	});

	it("should fall back to the hard-circle texture when no resolver is supplied for a def source", () => {
		const settings = normalizeBrushSettings({
			type: "scatter",
			source: { kind: "def", defId: "def-1" },
		});
		expect(resolveBrushTextureUid(settings)).toBe(BUILTIN_BRUSH_IDS.hardCircle);
	});

	it("should fall back to the hard-circle texture when the resolver cannot resolve the def", () => {
		const settings = normalizeBrushSettings({
			type: "scatter",
			source: { kind: "def", defId: "missing-def" },
		});
		const resolver: DefSourceResolver = {
			resolveDefTextureUid: () => null,
		};
		expect(resolveBrushTextureUid(settings, resolver)).toBe(
			BUILTIN_BRUSH_IDS.hardCircle,
		);
	});
});

describe("resolveScatterSourceUids", () => {
	it("should resolve each source to a texture uid", () => {
		const result = resolveScatterSourceUids([
			{ kind: "file", fileUid: "a" },
			{ kind: "file", fileUid: "b" },
		]);
		expect(result).toEqual(["a", "b"]);
	});

	it("should return an empty array when sources is undefined", () => {
		expect(resolveScatterSourceUids(undefined)).toEqual([]);
	});
});

describe("resolveOptionalSourceUid", () => {
	it("should resolve a source to a texture uid", () => {
		expect(resolveOptionalSourceUid({ kind: "file", fileUid: "a" })).toBe("a");
	});

	it("should return undefined when source is undefined", () => {
		expect(resolveOptionalSourceUid(undefined)).toBeUndefined();
	});
});
