import { describe, expect, it } from "vitest";
import { type BrushPreset, type BrushSettingsV2, hasWetInk } from "../schema";
import { normalizeBrushSettingsV2 } from "./migrate";
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

	it("should author settings that survive normalization unchanged", () => {
		for (const preset of createBuiltinBrushPresets()) {
			const normalized = isV2(preset.settings)
				? normalizeBrushSettingsV2(preset.settings)
				: normalizeBrushSettings(preset.settings);
			expect(normalized, preset.uid).toEqual(preset.settings);
		}
	});

	it("should enable wet ink on the watercolor-family presets", () => {
		const presets = createBuiltinBrushPresets();
		for (const uid of WET_INK_PRESET_UIDS) {
			expect(hasWetInk(asV1Settings(findPreset(presets, uid).settings))).toBe(
				true,
			);
		}
	});

	it("should pick up underlying color on the bleed watercolor preset", () => {
		const preset = findPreset(
			createBuiltinBrushPresets(),
			"builtin-brush-bleed-watercolor",
		);
		const settings = asV1Settings(preset.settings);
		if (settings.type !== "scatter") throw new Error("expected scatter");
		expect(settings.wetInk?.pickupUnderlyingColor).toBe(true);
	});

	it("should assign a category to every preset", () => {
		for (const preset of createBuiltinBrushPresets()) {
			expect(preset.category).toBeDefined();
		}
	});

	it("should set speed→size influence to 0.5 on every stamp-based preset", () => {
		for (const preset of createBuiltinBrushPresets()) {
			if (isV2(preset.settings)) {
				if (preset.settings.engine !== "dab") continue;
				const speedCurve = preset.settings.properties.size?.curves?.find(
					(curve) => curve.input === "speedFine",
				);
				expect(speedCurve?.points.at(-1), preset.uid).toEqual([1, -0.5]);
				continue;
			}

			const settings = asV1Settings(preset.settings);
			if (settings.type !== "scatter" && settings.type !== "calligraphy")
				continue;
			expect(settings.sizeBySpeed, preset.uid).toBe(0.5);
		}
	});
});

function isV2(settings: BrushPreset["settings"]): settings is BrushSettingsV2 {
	return "version" in settings && settings.version === 2;
}

function findPreset(presets: BrushPreset[], uid: string): BrushPreset {
	const preset = presets.find((p) => p.uid === uid);
	if (!preset) throw new Error(`missing builtin preset: ${uid}`);
	return preset;
}

function asV1Settings(
	settings: ReturnType<typeof createBuiltinBrushPresets>[number]["settings"],
) {
	if ("version" in settings) throw new Error("expected v1 settings");
	return settings;
}
