import type { Paplico } from "@paplico/core";
import { generateUid } from "@paplico/core/schema";
import { proxy, ref } from "valtio";
import {
	findDocumentImporter,
	openableDocumentExtension,
} from "@/documentImport";
import { setLastDocumentId } from "@/hooks/useAppConfig";
import { type FileHandle, FileSystem, nativePathOf } from "@/infra/filesystem";
import {
	resolveLinkedSourcePath,
	toLinkedSourcePath,
} from "@/infra/linkedFiles.tauri";
import {
	documentManagerState,
	saveDocument,
	upsertDocument,
} from "./documentStore";

type DocumentSessionSource =
	| { kind: "initial" }
	| { kind: "internal"; documentId: string }
	| { kind: "external" }
	| { kind: "snapshot" }
	| { kind: "room" };

/** What a document file holds beyond the document itself. */
export interface DocumentSaveOptions {
	/** Write the timelapse recording into the file. */
	timelapse: boolean;
	/**
	 * Keep linked images linked to the files they came from. Otherwise the
	 * file holds only their bytes.
	 */
	keepLinks: boolean;
}

interface DocumentSession {
	identity: string;
	source: DocumentSessionSource;
	fileHandle: FileHandle | null;
	/**
	 * What saves of this document write, once the user chose them or the file
	 * it was opened from carried them. `null` until then.
	 */
	saveOptions: DocumentSaveOptions | null;
	/** Edits made since the document was last read from or written to its file. */
	hasUnsavedFileChanges: boolean;
	revision: number;
}

export const DEFAULT_SAVE_OPTIONS: DocumentSaveOptions = {
	timelapse: true,
	keepLinks: true,
};

/** Version of what `appData.paplico` in a document file holds. */
const PAPLICO_APP_DATA_SCHEMA = 1;

/**
 * Save options chosen for each document while the app runs, by document id,
 * so returning to a document brings its choice back.
 */
const sessionSaveOptions = new Map<string, DocumentSaveOptions>();

// The native FileSystemFileHandle breaks when Valtio wraps it, so handles are stored with ref().
export const documentSessionState = proxy<DocumentSession>({
	identity: crypto.randomUUID(),
	source: { kind: "initial" },
	fileHandle: null,
	saveOptions: null,
	hasUnsavedFileChanges: false,
	revision: 0,
});

export function setInternalDocumentSession(documentId: string): void {
	replaceDocumentSession(
		{ kind: "internal", documentId },
		null,
		sessionSaveOptions.get(documentId) ?? null,
	);
}

export function setExternalDocumentSession(
	fileHandle: FileHandle | null,
): void {
	replaceDocumentSession({ kind: "external" }, fileHandle, null);
}

export function setSnapshotDocumentSession(): void {
	replaceDocumentSession({ kind: "snapshot" }, null, null);
}

/**
 * Marks the document as one received from a room this device joined. It is
 * not the document `currentDocumentId` names, so auto save leaves it alone
 * until another document is opened.
 */
export function setRoomDocumentSession(): void {
	replaceDocumentSession({ kind: "room" }, null, null);
}

/**
 * Makes a file the document was just written to the target of manual saves,
 * along with the options it was written with. The document stays the same,
 * so the session identity is kept.
 */
export function setDocumentFileHandle(
	fileHandle: FileHandle,
	saveOptions: DocumentSaveOptions,
): void {
	documentSessionState.fileHandle = ref(fileHandle);
	documentSessionState.hasUnsavedFileChanges = false;
	rememberSaveOptions(saveOptions);
}

/**
 * Keeps the save options chosen for the open document, for later saves and
 * for when the user returns to it while the app runs.
 */
export function rememberSaveOptions(saveOptions: DocumentSaveOptions): void {
	documentSessionState.saveOptions = saveOptions;

	const { source } = documentSessionState;
	if (source.kind !== "internal" && source.kind !== "external") return;

	const documentId = documentManagerState.currentDocumentId;
	if (documentId) sessionSaveOptions.set(documentId, saveOptions);
}

/**
 * Writes the document over the file manual saves target. Linked files are
 * stored relative to the folder of that file.
 */
export async function overwriteDocumentFile(
	paplico: Paplico,
	fileHandle: FileHandle,
	saveOptions = documentSessionState.saveOptions ?? DEFAULT_SAVE_OPTIONS,
): Promise<void> {
	const path = nativePathOf(fileHandle);
	if (path !== null) rebaseLinkedFilePaths(paplico, documentPath(), path);

	// Cleared before exporting so edits made during the write mark the file again
	documentSessionState.hasUnsavedFileChanges = false;
	try {
		await FileSystem.overwrite(
			fileHandle,
			await paplico.exportDocumentFile(documentExportOptions(saveOptions)),
		);
	} catch (error) {
		documentSessionState.hasUnsavedFileChanges = true;
		throw error;
	}
}

/**
 * Serializes the document for a file at `filePath` other than the one manual
 * saves target. Linked files are written relative to the folder of that file,
 * while the document keeps its own paths.
 */
export function exportDocumentCopy(
	paplico: Paplico,
	saveOptions: DocumentSaveOptions,
	filePath: string | null,
): Promise<Blob> {
	const fromPath = documentPath();

	return paplico.exportDocumentFile(
		documentExportOptions(saveOptions, (sourcePath) =>
			rebasedSourcePath(sourcePath, fromPath, filePath),
		),
	);
}

/**
 * Rewrites the stored source paths for a document file at `nextDocumentPath`,
 * so they start at its folder. Returns whether any path changed.
 */
function rebaseLinkedFilePaths(
	paplico: Paplico,
	previousDocumentPath: string | null,
	nextDocumentPath: string,
): boolean {
	let rebased = false;

	for (const file of paplico.uiState.document.files) {
		if (!file.sourcePath) continue;

		const sourcePath = rebasedSourcePath(
			file.sourcePath,
			previousDocumentPath,
			nextDocumentPath,
		);
		if (sourcePath === file.sourcePath) continue;

		paplico.commands.setEmbeddedFileSourcePath(file.uid, sourcePath);
		rebased = true;
	}

	return rebased;
}

/** The native path of the document file, known only to the desktop build. */
export function documentPath(): string | null {
	return nativePathOf(documentSessionState.fileHandle);
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
	const importer = findDocumentImporter(file.name);
	const appData = await paplico.importDocument(
		importer ? await importer.convert(file, paplico.fonts) : file,
	);
	const id = paplico.uiState.document.id || generateUid("doc");
	await upsertDocument(
		id,
		documentNameFromFile(file),
		await paplico.exportDocument(),
	);
	documentManagerState.currentDocumentId = id;
	// A converted file is never the save target: saving would replace it with
	// a papf under the other application's extension.
	setExternalDocumentSession(
		importer || source instanceof File || source.handle == null ? null : source,
	);
	const saveOptions = saveOptionsFromAppData(appData);
	if (saveOptions) rememberSaveOptions(saveOptions);
	setLastDocumentId(id);
}

/** Names a document after the file it was opened from or saved to. */
export function documentNameFromFile(file: File): string {
	const extension = openableDocumentExtension(file.name);
	return extension ? file.name.slice(0, -extension.length) : file.name;
}

function replaceDocumentSession(
	source: DocumentSessionSource,
	fileHandle: FileHandle | null,
	saveOptions: DocumentSaveOptions | null,
): void {
	documentSessionState.identity = crypto.randomUUID();
	documentSessionState.source = source;
	documentSessionState.fileHandle = fileHandle && ref(fileHandle);
	documentSessionState.saveOptions = saveOptions;
	documentSessionState.hasUnsavedFileChanges = false;
	documentSessionState.revision++;
}

/**
 * A stored source path rewritten to start at the folder of `nextDocumentPath`.
 * A relative path with no document file to start from stays as it is.
 */
function rebasedSourcePath(
	sourcePath: string,
	previousDocumentPath: string | null,
	nextDocumentPath: string | null,
): string {
	const path = resolveLinkedSourcePath(sourcePath, previousDocumentPath);
	return path === null
		? sourcePath
		: toLinkedSourcePath(path, nextDocumentPath);
}

/**
 * What `exportDocumentFile` takes to write a file with `saveOptions`. A kept
 * link is written as `keptSourcePath` returns it, or as stored without it.
 */
function documentExportOptions(
	saveOptions: DocumentSaveOptions,
	keptSourcePath?: (sourcePath: string) => string,
): Parameters<Paplico["exportDocumentFile"]>[0] {
	return {
		timelapse: saveOptions.timelapse,
		rewriteSourcePath: saveOptions.keepLinks ? keptSourcePath : () => undefined,
		appData: {
			paplico: { schema: PAPLICO_APP_DATA_SCHEMA, saveOptions },
		},
	};
}

/**
 * The save options a document file was written with. A file anyone could
 * have written may hold anything there, so only well-formed options of a
 * known schema come back.
 */
function saveOptionsFromAppData(
	appData: Record<string, unknown> | null,
): DocumentSaveOptions | null {
	const paplico = appData?.paplico;
	if (typeof paplico !== "object" || paplico === null) return null;
	if (!("schema" in paplico) || paplico.schema !== PAPLICO_APP_DATA_SCHEMA) {
		return null;
	}
	if (!("saveOptions" in paplico)) return null;

	const { saveOptions } = paplico;
	if (typeof saveOptions !== "object" || saveOptions === null) return null;
	if (!("timelapse" in saveOptions) || !("keepLinks" in saveOptions)) {
		return null;
	}

	const { timelapse, keepLinks } = saveOptions;
	return typeof timelapse === "boolean" && typeof keepLinks === "boolean"
		? { timelapse, keepLinks }
		: null;
}
