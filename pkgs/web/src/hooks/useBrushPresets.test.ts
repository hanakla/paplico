import { describe, expect, it, vi } from "vitest";
import { materializeBrushPresetTexture } from "@/hooks/useBrushPresets";
import { createPersistedBrushPreset } from "@/repos/brushPresets";

describe("materializeBrushPresetTexture", () => {
	it("should forward persisted texture payload to addEmbeddedFile and use its returned uid", () => {
		const preset = createPersistedBrushPreset({
			uid: "brush-preset-materialize",
			name: "Marker",
			defaultSettings: {
				type: "scatter",
				source: { kind: "file", fileUid: "builtin-brush-soft-circle" },
				randomSeed: 0,
				size: 18,
				sizeByPressure: 0.4,
				opacity: 0.9,
				opacityByPressure: 0.3,
				spacing: 0.07,
				flow: 0.8,
				stampRotation: "none",
				rotationByTilt: 0,
				aspectRatioByTilt: 0,
				sizeBySpeed: 0,
				pooling: 0,
				poolingSizeRatio: 0.5,
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
