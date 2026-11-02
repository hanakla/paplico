import type { Paplico } from "@paplico/core";
import { createCallable } from "react-call";
import { AlertDialog } from "@/components/AlertDialog";
import { Button } from "@/components/Button";
import { toastManager } from "@/components/Toast";
import { translateStatic, useTranslation } from "@/locales";
import {
	documentSessionState,
	overwriteDocumentFile,
} from "@/stores/documentSessionStore";
import { reportError } from "@/utils/errorReporting";
import { useEventCallback } from "@/utils/hooks";

type CloseDocumentChoice = "save" | "discard" | "cancel";

/**
 * Settles whether the open document may be closed. The app keeps its own copy
 * either way, so the user is asked only when the file is behind the edits.
 */
export async function confirmCloseDocument(paplico: Paplico): Promise<boolean> {
	const { fileHandle, hasUnsavedFileChanges } = documentSessionState;
	if (!fileHandle || !hasUnsavedFileChanges) return true;

	const fileName = fileHandle.file.name;
	const choice = await CloseDocumentDialog.call({ fileName });
	if (choice !== "save") return choice === "discard";

	try {
		await overwriteDocumentFile(paplico, fileHandle);
		toastManager.add({
			title: translateStatic("menubar.documentSaved", { name: fileName }),
			type: "success",
		});
		return true;
	} catch (cause) {
		reportError({ code: "SAVE_FAILED", cause });
		return false;
	}
}

export const CloseDocumentDialog = createCallable<
	{ fileName: string },
	CloseDocumentChoice
>(({ call, fileName }) => {
	const t = useTranslation();

	const handleSave = useEventCallback(() => call.end("save"));
	const handleDiscard = useEventCallback(() => call.end("discard"));
	const handleCancel = useEventCallback(() => call.end("cancel"));
	const handleOpenChange = useEventCallback((open: boolean) => {
		if (!open) call.end("cancel");
	});

	return (
		<AlertDialog.Root open onOpenChange={handleOpenChange}>
			<AlertDialog.Portal>
				<AlertDialog.Backdrop />
				<AlertDialog.Popup>
					<AlertDialog.Title>
						{t("closeDocumentDialog.title", { name: fileName })}
					</AlertDialog.Title>
					<AlertDialog.Description>
						{t("closeDocumentDialog.description")}
					</AlertDialog.Description>
					<div className="flex items-center gap-2">
						<Button
							$variant="ghost"
							$size="sm"
							className="mr-auto"
							onClick={handleDiscard}
						>
							{t("closeDocumentDialog.discard")}
						</Button>
						<Button $variant="ghost" $size="sm" onClick={handleCancel}>
							{t("common.cancel")}
						</Button>
						<Button $variant="default" $size="sm" onClick={handleSave}>
							{t("closeDocumentDialog.save")}
						</Button>
					</div>
				</AlertDialog.Popup>
			</AlertDialog.Portal>
		</AlertDialog.Root>
	);
});
