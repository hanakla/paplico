import { encode } from "cbor-x";
import { describe, expect, it } from "vitest";
import { PAPB_SCHEMA_VERSION, parsePapb, serializePapb } from "@/infra/papb";
import { createPersistedBrushPreset } from "@/repos/brushPresets";

describe("papb codec", () => {
	it("should preserve schemaVersion, settings, and texture bytes across roundtrip", () => {
		const preset = createPersistedBrushPreset({
			uid: "brush-preset-roundtrip",
			name: "Graphite",
			defaultSettings: {
				type: "scatter",
				source: { kind: "file", fileUid: "builtin-brush-soft-circle" },
				randomSeed: 0,
				size: 24,
				sizeByPressure: 0.3,
				opacity: 0.8,
				opacityByPressure: 0.4,
				spacing: 0.08,
				flow: 0.7,
				stampRotation: "random",
				rotationByTilt: 0.2,
				aspectRatioByTilt: 0.1,
				sizeBySpeed: 0.15,
				pooling: 0.25,
				poolingSizeRatio: 0.6,
			},
			file: {
				uid: "file-source",
				name: "graphite.png",
				type: "image/png",
				hash: "texture-hash",
				bin: Uint8Array.from([1, 4, 9, 16]),
			},
			sourceBuiltinUid: "builtin-brush-pencil",
			createdAt: 123,
			updatedAt: 456,
		});

		const payload = parsePapb(serializePapb(preset));

		expect(payload.schemaVersion).toBe(PAPB_SCHEMA_VERSION);
		expect(payload.brushPreset).toEqual(preset);
	});

	it("should reject unsupported schema versions", () => {
		const invalidPayload = encode({
			schemaVersion: PAPB_SCHEMA_VERSION + 1,
			brushPreset: createPersistedBrushPreset({
				name: "Broken",
				defaultSettings: {
					type: "scatter",
					source: { kind: "file", fileUid: "builtin-brush-soft-circle" },
					randomSeed: 0,
					size: 10,
					sizeByPressure: 0.5,
					opacity: 1,
					opacityByPressure: 0.3,
					spacing: 0.1,
					flow: 1,
					stampRotation: "none",
					rotationByTilt: 0,
					aspectRatioByTilt: 0,
					sizeBySpeed: 0,
					pooling: 0,
					poolingSizeRatio: 0.5,
				},
				file: {
					uid: "file-source",
					name: "broken.png",
					type: "image/png",
					hash: "broken-hash",
					bin: Uint8Array.from([0]),
				},
			}),
		}) as Uint8Array;

		expect(() => parsePapb(invalidPayload)).toThrow(
			"Unsupported papb schema version",
		);
	});
});
