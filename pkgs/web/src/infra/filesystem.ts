import type { Brand } from "@/core/utils/lang";
import { IS_TAURI_ENV } from "@/utils/platform";

declare const FILE_HANDLE_SYMBOL: unique symbol;
export type FileHandle = Brand<typeof FILE_HANDLE_SYMBOL> & {
	handle: any;
	file: File;
};

interface IFileSystem {
	canOpenFileDialog(): boolean;
	openFileDialog(option: {
		id?: string;
		types?: FilePickerAcceptType[];
	}): Promise<FileHandle | null>;
	overwrite(handle: FileHandle, blob: Blob): Promise<void>;
	exportFile(blob: Blob, filename: string): Promise<void>;
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
		const { readFile } = await import("@tauri-apps/plugin-fs");

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

		const path = result;
		const data = await readFile(path);
		const name = path.split("/").pop() ?? path;
		const file = new File([data], name);

		return { handle: path, file } as FileHandle;
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

		if (!path) return;

		const bytes = new Uint8Array(await blob.arrayBuffer());
		await writeFile(path, bytes);
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
