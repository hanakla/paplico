import type { Paplico } from "@paplico/core";
import { fireEvent, render } from "@testing-library/react";
import { setLanguage } from "@/hooks/useAppConfig";
import { type FileHandle, FileSystem } from "@/infra/filesystem";
import {
	documentSessionState,
	setExternalDocumentSession,
	setInternalDocumentSession,
} from "@/stores/documentSessionStore";
import {
	CloseDocumentDialog,
	confirmCloseDocument,
} from "./CloseDocumentDialog";

vi.mock("@/infra/filesystem", () => ({
	FileSystem: { overwrite: vi.fn() },
}));

describe("confirmCloseDocument", () => {
	beforeEach(() => {
		setLanguage("en");
		vi.mocked(FileSystem.overwrite).mockReset();
	});

	it("should close a document without a file without asking", async () => {
		const view = render(<CloseDocumentDialog.Root />);
		setInternalDocumentSession("internal-document");
		documentSessionState.hasUnsavedFileChanges = true;

		expect(await confirmCloseDocument(createPaplico())).toBe(true);
		expect(view.queryByText("Close Without Saving")).toBeNull();
	});

	it("should close a document whose file is up to date without asking", async () => {
		const view = render(<CloseDocumentDialog.Root />);
		setExternalDocumentSession(createFileHandle("drawing.papf"));

		expect(await confirmCloseDocument(createPaplico())).toBe(true);
		expect(view.queryByText("Close Without Saving")).toBeNull();
	});

	it("should keep the document open when the user cancels", async () => {
		const view = render(<CloseDocumentDialog.Root />);
		openEditedFile("drawing.papf");

		const closing = confirmCloseDocument(createPaplico());
		await view.findByText("Save changes to drawing.papf?");
		fireEvent.click(view.getByText("Cancel"));

		expect(await closing).toBe(false);
		expect(FileSystem.overwrite).not.toHaveBeenCalled();
	});

	it("should close without writing the file when the user declines to save", async () => {
		const view = render(<CloseDocumentDialog.Root />);
		openEditedFile("drawing.papf");

		const closing = confirmCloseDocument(createPaplico());
		fireEvent.click(await view.findByText("Close Without Saving"));

		expect(await closing).toBe(true);
		expect(FileSystem.overwrite).not.toHaveBeenCalled();
	});

	it("should write the file before closing when the user saves", async () => {
		const view = render(<CloseDocumentDialog.Root />);
		const handle = openEditedFile("drawing.papf");

		const closing = confirmCloseDocument(createPaplico());
		fireEvent.click(await view.findByText("Save and Close"));

		expect(await closing).toBe(true);
		expect(vi.mocked(FileSystem.overwrite).mock.calls[0][0]).toBe(handle);
		expect(documentSessionState.hasUnsavedFileChanges).toBe(false);
	});

	it("should keep the document open when writing the file fails", async () => {
		vi.mocked(FileSystem.overwrite).mockRejectedValue(new Error("denied"));
		const view = render(<CloseDocumentDialog.Root />);
		openEditedFile("drawing.papf");

		const closing = confirmCloseDocument(createPaplico());
		fireEvent.click(await view.findByText("Save and Close"));

		expect(await closing).toBe(false);
		expect(documentSessionState.hasUnsavedFileChanges).toBe(true);
	});
});

function openEditedFile(name: string): FileHandle {
	const handle = createFileHandle(name);
	setExternalDocumentSession(handle);
	documentSessionState.hasUnsavedFileChanges = true;
	return handle;
}

function createFileHandle(name: string): FileHandle {
	return {
		handle: `/documents/${name}`,
		file: new File([], name),
	} as FileHandle;
}

function createPaplico(): Paplico {
	return {
		exportDocumentFile: async () => new Blob(),
	} as unknown as Paplico;
}
