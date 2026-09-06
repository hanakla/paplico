import Dexie, { type EntityTable } from "dexie";
import {
	type AppearancePresetsRepo,
	clonePersistedAppearancePreset,
	type PersistedAppearancePreset,
} from "@/repos/appearancePresets";

class AppearancePresetsDB extends Dexie {
	public appearancePresets!: EntityTable<PersistedAppearancePreset, "uid">;

	public constructor() {
		super("paplico-appearance-presets");
		this.version(1).stores({
			appearancePresets: "uid, updatedAt, createdAt, name",
		});
	}
}

export const appearancePresetsDB = new AppearancePresetsDB();

export const webAppearancePresetsRepo: AppearancePresetsRepo = {
	async list() {
		const presets = await appearancePresetsDB.appearancePresets
			.orderBy("updatedAt")
			.reverse()
			.toArray();
		return presets.map(clonePersistedAppearancePreset);
	},

	async get(uid) {
		const preset = await appearancePresetsDB.appearancePresets.get(uid);
		return preset ? clonePersistedAppearancePreset(preset) : null;
	},

	async save(preset) {
		await appearancePresetsDB.appearancePresets.put(
			clonePersistedAppearancePreset(preset),
		);
	},

	async rename(uid, name) {
		// `modify` with a function sidesteps Dexie's UpdateSpec mapped type,
		// which cannot express Filter.subFilters' recursion.
		await appearancePresetsDB.appearancePresets
			.where("uid")
			.equals(uid)
			.modify((preset) => {
				preset.name = name;
				preset.updatedAt = Date.now();
			});
	},

	async delete(uid) {
		await appearancePresetsDB.appearancePresets.delete(uid);
	},
};
