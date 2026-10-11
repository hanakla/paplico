import type Dexie from "dexie";
import { migYjsStateToPapf } from "./20260405_mig_yjs_state_to_papf";

export interface IndexedDBMigration {
	/** Schema version date (YYYYMMDD) this migration upgrades TO */
	version: number;
	/** Apply migration to the database. */
	migrate(db: Dexie): Promise<void>;
}

const migrations: IndexedDBMigration[] = [migYjsStateToPapf];

/**
 * Run all pending IndexedDB migrations.
 * Tracks completed migrations in localStorage to avoid re-running.
 */
export async function runIndexedDBMigrations(db: Dexie): Promise<void> {
	const completedVersion = getCompletedVersion();

	for (const mig of migrations) {
		if (mig.version <= completedVersion) continue;

		try {
			await mig.migrate(db);
			setCompletedVersion(mig.version);
		} catch (e) {
			console.error(
				`[IndexedDBMigration] Failed migration v${mig.version}:`,
				e,
			);
			break;
		}
	}
}

const STORAGE_KEY = "paplico:dbMigrationVersion";

function getCompletedVersion(): number {
	try {
		return Number(localStorage.getItem(STORAGE_KEY)) || 0;
	} catch {
		return 0;
	}
}

function setCompletedVersion(version: number): void {
	try {
		localStorage.setItem(STORAGE_KEY, String(version));
	} catch {
		// localStorage may be unavailable
	}
}
