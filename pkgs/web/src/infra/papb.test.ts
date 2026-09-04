import { encode } from "cbor-x";
import { describe, expect, it } from "vitest";
import type { BrushSettings } from "@/core/schema";
import { PAPB_SCHEMA_VERSION, parsePapb, serializePapb } from "@/infra/papb";
import { createPersistedBrushPreset } from "@/repos/brushPresets";

describe("papb codec", () => {
	it("should preserve schemaVersion, settings, and texture bytes across roundtrip", () => {
		const preset = createPersistedBrushPreset({
			uid: "brush-preset-roundtrip",
			name: "Graphite",
			defaultSettings: graphiteBrush(),
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

	// Brush files written before v2 hold a v1 union. Reading one has to migrate
	// it, or the brush lands in the panel as an empty shell.
	it("should migrate a schemaVersion 1 brush file to v2 on read", () => {
		const payload = encode({
			schemaVersion: 1,
			brushPreset: {
				uid: "brush-preset-v1",
				name: "V1",
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
				},
				textureName: "v1.png",
				textureMime: "image/png",
				textureHash: "texture-hash",
				textureBin: Uint8Array.from([1]),
				createdAt: 1,
				updatedAt: 1,
			},
		}) as Uint8Array;

		const { brushPreset } = parsePapb(payload);

		expect(brushPreset.defaultSettings.version).toBe(2);
		expect(brushPreset.defaultSettings.engine).toBe("dab");
		// The width is never recorded in preset data: the v1 size 24 is dropped
		// on read while the pressure curve migrated from sizeByPressure
		// survives.
		expect(brushPreset.defaultSettings.properties.size?.base).toBeUndefined();
		expect(
			brushPreset.defaultSettings.properties.size?.curves?.length,
		).toBeGreaterThan(0);
	});

	it("should reject unsupported schema versions", () => {
		const invalidPayload = encode({
			schemaVersion: PAPB_SCHEMA_VERSION + 1,
			brushPreset: createPersistedBrushPreset({
				name: "Broken",
				defaultSettings: graphiteBrush(),
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

function graphiteBrush(): BrushSettings {
	return {
		version: 2,
		engine: "dab",
		strokeOpacity: 0.8,
		paintMode: "buildup",
		properties: {
			size: { base: 24 },
			spacing: { base: 0.08 },
			flow: { base: 0.7 },
		},
		tip: {
			kind: "image",
			sources: [{ kind: "file", fileUid: "builtin-brush-soft-circle" }],
			selection: "random",
			angleMode: "fixed",
		},
		randomSeed: 0,
	};
}
