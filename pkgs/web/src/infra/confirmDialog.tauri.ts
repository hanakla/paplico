import type { ConfirmDialog } from "./confirmDialog";

// The webview points `window.confirm` at a command the dialog plugin does not
// register, so the confirmation goes through the plugin API instead
export const tauriConfirmDialog: ConfirmDialog = async (message) => {
	const { confirm } = await import("@tauri-apps/plugin-dialog");
	return confirm(message);
};
