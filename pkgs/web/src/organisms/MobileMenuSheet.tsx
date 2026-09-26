import type { Paplico } from "@paplico/core";
import {
	Bot,
	Check,
	ChevronDown,
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
	Save,
	Scissors,
	ScrollText,
	Settings,
	Share2,
	SquareDashed,
	Timer,
	Undo,
	Ungroup,
	Unplug,
	Upload,
	XIcon,
} from "lucide-react";
import { memo, type ReactNode, useEffect, useRef } from "react";
import { useSnapshot } from "valtio";
import { Accordion } from "@/components/Accordion";
import { useCurrentCanvasTargetResolver } from "@/hooks/useCurrentCanvasTarget";
import { useMenuActions } from "@/hooks/useMenuActions";
import { useTranslation } from "@/locales";
import { documentSessionState } from "@/stores/documentSessionStore";
import { useUIState } from "@/stores/uiStore";
import { IS_TAURI_ENV } from "@/utils/platform";

type MobileMenuProps = {
	paplico: Paplico;
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
};

export namespace MobileMenuSheet {
	export type Props = MobileMenuProps;
}

export const MobileMenuSheet = memo(function MobileMenuSheet({
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
	onClose,
}: MobileMenuProps & { onClose: () => void }) {
	const t = useTranslation();
	const { getCurrentCanvasTarget } = useCurrentCanvasTargetResolver();
	const uiState = useSnapshot(paplico.uiState);
	const { fileHandle } = useSnapshot(documentSessionState);
	const appUiState = useUIState();

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
		handleDeselectAll,
		handleGroup,
		handleUngroup,
		handleImport,
		handleExport,
		handleSave,
		handleLoadImageToDocument,
		handleTogglePixelPreview,
		handleOpenLicensesDialog,
		handleReloadApp,
		handleEmulateDisconnect,
		handleRunPerfCheck,
		handleCopyLastStroke,
		handleSendLastStroke,
	} = useMenuActions(paplicoRef, {
		setExportDialogOpen: () => onOpenExportDialog(),
		setDocumentSettingsDialogOpen: () => onOpenDocumentSettingsDialog(),
	});

	const hasSelection = uiState.selectedElementIds.length > 0;

	const handleResetViewport = () => {
		getCurrentCanvasTarget(paplico)?.setViewport({ zoom: 1.0, rotation: 0 });
	};

	// Every item dismisses the full-screen sheet so the result is visible.
	const item = (action: () => void) => () => {
		action();
		onClose();
	};

	return (
		<Accordion.Root multiple defaultValue={[]}>
			<MenuSection value="paplico" label="Paplico">
				{/* Reaching your own other devices */}
				<MenuItem
					onClick={item(onOpenConnectOtherDevicesDialog)}
					disabled={connectedRoomId !== null && !isRoomOwner}
				>
					<MonitorSmartphone size={16} />
					{t("connectRoomDialog.connectOtherDevices")}
				</MenuItem>
				{isEncryptedRoom && (
					<MenuItem onClick={item(onStopDeviceSharing)}>
						<Unplug size={16} />
						{t("connectRoomDialog.stopConnecting")}
					</MenuItem>
				)}

				{/* Turning another device into a remote for this one. */}
				<MenuItem onClick={item(onOpenCompanionDialog)}>
					<Gamepad2 size={16} />
					{t("companion.title")}
				</MenuItem>
				{/* The other way round: this device is the remote. Only offered while
				    connected to someone else's session, since the remote needs a host
				    to point at. */}
				{isEncryptedRoom && !isRoomOwner && (
					<MenuItem onClick={item(onOpenCompanionPanel)}>
						<Gamepad2 size={16} />
						{t("companion.useAsCompanion")}
					</MenuItem>
				)}

				{/* Working with other people. Ordinary rooms need the room API, which
				    the desktop build has no server to serve. */}
				{!IS_TAURI_ENV && (
					<>
						<MenuSeparator />
						<MenuItem
							onClick={item(onOpenPublishRoomDialog)}
							disabled={connectedRoomId !== null && !isRoomOwner}
						>
							<Share2 size={16} />
							{t("connectRoomDialog.publishRoom")}
						</MenuItem>
						<MenuItem onClick={item(onOpenConnectRoomDialog)}>
							<Link size={16} />
							{t("connectRoomDialog.connectToRoom")}
						</MenuItem>
						{isRoomOwner && !isEncryptedRoom && (
							<MenuItem onClick={item(onCloseRoom)}>
								<XIcon size={16} />
								{t("connectRoomDialog.closeRoom")}
							</MenuItem>
						)}
					</>
				)}
				<MenuSeparator />
				<MenuItem onClick={item(onOpenPreferencesDialog)}>
					<Settings size={16} />
					{t("preferences.title")}
				</MenuItem>
				<MenuItem onClick={item(onOpenAutomationDialog)}>
					<Bot size={16} />
					{t("automation.title")}
				</MenuItem>
				<MenuSeparator />
				<MenuItem onClick={item(handleOpenLicensesDialog)}>
					<ScrollText size={16} />
					{t("licenses.title")}
				</MenuItem>
				<MenuSeparator />
				<MenuItem onClick={handleReloadApp}>
					<Undo size={16} />
					Reload App
				</MenuItem>
			</MenuSection>

			<MenuSection value="file" label={t("menubar.fileMenu")}>
				<MenuItem
					onClick={item(onNewDocument)}
					disabled={connectedRoomId != null}
				>
					<FilePlus size={16} />
					{t("menubar.new")}
				</MenuItem>
				<MenuSeparator />
				<MenuItem
					onClick={item(onOpenDocumentListDialog)}
					disabled={connectedRoomId != null}
				>
					<FolderOpen size={16} />
					{t("documentList.title")}
				</MenuItem>
				<MenuItem
					onClick={item(handleImport)}
					disabled={connectedRoomId != null}
				>
					<FileUp size={16} />
					{t("menubar.openDocument")}
				</MenuItem>
				<MenuItem onClick={item(handleSave)} disabled={fileHandle == null}>
					<Save size={16} />
					{t("menubar.overwriteDocument")}
				</MenuItem>
				<MenuItem onClick={item(handleExport)}>
					<FileDown size={16} />
					{t("menubar.saveDocument")}
				</MenuItem>
				<MenuItem onClick={item(onOpenExportDialog)}>
					<ImageDown size={16} />
					{t("menubar.exportPng")}
				</MenuItem>
				<MenuSeparator />
				<MenuItem onClick={item(handleLoadImageToDocument)}>
					<ImagePlus size={16} />
					{t("menubar.loadImage")}
				</MenuItem>
				<MenuSeparator />
				<MenuItem onClick={item(onOpenDocumentSettingsDialog)}>
					<Settings size={16} />
					{t("menubar.documentSettings")}
				</MenuItem>
				<MenuSeparator />
				<MenuItem onClick={item(onOpenTimelapseDialog)}>
					<Timer size={16} />
					{t("menubar.timelapse")}
				</MenuItem>
			</MenuSection>

			<MenuSection value="edit" label={t("menubar.editMenu")}>
				<MenuItem onClick={item(handleUndo)} disabled={!uiState.canUndo}>
					<Undo size={16} />
					{t("menubar.undo")}
				</MenuItem>
				<MenuItem onClick={item(handleRedo)} disabled={!uiState.canRedo}>
					<Redo size={16} />
					{t("menubar.redo")}
				</MenuItem>
				<MenuSeparator />
				<MenuItem onClick={item(handleCopy)} disabled={!hasSelection}>
					<Copy size={16} />
					{t("menubar.copy")}
				</MenuItem>
				<MenuItem onClick={item(handleCut)} disabled={!hasSelection}>
					<Scissors size={16} />
					{t("menubar.cut")}
				</MenuItem>
				<MenuItem onClick={item(handlePaste)}>
					<ClipboardPaste size={16} />
					{t("menubar.paste")}
				</MenuItem>
				<MenuItem onClick={item(handlePasteToFront)}>
					<ClipboardPaste size={16} />
					{t("menubar.pasteToFront")}
				</MenuItem>
				<MenuItem onClick={item(handlePasteToBack)}>
					<ClipboardPaste size={16} />
					{t("menubar.pasteToBack")}
				</MenuItem>
				<MenuSeparator />
				<MenuItem onClick={item(handleDeselectAll)} disabled={!hasSelection}>
					<SquareDashed size={16} />
					{t("menubar.deselectAll")}
				</MenuItem>
				<MenuSeparator />
				<MenuItem onClick={item(handleGroup)}>
					<Group size={16} />
					{t("menubar.group")}
				</MenuItem>
				<MenuItem onClick={item(handleUngroup)}>
					<Ungroup size={16} />
					{t("menubar.ungroup")}
				</MenuItem>
			</MenuSection>

			<MenuSection value="view" label={t("menubar.viewMenu")}>
				<MenuItem onClick={item(handleResetViewport)}>
					<RotateCcw size={16} />
					{t("menubar.resetRotationAndZoom")}
				</MenuItem>
				<MenuSeparator />
				<MenuItem onClick={item(handleTogglePixelPreview)}>
					<Grid2x2 size={16} />
					{t("menubar.pixelPreview")}
					{appUiState.pixelPreviewEnabled && (
						<Check size={16} className="ml-auto" />
					)}
				</MenuItem>
				<MenuSeparator />
				<MenuItem onClick={item(onToggleSplitView)}>
					<PanelLeftClose size={16} />
					{t("menubar.splitView")}
					{isSplitView && <Check size={16} className="ml-auto" />}
				</MenuItem>
			</MenuSection>

			{process.env.NODE_ENV === "development" && (
				<MenuSection value="dev" label={t("menubar.devMenu")}>
					<MenuItem
						onClick={item(handleEmulateDisconnect)}
						disabled={connectedRoomId == null}
					>
						<Unplug size={16} />
						{t("menubar.emulateDisconnect")}
					</MenuItem>
					<MenuItem onClick={item(handleRunPerfCheck)}>
						<Gauge size={16} />
						{t("menubar.runPerfCheck")}
					</MenuItem>
					<MenuItem onClick={item(handleCopyLastStroke)}>
						<ClipboardCopy size={16} />
						{t("menubar.copyLastStroke")}
					</MenuItem>
					<MenuItem onClick={item(handleSendLastStroke)}>
						<Upload size={16} />
						{t("menubar.sendLastStroke")}
					</MenuItem>
				</MenuSection>
			)}
		</Accordion.Root>
	);
});

/** One collapsible section of the mobile app menu. */
const MenuSection = memo(function MenuSection({
	value,
	label,
	children,
}: {
	value: string;
	label: string;
	children: ReactNode;
}) {
	return (
		<Accordion.Item
			value={value}
			className="border-t border-border/30 first:border-t-0"
		>
			<Accordion.Header className="m-0">
				<Accordion.Trigger className="group flex w-full items-center justify-between px-4 min-h-11 text-xs font-semibold tracking-wider text-muted-foreground transition-colors hover:bg-accent">
					<span>{label}</span>
					<ChevronDown
						size={14}
						className="shrink-0 transition-transform group-data-panel-open:rotate-180"
					/>
				</Accordion.Trigger>
			</Accordion.Header>
			<Accordion.Panel>
				<div className="flex flex-col pb-1">{children}</div>
			</Accordion.Panel>
		</Accordion.Item>
	);
});

/** A touch-sized row in a mobile menu section. */
function MenuItem({
	onClick,
	disabled,
	children,
}: {
	onClick: () => void;
	disabled?: boolean;
	children: ReactNode;
}) {
	return (
		<button
			type="button"
			className="flex items-center gap-3 px-4 min-h-11 text-sm hover:bg-accent transition-colors disabled:opacity-40 disabled:pointer-events-none"
			onClick={onClick}
			disabled={disabled}
		>
			{children}
		</button>
	);
}

function MenuSeparator() {
	return <div className="my-1 border-t border-border/30" />;
}
