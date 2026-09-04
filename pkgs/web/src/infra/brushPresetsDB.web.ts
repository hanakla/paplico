import Dexie, { type EntityTable } from "dexie";
import { migrateBrushSettingsToV2 } from "@/core/io/migrations/brushV2/convert";
import { deepClone } from "@/core/utils/lang";
import type {
	BrushPresetsRepo,
	PersistedBrushPreset,
} from "@/repos/brushPresets";

class BrushPresetsDB extends Dexie {
	public brushPresets!: EntityTable<PersistedBrushPreset, "uid">;

	public constructor() {
		super("paplico-brush-presets");
		this.version(1).stores({
			brushPresets: "uid, updatedAt, createdAt, name, textureHash",
		});
		// Records written before brush v2 are converted once here, so reads
		// never see the old shape.
		this.version(2)
			.stores({
				brushPresets: "uid, updatedAt, createdAt, name, textureHash",
			})
			.upgrade((tx) =>
				tx
					.table<PersistedBrushPreset, "uid">("brushPresets")
					.toCollection()
					.modify((preset) => {
						preset.defaultSettings = migrateBrushSettingsToV2(
							preset.defaultSettings,
						);
					}),
			);
	}
}

export const brushPresetsDB = new BrushPresetsDB();

export const webBrushPresetsRepo: BrushPresetsRepo = {
	async list() {
		const presets = await brushPresetsDB.brushPresets
			.orderBy("updatedAt")
			.reverse()
			.toArray();
		return presets.map(clonePersistedBrushPreset);
	},

	async get(uid) {
		const preset = await brushPresetsDB.brushPresets.get(uid);
		return preset ? clonePersistedBrushPreset(preset) : null;
	},

	async save(preset) {
		await brushPresetsDB.brushPresets.put(clonePersistedBrushPreset(preset));
	},

	async rename(uid, name) {
		await brushPresetsDB.brushPresets.update(uid, {
			name,
			updatedAt: Date.now(),
		});
	},

	async delete(uid) {
		await brushPresetsDB.brushPresets.delete(uid);
	},
};

function clonePersistedBrushPreset(
	preset: PersistedBrushPreset,
): PersistedBrushPreset {
	return {
		...preset,
		defaultSettings: deepClone(preset.defaultSettings),
		textureBin: new Uint8Array(preset.textureBin),
	};
}
