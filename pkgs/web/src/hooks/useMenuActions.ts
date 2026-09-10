import type React from "react";
import {
	createEmbeddedImageFile,
	createImageObject,
} from "@/core/document/factory";
import type { Paplico } from "@/core/Paplico";
import { isGroup } from "@/core/schema";
import { FileSystem } from "@/infra/filesystem";
import { useTranslation } from "@/locales";
import {
	documentSessionState,
	setExternalDocumentSession,
} from "@/stores/documentSessionStore";
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
	handleGroup: () => void;
	handleUngroup: () => void;
	handleImport: () => Promise<void>;
	handleExport: () => Promise<void>;
	handleSave: () => Promise<void>;
	handleLoadImageToDocument: () => Promise<void>;
	handleOpenExportDialog: () => void;
	handleOpenDocumentSettingsDialog: () => void;
};

export function useMenuActions(
	paplicoRef: React.RefObject<Paplico | null>,
	dialogs: {
		setExportDialogOpen: (v: boolean) => void;
		setDocumentSettingsDialogOpen: (v: boolean) => void;
		setExportingMessage: (v: string | null) => void;
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

	const handleExport = useEventCallback(async () => {
		try {
			const blob = await paplicoRef.current?.exportDocument();
			if (!blob) return;

			const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
			const url = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			a.download = `paplico-${timestamp}.papf`;
			a.click();
			URL.revokeObjectURL(url);
		} catch (cause) {
			reportError({
				code: "EXPORT_FAILED",
				cause,
				// handleExport is a stable useEventCallback reference, safe to self-reference
				action: { labelKey: "errors.retryAction", onClick: handleExport },
			});
		}
	});

	const handleSave = useEventCallback(async () => {
		const handle = documentSessionState.fileHandle;
		if (!handle) {
			await handleExport();
			return;
		}

		const blob = await paplicoRef.current?.exportDocument();
		if (!blob) return;

		try {
			await FileSystem.overwrite(handle, blob);
		} catch (error) {
			console.error("Failed to overwrite file:", error);
			await handleExport();
		}
	});

	const handleImport = useEventCallback(async () => {
		const discard = await confirm(t("menubar.saveAndCloseConfirm"));
		if (!discard) return;

		const result = await FileSystem.openFileDialog({
			id: "papf-open",
			types: [
				{
					description: "Paplico",
					accept: { "application/octet-stream": [".papf"] },
				},
			],
		});
		if (!result) return;

		try {
			await paplicoRef.current?.importDocument(result.file);
			setExternalDocumentSession(result);
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

	return {
		handleUndo,
		handleRedo,
		handleCopy,
		handleCut,
		handlePaste,
		handlePasteToFront,
		handlePasteToBack,
		handleGroup,
		handleUngroup,
		handleImport,
		handleExport,
		handleSave,
		handleLoadImageToDocument,
		handleOpenExportDialog,
		handleOpenDocumentSettingsDialog,
	};
}
