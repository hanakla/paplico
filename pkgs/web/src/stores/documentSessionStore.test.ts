import type { FileHandle } from "@/infra/filesystem";
import {
	documentSessionState,
	setExternalDocumentSession,
	setInternalDocumentSession,
	setSnapshotDocumentSession,
} from "./documentSessionStore";

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
});

function createFileHandle(name: string): FileHandle {
	return {
		handle: `/documents/${name}`,
		file: new File([], name),
	} as FileHandle;
}
