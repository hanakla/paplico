import "fake-indexeddb/auto";
import { normalizeBrushSettingsV2 } from "@/core/brush/migrate";
import type { BrushSettings } from "@/core/schema";
import type { PersistedBrushPreset } from "@/repos/brushPresets";
import { brushPresetsDB, webBrushPresetsRepo } from "./brushPresetsDB.web";
import { parsePapb, serializePapb } from "./papb";

function makeV1Preset(): PersistedBrushPreset {
	return {
		uid: "preset-v1",
		name: "V1 Preset",
		defaultSettings: {
			type: "scatter",
			size: 20,
			sizeByPressure: 0.5,
			opacity: 0.8,
			opacityByPressure: 0.3,
			randomSeed: 0,
			source: { kind: "file", fileUid: "tex-1" },
			spacing: 0.12,
			flow: 0.6,
			stampRotation: "none",
			rotationByTilt: 0,
			aspectRatioByTilt: 0,
			sizeBySpeed: 0,
			pooling: 0,
			poolingSizeRatio: 0.5,
		} as BrushSettings,
		textureName: "tex-1.png",
		textureMime: "image/png",
		textureHash: "sha256-tex-1",
		textureBin: new Uint8Array([1, 2, 3]),
		createdAt: 1,
		updatedAt: 2,
	};
}

describe("brush v2 papb roundtrip", () => {
	it("should convert an old .papb identically across a save/reload cycle", () => {
		const preset = makeV1Preset();

		const parsedOnce = parsePapb(serializePapb(preset));
		const convertedOnce = normalizeBrushSettingsV2(
			parsedOnce.brushPreset.defaultSettings,
		);
		expect(convertedOnce.version).toBe(2);
		expect(convertedOnce.engine).toBe("dab");

		// Save the still-v1 payload again and reload: the conversion must land
		// on the identical v2 value (double-migration idempotency).
		const parsedTwice = parsePapb(serializePapb(parsedOnce.brushPreset));
		const convertedTwice = normalizeBrushSettingsV2(
			parsedTwice.brushPreset.defaultSettings,
		);
		expect(convertedTwice).toEqual(convertedOnce);
		expect(normalizeBrushSettingsV2(convertedOnce)).toEqual(convertedOnce);
	});
});

describe("brush v2 IndexedDB roundtrip", () => {
	afterEach(async () => {
		await brushPresetsDB.brushPresets.clear();
	});

	it("should convert an old-format record identically across read/save/read", async () => {
		// Insert the old-format record directly, bypassing the repo.
		await brushPresetsDB.brushPresets.put(makeV1Preset());

		const first = await webBrushPresetsRepo.get("preset-v1");
		expect(first).not.toBeNull();
		if (first === null) throw new Error("unreachable");
		const convertedOnce = normalizeBrushSettingsV2(first.defaultSettings);
		expect(convertedOnce.version).toBe(2);

		await webBrushPresetsRepo.save(first);
		const second = await webBrushPresetsRepo.get("preset-v1");
		if (second === null) throw new Error("unreachable");
		const convertedTwice = normalizeBrushSettingsV2(second.defaultSettings);

		expect(convertedTwice).toEqual(convertedOnce);
	});
});
