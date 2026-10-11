import { createDefaultDocument } from "@paplico/core/document";
import { openPapf, serializeDocument } from "@paplico/core/io";
import { generateUid } from "@paplico/core/schema";
import { proxy } from "valtio";
import { AUTO_SAVE_MAX_REVISIONS } from "@/configs";
import type {
	DocumentData,
	DocumentMeta,
	DocumentRevision,
} from "@/infra/documentDB.types";
import { documentsRepo } from "@/repos/documents";

// --- State ---

export const documentManagerState = proxy<{
	currentDocumentId: string | null;
	isLoading: boolean;
}>({
	currentDocumentId: null,
	isLoading: false,
});

/** Bumped after every write, so views of the stored documents read them again. */
export const documentStorageState = proxy({ changeCount: 0 });

// --- CRUD ---

export async function createDocument(name: string): Promise<string> {
	const id = generateUid("doc");
	const now = Date.now();
	const document = await serializeDocument(createDefaultDocument(id));

	await documentsRepo.create(
		{ id, name, createdAt: now, updatedAt: now, thumbnail: null },
		{ id, document, thumbnail: null, createdAt: now },
	);
	documentStorageState.changeCount++;

	return id;
}

/**
 * Stores a document under its own id. A record that already exists keeps
 * its name and creation time and only takes the new content, so opening a
 * file that came from this store does not add a second copy.
 */
export async function upsertDocument(
	id: string,
	name: string,
	document: Blob,
): Promise<void> {
	await documentsRepo.upsert(id, name, document, Date.now());
	documentStorageState.changeCount++;
}

export async function saveDocument(
	id: string,
	document: Blob,
	thumbnail?: Blob | null,
): Promise<void> {
	await documentsRepo.save(id, document, thumbnail, Date.now());
	documentStorageState.changeCount++;
}

export async function saveRevision(
	documentId: string,
	document: Blob,
	thumbnail: Blob | null,
): Promise<void> {
	await documentsRepo.addRevision(
		{
			id: generateUid("rev"),
			documentId,
			document,
			thumbnail,
			createdAt: Date.now(),
		},
		AUTO_SAVE_MAX_REVISIONS,
	);
	documentStorageState.changeCount++;
}

export async function loadDocumentData(
	id: string,
): Promise<DocumentData | null> {
	return documentsRepo.load(id);
}

export async function loadDocumentMeta(
	id: string,
): Promise<DocumentMeta | null> {
	return documentsRepo.getMeta(id);
}

export async function listDocumentMetas(): Promise<DocumentMeta[]> {
	return documentsRepo.listMetas();
}

/** Newest first. */
export async function listDocumentRevisions(
	documentId: string,
): Promise<DocumentRevision[]> {
	return documentsRepo.listRevisions(documentId);
}

export async function countDocumentRevisions(): Promise<
	Record<string, number>
> {
	return documentsRepo.countRevisions();
}

export async function deleteDocument(id: string): Promise<void> {
	await documentsRepo.delete(id);
	documentStorageState.changeCount++;
}

export async function renameDocument(id: string, name: string): Promise<void> {
	await documentsRepo.rename(id, name);
	documentStorageState.changeCount++;
}

export async function duplicateDocument(
	id: string,
	newName: string,
): Promise<string> {
	const data = await documentsRepo.load(id);
	if (!data) throw new Error(`Document not found: ${id}`);

	const newId = generateUid("doc");
	const now = Date.now();
	// The copy carries its own id inside the document too, so a file saved
	// from it lands on the copy's record and not on the original's. It keeps
	// the stored shape and version: migrating happens when the copy is opened.
	const document = await serializeDocument({
		...(await (await openPapf(data.document)).readUnmigratedDocument()),
		id: newId,
	});

	await documentsRepo.create(
		{
			id: newId,
			name: newName,
			createdAt: now,
			updatedAt: now,
			thumbnail: null,
		},
		{ id: newId, document, thumbnail: data.thumbnail ?? null, createdAt: now },
	);
	documentStorageState.changeCount++;

	return newId;
}
