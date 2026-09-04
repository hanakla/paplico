"use client";

import {
	Bot,
	Check,
	ClipboardCopy,
	ClipboardPaste,
	Copy,
	FileDown,
	FilePlus,
	FileUp,
	FolderOpen,
	Gamepad2,
	Gauge,
	Grid2x2,
	Group,
	ImageDown,
	ImagePlus,
	Link,
	MonitorSmartphone,
	PanelLeftClose,
	Redo,
	RotateCcw,
	Scissors,
	ScrollText,
	Settings,
	Share2,
	Timer,
	Undo,
	Ungroup,
	Unplug,
	Upload,
	X as XIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { proxy, useSnapshot } from "valtio";
import { AutoSaveRing } from "@/components/AutoSaveRing";
import { Menu } from "@/components/Menu";
import { Menubar } from "@/components/Menubar";
import type { Paplico } from "@/core/Paplico";
import { LicensesDialog } from "@/dialogs/LicensesDialog";
import { useCurrentCanvasTargetResolver } from "@/hooks/useCurrentCanvasTarget";
import { useLayoutMode } from "@/hooks/useLayoutMode";
import { useMenuActions } from "@/hooks/useMenuActions";
import { useShortcutBinding } from "@/hooks/useShortcutBinding";
import { useTranslation } from "@/locales";
import { RoomParticipants } from "@/organisms/RoomParticipants";
import { UserMenu } from "@/organisms/UserMenu";
import { setPixelPreviewEnabled, useUIState } from "@/stores/uiStore";
import { useEventCallback } from "@/utils/hooks";
import { IS_TAURI_ENV } from "@/utils/platform";
import { twm } from "@/utils/tailwind";

export function DesktopMenuBar({
	paplico,
	connectedRoomId,
	isRoomOwner,
	isEncryptedRoom,
	onOpenExportDialog,
	onOpenDocumentSettingsDialog,
	onCloseRoom,
	onStopDeviceSharing,
	onOpenPublishRoomDialog,
	onOpenConnectOtherDevicesDialog,
	onOpenCompanionDialog,
	onOpenCompanionPanel,
	onOpenConnectRoomDialog,
	onOpenPreferencesDialog,
	onOpenAutomationDialog,
	onOpenDocumentListDialog,
	onNewDocument,
	onOpenTimelapseDialog,
	isSplitView,
	onToggleSplitView,
}: {
	paplico: Paplico | null;
	connectedRoomId: string | null;
	isRoomOwner: boolean;
	isEncryptedRoom: boolean;
	onOpenExportDialog: () => void;
	onOpenDocumentSettingsDialog: () => void;
	onCloseRoom: () => void;
	onStopDeviceSharing: () => void;
	onOpenPublishRoomDialog: () => void;
	onOpenConnectOtherDevicesDialog: () => void;
	onOpenCompanionDialog: () => void;
	onOpenCompanionPanel: () => void;
	onOpenConnectRoomDialog: () => void;
	onOpenPreferencesDialog: () => void;
	onOpenAutomationDialog: () => void;
	onOpenDocumentListDialog: () => void;
	onNewDocument: () => void;
	onOpenTimelapseDialog: () => void;

	isSplitView: boolean;
	onToggleSplitView: () => void;
}) {
	const layoutMode = useLayoutMode();
	const t = useTranslation();
	const { getCurrentCanvasTarget } = useCurrentCanvasTargetResolver();

	// Subscribe to uiState so canUndo/canRedo/selectedElementIds drive
	// menu disabled state. Fall back to an empty proxy when paplico is not yet
	// initialised so the hook order stays stable.
	const fallbackUiState = useMemo(
		() =>
			proxy({
				canUndo: false,
				canRedo: false,
				selectedElementIds: [] as string[],
			}),
		[],
	);
	const uiState = useSnapshot(paplico?.uiState ?? fallbackUiState);
	const appUiState = useUIState();

	const undoShortcut = useShortcutBinding("paplico.undo");
	const redoShortcut = useShortcutBinding("paplico.redo");
	const copyShortcut = useShortcutBinding("paplico.copy");
	const cutShortcut = useShortcutBinding("paplico.cut");
	const pasteShortcut = useShortcutBinding("paplico.paste");
	const pasteToFrontShortcut = useShortcutBinding("paplico.pasteToFront");
	const pasteToBackShortcut = useShortcutBinding("paplico.pasteToBack");
	const groupShortcut = useShortcutBinding("paplico.group");
	const ungroupShortcut = useShortcutBinding("paplico.ungroup");
	const resetZoomShortcut = useShortcutBinding("paplico.resetZoom");

	const paplicoRef = useRef<Paplico | null>(paplico);
	useEffect(() => {
		paplicoRef.current = paplico;
	}, [paplico]);

	const {
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
		handleLoadImageToDocument,
	} = useMenuActions(paplicoRef, {
		setExportDialogOpen: () => onOpenExportDialog(),
		setDocumentSettingsDialogOpen: () => onOpenDocumentSettingsDialog(),
		setExportingMessage: () => {},
	});

	const handleEmulateDisconnect = useEventCallback(() => {
		paplico?.getCollaboration()?.simulateDisconnect();
	});

	const handleRunPerfCheck = useEventCallback(async () => {
		if (!paplico) return;
		// Dynamic import keeps the dev profiler out of the production bundle.
		const { runPerfCheck } = await import("@/devtools/perfCheck");
		const result = await runPerfCheck(paplico);
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
		if (!paplico) return;
		// Dynamic import keeps the dev-only capture out of the production bundle.
		const { copyLastStrokeToClipboard } = await import(
			"@/devtools/copyLastStroke"
		);
		const copied = await copyLastStrokeToClipboard(paplico);
		console.log(
			copied
				? "[devtools] last stroke copied to clipboard"
				: "[devtools] no pen stroke to copy",
		);
	});

	const handleSendLastStroke = useEventCallback(async () => {
		if (!paplico) return;
		// Dynamic import keeps the dev-only capture out of the production bundle.
		const { sendLastStrokeToServer } = await import(
			"@/devtools/strokeRecorder"
		);
		try {
			const saved = await sendLastStrokeToServer(paplico);
			console.log(
				saved
					? `[stroke] recorded: ${saved}`
					: "[stroke] no pen stroke to record",
			);
		} catch (error) {
			console.error("[stroke] failed to record:", error);
		}
	});

	const handleTogglePixelPreview = useEventCallback(() => {
		const next = !appUiState.pixelPreviewEnabled;
		setPixelPreviewEnabled(next);
		paplico?.setPixelPreview(next);
	});

	const handleReloadApp = useEventCallback(() => {
		globalThis.location?.reload();
	});

	const handleOpenLicensesDialog = useEventCallback(() => {
		LicensesDialog.call();
	});

	if (layoutMode !== "desktop") return null;

	return (
		<div
			data-tauri-drag-region
			className={twm(
				"min-h-10 bg-background/80 backdrop-liquid flex items-center px-3 pointer-events-auto pt-safe-top",
				"tauri-mac:pl-18",
			)}
		>
			<div className="flex items-center gap-1.5 mr-4"></div>

			<Menubar.Root>
				<Menubar.Menu
					trigger={
						<span className="text-foreground font-semibold text-sm">
							Paplico
						</span>
					}
				>
					{/* Reaching your own other devices */}
					<Menubar.Item
						onClick={onOpenConnectOtherDevicesDialog}
						disabled={connectedRoomId !== null && !isRoomOwner}
					>
						<MonitorSmartphone size={16} />
						{t("connectRoomDialog.connectOtherDevices")}
					</Menubar.Item>
					{isEncryptedRoom && (
						<Menubar.Item onClick={onStopDeviceSharing}>
							<Unplug size={16} />
							{t("connectRoomDialog.stopConnecting")}
						</Menubar.Item>
					)}

					{/* Turning another device into a remote for this one. */}
					<Menubar.Item onClick={onOpenCompanionDialog}>
						<Gamepad2 size={16} />
						{t("companion.title")}
					</Menubar.Item>
					{/* The other way round: this device is the remote. Only offered
					    while connected to someone else's session, since the remote
					    needs a host to point at. */}
					{isEncryptedRoom && !isRoomOwner && (
						<Menubar.Item onClick={onOpenCompanionPanel}>
							<Gamepad2 size={16} />
							{t("companion.useAsCompanion")}
						</Menubar.Item>
					)}

					{/* Working with other people. Ordinary rooms need the room API,
					    which the desktop build has no server to serve. */}
					{!IS_TAURI_ENV && (
						<>
							<Menubar.Separator />
							<Menubar.Item
								onClick={onOpenPublishRoomDialog}
								disabled={connectedRoomId !== null && !isRoomOwner}
							>
								<Share2 size={16} />
								{t("connectRoomDialog.publishRoom")}
							</Menubar.Item>
							<Menubar.Item onClick={onOpenConnectRoomDialog}>
								<Link size={16} />
								{t("connectRoomDialog.connectToRoom")}
							</Menubar.Item>
							{isRoomOwner && !isEncryptedRoom && (
								<Menubar.Item onClick={onCloseRoom}>
									<XIcon size={16} />
									{t("connectRoomDialog.closeRoom")}
								</Menubar.Item>
							)}
						</>
					)}
					<Menubar.Separator />
					<Menubar.Item onClick={onOpenPreferencesDialog} shortcut="⌘,">
						<Settings size={16} />
						{t("preferences.title")}
					</Menubar.Item>
					<Menubar.Item onClick={onOpenAutomationDialog}>
						<Bot size={16} />
						{t("automation.title")}
					</Menubar.Item>
					<Menubar.Separator />
					<Menubar.Item onClick={handleOpenLicensesDialog}>
						<ScrollText size={16} />
						{t("licenses.title")}
					</Menubar.Item>
					<Menubar.Separator />
					<Menubar.Item onClick={handleReloadApp}>
						<Undo size={16} />
						Reload App
					</Menubar.Item>
				</Menubar.Menu>

				<Menubar.Menu trigger={t("menubar.fileMenu")}>
					<Menubar.Item
						onClick={onNewDocument}
						shortcut="⌘N"
						disabled={connectedRoomId != null}
					>
						<FilePlus size={16} />
						{t("menubar.new")}
					</Menubar.Item>
					<Menubar.Separator />
					<Menubar.Item
						onClick={onOpenDocumentListDialog}
						disabled={connectedRoomId != null}
					>
						<FolderOpen size={16} />
						{t("documentList.title")}
					</Menubar.Item>
					<Menubar.Item
						onClick={handleImport}
						shortcut="⌘O"
						disabled={connectedRoomId != null}
					>
						<FileUp size={16} />
						{t("menubar.openDocument")}
					</Menubar.Item>
					<Menubar.Item onClick={handleExport} shortcut="⇧⌘S">
						<FileDown size={16} />
						{t("menubar.saveDocument")}
					</Menubar.Item>
					<Menubar.Item onClick={onOpenExportDialog} shortcut="⇧⌘E">
						<ImageDown size={16} />
						{t("menubar.exportPng")}
					</Menubar.Item>
					<Menubar.Separator />
					<Menubar.Item onClick={handleLoadImageToDocument}>
						<ImagePlus size={16} />
						{t("menubar.loadImage")}
					</Menubar.Item>
					<Menubar.Separator />
					<Menubar.Item onClick={onOpenDocumentSettingsDialog}>
						<Settings size={16} />
						{t("menubar.documentSettings")}
					</Menubar.Item>
					<Menubar.Separator />
					<Menubar.Item onClick={onOpenTimelapseDialog}>
						<Timer size={16} />
						{t("menubar.timelapse")}
					</Menubar.Item>
				</Menubar.Menu>

				<Menubar.Menu trigger={t("menubar.editMenu")}>
					<Menubar.Item
						onClick={handleUndo}
						shortcut={undoShortcut}
						disabled={!uiState.canUndo}
					>
						<Undo size={16} />
						{t("menubar.undo")}
					</Menubar.Item>
					<Menubar.Item
						onClick={handleRedo}
						shortcut={redoShortcut}
						disabled={!uiState.canRedo}
					>
						<Redo size={16} />
						{t("menubar.redo")}
					</Menubar.Item>
					<Menubar.Separator />
					<Menubar.Item
						onClick={handleCopy}
						shortcut={copyShortcut}
						disabled={!paplico || uiState.selectedElementIds.length === 0}
					>
						<Copy size={16} />
						{t("menubar.copy")}
					</Menubar.Item>
					<Menubar.Item
						onClick={handleCut}
						shortcut={cutShortcut}
						disabled={!paplico || uiState.selectedElementIds.length === 0}
					>
						<Scissors size={16} />
						{t("menubar.cut")}
					</Menubar.Item>
					<Menubar.Item onClick={handlePaste} shortcut={pasteShortcut}>
						<ClipboardPaste size={16} />
						{t("menubar.paste")}
					</Menubar.Item>
					<Menubar.Item
						onClick={handlePasteToFront}
						shortcut={pasteToFrontShortcut}
					>
						<ClipboardPaste size={16} />
						{t("menubar.pasteToFront")}
					</Menubar.Item>
					<Menubar.Item
						onClick={handlePasteToBack}
						shortcut={pasteToBackShortcut}
					>
						<ClipboardPaste size={16} />
						{t("menubar.pasteToBack")}
					</Menubar.Item>
					<Menubar.Separator />
					<Menubar.Item onClick={handleGroup} shortcut={groupShortcut}>
						<Group size={16} />
						{t("menubar.group")}
					</Menubar.Item>
					<Menubar.Item onClick={handleUngroup} shortcut={ungroupShortcut}>
						<Ungroup size={16} />
						{t("menubar.ungroup")}
					</Menubar.Item>
				</Menubar.Menu>
				<Menubar.Menu trigger={t("menubar.viewMenu")}>
					<Menubar.Item
						onClick={() => {
							const target = paplico ? getCurrentCanvasTarget(paplico) : null;
							if (target) {
								target.setViewport({ zoom: 1.0, rotation: 0 });
							}
						}}
						shortcut={resetZoomShortcut}
						disabled={!paplico}
					>
						<RotateCcw size={16} />
						{t("menubar.resetRotationAndZoom")}
					</Menubar.Item>
					<Menubar.Separator />
					<Menubar.Item onClick={handleTogglePixelPreview} disabled={!paplico}>
						<Grid2x2 size={16} />
						{t("menubar.pixelPreview")}
						{appUiState.pixelPreviewEnabled && <Check size={16} />}
					</Menubar.Item>
					<Menubar.Separator />
					<Menubar.Item
						onClick={onToggleSplitView}
						shortcut="⌘\"
						disabled={!paplico}
					>
						<PanelLeftClose size={16} />
						{t("menubar.splitView")}
						{isSplitView && <Check size={16} />}
					</Menubar.Item>
				</Menubar.Menu>
				{process.env.NODE_ENV === "development" && (
					<Menubar.Menu trigger={t("menubar.devMenu")}>
						<Menu.SubmenuRoot>
							<Menu.SubmenuTrigger disabled={connectedRoomId == null}>
								{t("menubar.chatSubmenu")}
							</Menu.SubmenuTrigger>
							<Menu.Portal>
								<Menu.Positioner sideOffset={4}>
									<Menu.Popup>
										<Menu.Item onClick={handleEmulateDisconnect}>
											{t("menubar.emulateDisconnect")}
										</Menu.Item>
									</Menu.Popup>
								</Menu.Positioner>
							</Menu.Portal>
						</Menu.SubmenuRoot>
						<Menubar.Item onClick={handleRunPerfCheck} disabled={!paplico}>
							<Gauge size={16} />
							{t("menubar.runPerfCheck")}
						</Menubar.Item>
						<Menubar.Item onClick={handleCopyLastStroke} disabled={!paplico}>
							<ClipboardCopy size={16} />
							{t("menubar.copyLastStroke")}
						</Menubar.Item>
						<Menubar.Item onClick={handleSendLastStroke} disabled={!paplico}>
							<Upload size={16} />
							{t("menubar.sendLastStroke")}
						</Menubar.Item>
					</Menubar.Menu>
				)}
			</Menubar.Root>

			<div className="flex items-center gap-2 ml-auto shrink-0 self-center">
				<AutoSaveRing />
				<RoomParticipants
					connectedRoomId={connectedRoomId}
					isOwner={isRoomOwner}
				/>
				<UserMenu
					roomRole={
						connectedRoomId != null
							? isRoomOwner
								? "owner"
								: "member"
							: undefined
					}
				/>
			</div>
		</div>
	);
}
