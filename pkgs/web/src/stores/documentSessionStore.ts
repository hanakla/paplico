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
 * Opens a document from a file. The file stays the target of manual saves;
 * a copy in IndexedDB gives it auto save and revisions.
 */
export async function openDocumentFile(
	paplico: Paplico,
	file: File,
	handle: FileHandle | null,
): Promise<void> {
	const currentId = documentManagerState.currentDocumentId;
	if (currentId) {
		await saveDocument(currentId, await paplico.exportDocument());
	}

	await paplico.importDocument(file);
	const id = await createDocument(
		file.name.replace(/\.papf$/i, ""),
		await paplico.exportDocument(),
	);
	documentManagerState.currentDocumentId = id;
	setExternalDocumentSession(handle);
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
