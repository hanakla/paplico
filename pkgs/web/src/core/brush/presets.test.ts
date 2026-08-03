import { describe, expect, it } from "vitest";
import { type BrushPreset, hasWetInk } from "../schema";
import { normalizeBrushSettings } from "./normalize";
import { createBuiltinBrushPresets } from "./presets";

const WET_INK_PRESET_UIDS = [
	"builtin-brush-watercolor",
	"builtin-brush-dry-brush",
	"builtin-brush-bleed-watercolor",
];

describe("createBuiltinBrushPresets", () => {
	it("should give every preset a unique uid", () => {
		const uids = createBuiltinBrushPresets().map((preset) => preset.uid);
		expect(new Set(uids).size).toBe(uids.length);
	});

	it("should author settings that survive normalizeBrushSettings unchanged", () => {
		for (const preset of createBuiltinBrushPresets()) {
			expect(normalizeBrushSettings(preset.settings)).toEqual(preset.settings);
		}
	});

	it("should enable wet ink on the watercolor-family presets", () => {
		const presets = createBuiltinBrushPresets();
		for (const uid of WET_INK_PRESET_UIDS) {
			expect(hasWetInk(findPreset(presets, uid).settings)).toBe(true);
		}
	});

	it("should pick up underlying color on the bleed watercolor preset", () => {
		const preset = findPreset(
			createBuiltinBrushPresets(),
			"builtin-brush-bleed-watercolor",
		);
		if (preset.settings.type !== "scatter") throw new Error("expected scatter");
		expect(preset.settings.wetInk?.pickupUnderlyingColor).toBe(true);
	});

	it("should assign a category to every preset", () => {
		for (const preset of createBuiltinBrushPresets()) {
			expect(preset.category).toBeDefined();
		}
	});

	it("should set speed→size influence to 0.5 on every stamp-based preset", () => {
		for (const preset of createBuiltinBrushPresets()) {
			const settings = preset.settings;
			if (settings.type !== "scatter" && settings.type !== "calligraphy")
				continue;
			expect(settings.sizeBySpeed, preset.uid).toBe(0.5);
		}
	});
});

function findPreset(presets: BrushPreset[], uid: string): BrushPreset {
	const preset = presets.find((p) => p.uid === uid);
	if (!preset) throw new Error(`missing builtin preset: ${uid}`);
	return preset;
}
