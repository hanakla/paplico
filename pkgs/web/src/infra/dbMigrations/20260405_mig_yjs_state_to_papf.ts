import type Dexie from "dexie";
import * as Y from "yjs";
import { extractDocumentFromYDoc } from "@/core/collaboration/extractDocumentFromYDoc";
import { applyMigrations } from "@/core/io/migrations";
import { serializeDocument } from "@/core/io/papf/writer";
import type { Document } from "@/core/schema";
import type { DBMigration } from ".";

/**
 * Migrate documentData records from yjsState+viewport to PAPF Blob.
 */
/**
 * Convert legacy compound-path YDoc entries (sourceIds + operation)
 * to the current schema (sources: CompoundPathSource[]) before extraction.
 */
function migrateYDocCompoundPaths(ydoc: Y.Doc): void {
	const yObjects = ydoc.getMap<Y.Map<unknown>>("objects");
	for (const [, yMap] of yObjects.entries()) {
		const m = yMap as Y.Map<unknown>;
		if (m.get("type") !== "compound-path") continue;
		if (m.has("sources")) continue;
		if (!m.has("sourceIds")) continue;

		const sourceIds = JSON.parse(m.get("sourceIds") as string) as string[];
		const op = (m.get("operation") as string) ?? "union";
		const sources = sourceIds.map((id) => ({ id, op }));

		m.set("sources", JSON.stringify(sources));
		m.delete("sourceIds");
		m.delete("operation");
	}
}

export const migYjsStateToPapf: DBMigration = {
	version: 20260405,
	async migrate(db: Dexie): Promise<void> {
		const table = db.table("documentData");
		const rows = await table.toArray();

		for (const row of rows) {
			if (row.document instanceof Blob) continue;

			const legacy = row as {
				id: string;
				yjsState?: Uint8Array;
				viewport?: { x: number; y: number; zoom: number; rotation: number };
			};

			if (!legacy.yjsState) continue;

			const ydoc = new Y.Doc();
			Y.applyUpdate(ydoc, legacy.yjsState);
			migrateYDocCompoundPaths(ydoc);

			const doc: Document = {
				...extractDocumentFromYDoc(ydoc),
				viewport: legacy.viewport ?? { x: 0, y: 0, zoom: 1, rotation: 0 },
			} as Document;
			ydoc.destroy();
			applyMigrations(doc);

			const blob = await serializeDocument(doc);

			await table.put({
				id: legacy.id,
				document: blob,
				thumbnail: null,
				createdAt: Date.now(),
			});
		}
	},
};
