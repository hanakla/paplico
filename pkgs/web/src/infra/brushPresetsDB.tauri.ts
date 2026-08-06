import { normalizeBrushSettingsV2 } from "@/core/brush/migrate";
import { deepClone } from "@/core/utils/lang";
import type {
	BrushPresetsRepo,
	PersistedBrushPreset,
} from "@/repos/brushPresets";

type TauriDatabase = {
	execute(query: string, values?: unknown[]): Promise<unknown>;
	select<T>(query: string, values?: unknown[]): Promise<T[]>;
};

type BrushPresetRow = {
	uid: string;
	name: string;
	defaultSettingsJson: string;
	textureName: string;
	textureMime: string;
	textureHash: string;
	textureBinBase64: string;
	sourceBuiltinUid: string | null;
	createdAt: number;
	updatedAt: number;
};

let databasePromise: Promise<TauriDatabase> | null = null;

export const tauriBrushPresetsRepo: BrushPresetsRepo = {
	async list() {
		const db = await getBrushPresetsDatabase();
		const rows = await db.select<BrushPresetRow>(
			[
				"SELECT",
				"  uid,",
				"  name,",
				"  defaultSettingsJson,",
				"  textureName,",
				"  textureMime,",
				"  textureHash,",
				"  textureBinBase64,",
				"  sourceBuiltinUid,",
				"  createdAt,",
				"  updatedAt",
				"FROM brushPresets",
				"ORDER BY updatedAt DESC",
			].join(" "),
		);
		return rows.map(fromBrushPresetRow);
	},

	async get(uid) {
		const db = await getBrushPresetsDatabase();
		const rows = await db.select<BrushPresetRow>(
			[
				"SELECT",
				"  uid,",
				"  name,",
				"  defaultSettingsJson,",
				"  textureName,",
				"  textureMime,",
				"  textureHash,",
				"  textureBinBase64,",
				"  sourceBuiltinUid,",
				"  createdAt,",
				"  updatedAt",
				"FROM brushPresets",
				"WHERE uid = ?",
				"LIMIT 1",
			].join(" "),
			[uid],
		);
		return rows[0] ? fromBrushPresetRow(rows[0]) : null;
	},

	async save(preset) {
		const db = await getBrushPresetsDatabase();
		const row = toBrushPresetRow(preset);
		await db.execute(
			[
				"INSERT OR REPLACE INTO brushPresets (",
				"  uid,",
				"  name,",
				"  defaultSettingsJson,",
				"  textureName,",
				"  textureMime,",
				"  textureHash,",
				"  textureBinBase64,",
				"  sourceBuiltinUid,",
				"  createdAt,",
				"  updatedAt",
				") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			].join(" "),
			[
				row.uid,
				row.name,
				row.defaultSettingsJson,
				row.textureName,
				row.textureMime,
				row.textureHash,
				row.textureBinBase64,
				row.sourceBuiltinUid,
				row.createdAt,
				row.updatedAt,
			],
		);
	},

	async rename(uid, name) {
		const db = await getBrushPresetsDatabase();
		await db.execute(
			"UPDATE brushPresets SET name = ?, updatedAt = ? WHERE uid = ?",
			[name, Date.now(), uid],
		);
	},

	async delete(uid) {
		const db = await getBrushPresetsDatabase();
		await db.execute("DELETE FROM brushPresets WHERE uid = ?", [uid]);
	},
};

async function getBrushPresetsDatabase(): Promise<TauriDatabase> {
	databasePromise ??= createBrushPresetsDatabase();
	return databasePromise;
}

async function createBrushPresetsDatabase(): Promise<TauriDatabase> {
	const [{ default: Database }, { appDataDir, join }] = await Promise.all([
		import("@tauri-apps/plugin-sql"),
		import("@tauri-apps/api/path"),
	]);

	const databasePath = await join(await appDataDir(), "papdb.sqlite");
	const database = await Database.load(`sqlite:${databasePath}`);

	await database.execute(
		[
			"CREATE TABLE IF NOT EXISTS brushPresets (",
			"  uid TEXT PRIMARY KEY NOT NULL,",
			"  name TEXT NOT NULL,",
			"  defaultSettingsJson TEXT NOT NULL,",
			"  textureName TEXT NOT NULL,",
			"  textureMime TEXT NOT NULL,",
			"  textureHash TEXT NOT NULL,",
			"  textureBinBase64 TEXT NOT NULL,",
			"  sourceBuiltinUid TEXT,",
			"  createdAt INTEGER NOT NULL,",
			"  updatedAt INTEGER NOT NULL",
			")",
		].join(" "),
	);
	await database.execute(
		"CREATE INDEX IF NOT EXISTS brushPresetsUpdatedAtIdx ON brushPresets(updatedAt DESC)",
	);

	return database as unknown as TauriDatabase;
}

function toBrushPresetRow(preset: PersistedBrushPreset): BrushPresetRow {
	const snapshot = clonePersistedBrushPreset(preset);
	return {
		uid: snapshot.uid,
		name: snapshot.name,
		defaultSettingsJson: JSON.stringify(snapshot.defaultSettings),
		textureName: snapshot.textureName,
		textureMime: snapshot.textureMime,
		textureHash: snapshot.textureHash,
		textureBinBase64: toBase64(snapshot.textureBin),
		sourceBuiltinUid: snapshot.sourceBuiltinUid ?? null,
		createdAt: snapshot.createdAt,
		updatedAt: snapshot.updatedAt,
	};
}

function fromBrushPresetRow(row: BrushPresetRow): PersistedBrushPreset {
	return {
		uid: row.uid,
		name: row.name,
		// Records written before v2 are migrated on the way out, so callers
		// never see the old shape.
		defaultSettings: normalizeBrushSettingsV2(
			JSON.parse(row.defaultSettingsJson),
		),
		textureName: row.textureName,
		textureMime: row.textureMime,
		textureHash: row.textureHash,
		textureBin: fromBase64(row.textureBinBase64),
		...(row.sourceBuiltinUid ? { sourceBuiltinUid: row.sourceBuiltinUid } : {}),
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

function clonePersistedBrushPreset(
	preset: PersistedBrushPreset,
): PersistedBrushPreset {
	return {
		...preset,
		defaultSettings: deepClone(preset.defaultSettings),
		textureBin: new Uint8Array(preset.textureBin),
	};
}

function toBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let index = 0; index < bytes.length; index += 0x8000) {
		const chunk = bytes.subarray(index, index + 0x8000);
		binary += String.fromCharCode(...chunk);
	}
	return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
}
