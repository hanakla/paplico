import type { Filter } from "@/core/schema";
import type {
	AppearancePresetsRepo,
	PersistedAppearancePreset,
} from "@/repos/appearancePresets";

type TauriDatabase = {
	execute(query: string, values?: unknown[]): Promise<unknown>;
	select<T>(query: string, values?: unknown[]): Promise<T[]>;
};

type AppearancePresetRow = {
	uid: string;
	name: string;
	filtersJson: string;
	createdAt: number;
	updatedAt: number;
};

const SELECT_COLUMNS =
	"SELECT uid, name, filtersJson, createdAt, updatedAt FROM appearancePresets";

let databasePromise: Promise<TauriDatabase> | null = null;

export const tauriAppearancePresetsRepo: AppearancePresetsRepo = {
	async list() {
		const db = await getAppearancePresetsDatabase();
		const rows = await db.select<AppearancePresetRow>(
			`${SELECT_COLUMNS} ORDER BY updatedAt DESC`,
		);
		return rows.map(fromAppearancePresetRow);
	},

	async get(uid) {
		const db = await getAppearancePresetsDatabase();
		const rows = await db.select<AppearancePresetRow>(
			`${SELECT_COLUMNS} WHERE uid = ? LIMIT 1`,
			[uid],
		);
		const row = rows[0];
		return row ? fromAppearancePresetRow(row) : null;
	},

	async save(preset) {
		const db = await getAppearancePresetsDatabase();
		await db.execute(
			[
				"INSERT OR REPLACE INTO appearancePresets",
				"(uid, name, filtersJson, createdAt, updatedAt)",
				"VALUES (?, ?, ?, ?, ?)",
			].join(" "),
			[
				preset.uid,
				preset.name,
				JSON.stringify(preset.filters),
				preset.createdAt,
				preset.updatedAt,
			],
		);
	},

	async rename(uid, name) {
		const db = await getAppearancePresetsDatabase();
		await db.execute(
			"UPDATE appearancePresets SET name = ?, updatedAt = ? WHERE uid = ?",
			[name, Date.now(), uid],
		);
	},

	async delete(uid) {
		const db = await getAppearancePresetsDatabase();
		await db.execute("DELETE FROM appearancePresets WHERE uid = ?", [uid]);
	},
};

async function getAppearancePresetsDatabase(): Promise<TauriDatabase> {
	databasePromise ??= createAppearancePresetsDatabase();
	return databasePromise;
}

/**
 * Shares papdb.sqlite with the brush presets. `PRAGMA user_version` belongs to
 * brushPresetsDB.tauri.ts; this table only ever creates itself.
 */
async function createAppearancePresetsDatabase(): Promise<TauriDatabase> {
	const [{ default: Database }, { appDataDir, join }] = await Promise.all([
		import("@tauri-apps/plugin-sql"),
		import("@tauri-apps/api/path"),
	]);

	const databasePath = await join(await appDataDir(), "papdb.sqlite");
	const database = await Database.load(`sqlite:${databasePath}`);

	await database.execute(
		[
			"CREATE TABLE IF NOT EXISTS appearancePresets (",
			"  uid TEXT PRIMARY KEY NOT NULL,",
			"  name TEXT NOT NULL,",
			"  filtersJson TEXT NOT NULL,",
			"  createdAt INTEGER NOT NULL,",
			"  updatedAt INTEGER NOT NULL",
			")",
		].join(" "),
	);
	await database.execute(
		"CREATE INDEX IF NOT EXISTS appearancePresetsUpdatedAtIdx ON appearancePresets(updatedAt DESC)",
	);

	return database as unknown as TauriDatabase;
}

function fromAppearancePresetRow(
	row: AppearancePresetRow,
): PersistedAppearancePreset {
	return {
		uid: row.uid,
		name: row.name,
		filters: JSON.parse(row.filtersJson) as Filter[],
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}
