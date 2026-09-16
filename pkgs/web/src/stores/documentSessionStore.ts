import { proxy } from "valtio";
import type { Paplico } from "@/core/Paplico";
import { generateUid } from "@/core/schema";
import { setLastDocumentId } from "@/hooks/useAppConfig";
import type { FileHandle } from "@/infra/filesystem";
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
	revision: number;
}

export const documentSessionState = proxy<DocumentSession>({
	identity: crypto.randomUUID(),
	source: { kind: "initial" },
	fileHandle: null,
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
 * Makes a newly written file the target of manual saves. The document stays
 * the same, so the session identity is kept.
 */
export function setDocumentFileHandle(fileHandle: FileHandle): void {
	documentSessionState.fileHandle = fileHandle;
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
		file.name.replace(/\.papf$/i, ""),
		await paplico.exportDocument(),
	);
	documentManagerState.currentDocumentId = id;
	setExternalDocumentSession(source instanceof File ? null : source);
	setLastDocumentId(id);
}

function replaceDocumentSession(
	source: DocumentSessionSource,
	fileHandle: FileHandle | null,
): void {
	documentSessionState.identity = crypto.randomUUID();
	documentSessionState.source = source;
	documentSessionState.fileHandle = fileHandle;
	documentSessionState.revision++;
}
