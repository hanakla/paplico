import { FileSystem } from "@/infra/filesystem";
import type { DocumentsFileIO, FileHandle } from "./documents";

export const tauriFileIO: DocumentsFileIO = {
	async openFile(options) {
		return FileSystem.openFileDialog(options) as Promise<FileHandle | null>;
	},

	async overwriteFile(handle, blob) {
		await FileSystem.overwrite(handle as any, blob);
	},

	async exportFile(blob, filename) {
		await FileSystem.exportFile(blob, filename);
	},

	async fileHandleFromDrop() {
		// Tauri handles native drag-drop via TauriInit.tsx custom events
		return null;
	},
};
