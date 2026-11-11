import type { Paplico } from "@paplico/core";
import { generateUid } from "@paplico/core/schema";
import { proxy, ref } from "valtio";
import { setLastDocumentId } from "@/hooks/useAppConfig";
import { type FileHandle, FileSystem } from "@/infra/filesystem";
import {
	documentManagerState,
	saveDocument,
	upsertDocument,
} from "./documentStore";

type DocumentSessionSource =
	| { kind: "initial" }
	| { kind: "internal"; documentId: string }
	| { kind: "external" }
	| { kind: "snapshot" };

interface DocumentSession {
	identity: string;
	source: DocumentSessionSource;
	fileHandle: FileHandle | null;
	/** Edits made since the document was last read from or written to its file. */
	hasUnsavedFileChanges: boolean;
	revision: number;
}

// The native FileSystemFileHandle breaks when Valtio wraps it, so handles are stored with ref().
export const documentSessionState = proxy<DocumentSession>({
	identity: crypto.randomUUID(),
	source: { kind: "initial" },
	fileHandle: null,
	hasUnsavedFileChanges: false,
	revision: 0,
});

export function setInternalDocumentSession(documentId: string): void {
	replaceDocumentSession({ kind: "internal", documentId }, null);
}

export function setExternalDocumentSession(
	fileHandle: FileHandle | null,
): void {
	replaceDocumentSession({ kind: "external" }, fileHandle);
}

export function setSnapshotDocumentSession(): void {
	replaceDocumentSession({ kind: "snapshot" }, null);
}

/**
 * Makes a file the document was just written to the target of manual saves.
 * The document stays the same, so the session identity is kept.
 */
export function setDocumentFileHandle(fileHandle: FileHandle): void {
	documentSessionState.fileHandle = ref(fileHandle);
	documentSessionState.hasUnsavedFileChanges = false;
}

/** Writes the document over the file manual saves target. */
export async function overwriteDocumentFile(
	paplico: Paplico,
	fileHandle: FileHandle,
): Promise<void> {
	// Cleared before exporting so edits made during the write mark the file again
	documentSessionState.hasUnsavedFileChanges = false;
	try {
		await FileSystem.overwrite(fileHandle, await paplico.exportDocumentFile());
	} catch (error) {
		documentSessionState.hasUnsavedFileChanges = true;
		throw error;
	}
}

/**
 * Marks the file as behind the document on every edit, so closing the
 * document can ask before the edits are left out of the file.
 */
export function watchUnsavedFileChanges(paplico: Paplico): () => void {
	return paplico.getYjsProvider().on("update", () => {
		documentSessionState.hasUnsavedFileChanges = true;
	});
}

/**
 * Opens a document from a file. A handle keeps the file as the target of
 * manual saves; a bare file has no such target. The document is stored
 * under its own id so auto save and revisions cover it, and a file that
 * came from this store lands back on its existing record.
 */
export async function openDocumentFile(
	paplico: Paplico,
	source: File | FileHandle,
): Promise<void> {
	const currentId = documentManagerState.currentDocumentId;
	if (currentId) {
		await saveDocument(currentId, await paplico.exportDocument());
	}

	const file = source instanceof File ? source : source.file;
	await paplico.importDocument(file);
	const id = paplico.uiState.document.id || generateUid("doc");
	await upsertDocument(
		id,
		documentNameFromFile(file),
		await paplico.exportDocument(),
	);
	documentManagerState.currentDocumentId = id;
	setExternalDocumentSession(
		source instanceof File || source.handle == null ? null : source,
	);
	setLastDocumentId(id);
}

/** Names a document after the file it was opened from or saved to. */
export function documentNameFromFile(file: File): string {
	return file.name.replace(/\.papf$/i, "");
}

function replaceDocumentSession(
	source: DocumentSessionSource,
	fileHandle: FileHandle | null,
): void {
	documentSessionState.identity = crypto.randomUUID();
	documentSessionState.source = source;
	documentSessionState.fileHandle = fileHandle && ref(fileHandle);
	documentSessionState.hasUnsavedFileChanges = false;
	documentSessionState.revision++;
}
