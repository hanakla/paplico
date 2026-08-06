import "fake-indexeddb/auto";
import { encode } from "cbor-x";
import { normalizeBrushSettingsV2 } from "@/core/brush/migrate";
import type { BrushSettingsV2 } from "@/core/schema";
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
		} as unknown as BrushSettingsV2,
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

describe("papb v2 storage switchover", () => {
	function makeV2Preset(): PersistedBrushPreset {
		return {
			...makeV1Preset(),
			uid: "preset-v2",
			name: "V2 Preset",
			defaultSettings: normalizeBrushSettingsV2({
				version: 2,
				engine: "dab",
				strokeOpacity: 1,
				paintMode: "buildup",
				properties: {
					size: { base: 20 },
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
			}) as unknown as PersistedBrushPreset["defaultSettings"],
		};
	}

	it("should write schemaVersion 2 and still accept version-1 payloads", () => {
		const encoded = serializePapb(makeV1Preset());
		expect(parsePapb(encoded).schemaVersion).toBe(2);

		const legacyPayload = encode({
			schemaVersion: 1,
			brushPreset: makeV1Preset(),
		}) as Uint8Array;
		expect(parsePapb(legacyPayload).brushPreset.uid).toBe("preset-v1");
	});

	it("should preserve stored v2 settings (curves included) across a papb roundtrip", () => {
		const preset = makeV2Preset();
		const parsed = parsePapb(serializePapb(preset));
		const settings = parsed.brushPreset.defaultSettings as unknown as {
			version?: number;
			properties: {
				flow?: { curves?: { input: string; points: number[][] }[] };
			};
		};
		expect(settings.version).toBe(2);
		expect(settings.properties.flow?.curves?.[0].input).toBe("strokeT");
		expect(settings.properties.flow?.curves?.[0].points.length).toBe(3);
	});
});

describe("IndexedDB v2 storage switchover", () => {
	afterEach(async () => {
		await brushPresetsDB.brushPresets.clear();
	});

	it("should preserve stored v2 settings across read/save/read", async () => {
		const v2Settings = normalizeBrushSettingsV2({
			version: 2,
			engine: "dab",
			strokeOpacity: 1,
			paintMode: "buildup",
			properties: {
				flow: {
					base: 0.5,
					curves: [
						{
							input: "fade",
							points: [
								[0, 0],
								[1, -0.5],
							],
						},
					],
				},
			},
			randomSeed: 0,
		});
		await brushPresetsDB.brushPresets.put({
			...makeV1Preset(),
			uid: "preset-v2-db",
			defaultSettings:
				v2Settings as unknown as PersistedBrushPreset["defaultSettings"],
		});

		const first = await webBrushPresetsRepo.get("preset-v2-db");
		if (first === null) throw new Error("unreachable");
		expect(first.defaultSettings).toEqual(v2Settings);

		await webBrushPresetsRepo.save(first);
		const second = await webBrushPresetsRepo.get("preset-v2-db");
		if (second === null) throw new Error("unreachable");
		expect(second.defaultSettings).toEqual(v2Settings);
	});
});
