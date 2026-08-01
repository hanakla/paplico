import {
	Bot,
	Check,
	ChevronDown,
	FileDown,
	FilePlus,
	FileUp,
	FolderOpen,
	Gamepad2,
	Group,
	ImageDown,
	ImagePlus,
	Link,
	MonitorSmartphone,
	PanelLeftClose,
	Redo,
	RotateCcw,
	Settings,
	Share2,
	Timer,
	Undo,
	Ungroup,
	Unplug,
	XIcon,
} from "lucide-react";
import { memo, type ReactNode, useEffect, useRef } from "react";
import { Accordion } from "@/components/Accordion";
import type { Paplico } from "@/core/Paplico";
import { useCurrentCanvasTargetResolver } from "@/hooks/useCurrentCanvasTarget";
import { useMenuActions } from "@/hooks/useMenuActions";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";
import { IS_TAURI_ENV } from "@/utils/platform";

type MobileMenuProps = {
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
	onOpenTimelapseDialog,
	isSplitView,
	onToggleSplitView,
	onClose,
}: MobileMenuProps & { onClose: () => void }) {
	const t = useTranslation();
	const { getCurrentCanvasTarget } = useCurrentCanvasTargetResolver();

	const paplicoRef = useRef<Paplico | null>(paplico);
	useEffect(() => {
		paplicoRef.current = paplico;
	}, [paplico]);

	const {
		handleUndo,
		handleRedo,
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

	const wrap = (action: () => void) => () => {
		action();
		onClose();
	};
	const handlePublishRoom = useEventCallback(wrap(onOpenPublishRoomDialog));
	const handleConnectOtherDevices = useEventCallback(
		wrap(onOpenConnectOtherDevicesDialog),
	);
	const handleCompanionDialog = useEventCallback(wrap(onOpenCompanionDialog));
	const handleCompanionPanel = useEventCallback(wrap(onOpenCompanionPanel));
	const handleCloseRoomAction = useEventCallback(wrap(onCloseRoom));
	const handleStopDeviceSharing = useEventCallback(wrap(onStopDeviceSharing));
	const handleConnectRoom = useEventCallback(wrap(onOpenConnectRoomDialog));
	const handlePreferences = useEventCallback(wrap(onOpenPreferencesDialog));
	const handleAutomation = useEventCallback(wrap(onOpenAutomationDialog));
	const handleDocumentList = useEventCallback(wrap(onOpenDocumentListDialog));
	const handleImportAndClose = useEventCallback(wrap(handleImport));
	const handleExportAndClose = useEventCallback(wrap(handleExport));
	const handleExportDialog = useEventCallback(wrap(onOpenExportDialog));
	const handleLoadImage = useEventCallback(wrap(handleLoadImageToDocument));
	const handleDocSettings = useEventCallback(
		wrap(onOpenDocumentSettingsDialog),
	);
	const handleTimelapse = useEventCallback(wrap(onOpenTimelapseDialog));
	const handleUndoAndClose = useEventCallback(wrap(handleUndo));
	const handleRedoAndClose = useEventCallback(wrap(handleRedo));
	const handleGroupAndClose = useEventCallback(wrap(handleGroup));
	const handleUngroupAndClose = useEventCallback(wrap(handleUngroup));
	const handleReloadApp = useEventCallback(() => {
		location.reload();
	});
	const handleResetViewport = useEventCallback(() => {
		const target = paplico ? getCurrentCanvasTarget(paplico) : null;
		if (target) {
			target.setViewport({ zoom: 1.0, rotation: 0 });
		}
		onClose();
	});
	const handleSplitView = useEventCallback(() => {
		onToggleSplitView();
		onClose();
	});

	return (
		<Accordion.Root multiple defaultValue={[]}>
			<MenuSection value="paplico" label="Paplico">
				{/* Reaching your own other devices */}
				<button
					type="button"
					className="flex items-center gap-3 px-4 min-h-11 text-sm hover:bg-accent transition-colors"
					onClick={handleConnectOtherDevices}
					disabled={connectedRoomId !== null && !isRoomOwner}
				>
					<MonitorSmartphone size={16} />
					{t("connectRoomDialog.connectOtherDevices")}
				</button>
				{isEncryptedRoom && (
					<button
						type="button"
						className="flex items-center gap-3 px-4 min-h-11 text-sm hover:bg-accent transition-colors"
						onClick={handleStopDeviceSharing}
					>
						<Unplug size={16} />
						{t("connectRoomDialog.stopConnecting")}
					</button>
				)}

				{/* Turning another device into a remote for this one. */}
				<button
					type="button"
					className="flex items-center gap-3 px-4 min-h-11 text-sm hover:bg-accent transition-colors"
					onClick={handleCompanionDialog}
				>
					<Gamepad2 size={16} />
					{t("companion.title")}
				</button>
				{/* The other way round: this device is the remote. Only offered while
				    connected to someone else's session, since the remote needs a host
				    to point at. */}
				{isEncryptedRoom && !isRoomOwner && (
					<button
						type="button"
						className="flex items-center gap-3 px-4 min-h-11 text-sm hover:bg-accent transition-colors"
						onClick={handleCompanionPanel}
					>
						<Gamepad2 size={16} />
						{t("companion.useAsCompanion")}
					</button>
				)}

				{/* Working with other people. Ordinary rooms need the room API, which
			    the desktop build has no server to serve. */}
				{!IS_TAURI_ENV && (
					<>
						<div className="my-1 border-t border-border/30" />
						<button
							type="button"
							className="flex items-center gap-3 px-4 min-h-11 text-sm hover:bg-accent transition-colors"
							onClick={handlePublishRoom}
							disabled={connectedRoomId !== null && !isRoomOwner}
						>
							<Share2 size={16} />
							{t("connectRoomDialog.publishRoom")}
						</button>
						<button
							type="button"
							className="flex items-center gap-3 px-4 min-h-11 text-sm hover:bg-accent transition-colors"
							onClick={handleConnectRoom}
						>
							<Link size={16} />
							{t("connectRoomDialog.connectToRoom")}
						</button>
						{isRoomOwner && !isEncryptedRoom && (
							<button
								type="button"
								className="flex items-center gap-3 px-4 min-h-11 text-sm hover:bg-accent transition-colors"
								onClick={handleCloseRoomAction}
							>
								<XIcon size={16} />
								{t("connectRoomDialog.closeRoom")}
							</button>
						)}
						<div className="my-1 border-t border-border/30" />
					</>
				)}
				<button
					type="button"
					className="flex items-center gap-3 px-4 min-h-11 text-sm hover:bg-accent transition-colors"
					onClick={handlePreferences}
				>
					<Settings size={16} />
					{t("preferences.title")}
				</button>
				<button
					type="button"
					className="flex items-center gap-3 px-4 min-h-11 text-sm hover:bg-accent transition-colors"
					onClick={handleAutomation}
				>
					<Bot size={16} />
					{t("automation.title")}
				</button>
				<button
					type="button"
					className="flex items-center gap-3 px-4 min-h-11 text-sm hover:bg-accent transition-colors"
					onClick={handleReloadApp}
				>
					<Undo size={16} />
					Reload App
				</button>
			</MenuSection>

			<MenuSection value="file" label={t("menubar.fileMenu")}>
				<button
					type="button"
					className="flex items-center gap-3 px-4 min-h-11 text-sm hover:bg-accent transition-colors disabled:opacity-50"
					disabled={connectedRoomId != null}
					onClick={async () => {
						if (await confirm(t("menubar.saveAndCloseConfirm"))) {
							window.location.replace(window.location.pathname);
						}
					}}
				>
					<FilePlus size={16} />
					{t("menubar.new")}
				</button>
				<button
					type="button"
					className="flex items-center gap-3 px-4 min-h-11 text-sm hover:bg-accent transition-colors disabled:opacity-50"
					disabled={connectedRoomId != null}
					onClick={handleDocumentList}
				>
					<FolderOpen size={16} />
					{t("documentList.title")}
				</button>
				<button
					type="button"
					className="flex items-center gap-3 px-4 min-h-11 text-sm hover:bg-accent transition-colors disabled:opacity-50"
					disabled={connectedRoomId != null}
					onClick={handleImportAndClose}
				>
					<FileUp size={16} />
					{t("menubar.openDocument")}
				</button>
				<button
					type="button"
					className="flex items-center gap-3 px-4 min-h-11 text-sm hover:bg-accent transition-colors"
					onClick={handleExportAndClose}
				>
					<FileDown size={16} />
					{t("menubar.saveDocument")}
				</button>
				<button
					type="button"
					className="flex items-center gap-3 px-4 min-h-11 text-sm hover:bg-accent transition-colors"
					onClick={handleExportDialog}
				>
					<ImageDown size={16} />
					{t("menubar.exportPng")}
				</button>
				<button
					type="button"
					className="flex items-center gap-3 px-4 min-h-11 text-sm hover:bg-accent transition-colors"
					onClick={handleLoadImage}
				>
					<ImagePlus size={16} />
					{t("menubar.loadImage")}
				</button>
				<button
					type="button"
					className="flex items-center gap-3 px-4 min-h-11 text-sm hover:bg-accent transition-colors"
					onClick={handleDocSettings}
				>
					<Settings size={16} />
					{t("menubar.documentSettings")}
				</button>
				<button
					type="button"
					className="flex items-center gap-3 px-4 min-h-11 text-sm hover:bg-accent transition-colors"
					onClick={handleTimelapse}
				>
					<Timer size={16} />
					{t("menubar.timelapse")}
				</button>
			</MenuSection>

			<MenuSection value="edit" label={t("menubar.editMenu")}>
				<button
					type="button"
					className="flex items-center gap-3 px-4 min-h-11 text-sm hover:bg-accent transition-colors disabled:opacity-40 disabled:pointer-events-none"
					onClick={handleUndoAndClose}
					disabled={!paplico?.uiState.canUndo}
				>
					<Undo size={16} />
					{t("menubar.undo")}
				</button>
				<button
					type="button"
					className="flex items-center gap-3 px-4 min-h-11 text-sm hover:bg-accent transition-colors disabled:opacity-40 disabled:pointer-events-none"
					onClick={handleRedoAndClose}
					disabled={!paplico?.uiState.canRedo}
				>
					<Redo size={16} />
					{t("menubar.redo")}
				</button>
				<button
					type="button"
					className="flex items-center gap-3 px-4 min-h-11 text-sm hover:bg-accent transition-colors"
					onClick={handleGroupAndClose}
				>
					<Group size={16} />
					{t("menubar.group")}
				</button>
				<button
					type="button"
					className="flex items-center gap-3 px-4 min-h-11 text-sm hover:bg-accent transition-colors"
					onClick={handleUngroupAndClose}
				>
					<Ungroup size={16} />
					{t("menubar.ungroup")}
				</button>
			</MenuSection>

			<MenuSection value="view" label={t("menubar.viewMenu")}>
				<button
					type="button"
					className="flex items-center gap-3 px-4 min-h-11 text-sm hover:bg-accent transition-colors disabled:opacity-40 disabled:pointer-events-none"
					onClick={handleResetViewport}
					disabled={!paplico}
				>
					<RotateCcw size={16} />
					{t("menubar.resetRotationAndZoom")}
				</button>
				<button
					type="button"
					className="flex items-center gap-3 px-4 min-h-11 text-sm hover:bg-accent transition-colors disabled:opacity-40 disabled:pointer-events-none"
					onClick={handleSplitView}
					disabled={!paplico}
				>
					<PanelLeftClose size={16} />
					{t("menubar.splitView")}
					{isSplitView && <Check size={16} className="ml-auto" />}
				</button>
			</MenuSection>
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
