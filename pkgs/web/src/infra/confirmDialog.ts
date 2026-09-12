import { IS_TAURI_ENV } from "@/utils/platform";
import { tauriConfirmDialog } from "./confirmDialog.tauri";
import { webConfirmDialog } from "./confirmDialog.web";

/** Asks the user to confirm through the dialog the platform provides. */
export type ConfirmDialog = (message: string) => Promise<boolean>;

export const confirmDialog: ConfirmDialog = IS_TAURI_ENV
	? tauriConfirmDialog
	: webConfirmDialog;
