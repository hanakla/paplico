"use client";

import dynamic from "next/dynamic";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useSnapshot } from "valtio";
import type { TauriFileDropDetail } from "@/app/TauriInit";
import { ToastContainer } from "@/app/ToastContainer";
import { createAutomationScriptRepository } from "@/automation/repository";
import type { AutomationRuntimeFactory } from "@/automation/types";
import { ConfirmDialog } from "@/components/AlertDialog";
import { Resizable } from "@/components/Resizable";
import { PaplicoProvider } from "@/contexts/PaplicoContext";
import { Paplico, TextToolController } from "@/core";
import {
	buildDeepLinkUrl,
	type InviteTarget,
	parseInvite,
	readKeyFromFragment,
} from "@/core/collaboration/inviteUrl";
import { parseSessionCode } from "@/core/collaboration/sessionCode";
import {
	createEmbeddedImageFile,
	createImageObject,
} from "@/core/document/factory";
import { loadDevDocument } from "@/core/document/rendererState";
import { defaultShortcutCommands as Cmds } from "@/core/PaplicoShortcuts";
import type { Artboard } from "@/core/schema";
import { CompanionDialog } from "@/dialogs/CompanionDialog";
import { ConnectRoomDialog } from "@/dialogs/ConnectRoomDialog";
import { DisconnectedDialog } from "@/dialogs/DisconnectedDialog";
import { DocumentListDialog } from "@/dialogs/DocumentListDialog";
import { DocumentSettingsDialog } from "@/dialogs/DocumentSettingsDialog";
import { ExportDialog } from "@/dialogs/ExportDialog";
import { LicensesDialog } from "@/dialogs/LicensesDialog";
import {
	NewDocumentDialog,
	type NewDocumentDialogResult,
} from "@/dialogs/NewDocumentDialog";
import { PreferencesDialog } from "@/dialogs/PreferencesDialog";
import { PublishRoomDialog } from "@/dialogs/PublishRoomDialog";
import { ScanInviteDialog } from "@/dialogs/ScanInviteDialog";
import { SignInDialog } from "@/dialogs/SignInDialog";
import { SpinnerDialog } from "@/dialogs/SpinnerDialog";
import { TimelapseDialog } from "@/dialogs/TimelapseDialog";
import {
	appConfig,
	applyThemeToDOM,
	initAppConfig,
	resolveTouchDrawOffsetScale,
	SIDE_PANEL_MAX_HEIGHT,
	SIDE_PANEL_MIN_HEIGHT,
	type SidePanelId,
	setLastDocumentId,
	setShortcutOverrides,
	setSidePanelHeight,
	useAppConfig,
} from "@/hooks/useAppConfig";
import { useAutoSave } from "@/hooks/useAutoSave";
import { getEncryptedRoomCredentials, useCollab } from "@/hooks/useCollab";
import { useLayoutMode } from "@/hooks/useLayoutMode";
import { useMenuActions } from "@/hooks/useMenuActions";
import { createAutomationFileSystem } from "@/infra/automationFileSystem";
import { getBuiltinProfileBytes } from "@/infra/builtinIccProfiles";
import { runDBMigrations } from "@/infra/dbMigrations";
import { db } from "@/infra/documentDB";
import {
	domFSFileHandleFromTransferItem,
	type FileHandle,
} from "@/infra/filesystem";
import { useTranslation } from "@/locales";
import { ActionsPanel } from "@/organisms/ActionsPanel";
import { CanvasPane } from "@/organisms/CanvasPane";
import { CompanionHost } from "@/organisms/CompanionHost";
import {
	CompanionRemoteModal,
	openCompanionRemote,
} from "@/organisms/CompanionRemoteModal";
import { DesktopMenuBar } from "@/organisms/DesktopMenuBar";
import { EditingScopeBreadcrumb } from "@/organisms/EditingScopeBreadcrumb";
import { FatalErrorOverlay } from "@/organisms/FatalErrorOverlay";
import { FilterPanel } from "@/organisms/FilterPanel";
import { LayerPanel } from "@/organisms/LayerPanel";
import { MobilePanels } from "@/organisms/MobilePanels";
import { NotificationBannerHost } from "@/organisms/NotificationBannerHost";
import { ShiftButtonOverlay } from "@/organisms/ShiftButtonOverlay";
import { SplitViewContainer } from "@/organisms/SplitViewContainer";
import { Toolbar } from "@/organisms/Toolbar";
import { createPaplicoAutomationRuntime } from "@/scripting/runtime";
import {
	documentSessionState,
	setExternalDocumentSession,
	setInternalDocumentSession,
} from "@/stores/documentSessionStore";
import {
	createDocument,
	documentManagerState,
	loadDocumentData,
	saveDocument,
} from "@/stores/documentStore";
import {
	AUTOMATION_PANEL_MAX_WIDTH,
	AUTOMATION_PANEL_MIN_WIDTH,
	setAutomationPanelWidth,
	setBrushDesignerPanelOpen,
	toggleActiveColorTarget,
	uiState,
	useUIState,
} from "@/stores/uiStore";
import { codeFromError, reportError } from "@/utils/errorReporting";
import { useEventCallback, useNotchSide } from "@/utils/hooks";
import { resolveDefaultFontForLanguage } from "@/utils/paplico";
import {
	detectMacOSTauri,
	detectSafariBrowser,
	IS_TAURI_ENV,
} from "@/utils/platform";
import { twm } from "@/utils/tailwind";

const AutomationPanel = dynamic(() => import("@/dialogs/AutomationDialog"), {
	ssr: false,
});
const automationScriptRepository = createAutomationScriptRepository();

export default function Page() {
	const [paplico, setPaplico] = useState<Paplico | null>(null);
	const paplicoRef = useRef<Paplico | null>(null);
	const [primaryTargetId, setPrimaryTargetId] = useState<string | null>(null);
	const [isSplitView, setIsSplitView] = useState(false);
	const initializedRef = useRef(false);
	const [exportDialogOpen, setExportDialogOpen] = useState(false);
	const [documentSettingsDialogOpen, setDocumentSettingsDialogOpen] =
		useState(false);
	const [timelapseDialogOpen, setTimelapseDialogOpen] = useState(false);
	const [connectRoomDialogOpen, setConnectRoomDialogOpen] = useState(false);
	const [preferencesDialogOpen, setPreferencesDialogOpen] = useState(false);
	const [documentListDialogOpen, setDocumentListDialogOpen] = useState(false);
	const [automationDialogOpen, setAutomationDialogOpen] = useState(false);
	const [initialRoomId, setInitialRoomId] = useState<string | null>(null);
	/** Invite carrying a key: connects on its own, no dialog to fill in. */
	const [pendingInvite, setPendingInvite] = useState<InviteTarget | null>(null);
	const [isConnectingDevice, setIsConnectingDevice] = useState(false);

	const appSnap = useAppConfig();
	const uiSnap = useUIState();
	const documentSessionSnap = useSnapshot(documentSessionState);
	const layoutMode = useLayoutMode();
	// The side panel column sits next to the toolbar, so anything floating
	// beside the toolbar has to clear the column's width as well.
	const sidePanelsBesideToolbar =
		layoutMode === "desktop" && appSnap.panelLayout === "together";
	const notchSide = useNotchSide();
	useAutoSave();
	const t = useTranslation();

	const collab = useCollab(paplicoRef);

	useEffect(() => {
		document.documentElement.classList.toggle("safari", detectSafariBrowser());
		document.documentElement.classList.toggle("tauri-mac", detectMacOSTauri());
	}, []);

	useEffect(() => {
		const el = document.documentElement;
		el.classList.toggle("notch-left", notchSide === "left");
		el.classList.toggle("notch-right", notchSide === "right");
	}, [notchSide]);

	// Handle ?room=xxx URL parameter - open connect dialog with prefilled room ID
	useEffect(() => {
		const params = new URLSearchParams(window.location.search);
		const roomParam = params.get("room");
		if (!roomParam) return;

		const encodedRoomKey = readKeyFromFragment(window.location.hash);

		// Hand an encrypted invite over to the installed app when one is there.
		// If no handler claims the scheme the page simply stays put and the web
		// build takes the session instead.
		if (!IS_TAURI_ENV && encodedRoomKey) {
			window.location.href = buildDeepLinkUrl({
				roomId: roomParam,
				encodedKey: encodedRoomKey,
			});
		}

		if (encodedRoomKey) {
			setPendingInvite({ roomId: roomParam, encodedKey: encodedRoomKey });
			return;
		}

		setInitialRoomId(roomParam);
		setConnectRoomDialogOpen(true);
	}, []);

	const handleJoinRoomDeepLink = useEventCallback((e: Event) => {
		const invite = parseInvite((e as CustomEvent<string>).detail);
		if (!invite) return;

		if (invite.encodedKey) {
			setPendingInvite(invite);
			return;
		}

		setInitialRoomId(invite.roomId);
		setConnectRoomDialogOpen(true);
	});

	const connectPendingInvite = useEventCallback(async () => {
		if (!pendingInvite) return;

		const invite = pendingInvite;
		setPendingInvite(null);
		setIsConnectingDevice(true);

		// No display name is asked for: the link exists to reach the sender's own
		// other device, so a name prompt would be a question with no answer.
		const result = await collab.handleConnectRoom(
			invite.roomId,
			"",
			invite.encodedKey,
		);
		setIsConnectingDevice(false);

		if (!result?.error) return;

		// Falling back to the manual dialog keeps a failed link recoverable, but
		// only after saying what went wrong — the dialog alone would just look
		// like the app asking a question it never asked before.
		await DisconnectedDialog.call({
			title: t("connectRoomDialog.connectFailedTitle"),
			description: result.error,
		});
		setInitialRoomId(invite.roomId);
		setConnectRoomDialogOpen(true);
	});

	// Waits for the engine: connecting before it exists silently does nothing.
	// biome-ignore lint/correctness/useExhaustiveDependencies: useEventCallback keeps a stable reference
	useEffect(() => {
		if (!paplico || !pendingInvite) return;
		connectPendingInvite();
	}, [paplico, pendingInvite]);

	// Dispatched by TauriInit when the app is opened through a paplico://join link
	// biome-ignore lint/correctness/useExhaustiveDependencies: useEventCallback keeps a stable reference
	useEffect(() => {
		window.addEventListener("paplico-join-room", handleJoinRoomDeepLink);
		return () =>
			window.removeEventListener("paplico-join-room", handleJoinRoomDeepLink);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	useEffect(() => {
		initAppConfig();
		(async () => {
			await runDBMigrations(db);
		})();
	}, []);

	const createDocumentWithArtboard = useEventCallback(
		async (
			size: { width: number; height: number } | null,
			imageFile?: File,
		) => {
			setDocumentListDialogOpen(false);

			const p = paplicoRef.current;
			if (!p) return;

			// Save current document if exists
			const currentId = documentManagerState.currentDocumentId;
			if (currentId) {
				await saveDocument(currentId, await p.exportDocument());
			}

			const newId = await createDocument("Untitled");
			const data = await loadDocumentData(newId);
			if (!data) return;

			await p.importDocument(data.document);
			documentManagerState.currentDocumentId = newId;
			setInternalDocumentSession(newId);
			setLastDocumentId(newId);

			if (size) {
				const artboard: Artboard = {
					id: `artboard-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
					name: "Artboard 1",
					x: 0,
					y: 0,
					width: size.width,
					height: size.height,
				};

				p.commands.addArtboard(artboard);
			}

			if (imageFile && size) {
				const embeddedFile = await createEmbeddedImageFile(imageFile);
				const fileUid = p.commands.addEmbeddedFile(embeddedFile);

				p.commands.addImage(
					createImageObject({
						fileUid,
						x: 0,
						y: 0,
						width: size.width,
						height: size.height,
					}),
				);
			}
		},
	);

	/** Loads a document the user picked out of the filesystem. */
	const openDocumentFile = useEventCallback(async (handle: FileHandle) => {
		try {
			await paplicoRef.current?.importDocument(handle.file);
			setExternalDocumentSession(handle);
		} catch (error) {
			reportError({
				code: codeFromError(error, "DOCUMENT_OPEN_FAILED"),
				cause: error,
			});
		}
	});

	/** Applies what the new document dialog was closed for. */
	const applyNewDocumentResult = useEventCallback(
		async (result: NewDocumentDialogResult) => {
			const p = paplicoRef.current;
			if (!p) return;

			if (result.action === "openRecents") {
				setDocumentListDialogOpen(true);
				return;
			}

			if (result.action === "openFile") {
				await openDocumentFile(result.handle);
				return;
			}

			if (result.action === "cancel") return;

			await createDocumentWithArtboard(result.size, result.imageFile);

			if (result.hdr?.enabled) {
				p.commands.setHdr({ enabled: true });
			}
			if (result.units) {
				p.commands.setUnits(result.units);
			}
		},
	);

	const handleNewDocument = useEventCallback(async () => {
		const p = paplicoRef.current;
		if (!p) return;
		if (
			!(await ConfirmDialog.call({
				description: t("menubar.saveAndCloseConfirm"),
				confirmLabel: t("menubar.saveAndContinue"),
			}))
		)
			return;

		const result = await NewDocumentDialog.call({
			hdrSupported: p.uiState.hdrSupported,
		});

		try {
			await applyNewDocumentResult(result);
		} catch (cause) {
			reportError({ code: "DOCUMENT_CREATE_FAILED", cause });
		}
	});

	const handlePrimaryCanvasReady = useEventCallback(
		async (canvas: HTMLCanvasElement) => {
			if (initializedRef.current) return;
			initializedRef.current = true;

			const textToolController = new TextToolController(uiState.textEditState);

			try {
				const p = await Paplico.create(canvas, {
					textToolController,
					googleFontsApiKey: process.env.NEXT_PUBLIC_GOOGLE_FONTS_API_KEY,
					getBuiltinProfileBytes,
					filterShortcutEvents: ignoreShortcutsInOptedOutSubtree,
				});
				paplicoRef.current = p;
				window.__paplico = p;
				p.startRendering();
				applyThemeToDOM(appConfig.theme);

				const devDoc = await loadDevDocument();
				if (devDoc) await p.importDocument(devDoc);

				if (appConfig.shortcutOverrides) {
					p.shortcuts.importConfig(appConfig.shortcutOverrides);
				}

				Object.assign(
					p.tools.state.textDefaultStyle,
					resolveDefaultFontForLanguage(appConfig.language),
				);
				p.tools.state.selectStrokeAfterDraw = appConfig.selectStrokeAfterDraw;
				p.tools.state.selectSelectionMode = appConfig.selectSelectionMode;
				p.tools.state.pathEditSelectionMode = appConfig.pathEditSelectionMode;
				p.tools.setPressureCurve(appConfig.pressureCurvePoints);
				p.tools.setTouchDrawOffsetScale(resolveTouchDrawOffsetScale());
				p.tools.setMaxZoomScale(appConfig.maxZoomScale);

				// Skip new document dialog when joining a room via URL parameter
				const roomParam = new URLSearchParams(window.location.search).get(
					"room",
				);

				if (!roomParam && !devDoc) {
					// Show new document dialog repeatedly until a document is loaded,
					// here or by a file the OS handed to the app
					while (
						!documentManagerState.currentDocumentId &&
						documentSessionState.source.kind === "initial"
					) {
						const result = await NewDocumentDialog.call({
							hdrSupported: p.uiState.hdrSupported,
						});

						// Opening hands the choice to another dialog or to a file,
						// neither of which this loop should talk over
						if (
							result.action === "openRecents" ||
							result.action === "openFile"
						) {
							await applyNewDocumentResult(result);
							break;
						}

						try {
							await applyNewDocumentResult(result);
						} catch (cause) {
							// The loop re-opens the dialog while no document is loaded
							reportError({ code: "DOCUMENT_CREATE_FAILED", cause });
						}
					}
				}

				const primary = p.getPrimaryTarget();
				if (primary) setPrimaryTargetId(primary.id);

				setPaplico(p);
			} catch (err) {
				reportError({
					code: codeFromError(err, "PAPLICO_INIT_FAILED"),
					channel: "fatal",
					cause: err,
				});
			}
		},
	);

	// Artboards list for ExportDialog (read directly, not reactive - dialog is opened by user action)
	const artboards = paplico?.uiState.document.artboards ?? [];

	const menuActions = useMenuActions(paplicoRef, {
		setExportDialogOpen,
		setDocumentSettingsDialogOpen,
	});

	const handlePublishRoom = useEventCallback(async (readonly: boolean) => {
		collab.setPublishedReadonly(readonly);
		return collab.handlePublishRoom(false);
	});

	const handleConnectOtherDevices = useEventCallback(
		async (readonly: boolean) => {
			collab.setPublishedReadonly(readonly);
			return collab.handlePublishRoom(true);
		},
	);

	const handleOpenPublishRoomDialog = useEventCallback(() => {
		PublishRoomDialog.call({
			encrypted: false,
			publishedRoomId: collab.publishedRoomId,
			inviteUrl: collab.inviteUrl,
			onPublish: handlePublishRoom,
		});
	});

	const handleOpenConnectOtherDevicesDialog = useEventCallback(() => {
		PublishRoomDialog.call({
			encrypted: true,
			publishedRoomId: collab.publishedRoomId,
			inviteUrl: collab.inviteUrl,
			onPublish: handleConnectOtherDevices,
			onScanCode: handleScanInviteCode,
		});
	});

	const handleScanInviteCode = useEventCallback(async () => {
		const scanned = await ScanInviteDialog.call({});
		if (!scanned) return;

		// The QR carries an invite link, which parseSessionCode reads. What it
		// will not read is an invite to a room with no key, handled below.
		const code = parseSessionCode(scanned);
		if (code?.kind === "room") {
			setPendingInvite({ roomId: code.roomId, encodedKey: code.encodedKey });
			return;
		}

		// A camera reads anything, so only a real invite URL may pass — the bare
		// room id fallback of parseInvite would turn a random QR into garbage.
		const invite = code
			? null
			: URL.canParse(scanned)
				? parseInvite(scanned)
				: null;
		if (!invite) {
			await DisconnectedDialog.call({
				title: t("connectRoomDialog.connectFailedTitle"),
				description: t("connectRoomDialog.scanNotInviteCode"),
			});
			return;
		}

		if (invite.encodedKey) {
			setPendingInvite(invite);
			return;
		}

		setInitialRoomId(invite.roomId);
		setConnectRoomDialogOpen(true);
	});
	const handleOpenCompanionDialog = useEventCallback(() => {
		CompanionDialog.call({});
	});
	const handleOpenCompanionPanel = useEventCallback(() => {
		const credentials = getEncryptedRoomCredentials();
		if (credentials) openCompanionRemote(credentials);
	});
	const handleOpenConnectRoomDialog = useEventCallback(() => {
		setConnectRoomDialogOpen(true);
	});
	const handleOpenPreferencesDialog = useEventCallback(() => {
		setPreferencesDialogOpen(true);
	});
	const handleOpenAutomationDialog = useEventCallback(() => {
		setBrushDesignerPanelOpen(false);
		setAutomationDialogOpen(true);
	});
	const handleCloseAutomationDialog = useEventCallback(() => {
		setAutomationDialogOpen(false);
	});
	const handleCreateAutomationRuntime: AutomationRuntimeFactory =
		useEventCallback(async ({ onLog, onPrompt }) => {
			if (!paplico) throw new Error("Paplico is not initialized");

			const fileSystem = await createAutomationFileSystem(
				documentSessionState.fileHandle,
			);
			const runtime = createPaplicoAutomationRuntime({
				paplico,
				fileSystem,
				stdout: onLog,
				prompt: onPrompt,
			});

			return {
				run: async (source) => {
					const result = await runtime.run(source);
					return {
						diagnostics: result.diagnostics.map((diagnostic) => {
							const precedingSource = source.slice(0, diagnostic.span.start);
							const precedingLines = precedingSource.split("\n");
							return {
								message: diagnostic.message,
								severity: diagnostic.severity,
								line: precedingLines.length,
								column: (precedingLines.at(-1)?.length ?? 0) + 1,
							};
						}),
					};
				},
				stop: () => runtime.stop(),
				dispose: async () => {
					runtime.dispose();
					await fileSystem?.dispose();
				},
			};
		});
	const handleOpenDocumentListDialog = useEventCallback(() => {
		setDocumentListDialogOpen(true);
	});
	const handleOpenTimelapseDialog = useEventCallback(() => {
		setTimelapseDialogOpen(true);
	});
	const handleToggleSplitView = useEventCallback(() => {
		setIsSplitView((prev) => !prev);
	});

	// biome-ignore lint/correctness/useExhaustiveDependencies: menuActions.handleSave is stable (useEventCallback)
	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			if ((e.metaKey || e.ctrlKey) && e.key === "s") {
				e.preventDefault();
				void menuActions.handleSave();
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, []);

	const handleWindowDragOver = useEventCallback((e: React.DragEvent) => {
		const files = Array.from(e.dataTransfer.items);
		if (files.some((item) => item.kind === "file")) {
			e.preventDefault();
			e.dataTransfer.dropEffect = "copy";
		}
	});

	const handleDropFiles = useEventCallback(
		async (files: File[], fileHandle?: FileHandle | null) => {
			const papfFile = files.find((f) => f.name.endsWith(".papf"));
			if (!papfFile) return;

			if (
				!(await ConfirmDialog.call({
					description: t("menubar.saveAndCloseConfirm"),
					confirmLabel: t("menubar.saveAndContinue"),
				}))
			)
				return;

			try {
				await paplicoRef.current?.importDocument(papfFile);
				setExternalDocumentSession(fileHandle ?? null);
			} catch (error) {
				reportError({
					code: codeFromError(error, "DOCUMENT_OPEN_FAILED"),
					cause: error,
				});
			}
		},
	);

	const handleWindowDrop = useEventCallback(async (e: React.DragEvent) => {
		const items = Array.from(e.dataTransfer.items);
		const files = Array.from(e.dataTransfer.files);
		const papfIndex = files.findIndex((f) => f.name.endsWith(".papf"));

		if (papfIndex === -1) return;
		e.preventDefault();

		const fileHandle = await domFSFileHandleFromTransferItem(
			items[papfIndex],
			files[papfIndex],
		);
		handleDropFiles(files, fileHandle);
	});

	// Handle file drops from Tauri (native drag-drop bypasses browser events)
	useEffect(() => {
		const handler = (e: Event) => {
			const { files, handles } = (e as CustomEvent<TauriFileDropDetail>).detail;
			const papfIndex = files.findIndex((f) => f.name.endsWith(".papf"));
			handleDropFiles(files, handles[papfIndex] ?? null);
		};

		window.addEventListener("tauri-file-drop", handler);
		return () => window.removeEventListener("tauri-file-drop", handler);
	}, [handleDropFiles]);

	// Documents the OS opened through the .papf association. Before anything
	// is loaded there is nothing to confirm closing, and the startup dialog
	// gives way to the file.
	useEffect(() => {
		const handler = async (e: Event) => {
			const { files, handles } = (e as CustomEvent<TauriFileDropDetail>).detail;
			const handle = handles[files.findIndex((f) => f.name.endsWith(".papf"))];
			if (!handle) return;

			if (documentSessionState.source.kind !== "initial") {
				handleDropFiles(files, handle);
				return;
			}

			await openDocumentFile(handle);
			NewDocumentDialog.end({ action: "cancel" });
		};

		window.addEventListener("tauri-open-files", handler);
		return () => window.removeEventListener("tauri-open-files", handler);
	}, [handleDropFiles, openDocumentFile]);

	// Persist shortcut overrides to appConfig on change
	useEffect(() => {
		if (!paplico) return;
		return paplico.shortcuts.on("change", () => {
			const config = paplico.shortcuts.exportConfig();
			setShortcutOverrides(config.keybindings.length > 0 ? config : null);
		});
	}, [paplico]);

	// Register app-level shortcut commands that need React/store closures
	useEffect(() => {
		if (!paplico) return;

		const s = paplico.shortcuts;

		s.registerCommand(Cmds["paplico.toggleColorTarget"], "Color", () => {
			toggleActiveColorTarget();
			return true;
		});
		s.registerDefaultKeybinding(
			Cmds["paplico.toggleColorTarget"],
			{
				code: "KeyX",
			},
			{ canvasFocused: true },
		);

		s.registerCommand(Cmds["paplico.swapColors"], "Color", () => {
			paplico.tools.swapColors();
			if (paplico.uiState.selectedElementIds.length > 0) {
				paplico.commands.swapSelectedElementsColors();
			}
			return true;
		});
		s.registerDefaultKeybinding(
			Cmds["paplico.swapColors"],
			{
				code: "KeyX",
				shift: true,
			},
			{ canvasFocused: true },
		);

		s.registerCommand(Cmds["paplico.clearActiveColor"], "Color", () => {
			const target = uiState.activeColorTarget;
			if (target === "stroke") {
				paplico.tools.setStrokeColor(null);
				if (paplico.uiState.selectedElementIds.length > 0) {
					paplico.commands.updateSelectedElementsStrokeColor(null);
				}
			} else {
				paplico.tools.setFillColor(null);
				if (paplico.uiState.selectedElementIds.length > 0) {
					paplico.commands.updateSelectedElementsFillColor(null);
				}
			}
			return true;
		});
		s.registerDefaultKeybinding(
			Cmds["paplico.clearActiveColor"],
			{
				code: "Slash",
			},
			{ canvasFocused: true },
		);

		s.registerCommand(Cmds["paplico.toggleSplitView"], "View", () => {
			setIsSplitView((prev) => !prev);
			return true;
		});
		s.registerDefaultKeybinding(Cmds["paplico.toggleSplitView"], {
			code: "Backslash",
			ctrlOrMeta: true,
		});

		return () => {
			s.unregisterCommand(Cmds["paplico.toggleColorTarget"]);
			s.unregisterCommand(Cmds["paplico.swapColors"]);
			s.unregisterCommand(Cmds["paplico.clearActiveColor"]);
			s.unregisterCommand(Cmds["paplico.toggleSplitView"]);
		};
	}, [paplico]);

	// Eyedropper pick event: sync picked colors to uiStore
	useEffect(() => {
		if (!paplico) return;
		return paplico.on(
			"eyedropperPick",
			({ strokeColor, fillColor, pixelPick }) => {
				if (pixelPick) {
					if (uiState.activeColorTarget === "stroke") {
						paplico.tools.setStrokeColor(strokeColor);
					} else {
						paplico.tools.setFillColor(fillColor);
					}
				} else {
					paplico.tools.setStrokeColor(strokeColor);
					paplico.tools.setFillColor(fillColor);
				}
			},
		);
	}, [paplico]);

	// Workaround for Safari PWA bug: switching vh→dvh forces relayout and fixes the
	// incorrect bottom whitespace caused by dvh being computed before tab bar settles.
	// https://bugs.webkit.org/show_bug.cgi?id=261185
	useEffect(() => {
		if (!detectSafariBrowser()) return;
		document.documentElement.style.height = "100vh";

		setTimeout(() => {
			document.documentElement.style.height = "";
		}, 100);
	}, []);

	useEffect(() => {
		const handler = (e: MouseEvent) => {
			if ((e.target as Element).matches("input, textarea")) return;
			e.preventDefault();
		};
		window.addEventListener("contextmenu", handler);

		return () => {
			window.addEventListener("contextmenu", handler);
		};
	}, []);

	return (
		<PaplicoProvider paplico={paplico}>
			<ToastContainer>
				<div
					role="application"
					className="w-dvw h-dvh relative overscroll-none"
					onDragOver={handleWindowDragOver}
					onDrop={handleWindowDrop}
				>
					{/* Canvas - Full screen background */}
					<div className="absolute inset-0">
						{paplico && primaryTargetId && isSplitView ? (
							<SplitViewContainer
								paplico={paplico}
								primaryTargetId={primaryTargetId}
							/>
						) : (
							<CanvasPane
								paplico={paplico}
								targetId={primaryTargetId ?? undefined}
								isPrimary
								onCanvasReady={!paplico ? handlePrimaryCanvasReady : undefined}
							/>
						)}
					</div>

					<div className="absolute top-0 left-0 right-0 bottom-0 flex flex-col pointer-events-none">
						<DesktopMenuBar
							paplico={paplico}
							connectedRoomId={collab.connectedRoomId}
							isRoomOwner={collab.isRoomOwner}
							isEncryptedRoom={collab.isEncryptedRoom}
							onOpenExportDialog={menuActions.handleOpenExportDialog}
							onOpenDocumentSettingsDialog={
								menuActions.handleOpenDocumentSettingsDialog
							}
							onCloseRoom={collab.handleCloseRoom}
							onStopDeviceSharing={collab.handleStopDeviceSharing}
							onOpenPublishRoomDialog={handleOpenPublishRoomDialog}
							onOpenConnectOtherDevicesDialog={
								handleOpenConnectOtherDevicesDialog
							}
							onOpenCompanionDialog={handleOpenCompanionDialog}
							onOpenCompanionPanel={handleOpenCompanionPanel}
							onOpenConnectRoomDialog={handleOpenConnectRoomDialog}
							onOpenPreferencesDialog={handleOpenPreferencesDialog}
							onOpenAutomationDialog={handleOpenAutomationDialog}
							onOpenDocumentListDialog={handleOpenDocumentListDialog}
							onNewDocument={handleNewDocument}
							onOpenTimelapseDialog={handleOpenTimelapseDialog}
							isSplitView={isSplitView}
							onToggleSplitView={handleToggleSplitView}
						/>

						<div className="relative flex-1">
							{/* Main workspace - fills remaining space below menubar */}
							<div className="flex-1">
								{/* Toolbar - Floating left or right depending on settings */}
								{paplico && (
									<div
										className={twm(
											"absolute top-0 bottom-0 pointer-events-none",
											appSnap.toolbarSide === "left" ? "left-0" : "right-0",
										)}
									>
										<Toolbar
											className="pointer-events-auto"
											side={appSnap.toolbarSide}
											edgeAccessory={
												sidePanelsBesideToolbar ? undefined : (
													<ShiftButtonOverlay />
												)
											}
											adjacentPanel={
												automationDialogOpen
													? {
															desktop: (
																<AutomationPanel
																	onClose={handleCloseAutomationDialog}
																	repository={automationScriptRepository}
																	createRuntime={handleCreateAutomationRuntime}
																	runtimeKey={documentSessionSnap.identity}
																	side={appSnap.toolbarSide}
																/>
															),
															mobile: (
																<AutomationPanel
																	variant="mobile"
																	onClose={handleCloseAutomationDialog}
																	repository={automationScriptRepository}
																	createRuntime={handleCreateAutomationRuntime}
																	runtimeKey={documentSessionSnap.identity}
																/>
															),
															width: uiSnap.automationPanelWidth,
															minWidth: AUTOMATION_PANEL_MIN_WIDTH,
															maxWidth: AUTOMATION_PANEL_MAX_WIDTH,
															onWidthChange: setAutomationPanelWidth,
														}
													: undefined
											}
											mobileMenuProps={{
												paplico,
												connectedRoomId: collab.connectedRoomId,
												isRoomOwner: collab.isRoomOwner,
												isEncryptedRoom: collab.isEncryptedRoom,
												onOpenExportDialog: menuActions.handleOpenExportDialog,
												onOpenDocumentSettingsDialog:
													menuActions.handleOpenDocumentSettingsDialog,
												onCloseRoom: collab.handleCloseRoom,
												onStopDeviceSharing: collab.handleStopDeviceSharing,
												onOpenPublishRoomDialog: handleOpenPublishRoomDialog,
												onOpenConnectOtherDevicesDialog:
													handleOpenConnectOtherDevicesDialog,
												onOpenCompanionDialog: handleOpenCompanionDialog,
												onOpenCompanionPanel: handleOpenCompanionPanel,
												onOpenConnectRoomDialog: handleOpenConnectRoomDialog,
												onOpenPreferencesDialog: handleOpenPreferencesDialog,
												onOpenAutomationDialog: handleOpenAutomationDialog,
												onOpenDocumentListDialog: handleOpenDocumentListDialog,
												onOpenTimelapseDialog: handleOpenTimelapseDialog,
												isSplitView,
												onToggleSplitView: handleToggleSplitView,
											}}
										/>
									</div>
								)}
							</div>

							{/* Side panels - desktop only */}
							{paplico &&
								layoutMode === "desktop" &&
								(() => {
									const isToolbarLeft = appSnap.toolbarSide === "left";
									const isTogether = sidePanelsBesideToolbar;

									// together: panels on the same side as toolbar (next to it)
									// split: panels on the opposite side from toolbar (spread to both ends)
									// Both panels docked next to the toolbar are resizable, so the
									// offset they impose on the side panels resolves at runtime.
									const adjacentPanelWidth = uiSnap.brushDesignerPanelOpen
										? uiSnap.brushDesignerPanelWidth
										: automationDialogOpen
											? uiSnap.automationPanelWidth
											: 0;
									const panelSideCls = isTogether
										? undefined
										: isToolbarLeft
											? twm("right-[max(0.75rem,var(--spacing-safe-right))]")
											: twm("left-3");
									const panelSideStyle = isTogether
										? isToolbarLeft
											? {
													left: `calc(3.5rem + ${adjacentPanelWidth}px + var(--notch-left))`,
												}
											: {
													right: `calc(3.5rem + ${adjacentPanelWidth}px + var(--notch-right))`,
												}
										: undefined;
									const colCls = twm(
										"absolute top-2 bottom-[max(0.75rem,var(--spacing-safe-bottom))] flex flex-col gap-3 pointer-events-none",
									);

									return (
										<div
											className={twm(colCls, panelSideCls)}
											style={panelSideStyle}
										>
											<div className="contents pointer-events-auto">
												<EditingScopeBreadcrumb />
											</div>
											{/* Only the panels scroll. The breadcrumb and the shift
											    button deliberately reach outside the column's width,
											    which a scroll container would clip. The bottom
											    padding keeps the last panel's resize handle, which
											    straddles its edge, from making the column scrollable
											    on its own. */}
											<div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pb-1">
												<ResizableSidePanel
													id="actions"
													height={appSnap.sidePanelHeights.actions ?? null}
												>
													<ActionsPanel />
												</ResizableSidePanel>
												<ResizableSidePanel
													id="layers"
													height={appSnap.sidePanelHeights.layers ?? null}
													// Default limit: the layer list has to leave room
													// for the panels under it.
													className="max-h-[30dvh]"
												>
													<LayerPanel />
												</ResizableSidePanel>
												<ResizableSidePanel
													id="filters"
													height={appSnap.sidePanelHeights.filters ?? null}
												>
													<FilterPanel />
												</ResizableSidePanel>
											</div>
											{isTogether && (
												<ShiftButtonOverlay
													className={twm(
														"absolute bottom-13",
														isToolbarLeft
															? "left-full ml-4"
															: "right-full mr-4",
													)}
												/>
											)}
										</div>
									);
								})()}

							{/* Mobile panels (portrait / landscape-compact) */}
							{paplico && <MobilePanels />}
						</div>
					</div>

					{/* Export Dialog */}
					<ExportDialog
						open={exportDialogOpen}
						onOpenChange={setExportDialogOpen}
						artboards={artboards}
						paplico={paplico ?? null}
						isHdrEnabled={!!paplico?.uiState.document.hdr?.enabled}
					/>

					{/* Document Settings Dialog */}
					<DocumentSettingsDialog
						open={documentSettingsDialogOpen}
						onOpenChange={setDocumentSettingsDialogOpen}
						paplico={paplico ?? null}
					/>

					{/* New Document Dialog */}
					<NewDocumentDialog.Root />
					<ConfirmDialog.Root />
					<LicensesDialog.Root />

					{/* Stays up until the document lands, not just until the socket
					    opens: an empty canvas and a synced one look the same, so
					    letting go earlier would look like the drawing never came. */}
					<SpinnerDialog
						open={isConnectingDevice || collab.isSyncing}
						message={t("connectRoomDialog.connectingToDevice")}
					/>

					{/* Timelapse Dialog */}
					<TimelapseDialog
						open={timelapseDialogOpen}
						onOpenChange={setTimelapseDialogOpen}
					/>

					{/* Preferences Dialog */}
					<PreferencesDialog
						open={preferencesDialogOpen}
						onOpenChange={setPreferencesDialogOpen}
					/>

					{/* Document List Dialog */}
					<DocumentListDialog
						open={documentListDialogOpen}
						onOpenChange={setDocumentListDialogOpen}
						paplico={paplico}
						onRequestNewDocument={handleNewDocument}
					/>

					{/* Connect Room Dialog */}
					<ConnectRoomDialog
						open={connectRoomDialogOpen}
						onOpenChange={setConnectRoomDialogOpen}
						defaultRoomId={initialRoomId ?? undefined}
						onConnect={collab.handleConnectRoom}
						onDisconnect={collab.handleDisconnectRoom}
						isConnected={collab.connectedRoomId !== null}
						currentRoomId={collab.connectedRoomId}
						defaultUserName={appConfig.collaborationUserName}
					/>

					<PublishRoomDialog.Root />
					<ScanInviteDialog.Root />
					<CompanionDialog.Root />
					<DisconnectedDialog.Root />

					{/* Sign In Dialog (cloud mode only — requires ClerkProvider) */}
					{process.env.NEXT_PUBLIC_COLLAB_MODE === "cloud" && (
						<SignInDialog
							open={collab.signInDialogOpen}
							onOpenChange={(open) => {
								collab.setSignInDialogOpen(open);
								if (!open) collab.setPendingRoomId(null);
							}}
							onSignInComplete={collab.handleSignInComplete}
						/>
					)}
				</div>
			</ToastContainer>

			{/* Answers companion devices, and the remote this device can become */}
			<CompanionHost
				isEncryptedRoom={collab.isEncryptedRoom}
				isRoomOwner={collab.isRoomOwner}
			/>
			<CompanionRemoteModal />

			{/* Global error notification hosts */}
			<NotificationBannerHost />
			<FatalErrorOverlay />
		</PaplicoProvider>
	);
}

/**
 * Slot in the desktop side panel column. The height dragged on its bottom edge
 * is a limit rather than a fixed size, so a panel holding less than that keeps
 * the height its content asks for.
 */
function ResizableSidePanel({
	id,
	height,
	className,
	children,
}: {
	id: SidePanelId;
	height: number | null;
	className?: string;
	children: ReactNode;
}) {
	return (
		<Resizable
			dir="bottom"
			limit="max"
			defaultSize={height}
			minSize={SIDE_PANEL_MIN_HEIGHT}
			maxSize={SIDE_PANEL_MAX_HEIGHT}
			onSizeChange={(size) => setSidePanelHeight(id, size)}
			className={twm("flex shrink-0 flex-col pointer-events-auto", className)}
		>
			{children}
		</Resizable>
	);
}

/**
 * Suppresses app shortcuts while the event originates inside a subtree marked
 * with `data-app-shortcuts="off"`. Editors that own their own keybindings
 * (Monaco) receive keys through elements the engine cannot recognize as text
 * inputs, so they opt out explicitly.
 */
function ignoreShortcutsInOptedOutSubtree(
	event: KeyboardEvent,
): false | undefined {
	if (!(event.target instanceof HTMLElement)) return undefined;
	return event.target.closest('[data-app-shortcuts="off"]') ? false : undefined;
}
