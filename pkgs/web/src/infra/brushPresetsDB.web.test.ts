import "fake-indexeddb/auto";
import Dexie from "dexie";
import { describe, expect, it } from "vitest";
import { resolveBrushTextureUid } from "@/core/brush/brushSource";
import { webBrushPresetsRepo } from "./brushPresetsDB.web";

describe("brushPresetsDB upgrade", () => {
	it("should convert rows written before brush v2 once when the database opens", async () => {
		// Write a pre-v2 row through a version-1 database, the way the old app
		// left it, before the repo opens the current version.
		const legacy = new Dexie("paplico-brush-presets");
		legacy.version(1).stores({
			brushPresets: "uid, updatedAt, createdAt, name, textureHash",
		});
		await legacy.table("brushPresets").put({
			uid: "brush-preset-v1",
			name: "V1 Ink",
			defaultSettings: {
				textureFileUid: "builtin-brush-soft-circle",
				size: 24,
				spacing: 0.15,
			},
			textureName: "v1.png",
			textureMime: "image/png",
			textureHash: "v1-hash",
			textureBin: Uint8Array.from([1, 2, 3]),
			createdAt: 1,
			updatedAt: 1,
		});
		legacy.close();

		const got = await webBrushPresetsRepo.get("brush-preset-v1");
		expect(got?.defaultSettings.version).toBe(2);
		expect(got?.defaultSettings.engine).toBe("dab");
		expect(resolveBrushTextureUid(got!.defaultSettings)).toBe(
			"builtin-brush-soft-circle",
		);
		expect(got?.defaultSettings.properties.spacing?.base).toBe(0.15);
	});
});
