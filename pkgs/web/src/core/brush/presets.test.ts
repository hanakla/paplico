import { describe, expect, it } from "vitest";
import type { BrushPreset } from "../schema";
import { normalizeBrushSettingsV2 } from "./migrate";
import {
	BUILTIN_PRESET_CATEGORY_ORDER,
	createBuiltinBrushPresets,
} from "./presets";

const BLUR_PRESET_UIDS = ["builtin-brush-blur", "builtin-brush-scatter-blur"];

const WET_PRESET_UIDS = [
	"builtin-brush-watercolor",
	"builtin-brush-dry-brush",
	"builtin-brush-bleed-watercolor",
];

describe("createBuiltinBrushPresets", () => {
	// Selecting a preset hands the whole brush to the tool, which only takes
	// v2. A preset still in the v1 shape would be read as a partial edit,
	// apply almost nothing, and leave the brush looking unchanged.
	it("should be authored as v2", () => {
		for (const preset of createBuiltinBrushPresets()) {
			expect(preset.settings.version, preset.uid).toBe(2);
		}
	});

	it("should give every preset a unique uid", () => {
		const uids = createBuiltinBrushPresets().map((preset) => preset.uid);
		expect(new Set(uids).size).toBe(uids.length);
	});

	it("should author settings that survive normalization unchanged", () => {
		for (const preset of createBuiltinBrushPresets()) {
			expect(normalizeBrushSettingsV2(preset.settings), preset.uid).toEqual(
				preset.settings,
			);
		}
	});

	// A blur brush carries no paint of its own: every dab takes the colour
	// already on the layer, averaged over its footprint. Anything above zero
	// in the paint amount would tint what it is meant to smear.
	it("should paint no colour of its own on the blur presets", () => {
		const presets = createBuiltinBrushPresets();
		for (const uid of BLUR_PRESET_UIDS) {
			const settings = findPreset(presets, uid).settings;
			expect(settings.properties.colorRate?.base, uid).toBe(0);
			expect(settings.properties.alphaRate?.base, uid).toBe(0);
			expect(settings.mixing?.enabled, uid).toBe(true);
		}
	});

	it("should displace its texels on the scattering blur preset", () => {
		const settings = findPreset(
			createBuiltinBrushPresets(),
			"builtin-brush-scatter-blur",
		).settings;
		expect(settings.wet?.scatter ?? 0).toBeGreaterThan(0);
	});

	it("should put every preset on a shelf the panel actually shows", () => {
		for (const preset of createBuiltinBrushPresets()) {
			expect(BUILTIN_PRESET_CATEGORY_ORDER, preset.uid).toContain(
				preset.category,
			);
		}
	});

	it("should run the wet layer on the watercolor-family presets", () => {
		const presets = createBuiltinBrushPresets();
		for (const uid of WET_PRESET_UIDS) {
			const settings = findPreset(presets, uid).settings;
			expect(settings.wet?.enabled, uid).toBe(true);
			// Wet strokes composite as a single wash; the normalizer enforces it.
			expect(settings.paintMode, uid).toBe("wash");
		}
	});

	it("should pick up the layer below on the bleed watercolor preset", () => {
		const settings = findPreset(
			createBuiltinBrushPresets(),
			"builtin-brush-bleed-watercolor",
		).settings;

		expect(settings.mixing?.enabled).toBe(true);
	});

	it("should assign a category to every preset", () => {
		for (const preset of createBuiltinBrushPresets()) {
			expect(preset.category).toBeDefined();
		}
	});

	it("should set speed→size influence to 0.5 on every stamp-based preset", () => {
		for (const preset of createBuiltinBrushPresets()) {
			if (preset.settings.engine !== "dab") continue;
			const speedCurve = preset.settings.properties.size?.curves?.find(
				(curve) => curve.input === "speedFine",
			);
			expect(speedCurve?.points.at(-1), preset.uid).toEqual([1, -0.5]);
		}
	});
});

function findPreset(presets: BrushPreset[], uid: string): BrushPreset {
	const preset = presets.find((p) => p.uid === uid);
	if (!preset) throw new Error(`missing builtin preset: ${uid}`);
	return preset;
}
