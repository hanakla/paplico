import { describe, expect, it } from "vitest";
import { type BrushSettingsV2, BUILTIN_BRUSH_IDS } from "../schema";
import {
	type DefSourceResolver,
	resolveBrushTextureUid,
	resolveOptionalSourceUid,
	resolveScatterSourceUids,
	withTextureFileUid,
} from "./brushSource";
import { normalizeBrushSettingsV2 } from "./migrate";

describe("withTextureFileUid", () => {
	it("should re-point the source of an image tip", () => {
		const result = withTextureFileUid(imageTipBrush("old"), "new");
		if (result.tip?.kind !== "image") throw new Error("expected an image tip");
		expect(result.tip.sources[0]).toEqual({ kind: "file", fileUid: "new" });
	});

	it("should re-point the source of a ribbon brush", () => {
		const result = withTextureFileUid(ribbonBrush("old"), "new");
		expect(result.ribbon?.source).toEqual({ kind: "file", fileUid: "new" });
	});

	it("should return a geometric brush unchanged (it samples no texture)", () => {
		const settings = geometricBrush();
		expect(withTextureFileUid(settings, "new")).toBe(settings);
	});

	it("should return a procedural tip unchanged (it samples no texture)", () => {
		const settings = proceduralTipBrush();
		expect(withTextureFileUid(settings, "new")).toBe(settings);
	});
});

describe("resolveBrushTextureUid", () => {
	it("should return null for a geometric brush", () => {
		expect(resolveBrushTextureUid(geometricBrush())).toBeNull();
	});

	it("should return the file uid of an image tip", () => {
		expect(resolveBrushTextureUid(imageTipBrush("tex-tip"))).toBe("tex-tip");
	});

	it("should return the file uid of a ribbon source", () => {
		expect(resolveBrushTextureUid(ribbonBrush("tex-ribbon"))).toBe(
			"tex-ribbon",
		);
	});

	// A procedural tip draws its own shape, but the stamp pipeline still needs
	// something bound to keep the bind group valid.
	it("should return the hard-circle texture for a procedural tip", () => {
		expect(resolveBrushTextureUid(proceduralTipBrush())).toBe(
			BUILTIN_BRUSH_IDS.hardCircle,
		);
	});

	it("should resolve a def source via the provided resolver", () => {
		const resolver: DefSourceResolver = {
			resolveDefTextureUid: (defId) =>
				defId === "def-1" ? "def:def-1:rasterized" : null,
		};
		expect(resolveBrushTextureUid(defTipBrush("def-1"), resolver)).toBe(
			"def:def-1:rasterized",
		);
	});

	it("should fall back to the hard-circle texture when no resolver is supplied for a def source", () => {
		expect(resolveBrushTextureUid(defTipBrush("def-1"))).toBe(
			BUILTIN_BRUSH_IDS.hardCircle,
		);
	});

	it("should fall back to the hard-circle texture when the resolver cannot resolve the def", () => {
		const resolver: DefSourceResolver = { resolveDefTextureUid: () => null };
		expect(resolveBrushTextureUid(defTipBrush("missing-def"), resolver)).toBe(
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

function dabBrush(tip: BrushSettingsV2["tip"]): BrushSettingsV2 {
	return normalizeBrushSettingsV2({
		version: 2,
		engine: "dab",
		strokeOpacity: 1,
		paintMode: "buildup",
		properties: { size: { base: 10 } },
		tip,
		randomSeed: 0,
	});
}

function imageTipBrush(fileUid: string): BrushSettingsV2 {
	return dabBrush({
		kind: "image",
		sources: [{ kind: "file", fileUid }],
		selection: "random",
		angleMode: "fixed",
	});
}

function defTipBrush(defId: string): BrushSettingsV2 {
	return dabBrush({
		kind: "image",
		sources: [{ kind: "def", defId }],
		selection: "random",
		angleMode: "fixed",
	});
}

function proceduralTipBrush(): BrushSettingsV2 {
	return dabBrush({ kind: "procedural", hardness: 1, angleMode: "fixed" });
}

function ribbonBrush(fileUid: string): BrushSettingsV2 {
	return normalizeBrushSettingsV2({
		version: 2,
		engine: "ribbon",
		strokeOpacity: 1,
		paintMode: "buildup",
		properties: { size: { base: 10 } },
		ribbon: {
			source: { kind: "file", fileUid },
			uvMode: "repeat",
			tileScale: 1,
			tileSpacing: 0,
		},
		randomSeed: 0,
	});
}

function geometricBrush(): BrushSettingsV2 {
	return normalizeBrushSettingsV2({
		version: 2,
		engine: "geometric",
		strokeOpacity: 1,
		paintMode: "buildup",
		properties: { size: { base: 10 } },
		randomSeed: 0,
	});
}
