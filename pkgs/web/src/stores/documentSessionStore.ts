import { proxy } from "valtio";
import type { Paplico } from "@/core/Paplico";
import { setLastDocumentId } from "@/hooks/useAppConfig";
import type { FileHandle } from "@/infra/filesystem";
import {
	createDocument,
	documentManagerState,
	saveDocument,
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
 * Opens a document from a file. The file stays the target of manual saves
 * when the handle can reach it; a copy in IndexedDB gives the document auto
 * save and revisions either way.
 */
export async function openDocumentFile(
	paplico: Paplico,
	handle: FileHandle,
): Promise<void> {
	const currentId = documentManagerState.currentDocumentId;
	if (currentId) {
		await saveDocument(currentId, await paplico.exportDocument());
	}

	await paplico.importDocument(handle.file);
	const id = await createDocument(
		handle.file.name.replace(/\.papf$/i, ""),
		await paplico.exportDocument(),
	);
	documentManagerState.currentDocumentId = id;
	setExternalDocumentSession(handle.handle == null ? null : handle);
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
