import { describe, expect, it, vi } from "vitest";
import { materializeBrushPresetTexture } from "@/hooks/useBrushPresets";
import { createPersistedBrushPreset } from "@/repos/brushPresets";

describe("materializeBrushPresetTexture", () => {
	it("should forward persisted texture payload to addEmbeddedFile and use its returned uid", () => {
		const preset = createPersistedBrushPreset({
			uid: "brush-preset-materialize",
			name: "Marker",
			defaultSettings: {
				version: 2,
				engine: "dab",
				strokeOpacity: 0.9,
				paintMode: "buildup",
				properties: {
					size: { base: 18 },
					spacing: { base: 0.07 },
					flow: { base: 0.8 },
				},
				tip: {
					kind: "image",
					sources: [{ kind: "file", fileUid: "builtin-brush-soft-circle" }],
					selection: "random",
					angleMode: "fixed",
				},
				randomSeed: 0,
			},
			file: {
				uid: "file-source",
				name: "marker.png",
				type: "image/png",
				hash: "marker-hash",
				bin: Uint8Array.from([9, 8, 7]),
			},
		});
		const addEmbeddedFile = vi.fn().mockReturnValue("file-materialized");

		const materializedUid = materializeBrushPresetTexture({
			preset,
			addEmbeddedFile,
			createFileUid: () => "file-generated",
		});

		expect(materializedUid).toBe("file-materialized");
		expect(addEmbeddedFile).toHaveBeenCalledTimes(1);
		expect(addEmbeddedFile.mock.calls[0][0]).toEqual({
			uid: "file-generated",
			name: "marker.png",
			type: "image/png",
			hash: "marker-hash",
			bin: Uint8Array.from([9, 8, 7]),
		});
	});
});
