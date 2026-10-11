import Dexie, { type EntityTable } from "dexie";
import type {
	DocumentData,
	DocumentMeta,
	DocumentRevision,
	DocumentsRepo,
} from "@/infra/documentDB.types";

class PaplicoDB extends Dexie {
	public documentMeta!: EntityTable<DocumentMeta, "id">;
	public documentData!: EntityTable<DocumentData, "id">;
	public documentRevisions!: EntityTable<DocumentRevision, "id">;

	public constructor() {
		super("paplico");
		this.version(1).stores({
			documentMeta: "id, updatedAt",
			documentData: "id",
		});
		this.version(2).stores({
			documentRevisions: "id, documentId, [documentId+createdAt]",
		});
	}
}

export const db = new PaplicoDB();

export const webDocumentsRepo: DocumentsRepo = {
	listMetas() {
		return db.documentMeta.orderBy("updatedAt").reverse().toArray();
	},

	async getMeta(id) {
		return (await db.documentMeta.get(id)) ?? null;
	},

	async load(id) {
		return (await db.documentData.get(id)) ?? null;
	},

	async listRevisions(documentId) {
		return (
			await db.documentRevisions
				.where("documentId")
				.equals(documentId)
				.sortBy("createdAt")
		).reverse();
	},

	async countRevisions() {
		const counts: Record<string, number> = {};
		await db.documentRevisions.each((rev) => {
			counts[rev.documentId] = (counts[rev.documentId] ?? 0) + 1;
		});
		return counts;
	},

	async create(meta, data) {
		await db.transaction("rw", db.documentMeta, db.documentData, async () => {
			await db.documentMeta.add(meta);
			await db.documentData.add(data);
		});
	},

	async upsert(id, name, document, now) {
		await db.transaction("rw", db.documentMeta, db.documentData, async () => {
			const meta = await db.documentMeta.get(id);
			await db.documentMeta.put({
				id,
				name: meta?.name ?? name,
				createdAt: meta?.createdAt ?? now,
				updatedAt: now,
				thumbnail: meta?.thumbnail ?? null,
			});
			await db.documentData.put({
				id,
				document,
				thumbnail: null,
				createdAt: now,
			});
		});
	},

	async save(id, document, thumbnail, now) {
		await db.transaction("rw", db.documentMeta, db.documentData, async () => {
			await db.documentMeta.update(id, {
				updatedAt: now,
				...(thumbnail !== undefined ? { thumbnail } : {}),
			});
			await db.documentData.put({
				id,
				document,
				thumbnail: thumbnail ?? null,
				createdAt: now,
			});
		});
	},

	async addRevision(revision, keepCount) {
		const { documentId, document, thumbnail, createdAt } = revision;

		await db.transaction(
			"rw",
			db.documentRevisions,
			db.documentMeta,
			db.documentData,
			async () => {
				await db.documentRevisions.add(revision);
				await db.documentData.put({
					id: documentId,
					document,
					thumbnail,
					createdAt,
				});
				await db.documentMeta.update(documentId, {
					updatedAt: createdAt,
					thumbnail,
				});

				const revisions = await db.documentRevisions
					.where("documentId")
					.equals(documentId)
					.sortBy("createdAt");
				await db.documentRevisions.bulkDelete(
					revisions
						.slice(0, Math.max(0, revisions.length - keepCount))
						.map((rev) => rev.id),
				);
			},
		);
	},

	async delete(id) {
		await db.transaction(
			"rw",
			db.documentMeta,
			db.documentData,
			db.documentRevisions,
			async () => {
				await db.documentMeta.delete(id);
				await db.documentData.delete(id);
				await db.documentRevisions.where("documentId").equals(id).delete();
			},
		);
	},

	async rename(id, name) {
		await db.documentMeta.update(id, { name });
	},
};
