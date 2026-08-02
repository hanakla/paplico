import Dexie from "dexie";
import * as Y from "yjs";
import { migYjsStateToPapf } from "@/infra/dbMigrations/20260405_mig_yjs_state_to_papf";

function createLegacyYjsState(): Uint8Array {
	const ydoc = new Y.Doc();
	ydoc.transact(() => {
		const yLayers = ydoc.getArray("layers");
		const yLayer = new Y.Map<unknown>();
		yLayer.set("id", "layer-test-001");
		yLayer.set("name", "Layer 1");
		yLayer.set("visible", true);
		yLayer.set("locked", false);
		yLayer.set("opacity", 1.0);
		yLayer.set("elementIds", new Y.Array<string>());
		yLayers.push([yLayer]);
	});
	const state = Y.encodeStateAsUpdate(ydoc);
	ydoc.destroy();
	return state;
}

function createTestDB(name: string): Dexie {
	const db = new Dexie(name);
	db.version(1).stores({
		documentMeta: "id, updatedAt",
		documentData: "id",
	});
	db.version(2).stores({
		documentRevisions: "id, documentId, [documentId+createdAt]",
	});
	return db;
}

describe("DB migration: yjsState to PAPF", () => {
	const DB_NAME = "paplico-migration-test";

	afterEach(async () => {
		await Dexie.delete(DB_NAME);
	});

	it("should migrate yjsState + viewport to PAPF Blob", async () => {
		const v1db = new Dexie(DB_NAME);
		v1db.version(1).stores({
			documentMeta: "id, updatedAt",
			documentData: "id",
		});

		await v1db.table("documentMeta").add({
			id: "doc-1",
			name: "Test Document",
			createdAt: 1000,
			updatedAt: 2000,
			thumbnail: null,
		});

		await v1db.table("documentData").add({
			id: "doc-1",
			yjsState: createLegacyYjsState(),
			viewport: { x: 10, y: 20, zoom: 2, rotation: 45 },
		});

		v1db.close();

		const db = createTestDB(DB_NAME);
		await db.open();
		await migYjsStateToPapf.migrate(db);

		const migrated = await db.table("documentData").get("doc-1");

		expect(migrated.yjsState).toBeUndefined();
		expect(migrated.viewport).toBeUndefined();
		expect(migrated.document).toBeTruthy();
		expect(migrated.thumbnail).toBeNull();
		expect(migrated.createdAt).toBeGreaterThan(0);

		db.close();
	});

	it("should skip records without yjsState", async () => {
		const v1db = new Dexie(DB_NAME);
		v1db.version(1).stores({
			documentMeta: "id, updatedAt",
			documentData: "id",
		});

		await v1db.table("documentMeta").add({
			id: "doc-2",
			name: "Already Migrated",
			createdAt: 1000,
			updatedAt: 2000,
			thumbnail: null,
		});

		await v1db.table("documentData").add({
			id: "doc-2",
			document: new Blob(["fake-papf"]),
			thumbnail: null,
			createdAt: 3000,
		});

		v1db.close();

		const db = createTestDB(DB_NAME);
		await db.open();
		await migYjsStateToPapf.migrate(db);

		const data = await db.table("documentData").get("doc-2");
		expect(data.createdAt).toBe(3000);
		expect(data.document).toBeTruthy();

		db.close();
	});
});
