import type { Paplico } from "@paplico/core";
import {
	createEmbeddedImageFile,
	createImageObject,
} from "@paplico/core/document";
import { isGroup } from "@paplico/core/schema";
import type React from "react";
import { toastManager } from "@/components/Toast";
import { confirmCloseDocument } from "@/dialogs/CloseDocumentDialog";
import { LicensesDialog } from "@/dialogs/LicensesDialog";
import { SaveOptionsDialog } from "@/dialogs/SaveOptionsDialog";
import { openableDocumentExtensions } from "@/documentImport";
import { type FileHandle, FileSystem, nativePathOf } from "@/infra/filesystem";
import { useTranslation } from "@/locales";
import {
	DEFAULT_SAVE_OPTIONS,
	type DocumentSaveOptions,
	documentSessionState,
	exportDocumentCopy,
	openDocumentFile,
	overwriteDocumentFile,
	rememberSaveOptions,
	setDocumentFileHandle,
} from "@/stores/documentSessionStore";
import {
	setPixelPreviewEnabled,
	uiState,
	whileLoadingDocument,
} from "@/stores/uiStore";
import { codeFromError, reportError } from "@/utils/errorReporting";
import { useEventCallback } from "@/utils/hooks";

type MenuActions = {
	handleUndo: () => void;
	handleRedo: () => void;
	handleCopy: () => void;
	handleCut: () => void;
	handlePaste: () => void;
	handlePasteToFront: () => void;
	handlePasteToBack: () => void;
	handleDeselectAll: () => void;
	handleGroup: () => void;
	handleUngroup: () => void;
	handleImport: () => Promise<void>;
	handleSaveCopy: () => Promise<void>;
	handleSave: () => Promise<void>;
	handleLoadImageToDocument: () => Promise<void>;
	handleOpenExportDialog: () => void;
	handleOpenDocumentSettingsDialog: () => void;
	handleTogglePixelPreview: () => void;
	handleOpenLicensesDialog: () => void;
	handleReloadApp: () => void;
	handleEmulateDisconnect: () => void;
	handleRunPerfCheck: () => Promise<void>;
	handleCopyLastStroke: () => Promise<void>;
	handleSendLastStroke: () => Promise<void>;
};

export function useMenuActions(
	paplicoRef: React.RefObject<Paplico | null>,
	dialogs: {
		setExportDialogOpen: (v: boolean) => void;
		setDocumentSettingsDialogOpen: (v: boolean) => void;
	},
): MenuActions {
	const t = useTranslation();

	const handleUndo = useEventCallback(() => {
		paplicoRef.current?.commands.undo();
	});

	const handleRedo = useEventCallback(() => {
		paplicoRef.current?.commands.redo();
	});

	const handleCopy = useEventCallback(() => {
		paplicoRef.current?.shortcuts.executeCommand("paplico.copy");
	});

	const handleCut = useEventCallback(() => {
		paplicoRef.current?.shortcuts.executeCommand("paplico.cut");
	});

	// Menu-triggered paste cannot rely on the browser `paste` event,
	// so it routes to the same command as Paste to Front.
	const handlePaste = useEventCallback(() => {
		paplicoRef.current?.shortcuts.executeCommand("paplico.pasteToFront");
	});

	const handlePasteToFront = useEventCallback(() => {
		paplicoRef.current?.shortcuts.executeCommand("paplico.pasteToFront");
	});

	const handlePasteToBack = useEventCallback(() => {
		paplicoRef.current?.shortcuts.executeCommand("paplico.pasteToBack");
	});

	const handleDeselectAll = useEventCallback(() => {
		paplicoRef.current?.shortcuts.executeCommand("paplico.deselectAll");
	});

	const handleGroup = useEventCallback(() => {
		const p = paplicoRef.current;
		if (!p) return;
		const selectedIds = p.uiState.selectedElementIds;
		if (selectedIds.length >= 2) {
			p.commands.groupSelectedElements(selectedIds);
		}
	});

	const handleUngroup = useEventCallback(() => {
		const p = paplicoRef.current;
		if (!p) return;
		const selectedIds = p.uiState.selectedElementIds;
		if (selectedIds.length !== 1) return;

		const layerId = p.uiState.currentLayerId;
		if (!layerId) return;

		const layer = p.uiState.document.layers.find((l) => l.id === layerId);
		if (!layer) return;

		const element = p.uiState.document.objects[selectedIds[0]];
		if (element && isGroup(element)) {
			p.commands.ungroupElements(element.id);
		}
	});

	/**
	 * Saves the document to a file the user picks. Only a save that is not a
	 * copy makes that file, and the options chosen for it, the document's own.
	 */
	const saveToPickedFile = useEventCallback(async (asCopy: boolean) => {
		try {
			const p = paplicoRef.current;
			if (!p) return;

			const target = await pickSaveTarget(!asCopy);
			if (!target) return;

			const { handle, saveOptions, filename } = target;
			if (!handle) {
				await FileSystem.exportFile(
					await exportDocumentCopy(p, saveOptions, null),
					filename,
				);
				if (!asCopy) rememberSaveOptions(saveOptions);
				return;
			}

			if (asCopy) {
				await FileSystem.overwrite(
					handle,
					await exportDocumentCopy(p, saveOptions, nativePathOf(handle)),
				);
			} else {
				await overwriteDocumentFile(p, handle, saveOptions);
				setDocumentFileHandle(handle, saveOptions);
			}
			toastManager.add({
				title: t("menubar.documentSaved", { name: handle.file.name }),
				type: "success",
			});
		} catch (cause) {
			reportError({
				code: "SAVE_FAILED",
				cause,
				action: {
					labelKey: "errors.retryAction",
					onClick: () => saveToPickedFile(asCopy),
				},
			});
		}
	});

	const handleSaveCopy = useEventCallback(() => saveToPickedFile(true));

	const handleSave = useEventCallback(async () => {
		const p = paplicoRef.current;
		if (!p) return;

		const handle = documentSessionState.fileHandle;
		if (!handle) {
			await saveToPickedFile(false);
			return;
		}

		const toastId = toastManager.add({
			title: t("menubar.savingDocument"),
			type: "loading",
		});

		try {
			await overwriteDocumentFile(p, handle);
			toastManager.update(toastId, {
				title: t("menubar.documentSaved", { name: handle.file.name }),
				type: "success",
			});
		} catch (error) {
			toastManager.close(toastId);
			reportError({ code: "SAVE_FAILED", cause: error });
			await saveToPickedFile(false);
		}
	});

	const handleImport = useEventCallback(async () => {
		const p = paplicoRef.current;
		if (!p || !(await confirmCloseDocument(p))) return;

		const result = await FileSystem.openFileDialog({
			id: "papf-open",
			types: [
				{
					description: "Paplico",
					accept: { "application/octet-stream": openableDocumentExtensions() },
				},
			],
		});
		if (!result) return;

		try {
			await whileLoadingDocument(() => openDocumentFile(p, result));
		} catch (error) {
			reportError({
				code: codeFromError(error, "IMPORT_FAILED"),
				cause: error,
			});
		}
	});

	const handleLoadImageToDocument = useEventCallback(async () => {
		const p = paplicoRef.current;
		if (!p) return;

		const handle = await FileSystem.openFileDialog({
			id: "document-image-import",
			types: [
				{
					description: "Image Files",
					accept: { "image/*": [".png", ".jpg", ".jpeg", ".webp"] },
				},
			],
		});
		if (!handle) return;

		const bitmap = await createImageBitmap(handle.file);
		const { width, height } = bitmap;
		bitmap.close();

		const embeddedFile = await createEmbeddedImageFile(handle.file);
		const fileUid = p.commands.addEmbeddedFile(embeddedFile);

		p.commands.addImage(
			createImageObject({ fileUid, x: 0, y: 0, width, height }),
		);
	});

	const handleOpenExportDialog = useEventCallback(() => {
		const p = paplicoRef.current;
		if (!p) return;
		if (p.uiState.document.artboards.length === 0) {
			alert(t("page.noArtboardsAlert"));
			return;
		}
		dialogs.setExportDialogOpen(true);
	});

	const handleOpenDocumentSettingsDialog = useEventCallback(() => {
		dialogs.setDocumentSettingsDialogOpen(true);
	});

	const handleTogglePixelPreview = useEventCallback(() => {
		const next = !uiState.pixelPreviewEnabled;
		setPixelPreviewEnabled(next);
		paplicoRef.current?.setPixelPreview(next);
	});

	const handleOpenLicensesDialog = useEventCallback(() => {
		LicensesDialog.call();
	});

	const handleReloadApp = useEventCallback(() => {
		globalThis.location?.reload();
	});

	const handleEmulateDisconnect = useEventCallback(() => {
		paplicoRef.current?.getCollaboration()?.simulateDisconnect();
	});

	const handleRunPerfCheck = useEventCallback(async () => {
		const p = paplicoRef.current;
		if (!p) return;
		// Dynamic import keeps the dev profiler out of the production bundle.
		const { runPerfCheck } = await import("@/devtools/perfCheck");
		const result = await runPerfCheck(p);
		if (!result) return;
		try {
			const res = await fetch("/api/dev/perf-result", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(result),
			});
			const { saved } = await res.json();
			console.log(`[perf] result sent: ${saved}`);
		} catch (e) {
			console.error("[perf] failed to send result:", e);
		}
	});

	const handleCopyLastStroke = useEventCallback(async () => {
		const p = paplicoRef.current;
		if (!p) return;
		// Dynamic import keeps the dev-only capture out of the production bundle.
		const { copyLastStrokeToClipboard } = await import(
			"@/devtools/copyLastStroke"
		);
		const copied = await copyLastStrokeToClipboard(p);
		console.log(
			copied
				? "[devtools] last stroke copied to clipboard"
				: "[devtools] no pen stroke to copy",
		);
	});

	const handleSendLastStroke = useEventCallback(async () => {
		const p = paplicoRef.current;
		if (!p) return;
		// Dynamic import keeps the dev-only capture out of the production bundle.
		const { sendLastStrokeToServer } = await import(
			"@/devtools/strokeRecorder"
		);
		try {
			const saved = await sendLastStrokeToServer(p);
			console.log(
				saved
					? `[stroke] recorded: ${saved}`
					: "[stroke] no pen stroke to record",
			);
		} catch (error) {
			console.error("[stroke] failed to record:", error);
		}
	});

	return {
		handleUndo,
		handleRedo,
		handleCopy,
		handleCut,
		handlePaste,
		handlePasteToFront,
		handlePasteToBack,
		handleDeselectAll,
		handleGroup,
		handleUngroup,
		handleImport,
		handleSaveCopy,
		handleSave,
		handleLoadImageToDocument,
		handleOpenExportDialog,
		handleOpenDocumentSettingsDialog,
		handleTogglePixelPreview,
		handleOpenLicensesDialog,
		handleReloadApp,
		handleEmulateDisconnect,
		handleRunPerfCheck,
		handleCopyLastStroke,
		handleSendLastStroke,
	};
}

/**
 * Lets the user pick where the document goes and what the file holds.
 * `handle` is `null` where the platform only hands files over as a
 * download, under `filename`. There, `reuseSaveOptions` downloads with the
 * options the document already has instead of asking again. `null` means
 * the user called it off.
 */
async function pickSaveTarget(reuseSaveOptions: boolean): Promise<{
	handle: FileHandle | null;
	saveOptions: DocumentSaveOptions;
	filename: string;
} | null> {
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const filename = `paplico-${timestamp}.papf`;

	if (!FileSystem.canRequestSaveFile()) {
		const known = reuseSaveOptions ? documentSessionState.saveOptions : null;
		const saveOptions = known ?? (await askSaveOptions());
		return saveOptions && { handle: null, saveOptions, filename };
	}

	const handle = await FileSystem.requestSaveFile(filename);
	if (!handle) return null;

	const saveOptions = await askSaveOptions();
	return saveOptions && { handle, saveOptions, filename };
}

/** Asks for save options, starting from the ones the document has. */
function askSaveOptions(): Promise<DocumentSaveOptions | null> {
	return SaveOptionsDialog.call({
		saveOptions: documentSessionState.saveOptions ?? DEFAULT_SAVE_OPTIONS,
	});
}
