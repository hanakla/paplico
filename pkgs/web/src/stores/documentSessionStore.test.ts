import type { Paplico } from "@paplico/core";
import type { FileHandle } from "@/infra/filesystem";
import {
	type DocumentSaveOptions,
	documentSessionState,
	exportDocumentCopy,
	openDocumentFile,
	setDocumentFileHandle,
	setExternalDocumentSession,
	setInternalDocumentSession,
	setSnapshotDocumentSession,
} from "./documentSessionStore";
import { documentManagerState } from "./documentStore";

vi.mock("./documentStore", () => ({
	documentManagerState: { currentDocumentId: null },
	saveDocument: vi.fn(),
	upsertDocument: vi.fn(),
}));

vi.mock("@/hooks/useAppConfig", () => ({ setLastDocumentId: vi.fn() }));

const DEFAULT_OPTIONS: DocumentSaveOptions = {
	timelapse: true,
	keepLinks: true,
};

const CHOSEN_OPTIONS: DocumentSaveOptions = {
	timelapse: false,
	keepLinks: false,
};

describe("documentSessionStore", () => {
	it("should clear an external file handle when an internal document opens", () => {
		const handle = createFileHandle("external.papf");
		setExternalDocumentSession(handle);

		setInternalDocumentSession("internal-document");

		expect(documentSessionState.source).toEqual({
			kind: "internal",
			documentId: "internal-document",
		});
		expect(documentSessionState.fileHandle).toBeNull();
	});

	it("should clear a previous file handle when a handle-less file is dropped", () => {
		setExternalDocumentSession(createFileHandle("first.papf"));

		setExternalDocumentSession(null);

		expect(documentSessionState.source).toEqual({ kind: "external" });
		expect(documentSessionState.fileHandle).toBeNull();
	});

	it("should clear an external file handle when a snapshot opens", () => {
		setExternalDocumentSession(createFileHandle("external.papf"));

		setSnapshotDocumentSession();

		expect(documentSessionState.source).toEqual({ kind: "snapshot" });
		expect(documentSessionState.fileHandle).toBeNull();
	});

	it("should change its identity and revision for every document transition", () => {
		const identity = documentSessionState.identity;
		const revision = documentSessionState.revision;

		setInternalDocumentSession("next-document");

		expect(documentSessionState.identity).not.toBe(identity);
		expect(documentSessionState.revision).toBe(revision + 1);
	});

	it("should keep its identity when a saved file becomes the save target", () => {
		setInternalDocumentSession("internal-document");
		const identity = documentSessionState.identity;

		setDocumentFileHandle(createFileHandle("saved.papf"), DEFAULT_OPTIONS);

		expect(documentSessionState.fileHandle?.handle).toBe(
			"/documents/saved.papf",
		);
		expect(documentSessionState.identity).toBe(identity);
	});

	it("should treat a newly opened document as saved to its file", () => {
		documentSessionState.hasUnsavedFileChanges = true;

		setExternalDocumentSession(createFileHandle("opened.papf"));

		expect(documentSessionState.hasUnsavedFileChanges).toBe(false);
	});

	it("should treat the document as saved once it is written to a file", () => {
		setInternalDocumentSession("internal-document");
		documentSessionState.hasUnsavedFileChanges = true;

		setDocumentFileHandle(createFileHandle("saved.papf"), DEFAULT_OPTIONS);

		expect(documentSessionState.hasUnsavedFileChanges).toBe(false);
	});

	it("should keep the save options a file was first saved with", () => {
		setInternalDocumentSession("internal-document");

		setDocumentFileHandle(createFileHandle("saved.papf"), CHOSEN_OPTIONS);

		expect(documentSessionState.saveOptions).toEqual(CHOSEN_OPTIONS);
	});

	it("should have no save options for a file opened without them", () => {
		setDocumentFileHandle(createFileHandle("saved.papf"), CHOSEN_OPTIONS);

		setExternalDocumentSession(createFileHandle("opened.papf"));

		expect(documentSessionState.saveOptions).toBeNull();
	});

	it("should bring back the save options of a document the user returns to", () => {
		documentManagerState.currentDocumentId = "first-document";
		setInternalDocumentSession("first-document");
		setDocumentFileHandle(createFileHandle("first.papf"), CHOSEN_OPTIONS);

		documentManagerState.currentDocumentId = "second-document";
		setInternalDocumentSession("second-document");
		expect(documentSessionState.saveOptions).toBeNull();

		documentManagerState.currentDocumentId = "first-document";
		setInternalDocumentSession("first-document");
		expect(documentSessionState.saveOptions).toEqual(CHOSEN_OPTIONS);
	});
});

describe("openDocumentFile", () => {
	it("should take the save options the file was written with", async () => {
		const paplico = createOpeningPaplico({
			paplico: { schema: 1, saveOptions: CHOSEN_OPTIONS },
		});

		await openDocumentFile(paplico, createFileHandle("opened.papf"));

		expect(documentSessionState.saveOptions).toEqual(CHOSEN_OPTIONS);
	});

	it("should ignore save options of an unknown schema or shape", async () => {
		for (const appData of [
			{ paplico: { schema: 2, saveOptions: CHOSEN_OPTIONS } },
			{ paplico: { schema: 1, saveOptions: { timelapse: "no" } } },
			{ paplico: "options" },
			null,
		]) {
			await openDocumentFile(
				createOpeningPaplico(appData),
				createFileHandle("opened.papf"),
			);

			expect(documentSessionState.saveOptions).toBeNull();
		}
	});
});

describe("exportDocumentCopy", () => {
	it("should write linked paths relative to the copy and leave the document alone", async () => {
		setExternalDocumentSession(createFileHandle("drawing.papf"));
		const paplico = createPaplico();

		await exportDocumentCopy(
			paplico,
			DEFAULT_OPTIONS,
			"/documents/copies/copy.papf",
		);

		const [options] = vi.mocked(paplico.exportDocumentFile).mock.calls[0];
		expect(options?.timelapse).toBe(true);
		expect(options?.rewriteSourcePath?.("img/ref.png")).toBe("../img/ref.png");
		expect(options?.appData).toEqual({
			paplico: { schema: 1, saveOptions: DEFAULT_OPTIONS },
		});
		expect(documentSessionState.fileHandle?.handle).toBe(
			"/documents/drawing.papf",
		);
	});

	it("should write linked images without their links when links are not kept", async () => {
		setExternalDocumentSession(createFileHandle("drawing.papf"));
		const paplico = createPaplico();

		await exportDocumentCopy(paplico, CHOSEN_OPTIONS, "/documents/copy.papf");

		const [options] = vi.mocked(paplico.exportDocumentFile).mock.calls[0];
		expect(options?.timelapse).toBe(false);
		expect(options?.rewriteSourcePath?.("img/ref.png")).toBeUndefined();
	});
});

function createPaplico(): Paplico {
	return {
		exportDocumentFile: vi.fn(async () => new Blob()),
	} as unknown as Paplico;
}

function createOpeningPaplico(
	appData: Record<string, unknown> | null,
): Paplico {
	return {
		importDocument: vi.fn(async () => appData),
		exportDocument: vi.fn(async () => new Blob()),
		uiState: { document: { id: "opened-document" } },
	} as unknown as Paplico;
}

function createFileHandle(name: string): FileHandle {
	return {
		handle: `/documents/${name}`,
		file: new File([], name),
	} as FileHandle;
}
