import { encode } from "cbor-x";
import { describe, expect, it } from "vitest";
import type { BrushSettings } from "@/core/schema";
import type { PersistedBrushPreset } from "@/repos/brushPresets";
import { parsePapb, serializePapb } from "./papb";

describe("papb schemaVersion 1 migration", () => {
	it("should convert a version-1 file once and preserve it across a save/reload cycle", () => {
		const parsedOnce = parsePapb(v1Payload());
		expect(parsedOnce.schemaVersion).toBe(2);
		expect(parsedOnce.brushPreset.uid).toBe("preset-v1");
		expect(parsedOnce.brushPreset.defaultSettings.version).toBe(2);
		expect(parsedOnce.brushPreset.defaultSettings.engine).toBe("dab");

		// Saving the migrated preset writes version 2, which reads back as is.
		const parsedTwice = parsePapb(serializePapb(parsedOnce.brushPreset));
		expect(parsedTwice.brushPreset).toEqual(parsedOnce.brushPreset);
	});

	it("should preserve stored v2 settings (curves included) across a roundtrip", () => {
		const preset = makeV2Preset();
		const parsed = parsePapb(serializePapb(preset));
		expect(parsed.brushPreset.defaultSettings.version).toBe(2);
		expect(parsed.brushPreset.defaultSettings.properties.flow?.curves).toEqual(
			preset.defaultSettings.properties.flow?.curves,
		);
	});
});

function v1Payload(): Uint8Array {
	return encode({
		schemaVersion: 1,
		brushPreset: {
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
			},
			textureName: "tex-1.png",
			textureMime: "image/png",
			textureHash: "sha256-tex-1",
			textureBin: new Uint8Array([1, 2, 3]),
			createdAt: 1,
			updatedAt: 2,
		},
	}) as Uint8Array;
}

function makeV2Preset(): PersistedBrushPreset {
	const defaultSettings: BrushSettings = {
		version: 2,
		engine: "dab",
		strokeOpacity: 1,
		paintMode: "buildup",
		properties: {
			flow: {
				base: 0.5,
				curves: [
					{
						input: "strokeT",
						points: [
							[0, 0.4],
							[0.5, -0.2],
							[1, 0.4],
						],
					},
				],
			},
		},
		tip: {
			kind: "image",
			sources: [{ kind: "file", fileUid: "tex-1" }],
			selection: "random",
			angleMode: "fixed",
		},
		randomSeed: 0,
	};
	return {
		uid: "preset-v2",
		name: "V2 Preset",
		defaultSettings,
		textureName: "tex-1.png",
		textureMime: "image/png",
		textureHash: "sha256-tex-1",
		textureBin: new Uint8Array([1, 2, 3]),
		createdAt: 1,
		updatedAt: 2,
	};
}
