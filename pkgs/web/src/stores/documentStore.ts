import { proxy } from "valtio";
import { createDefaultDocument } from "@/core/document/factory";
import { serializeDocument } from "@/core/io/papf/writer";
import { generateUid } from "@/core/schema";
import { type DocumentData, type DocumentMeta, db } from "@/infra/documentDB";
import { getRevisionIdsToPrune } from "./autoSave";

// --- State ---

export const documentManagerState = proxy<{
	currentDocumentId: string | null;
	isLoading: boolean;
}>({
	currentDocumentId: null,
	isLoading: false,
});

// --- CRUD ---

export async function createDocument(name: string): Promise<string> {
	const id = generateUid("doc");
	const now = Date.now();
	const document = await serializeDocument(createDefaultDocument(id));

	await db.transaction("rw", db.documentMeta, db.documentData, async () => {
		await db.documentMeta.add({
			id,
			name,
			createdAt: now,
			updatedAt: now,
			thumbnail: null,
		});
		await db.documentData.add({
			id,
			document,
			thumbnail: null,
			createdAt: now,
		});
	});

	return id;
}

export async function saveDocument(
	id: string,
	document: Blob,
	thumbnail?: Blob | null,
): Promise<void> {
	const now = Date.now();

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
}

export async function saveRevision(
	documentId: string,
	document: Blob,
	thumbnail: Blob | null,
): Promise<void> {
	const now = Date.now();
	const revId = generateUid("rev");

	await db.transaction(
		"rw",
		db.documentRevisions,
		db.documentMeta,
		db.documentData,
		async () => {
			await db.documentRevisions.add({
				id: revId,
				documentId,
				document,
				thumbnail,
				createdAt: now,
			});

			await db.documentData.put({
				id: documentId,
				document,
				thumbnail,
				createdAt: now,
			});

			await db.documentMeta.update(documentId, {
				updatedAt: now,
				thumbnail,
			});

			// Prune: keep only newest revisions
			const allRevisions = await db.documentRevisions
				.where("documentId")
				.equals(documentId)
				.sortBy("createdAt");

			const toDelete = getRevisionIdsToPrune(allRevisions);
			if (toDelete.length > 0) {
				await db.documentRevisions.bulkDelete(toDelete);
			}
		},
	);
}

export async function loadDocumentData(
	id: string,
): Promise<DocumentData | null> {
	return (await db.documentData.get(id)) ?? null;
}

export async function listDocumentMetas(): Promise<DocumentMeta[]> {
	return db.documentMeta.orderBy("updatedAt").reverse().toArray();
}

export async function deleteDocument(id: string): Promise<void> {
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
}

export async function renameDocument(id: string, name: string): Promise<void> {
	await db.documentMeta.update(id, { name });
}

export async function duplicateDocument(
	id: string,
	newName: string,
): Promise<string> {
	const data = await db.documentData.get(id);
	if (!data) throw new Error(`Document not found: ${id}`);

	const newId = generateUid("doc");
	const now = Date.now();

	await db.transaction("rw", db.documentMeta, db.documentData, async () => {
		await db.documentMeta.add({
			id: newId,
			name: newName,
			createdAt: now,
			updatedAt: now,
			thumbnail: null,
		});
		await db.documentData.add({
			id: newId,
			document: data.document,
			thumbnail: data.thumbnail ?? null,
			createdAt: now,
		});
	});

	return newId;
}
