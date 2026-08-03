import { beforeEach, describe, expect, it } from "vitest";
import { resolveBrushTextureUid } from "@/core/brush/brushSource";
import { createDefaultBrushSettings } from "@/core/document/factory";
import type { BrushSettings } from "@/core/schema";
import {
	brushPresetsDB,
	webBrushPresetsRepo,
} from "@/infra/brushPresetsDB.web";
import {
	clonePersistedBrushPreset,
	createBrushPresetDefaults,
	createBuiltinBrushPreviewSource,
	createPersistedBrushPreset,
	createPersistedBrushPreviewSource,
} from "@/repos/brushPresets";

describe("brushPresets helpers", () => {
	it("should reset randomSeed and keep settings reproducible", () => {
		const defaults = createBrushPresetDefaults({
			...createDefaultBrushSettings(),
			source: { kind: "file", fileUid: "builtin-brush-airbrush" },
			randomSeed: 12345,
			size: 42,
			flow: 0.35,
		});

		expect(defaults).toMatchObject({
			type: "scatter",
			size: 42,
			flow: 0.35,
		});
		// randomSeed is reset to 0 so the preset renders reproducibly.
		expect(defaults.randomSeed).toBe(0);
		// The flat textureFileUid no longer exists; the source carries the texture.
		expect("textureFileUid" in defaults).toBe(false);
		expect(resolveBrushTextureUid(defaults)).toBe("builtin-brush-airbrush");
	});

	it("should duplicate preset settings and texture payload into a new record", () => {
		const preset = createPersistedBrushPreset({
			uid: "brush-preset-source",
			name: "Soft Grain",
			defaultSettings: createBrushPresetDefaults(createDefaultBrushSettings()),
			file: {
				uid: "file-source",
				name: "soft-grain.png",
				type: "image/png",
				hash: "soft-grain-hash",
				bin: Uint8Array.from([2, 4, 6, 8]),
			},
			sourceBuiltinUid: "builtin-brush-soft-circle",
			createdAt: 1,
			updatedAt: 1,
		});

		const duplicated = clonePersistedBrushPreset(
			preset,
			"Soft Grain Copy",
			"brush-preset-copy",
		);

		expect(duplicated.uid).toBe("brush-preset-copy");
		expect(duplicated.name).toBe("Soft Grain Copy");
		expect(duplicated.defaultSettings).toEqual(preset.defaultSettings);
		expect(duplicated.textureHash).toBe(preset.textureHash);
		expect(duplicated.textureBin).toEqual(preset.textureBin);
		expect(duplicated.createdAt).not.toBe(preset.createdAt);
	});

	it("should create builtin preview settings with a deterministic random seed", () => {
		const preview = createBuiltinBrushPreviewSource(
			{
				uid: "builtin-brush-airbrush",
				name: "Airbrush",
				settings: {
					type: "scatter",
					source: { kind: "file", fileUid: "builtin-brush-airbrush" },
					randomSeed: 0,
					size: 18,
					sizeByPressure: 0.2,
					opacity: 0.8,
					opacityByPressure: 0.4,
					spacing: 0.1,
					flow: 0.5,
					stampRotation: "random",
					rotationByTilt: 0.3,
					aspectRatioByTilt: 0.1,
					sizeBySpeed: 0.2,
					pooling: 0.4,
					poolingSizeRatio: 0.5,
				},
			},
			{
				uid: "builtin-brush-airbrush",
				name: "airbrush.png",
				type: "image/png",
				hash: "builtin-airbrush-hash",
				bin: Uint8Array.from([1, 2, 3]),
			},
		);

		expect(resolveBrushTextureUid(preview.brushSettings)).toBe(
			"builtin-brush-airbrush",
		);
		expect(preview.brushSettings.randomSeed).toBe(0x41c6_4e6d);
		expect(preview.textureFile?.bin).toEqual(Uint8Array.from([1, 2, 3]));
	});

	it("should create persisted preview settings with a deterministic preview texture id", () => {
		const preset = createPersistedBrushPreset({
			uid: "brush-preset-preview",
			name: "Preview Me",
			defaultSettings: createBrushPresetDefaults(createDefaultBrushSettings()),
			file: {
				uid: "source-file",
				name: "preview.png",
				type: "image/png",
				hash: "preview-hash",
				bin: Uint8Array.from([9, 8, 7]),
			},
		});

		const preview = createPersistedBrushPreviewSource(preset);

		expect(resolveBrushTextureUid(preview.brushSettings)).toBe(
			"brush-preview-texture",
		);
		expect(preview.brushSettings.randomSeed).toBe(0x41c6_4e6d);
		expect(preview.textureFile?.uid).toBe("brush-preview-texture");
		expect(preview.textureFile?.bin).toEqual(Uint8Array.from([9, 8, 7]));
	});
});

describe("webBrushPresetsRepo", () => {
	beforeEach(async () => {
		await brushPresetsDB.brushPresets.clear();
	});

	it("should save, list, rename, and delete persisted brush presets", async () => {
		const preset = createPersistedBrushPreset({
			uid: "brush-preset-repo",
			name: "Texture One",
			defaultSettings: createBrushPresetDefaults(createDefaultBrushSettings()),
			file: {
				uid: "file-source",
				name: "texture-one.png",
				type: "image/png",
				hash: "texture-one-hash",
				bin: Uint8Array.from([10, 20, 30]),
			},
		});

		await webBrushPresetsRepo.save(preset);

		expect(await webBrushPresetsRepo.list()).toEqual([preset]);

		await webBrushPresetsRepo.rename(preset.uid, "Texture Prime");
		expect((await webBrushPresetsRepo.get(preset.uid))?.name).toBe(
			"Texture Prime",
		);

		await webBrushPresetsRepo.delete(preset.uid);
		expect(await webBrushPresetsRepo.list()).toEqual([]);
	});

	it("should normalize a legacy flat defaultSettings record written before the BrushSettings union existed", async () => {
		// Simulates a row written by pre-union app code: `defaultSettings` has
		// no `type` discriminator. Written directly to the DB (bypassing
		// webBrushPresetsRepo.save, which always normalizes on write) so the
		// read path is what's under test.
		await brushPresetsDB.brushPresets.put({
			uid: "brush-preset-legacy",
			name: "Legacy Ink",
			defaultSettings: {
				textureFileUid: "builtin-brush-soft-circle",
				size: 24,
				spacing: 0.15,
			} as unknown as BrushSettings,
			textureName: "legacy.png",
			textureMime: "image/png",
			textureHash: "legacy-hash",
			textureBin: Uint8Array.from([1, 2, 3]),
			createdAt: 1,
			updatedAt: 1,
		});

		const listed = await webBrushPresetsRepo.list();
		expect(listed).toHaveLength(1);
		const listedSettings = listed[0]?.defaultSettings;
		if (listedSettings == null || "version" in listedSettings)
			throw new Error("expected v1 settings");
		expect(listedSettings.type).toBe("scatter");
		expect(resolveBrushTextureUid(listed[0]!.defaultSettings)).toBe(
			"builtin-brush-soft-circle",
		);

		const got = await webBrushPresetsRepo.get("brush-preset-legacy");
		const gotSettings = got?.defaultSettings;
		if (gotSettings == null || "version" in gotSettings)
			throw new Error("expected v1 settings");
		expect(gotSettings.type).toBe("scatter");

		// createPersistedBrushPreviewSource routes defaultSettings through
		// withTextureFileUid — must not blow up on a (now-normalized) record
		// that originated from a legacy flat shape.
		const preview = createPersistedBrushPreviewSource(got!);
		expect(preview.brushSettings).toBeDefined();
		expect(resolveBrushTextureUid(preview.brushSettings)).toBe(
			preview.textureFile?.uid,
		);
	});
});
