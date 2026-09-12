import type { ConfirmDialog } from "./confirmDialog";

export const webConfirmDialog: ConfirmDialog = async (message) =>
	globalThis.confirm(message);
