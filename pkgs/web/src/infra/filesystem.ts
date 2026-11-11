import type { Brand } from "@paplico/core/utils";
import { IS_TAURI_ENV } from "@/utils/platform";

declare const FILE_HANDLE_SYMBOL: unique symbol;
export type FileHandle = Brand<typeof FILE_HANDLE_SYMBOL> & {
	/** `null` when the platform hands over only the file, which cannot be written back. */
	handle: any;
	file: File;
};

/** One file to write out: the encoded bytes and the name to save them under. */
export interface ExportedFile {
	blob: Blob;
	filename: string;
}

/** Writes one exported file where the user asked the export to go. */
export type ExportFileWriter = (file: ExportedFile) => Promise<void>;

interface IFileSystem {
	canOpenFileDialog(): boolean;
	openFileDialog(option: {
		id?: string;
		types?: FilePickerAcceptType[];
	}): Promise<FileHandle | null>;
	overwrite(handle: FileHandle, blob: Blob): Promise<void>;
	/**
	 * Writes a file to a place the user picks. The result is a handle that
	 * later saves can overwrite, or `null` when the user called it off or the
	 * platform only hands the file over as a download.
	 */
	exportFile(blob: Blob, filename: string): Promise<FileHandle | null>;
	/**
	 * Settles where a batch of exported files goes before the first one is
	 * rendered. `null` means the user called the export off.
	 */
	requestExportDestination(
		documentHandle: FileHandle | null,
	): Promise<ExportFileWriter | null>;
	fileHandleFromDrop(
		item: DataTransferItem,
		file: File,
	): Promise<FileHandle | null>;
}

const tauriFS: IFileSystem = new (class TauriFS implements IFileSystem {
	public canOpenFileDialog() {
		return true;
	}

	public async openFileDialog({ types }) {
		const { open } = await import("@tauri-apps/plugin-dialog");

		const extensions = types?.flatMap((t) => {
			if (!t.accept) return [];
			return Object.values(t.accept).flatMap((exts): string[] => {
				const arr = Array.isArray(exts) ? exts : [exts];
				return arr.map((e) => e.replace(/^\./, ""));
			});
		});

		const result = await open({
			multiple: false,
			filters: extensions?.length ? [{ name: "Files", extensions }] : undefined,
		});

		if (!result) return null;

		return tauriFileHandleFromPath(result);
	}

	public async overwrite(handle, blob: Blob) {
		const { writeFile } = await import("@tauri-apps/plugin-fs");
		const bytes = new Uint8Array(await blob.arrayBuffer());
		await writeFile(handle.handle as string, bytes);
	}

	public async exportFile(blob: Blob, filename: string) {
		const { save } = await import("@tauri-apps/plugin-dialog");
		const { writeFile } = await import("@tauri-apps/plugin-fs");

		const path = await save({
			defaultPath: filename,
			filters: [
				{
					name: "Paplico",
					extensions: [filename.split(".").pop() ?? "papf"],
				},
			],
		});

		if (!path) return null;

		const bytes = new Uint8Array(await blob.arrayBuffer());
		await writeFile(path, bytes);

		const name = path.split("/").pop() ?? path;
		return { handle: path, file: new File([bytes], name) } as FileHandle;
	}

	public async requestExportDestination(documentHandle: FileHandle | null) {
		const { open } = await import("@tauri-apps/plugin-dialog");

		const directory = await open({
			directory: true,
			defaultPath:
				(await resolveDefaultExportDirectory(documentHandle)) ?? undefined,
		});
		if (typeof directory !== "string") return null;

		// Writing is permitted because the folder came back from the dialog,
		// which grants the filesystem scope for it
		return async (file: ExportedFile) => {
			const { join } = await import("@tauri-apps/api/path");
			const { writeFile } = await import("@tauri-apps/plugin-fs");

			const bytes = new Uint8Array(await file.blob.arrayBuffer());
			await writeFile(await join(directory, file.filename), bytes);
		};
	}

	public async fileHandleFromDrop() {
		return null;
	}
})();

const domFS: IFileSystem = new (class DomFS implements IFileSystem {
	public canOpenFileDialog() {
		return true;
	}

	public async openFileDialog({ id, types }) {
		// Safari, including installed web apps on iPad, has no showOpenFilePicker
		if (!("showOpenFilePicker" in window)) {
			const file = await pickFileWithInput(types);
			return file && ({ handle: null, file } as FileHandle);
		}

		const [result] = await showOpenFilePicker({ id, types });
		if (!result) return null;

		return {
			handle: result,
			file: await result.getFile(),
		} as FileHandle;
	}

	public async overwrite(handle, blob: Blob) {
		const writable = await (
			handle.handle as FileSystemFileHandle
		).createWritable({});
		await writable.write(blob);
		await writable.close();
	}

	public async exportFile(blob: Blob, filename: string) {
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = filename;
		a.click();
		URL.revokeObjectURL(url);
		return null;
	}

	// The browser has no folder to name, so there is nothing to ask about
	public async requestExportDestination() {
		return async (file: ExportedFile) => {
			await this.exportFile(file.blob, file.filename);
		};
	}

	public async fileHandleFromDrop(item: DataTransferItem, file: File) {
		if (!("getAsFileSystemHandle" in item)) return null;

		try {
			const handle = await item.getAsFileSystemHandle();
			if (handle?.kind !== "file") return null;
			return { handle, file } as FileHandle;
		} catch {
			return null;
		}
	}
})();

export const FileSystem: IFileSystem = IS_TAURI_ENV ? tauriFS : domFS;

/** Reads a native path into a handle that later saves can overwrite. */
export async function tauriFileHandleFromPath(
	path: string,
): Promise<FileHandle> {
	const { readFile } = await import("@tauri-apps/plugin-fs");
	const data = await readFile(path);
	const name = path.split("/").pop() ?? path;

	return { handle: path, file: new File([data], name) } as FileHandle;
}

export async function domFSFileHandleFromTransferItem(
	item: DataTransferItem,
	file: File,
): Promise<FileHandle | null> {
	if (!("getAsFileSystemHandle" in item)) return null;

	try {
		const handle = await item.getAsFileSystemHandle();
		if (handle?.kind !== "file") return null;
		return { handle, file } as FileHandle;
	} catch {
		return null;
	}
}

/** Opens the folder holding a saved file, with the file selected. */
export async function tauriRevealFileInFolder(
	handle: FileHandle,
): Promise<void> {
	const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
	await revealItemInDir(handle.handle as string);
}

/** Lets the user pick one file through a file input. `null` means the user called it off. */
function pickFileWithInput(
	types: FilePickerAcceptType[] = [],
): Promise<File | null> {
	const input = document.createElement("input");
	input.type = "file";
	// MIME types stay in the list because iOS greys out every file when it
	// cannot map an unknown extension such as .papf to a file type
	input.accept = types
		.flatMap(({ accept = {} }) => Object.entries(accept).flat(2))
		.join(",");

	return new Promise((resolve) => {
		input.addEventListener("change", () => resolve(input.files?.[0] ?? null));
		input.addEventListener("cancel", () => resolve(null));
		input.click();
	});
}

/**
 * Picks the folder the export dialog opens on: the one holding the document,
 * then the download folder, then the documents folder.
 */
async function resolveDefaultExportDirectory(
	documentHandle: FileHandle | null,
): Promise<string | null> {
	const { dirname, documentDir, downloadDir } = await import(
		"@tauri-apps/api/path"
	);

	const documentPath = documentHandle?.handle;
	if (typeof documentPath === "string") {
		try {
			return await dirname(documentPath);
		} catch {
			// A document that never came from a file leaves the folder unresolved
		}
	}

	for (const resolve of [downloadDir, documentDir]) {
		try {
			return await resolve();
		} catch {
			// Not every platform has both folders
		}
	}

	return null;
}
