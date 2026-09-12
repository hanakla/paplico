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
 * Opens a document from a file. A handle keeps the file as the target of
 * manual saves; a bare file has no such target. A copy in IndexedDB gives
 * the document auto save and revisions either way.
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
	const id = await createDocument(
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
