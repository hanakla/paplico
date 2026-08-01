import { createDefaultDocument } from "@/core/document/factory";
import { serializeDocument } from "@/core/io/papf/writer";
import { generateUid } from "@/core/schema";
import { type DocumentData, type DocumentMeta, db } from "@/infra/documentDB";
import type { FileHandle } from "@/infra/filesystem";
import { IS_TAURI_ENV } from "@/utils/platform";

export type { FileHandle };

import { domFileIO } from "./documents.dom";
import { tauriFileIO } from "./documents.tauri";

export interface DocumentsFileIO {
	openFile(options: {
		id?: string;
		types?: FilePickerAcceptType[];
	}): Promise<FileHandle | null>;
	overwriteFile(handle: FileHandle, blob: Blob): Promise<void>;
	exportFile(blob: Blob, filename: string): Promise<void>;
	fileHandleFromDrop(
		item: DataTransferItem,
		file: File,
	): Promise<FileHandle | null>;
}

export interface DocumentsRepo extends DocumentsFileIO {
	list(): Promise<DocumentMeta[]>;
	load(id: string): Promise<DocumentData | null>;
	create(name: string): Promise<string>;
	save(id: string, document: Blob, thumbnail?: Blob | null): Promise<void>;
	delete(id: string): Promise<void>;
	rename(id: string, name: string): Promise<void>;
	duplicate(id: string, newName: string): Promise<string>;
}

// --- File I/O (platform-specific) ---

const fileIO: DocumentsFileIO = IS_TAURI_ENV ? tauriFileIO : domFileIO;

// --- Shared CRUD (IndexedDB) ---

export const documentsRepo: DocumentsRepo = {
	// File I/O (delegated to platform implementation)
	...fileIO,

	// CRUD (shared IndexedDB)
	list() {
		return db.documentMeta.orderBy("updatedAt").reverse().toArray();
	},

	async load(id) {
		return (await db.documentData.get(id)) ?? null;
	},

	async create(name) {
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
	},

	async save(id, document, thumbnail) {
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
	},

	async delete(id) {
		await db.transaction("rw", db.documentMeta, db.documentData, async () => {
			await db.documentMeta.delete(id);
			await db.documentData.delete(id);
		});
	},

	async rename(id, name) {
		await db.documentMeta.update(id, { name });
	},

	async duplicate(id, newName) {
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
	},
};
