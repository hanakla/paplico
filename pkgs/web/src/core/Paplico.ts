import { ref, snapshot, subscribe } from "valtio";
import { subscribeKey } from "valtio/utils";
import * as Y from "yjs";
import {
	type BrushStrokePreviewOptions,
	createBrushStrokePreviewScene,
} from "./brush/strokePreview";
import type { ICollaboration } from "./collaboration/ICollaboration";
import { YjsProvider } from "./collaboration/YjsProvider";
import { buildSoftProofLut } from "./color/ColorEngine";
import type { BuiltinIccProfileId, ProofProfileRef } from "./color/types";
import { PREVIEW_ELEMENT_SENTINEL_ID } from "./document/constants";
import { DefIndex } from "./document/DefIndex";
import { collectEditablePaths } from "./document/editablePaths";
import {
	createDefaultColor,
	createEmbeddedFileFromBytes,
	createIdentityTransform,
} from "./document/factory";
import { createRendererState } from "./document/rendererState";
import { SpatialIndex } from "./document/SpatialIndex";
import { TextDependencyIndex } from "./document/TextDependencyIndex";
import { PaplicoMaskEdit } from "./editSessions/PaplicoMaskEdit";
import {
	PATTERN_EDIT_ORIGIN,
	PaplicoPatternEdit,
} from "./editSessions/PaplicoPatternEdit";
import { PaplicoError } from "./errors";
import { PaplicoExporter } from "./io/export/PaplicoExporter";
import { PaplicoPSDExporter } from "./io/export/PaplicoPSDExporter";
import { PaplicoTIFFExporter } from "./io/export/PaplicoTIFFExporter";
import { gcDocument } from "./io/papf/gc";
import { openPapf } from "./io/papf/reader";
import { serializeDocument } from "./io/papf/writer";
import { PaplicoCommands } from "./PaplicoCommands";
import { PaplicoSelection } from "./PaplicoSelection";
import {
	defaultShortcutCommands as Cmds,
	type KeySpec,
	PaplicoShortcuts,
} from "./PaplicoShortcuts";
import { PaplicoTools } from "./PaplicoTools";
import {
	getReference3DServiceSync,
	loadReference3DService,
} from "./reference3d";
import {
	computePerspectiveGuides,
	guideSourceAffectedByDelta,
	type PerspectiveGuideData,
} from "./reference3d/perspective/vanishingPoints";
import { CanvasTarget } from "./renderer/CanvasTarget";
import type { Reference3DRenderContext } from "./renderer/canvas/elements/Reference3DElementRenderer";
import { DocumentChangeSubscriber } from "./renderer/DocumentChangeSubscriber";
import {
	RenderOrchestrator,
	RenderStrategy,
} from "./renderer/RenderOrchestrator";
import { type DirtyReason, RenderScheduler } from "./renderer/RenderScheduler";
import type {
	ChangedElements,
	ToolSession,
	TransientElementEntry,
	UIOverlayState,
} from "./renderer/types";
import { buildEraserOverlay } from "./renderer/ui/builders/eraser";
import { buildPerspectiveGuideOverlay } from "./renderer/ui/builders/perspectiveGuides";
import type { WorldBounds } from "./renderer/ui/builders/text";
import { buildTextEditOverlay } from "./renderer/ui/builders/textEdit";
import { buildToolCursorOverlay } from "./renderer/ui/builders/toolCursor";
import { hitTestOverlays } from "./renderer/ui/hitTest";
import { OVERLAY_KEYS, type OverlayKey } from "./renderer/ui/overlayKeys";
import {
	setArtboardSelectionOverlay,
	setFontMissingOverlay,
	setOverlayEntry,
	setSelectionOverlay,
	setTextOverflowOverlay,
} from "./renderer/ui/overlaySink";
import type { UIOverlay } from "./renderer/ui/primitives";
import { OVERLAY_Z, UI_THEME } from "./renderer/ui/theme";
import type {
	ArtboardSelectionUIData,
	SelectionUIData,
} from "./renderer/ui/types";
import {
	type AnyArtObject,
	type Artboard,
	type BoundingBox,
	type Color,
	cloneAppearance,
	colorToRawRGBA,
	createDefaultContentAppearance,
	type Document,
	type ElementTransform,
	type EmbeddedFile,
	type FillAppearance,
	type FillColor,
	type Filter,
	type Group,
	generateUid,
	getArtboardBounds,
	getContainerChildIds,
	getTransform,
	type ImageObject,
	isBlend,
	isContainer,
	isGroup,
	isIdentityTransform,
	isMesh,
	isReference3D,
	isRepeat,
	isSolidColor,
	type Layer,
	type MeshArtObject,
	type Path,
	type Reference3DDef,
	type Reference3DElement,
	type StrokeAppearance,
	type StrokeColor,
	type TextElement,
	type Viewport,
} from "./schema";
import { TimelapseExporter } from "./timelapse/TimelapseExporter";
import { TimelapsePlayer } from "./timelapse/TimelapsePlayer";
import { TimelapseRecorder } from "./timelapse/TimelapseRecorder";
import type { PlaybackState } from "./timelapse/types";
import { ArtboardTool } from "./tools/ArtboardTool";
import { BucketFillTool } from "./tools/BucketFillTool";
import { EraserTool } from "./tools/EraserTool";
import { EyedropperTool } from "./tools/EyedropperTool";
import { FreeTransformTool } from "./tools/FreeTransformTool";
import { GradientTool } from "./tools/GradientTool";
import { MeshDeformTool } from "./tools/MeshDeformTool";
import { PathEditTool } from "./tools/PathEditTool";
import { PathTool } from "./tools/PathTool";
import { PenTool } from "./tools/PenTool";
import { Reference3DController } from "./tools/Reference3DController";
import { Reference3DTool } from "./tools/Reference3DTool";
import {
	createResizeHandles,
	createRotationHandle,
} from "./tools/resizeHandleHelper";
import { SelectTool } from "./tools/SelectTool";
import { ShapeTool } from "./tools/ShapeTool";
import { SkewTool } from "./tools/SkewTool";
import { StrokeWidthEditTool } from "./tools/StrokeWidthEditTool";
import { TextTool } from "./tools/TextTool";
import type { TextToolController } from "./tools/TextToolController";
import type { Tool } from "./tools/Tool";
import { ToolContext } from "./tools/ToolContext";
import {
	createToolSettings,
	type ToolSettings,
	type ToolType,
} from "./tools/toolSettings";
import { getFontManager } from "./typography/fonts";
import { PaplicoUI } from "./ui/PaplicoUI";
import {
	type ExtractedAppearance,
	extractAppearance as extractAppearanceFromArtObject,
} from "./utils/elementQuery";
import { Emitter } from "./utils/emitter";
import {
	type AlignDelta,
	type AlignItem,
	type AlignMode,
	computeAlignDeltas,
	computeDistributeDeltas,
	type DistributeAxis,
	unionBounds,
} from "./utils/geometry/align";
import { arcLengthOfNearestSpinePoint } from "./utils/geometry/blendInterpolation";
import {
	brandWorldBBox,
	calculateLocalElementBounds,
	calculateRepeatSourceUnion,
	translateBounds,
	type WorldBBox,
} from "./utils/geometry/bounds";
import {
	applyTransformToPoint,
	applyWorldAffineToTransform,
	composeTransforms,
	computeTransformOrigin,
	cursorLocalToWorld,
	inverseTransform,
} from "./utils/geometry/geometry";
import { buildArcLengthTable } from "./utils/geometry/pathSampling";
import {
	createScaleTransform,
	scaleSegments,
	scaleTextContent,
	scaleTextLayout,
	scaleTextStyle,
} from "./utils/geometry/resize";
import { toWorldPath } from "./utils/geometry/segmentOps";
import {
	collectSelectionOutlines,
	shouldDashSelectionBounds,
} from "./utils/geometry/selectionOutlines";
import { assertNonNull, deepClone } from "./utils/lang";
import { transformPressure } from "./utils/pressureCurve";

type PaplicoEventMap = {
	sizeChange: { width: number; height: number };
	deviceLost: undefined;
	deviceRestored: undefined;
	deviceRecoveryFailed: undefined;
	/**
	 * A collaboration was attached or detached. getCollaboration() is a plain
	 * getter, so anything that renders presence needs this to know when to
	 * re-read it — otherwise it only learns on an unrelated re-render.
	 */
	collaborationChanged: undefined;
	eyedropperPick: {
		strokeColor: StrokeColor | null;
		fillColor: FillColor | null;
		pixelPick?: boolean;
	};
};

interface PaplicoOptions {
	textToolController?: TextToolController;
	filterShortcutEvents?: (event: KeyboardEvent) => false | undefined;
	googleFontsApiKey?: string;
	collaboration?: ICollaboration;
	/**
	 * Resolves raw bytes of a builtin ICC profile. Injected from infra so core
	 * stays platform-agnostic (it never fetches /assets/icc/ itself).
	 */
	getBuiltinProfileBytes: (id: BuiltinIccProfileId) => Promise<Uint8Array>;
}

export interface RendererState {
	document: Document;
	currentLayerId: string | null;
	canUndo: boolean;
	canRedo: boolean;
	elementOverrides: Map<string, AnyArtObject>;
	transientElements: Map<string, TransientElementEntry>;
	selectedElementIds: string[];
	selectionBounds: BoundingBox | null;
	/** The key object within a multi-selection: the alignment reference the user
	 *  picked by clicking an already-selected element without modifier keys.
	 *  Always a member of selectedElementIds, or null. */
	keyObjectId: string | null;
	uiOverlayState: UIOverlayState;
	/** Active pattern-edit session identity (mirrored by PaplicoPatternEdit).
	 *  Reactive visibility gate for session-scoped UI such as PatternEditBar. */
	patternEditSession: { defId: string } | null;
	/** Element whose mask is being edited (mirrored by PaplicoMaskEdit).
	 *  Gates the mask-edit UI, and tells the renderer to leave that element
	 *  unmasked so there is something to draw the mask against. */
	maskEditSession: { ownerId: string } | null;
	/** Active tool session info for React overlays (MeshDeformHintOverlay). */
	toolSession: ToolSession | null;
	/** Reference3D element currently being edited (reactive gate for the Reference3D
	 *  action-panel controls). Mirrors Reference3DController's editing session. */
	reference3dEditingElementId: string | null;
	/** Selected node inside the edited scene (reactive gate for the node
	 *  context actions). Mirrors Reference3DController's node selection. */
	reference3dSelectedNodeId: string | null;
	editingScopeStack: string[];
	selectedArtboardId: string | null;
	hdrSupported: boolean;
	/** Per-target viewports keyed by CanvasTarget ID. */
	viewports: Record<string, Viewport>;
}

export type PublicUIState = Readonly<
	Pick<
		RendererState,
		| "document"
		| "viewports"
		| "currentLayerId"
		| "canUndo"
		| "canRedo"
		| "selectedElementIds"
		| "selectionBounds"
		| "keyObjectId"
		| "selectedArtboardId"
		| "uiOverlayState"
		| "patternEditSession"
		| "maskEditSession"
		| "toolSession"
		| "reference3dEditingElementId"
		| "reference3dSelectedNodeId"
		| "editingScopeStack"
		| "hdrSupported"
	>
>;

// --- Paplico Class ---

/**
 * Paplico - Main application class
 * Manages renderer, tools, UI input handling, collaboration, spatial index, and document commands
 *
 * Usage:
 *   const paplico = await Paplico.create(canvas);
 *   paplico.startRendering();
 */
export class Paplico extends Emitter<PaplicoEventMap> {
	private readonly rendererStore: RendererState;

	public readonly uiState: PublicUIState;
	public readonly commands!: PaplicoCommands;
	public readonly selection!: PaplicoSelection;
	public readonly patternEdit!: PaplicoPatternEdit;
	public readonly maskEdit!: PaplicoMaskEdit;
	public readonly spatialIndex!: SpatialIndex;
	public readonly exporter!: PaplicoExporter;
	public readonly psdExporter!: PaplicoPSDExporter;
	public readonly tiffExporter!: PaplicoTIFFExporter;
	public readonly shortcuts!: PaplicoShortcuts;

	private renderer: RenderOrchestrator;
	private canvasTargets = new Map<string, CanvasTargetEntry>();
	private primaryTargetId: string | null = null;
	private tool: Tool | null = null;
	private toolContext!: ToolContext;
	private yjsProvider!: YjsProvider;
	private collaboration: ICollaboration | null = null;

	private valtioUnsubscribes: Array<() => void> = [];
	private readonly renderChangeSubscriber: DocumentChangeSubscriber;
	private readonly defIndex = new DefIndex();
	private readonly textDepIndex = new TextDependencyIndex();
	private textOverflowRefreshSeq = 0;
	private lastTextOverflowBadgeKey: string | null = null;
	private textOverflowRefreshTimer: ReturnType<typeof setTimeout> | null = null;
	private fontMissingRefreshSeq = 0;
	private lastFontMissingKey: string | null = null;
	private fontMissingRefreshTimer: ReturnType<typeof setTimeout> | null = null;
	private _isDrawing = false;
	private activeTarget: CanvasTarget | null = null;
	public readonly textToolController: TextToolController | null = null;
	private timelapseRecorder: TimelapseRecorder = new TimelapseRecorder();

	private readonly toolSettings: ToolSettings;
	public readonly tools: PaplicoTools;
	private currentToolType: ToolType;

	// --- Reference3D subsystem (lazy three.js runtime) ---
	private readonly reference3dController = new Reference3DController();
	/** Set once loadReference3DService has been kicked (dedupe guard). */
	private reference3dLoadRequested = false;
	/** Per-scene node previews for gizmo drags (Yjs-bypassing). */
	private readonly reference3dDefPreviews = new Map<string, Reference3DDef>();
	/** Reference3d element the perspective ruler derives guides from. */
	private perspectiveGuideSourceId: string | null = null;
	/** Cached guide data for tools (recomputed on source changes). */
	private perspectiveGuides: PerspectiveGuideData | null = null;

	private filterShortcutEvents:
		| ((event: KeyboardEvent) => false | undefined)
		| null = null;
	private options: PaplicoOptions | undefined;
	private readonly getBuiltinProfileBytes: (
		id: BuiltinIccProfileId,
	) => Promise<Uint8Array>;

	/** Soft proof (print simulation) display state. */
	private softProof = {
		/** Whether soft proof display is enabled. */
		active: false,
		/** Monotonic counter to discard stale async LUT builds. */
		generation: 0,
		/** JSON key of the colorProfile settings the current LUT was built from. */
		settingsKey: null as string | null,
	};

	private constructor(options: PaplicoOptions) {
		super();
		this.toolSettings = createToolSettings();
		this.tools = new PaplicoTools(this.toolSettings, {
			getCurrentTool: () => this.tool,
		});
		this.currentToolType = this.toolSettings.currentTool;
		this.rendererStore = createRendererState();
		this.uiState = this.rendererStore;
		this.renderChangeSubscriber = new DocumentChangeSubscriber(
			this.rendererStore,
			(reason, _source, changes) => {
				for (const entry of this.canvasTargets.values()) {
					entry.scheduler.markDirty(reason, changes);
				}
			},
			{
				getSpatialIndex: () => this.spatialIndex,
				refreshToolUI: () => this.refreshToolUI(),
				syncPathToolFromDocument: () => this.syncPathToolFromDocument(),
				isArtboardToolActive: () => this.tool?.name === "artboard",
			},
		);
		this.renderer = new RenderOrchestrator();
		this.wireTextDocumentResolver();
		// Reference3D edit isolation dims the whole composite — entering/leaving
		// the session needs a document-level re-render, not just overlays.
		this.reference3dController.onEditingChange = (elementId) => {
			this.rendererStore.reference3dEditingElementId = elementId;
			this.markDirty("editingScope");
		};
		this.reference3dController.onNodeSelectionChange = (nodeId) => {
			this.rendererStore.reference3dSelectedNodeId = nodeId;
		};
		this.textToolController = options?.textToolController ?? null;
		this.textToolController?.setOnTextEditUIChange((data) => {
			this.setUIOverlay(
				OVERLAY_KEYS.sysTextEdit,
				data
					? {
							zIndex: OVERLAY_Z.textEdit,
							primitives: buildTextEditOverlay(data, UI_THEME),
						}
					: null,
			);
			this.markDirty("selection");
		});
		this.filterShortcutEvents = options?.filterShortcutEvents ?? null;
		this.getBuiltinProfileBytes = options.getBuiltinProfileBytes;
		this.options = options;
	}

	private syncTextToolFromStore(tool: TextTool): void {
		const id = tool.editingElementId;
		if (!id) {
			tool.clampCursorToContent();
			return;
		}
		const stored = this.rendererStore.document.objects[id];
		if (stored) {
			tool.clampCursorToContent(deepClone(stored as TextElement));
		}
	}

	private registerDefaultShortcuts(): void {
		const s = this.shortcuts;

		// Edit commands
		s.registerCommand(Cmds["paplico.deleteElements"], "Edit", () => {
			const ids = [...this.rendererStore.selectedElementIds];
			if (ids.length === 0) return false;
			this.commands.deleteElements(ids);
			this.selection.clear();
			return true;
		});
		s.registerDefaultKeybinding(
			Cmds["paplico.deleteElements"],
			{ code: "Delete" },
			{ canvasFocused: true },
		);
		s.registerDefaultKeybinding(
			Cmds["paplico.deleteElements"],
			{ code: "Backspace" },
			{ canvasFocused: true },
		);

		// Copy/Cut/Paste
		s.registerCommand(Cmds["paplico.copy"], "Edit", () => {
			if (this.textToolController?.isTextEditing()) {
				void this.textToolController.getTextTool()?.copyToClipboard();
				return true;
			}
			if (this.rendererStore.selectedElementIds.length === 0) return false;
			this.commands.copySelectedToClipboard();
			return true;
		});
		s.registerDefaultKeybinding(Cmds["paplico.copy"], {
			code: "KeyC",
			ctrlOrMeta: true,
		});

		s.registerCommand(Cmds["paplico.cut"], "Edit", () => {
			if (this.textToolController?.isTextEditing()) {
				void this.textToolController.getTextTool()?.cutToClipboard();
				return true;
			}
			if (this.rendererStore.selectedElementIds.length === 0) return false;
			this.commands.cutSelectedToClipboard();
			return true;
		});
		s.registerDefaultKeybinding(Cmds["paplico.cut"], {
			code: "KeyX",
			ctrlOrMeta: true,
		});

		s.registerCommand(Cmds["paplico.paste"], "Edit", () => {
			// Return false to let browser paste event fire →
			// PaplicoUI.handlePaste → handleDataTransfer handles
			// PAPLICO_ELEMENTS_MIME, images, SVG, and text.
			return false;
		});
		s.registerDefaultKeybinding(Cmds["paplico.paste"], {
			code: "KeyV",
			ctrlOrMeta: true,
		});

		s.registerCommand(Cmds["paplico.pasteToFront"], "Edit", () => {
			void this.commands.pasteFromSystemClipboard({ placement: "front" });
			return true;
		});
		s.registerDefaultKeybinding(Cmds["paplico.pasteToFront"], {
			code: "KeyF",
			ctrlOrMeta: true,
		});

		s.registerCommand(Cmds["paplico.pasteToBack"], "Edit", () => {
			void this.commands.pasteFromSystemClipboard({ placement: "back" });
			return true;
		});
		s.registerDefaultKeybinding(Cmds["paplico.pasteToBack"], {
			code: "KeyB",
			ctrlOrMeta: true,
		});

		// Undo/Redo
		s.registerCommand(Cmds["paplico.undo"], "Edit", () => {
			// commands.undo picks the session stack for itself when one is open,
			// so the toolbar button and the menu get the same routing this does.
			this.commands.undo();
			if (this.tool instanceof TextTool) {
				this.syncTextToolFromStore(this.tool);
			}
			return true;
		});
		s.registerDefaultKeybinding(Cmds["paplico.undo"], {
			code: "KeyZ",
			ctrlOrMeta: true,
		});

		s.registerCommand(Cmds["paplico.redo"], "Edit", () => {
			this.commands.redo();
			if (this.tool instanceof TextTool) {
				this.syncTextToolFromStore(this.tool);
			}
			return true;
		});
		s.registerDefaultKeybinding(Cmds["paplico.redo"], {
			code: "KeyZ",
			ctrlOrMeta: true,
			shift: true,
		});

		// Group/Ungroup
		s.registerCommand(Cmds["paplico.group"], "Edit", () => {
			const selectedIds = this.rendererStore.selectedElementIds;
			if (selectedIds.length < 2) return false;
			this.commands.groupSelectedElements(selectedIds);
			return true;
		});
		s.registerDefaultKeybinding(Cmds["paplico.group"], {
			code: "KeyG",
			ctrlOrMeta: true,
		});

		s.registerCommand(Cmds["paplico.ungroup"], "Edit", () => {
			const selectedIds = this.rendererStore.selectedElementIds;
			if (selectedIds.length !== 1) return false;
			const layerId = this.rendererStore.currentLayerId;
			if (!layerId) return false;
			const layer = this.rendererStore.document.layers.find(
				(l) => l.id === layerId,
			);
			if (!layer) return false;
			const element = this.rendererStore.document.objects[selectedIds[0]];
			if (!element || element.type !== "group") return false;
			this.commands.ungroupElements(element.id);
			return true;
		});
		s.registerDefaultKeybinding(Cmds["paplico.ungroup"], {
			code: "KeyG",
			ctrlOrMeta: true,
			shift: true,
		});

		// Clip group
		s.registerCommand(Cmds["paplico.clipGroup"], "Edit", () => {
			if (this.rendererStore.selectedElementIds.length < 2) return false;
			this.commands.createClipGroupFromTopmost();
			return true;
		});
		s.registerDefaultKeybinding(Cmds["paplico.clipGroup"], {
			code: "Digit7",
			ctrlOrMeta: true,
		});

		// Arrange
		s.registerCommand(Cmds["paplico.arrangeBackward"], "Arrange", () => {
			if (this.rendererStore.selectedElementIds.length !== 1) return false;
			this.commands.moveElementBackward(
				this.rendererStore.selectedElementIds[0],
			);
			return true;
		});
		s.registerDefaultKeybinding(Cmds["paplico.arrangeBackward"], {
			code: "BracketLeft",
			ctrlOrMeta: true,
		});
		s.registerDefaultKeybinding(Cmds["paplico.arrangeBackward"], {
			code: "BracketLeft",
			alt: true,
		});

		s.registerCommand(Cmds["paplico.arrangeForward"], "Arrange", () => {
			if (this.rendererStore.selectedElementIds.length !== 1) return false;
			this.commands.moveElementForward(
				this.rendererStore.selectedElementIds[0],
			);
			return true;
		});
		s.registerDefaultKeybinding(Cmds["paplico.arrangeForward"], {
			code: "BracketRight",
			ctrlOrMeta: true,
		});
		s.registerDefaultKeybinding(Cmds["paplico.arrangeForward"], {
			code: "BracketRight",
			alt: true,
		});

		// Navigation (registered before clearSelection for Escape priority)
		s.registerCommand(Cmds["paplico.exitEditingScope"], "Navigation", () => {
			return this.exitEditingScopeOneLevel();
		});
		s.registerDefaultKeybinding(
			Cmds["paplico.exitEditingScope"],
			{ code: "Escape" },
			{ canvasFocused: true },
		);

		s.registerCommand(Cmds["paplico.exitEditingScopeAll"], "Navigation", () => {
			if (this.rendererStore.editingScopeStack.length === 0) return false;
			this.selection.exitEditingScope();
			return true;
		});
		s.registerDefaultKeybinding(
			Cmds["paplico.exitEditingScopeAll"],
			{ code: "Escape", shift: true },
			{ canvasFocused: true },
		);

		// Selection commands (clearSelection after exitEditingScope for Escape fallback)
		s.registerCommand(Cmds["paplico.clearSelection"], "Selection", () => {
			this.selection.clear();
			return true;
		});
		s.registerDefaultKeybinding(
			Cmds["paplico.clearSelection"],
			{ code: "Escape" },
			{ canvasFocused: true },
		);

		s.registerCommand(Cmds["paplico.selectAll"], "Selection", () => {
			this.selection.selectAll();
			return true;
		});
		s.registerDefaultKeybinding(Cmds["paplico.selectAll"], {
			code: "KeyA",
			ctrlOrMeta: true,
		});

		s.registerCommand(Cmds["paplico.deselectAll"], "Selection", () => {
			this.selection.clear();
			return true;
		});
		s.registerDefaultKeybinding(Cmds["paplico.deselectAll"], {
			code: "KeyA",
			ctrlOrMeta: true,
			shift: true,
		});

		// View commands
		s.registerCommand(Cmds["paplico.resetZoom"], "View", () => {
			for (const entry of this.canvasTargets.values()) {
				entry.target.setViewport({ zoom: 1, rotation: 0 });
				entry.scheduler.markDirty("viewport");
			}
			return true;
		});
		s.registerDefaultKeybinding(Cmds["paplico.resetZoom"], {
			code: "Digit0",
			ctrlOrMeta: true,
		});

		// Tool commands
		const toolBindings: Array<[string, KeySpec, ToolType]> = [
			[Cmds["paplico.tool.select"], { code: "KeyV" }, "select"],
			[Cmds["paplico.tool.path"], { code: "KeyP" }, "path"],
			[Cmds["paplico.tool.pen"], { code: "KeyB" }, "pen"],
			[Cmds["paplico.tool.eraser"], { code: "KeyE" }, "eraser"],
			[Cmds["paplico.tool.pathEdit"], { code: "KeyA" }, "path-edit"],
			[Cmds["paplico.tool.text"], { code: "KeyT" }, "text"],
			[Cmds["paplico.tool.gradient"], { code: "KeyG" }, "gradient"],
			[Cmds["paplico.tool.eyedropper"], { code: "KeyI" }, "eyedropper"],
			[
				Cmds["paplico.tool.strokeWidthEdit"],
				{ code: "KeyW", shift: true },
				"stroke-width-edit",
			],
		];

		for (const [id, key, toolType] of toolBindings) {
			s.registerCommand(id, "Tools", () => {
				this.updateToolState({ currentTool: toolType });
				return true;
			});
			s.registerDefaultKeybinding(id, key);
		}

		// Shape tools (also set shape type)
		s.registerCommand(Cmds["paplico.tool.shapeRect"], "Tools", () => {
			this.tools.setShapeType("rectangle");
			this.updateToolState({ currentTool: "shape" });
			return true;
		});
		s.registerDefaultKeybinding(Cmds["paplico.tool.shapeRect"], {
			code: "KeyM",
		});

		s.registerCommand(Cmds["paplico.tool.shapeEllipse"], "Tools", () => {
			this.tools.setShapeType("ellipse");
			this.updateToolState({ currentTool: "shape" });
			return true;
		});
		s.registerDefaultKeybinding(Cmds["paplico.tool.shapeEllipse"], {
			code: "KeyL",
		});

		// Transform group tools: the per-tool commands carry no default key (bind
		// in settings); the group's default key is the cycle command below.
		s.registerCommand(Cmds["paplico.tool.meshDeform"], "Tools", () => {
			this.updateToolState({ currentTool: "mesh-deform" });
			return true;
		});
		s.registerCommand(Cmds["paplico.tool.skew"], "Tools", () => {
			this.updateToolState({ currentTool: "skew" });
			return true;
		});
		s.registerCommand(Cmds["paplico.tool.freeTransform"], "Tools", () => {
			this.updateToolState({ currentTool: "free-transform" });
			return true;
		});
		// Cycle through the transform group (shape-tool style repeated presses):
		// entering from any other tool starts at the group default. mesh-deform
		// needs a selection (it bounces to select otherwise), so it is skipped
		// from the cycle while nothing is selected.
		s.registerCommand(Cmds["paplico.tool.transformCycle"], "Tools", () => {
			const cycle: ToolType[] =
				this.rendererStore.selectedElementIds.length > 0
					? ["free-transform", "mesh-deform", "skew"]
					: ["free-transform", "skew"];
			const index = cycle.indexOf(this.toolSettings.currentTool);
			this.updateToolState({
				currentTool:
					index === -1 ? cycle[0] : cycle[(index + 1) % cycle.length],
			});
			return true;
		});
		s.registerDefaultKeybinding(Cmds["paplico.tool.transformCycle"], {
			code: "KeyD",
		});
	}

	/**
	 * Create and fully initialize a Paplico instance.
	 * @throws if WebGPU initialization fails
	 */
	public static async create(
		canvas: HTMLCanvasElement,
		options: PaplicoOptions,
	): Promise<Paplico> {
		const paplico = new Paplico(options);
		await paplico._initSubsystems(canvas);

		// Phase 3: Sync initial layers and finalize
		paplico.syncInitialLayers();
		paplico.commands.ensureBuiltinBrushes();
		paplico.createTool(paplico.toolSettings.currentTool);
		paplico.setupBrushSettingsSubscription();

		return paplico;
	}

	/**
	 * Initialize all engine subsystems: GPU, canvas target, Yjs, and the
	 * downstream Valtio-backed sub-systems. Shared between create() and
	 * _devHotReload().
	 */
	private async _initSubsystems(canvas: HTMLCanvasElement): Promise<void> {
		const success = await this.renderer.initDevice();
		if (!success) {
			throw new PaplicoError(
				navigator.gpu ? "WEBGPU_INIT_FAILED" : "WEBGPU_UNSUPPORTED",
				navigator.gpu
					? "Failed to initialize WebGPU: adapter/device request failed"
					: "Failed to initialize WebGPU: WebGPU is not supported in this browser",
			);
		}

		this.rendererStore.hdrSupported = this.renderer.hdrGpuSupported;

		console.log("✅ WebGPU renderer initialized");

		this.renderer.setDeviceLostCallbacks({
			onDeviceLost: () => {
				this.emit("deviceLost", undefined as unknown as undefined);
			},
			onDeviceRestored: () => {
				this.emit("deviceRestored", undefined as unknown as undefined);
				this.markDirty("document");
			},
			onDeviceRecoveryFailed: () => {
				this.emit("deviceRecoveryFailed", undefined as unknown as undefined);
			},
		});

		this.renderer.setReference3DContextProvider(() =>
			this.buildReference3DRenderContext(),
		);

		if (this.options?.googleFontsApiKey) {
			getFontManager(this.options.googleFontsApiKey);
		}

		// Re-evaluate font-missing outlines once a still-loading font arrives, so
		// the red box clears itself when the font finally becomes available.
		getFontManager().on("fontLoaded", () => {
			if (this.currentToolType === "text") {
				this.scheduleFontMissingOutlineRefresh();
			}
		});

		// Add initial canvas as primary target
		const primaryTarget = await this.addCanvasTarget(canvas);
		this.primaryTargetId = primaryTarget.id;

		this.initYjsProvider();

		(this as { spatialIndex: SpatialIndex }).spatialIndex = new SpatialIndex(
			this.rendererStore,
		);
		this.spatialIndex.start();
		this.wireTextHitTester();
		(this as { selection: PaplicoSelection }).selection = new PaplicoSelection(
			this.rendererStore,
			this.spatialIndex,
			(scopeId) => {
				if (this.patternEdit?.getSession()?.transientLayerId === scopeId) {
					return this.patternEdit.commit();
				}
				if (this.maskEdit?.getSession()?.transientLayerId === scopeId) {
					return this.maskEdit.leave();
				}
				return false;
			},
		);
		(this as { commands: PaplicoCommands }).commands = new PaplicoCommands({
			store: this.rendererStore,
			yjsProvider: this.yjsProvider,
			spatial: this.spatialIndex,
			isReadonly: () => false,
			renderElementsToPNG: (elementIds) =>
				this.exporter.renderElementsToPNG(
					elementIds,
					this.rendererStore.document,
					{
						// Rasterize the copied image at the document's rasterization
						// resolution (72 DPI = 1x) instead of a fixed 1x.
						scale: (this.rendererStore.document.rasterizationDpi ?? 72) / 72,
						backgroundColor: { r: 0, g: 0, b: 0, a: 0 },
					},
				),
			filterHandlerLookup: (processor) =>
				this.renderer.getFilterHandler(processor),
			toolSettings: this.toolSettings,
			getTextRenderer: () => this.renderer.getTextRenderer(),
			selection: this.selection,
			// `this.patternEdit` is assigned right after this constructor call
			// (see below) — by the time any command actually mutates the
			// document, the field is populated, so the closure resolves it
			// correctly despite being defined before the assignment.
			getMutationOrigin: () =>
				this.patternEdit?.isActive() ? PATTERN_EDIT_ORIGIN : undefined,
			// Mask edit is deliberately absent: it edits real objects in place, so
			// its edits belong in the ordinary history and undo must reach them
			// there. Pattern edit works on throwaway copies and does need its own.
			getSessionHistory: () =>
				this.patternEdit?.isActive() ? this.patternEdit : null,
		});
		(this as { patternEdit: PaplicoPatternEdit }).patternEdit =
			new PaplicoPatternEdit({
				store: this.rendererStore,
				yjsProvider: this.yjsProvider,
				getViewportCenter: () => this.getActiveViewportCenter(),
				setOverlay: (key, overlay) => this.setUIOverlay(key, overlay),
				focusCanvas: () => this.ui?.focusCanvas(),
			});
		(this as { maskEdit: PaplicoMaskEdit }).maskEdit = new PaplicoMaskEdit({
			store: this.rendererStore,
			yjsProvider: this.yjsProvider,
			getWorldTransform: (elementId) => {
				const element = this.rendererStore.document.objects[elementId];
				if (!element) return createIdentityTransform();
				const ancestorT = this.spatialIndex.getAncestorTransform(elementId);
				const ownT = getTransform(element);
				return ancestorT ? composeTransforms(ancestorT, ownT) : ownT;
			},
			focusCanvas: () => this.ui?.focusCanvas(),
			selectElement: (elementId) =>
				this.selection.selectElement(
					elementId,
					this.spatialIndex.getBounds(elementId) ?? undefined,
				),
		});
		(this as { shortcuts: PaplicoShortcuts }).shortcuts =
			new PaplicoShortcuts();
		(this as { exporter: PaplicoExporter }).exporter = new PaplicoExporter(
			this.renderer,
			() => this.rendererStore.document,
		);
		(this as { psdExporter: PaplicoPSDExporter }).psdExporter =
			new PaplicoPSDExporter(this.renderer, () => this.rendererStore.document);
		(this as { tiffExporter: PaplicoTIFFExporter }).tiffExporter =
			new PaplicoTIFFExporter(
				this.renderer,
				() => this.rendererStore.document,
				this.getBuiltinProfileBytes,
			);
		this.toolContext = this.createToolContext();
		// Timelapse recording
		this.yjsProvider.ydoc.on("update", (update: Uint8Array) => {
			this.timelapseRecorder.onYjsUpdate(update);
		});

		// Register default shortcut commands
		this.registerDefaultShortcuts();
	}

	/**
	 * Dev-only: Rebuild all engine internals with hot-reloaded module code.
	 * Preserves the Paplico instance reference (React state stays valid)
	 * and restores document content + viewport from Y.Doc serialization.
	 *
	 * Note: Collaboration is destroyed and NOT re-established after HMR.
	 * The collaboration layer is connected externally (via connectToRoom),
	 * so it requires a manual reconnect or page reload for collab features.
	 */
	private _hmrReloading = false;

	public async _devHotReload(): Promise<void> {
		if (this._hmrReloading) {
			console.warn("[HMR] reload already in progress, skipping");
			return;
		}
		this._hmrReloading = true;

		try {
			console.log("🔄 Core HMR: rebuilding engine...");

			// 1. Save state for ALL canvas targets
			const yjsState = this.getYjsState();
			const targetSnapshots: Array<{
				canvas: HTMLCanvasElement;
				viewport: Viewport;
				isPrimary: boolean;
			}> = [];

			for (const [id, entry] of this.canvasTargets) {
				targetSnapshots.push({
					canvas: entry.target.canvas,
					viewport: entry.target.getViewport(),
					isPrimary: id === this.primaryTargetId,
				});
			}

			const primarySnapshot = targetSnapshots.find((s) => s.isPrimary);
			if (!primarySnapshot) return;

			// 2. Destroy subsystems (rendererStore, toolSettings, tools are kept)
			this.stopRendering();
			for (const [id] of this.canvasTargets) {
				this.removeCanvasTarget(id);
			}
			this.renderer.destroy();
			this.collaboration?.destroy();
			this.collaboration = null;
			this.yjsProvider.destroy();

			// Clear injected collaboration ref so initYjsProvider won't
			// reattach the destroyed instance to the new Y.Doc.
			if (this.options?.collaboration) {
				this.options.collaboration = undefined;
			}

			// Clear injected collaboration ref so initYjsProvider won't
			// reattach the destroyed instance to the new Y.Doc.
			if (this.options?.collaboration) {
				this.options.collaboration = undefined;
			}

			// Clear injected collaboration ref so initYjsProvider won't
			// reattach the destroyed instance to the new Y.Doc.
			if (this.options?.collaboration) {
				this.options.collaboration = undefined;
			}

			// 3. Rebuild renderer with new code
			this.renderer = new RenderOrchestrator();
			this.wireTextDocumentResolver();

			// 4. Re-init all subsystems (with primary canvas)
			await this._initSubsystems(primarySnapshot.canvas);

			// 5. Restore secondary canvas targets
			for (const snap of targetSnapshots) {
				if (snap.isPrimary) continue;
				const target = await this.addCanvasTarget(snap.canvas);
				target.setViewport(snap.viewport);
			}

			// 6. Restore document state (loadYjsState handles startRendering,
			//    createTool, setupBrushSettingsSubscription internally)
			this.stopRendering();
			this.loadYjsState(yjsState, primarySnapshot.viewport);

			console.log("✅ Core HMR: engine rebuilt");
		} finally {
			this._hmrReloading = false;
		}
	}

	public get ui(): PaplicoUI | null {
		if (!this.primaryTargetId) return null;
		return this.canvasTargets.get(this.primaryTargetId)?.ui ?? null;
	}

	public startRendering(): void {
		if (this.renderChangeSubscriber.isStarted()) return;
		this.renderChangeSubscriber.start();

		this.valtioUnsubscribes.push(
			subscribeKey(this.rendererStore, "selectedElementIds", () => {
				this.syncToolAppearanceFromSelection();
				this.syncPerspectiveGuideSourceToSelection();
				this.tool?.refreshUI?.();
				this.markDirty("selection");
			}),
		);

		this.renderer.setOnRequestRender(() => {
			this.renderer.invalidateDocumentCache();
			this.markDirty("render");
		});

		this.renderer.setOnTextBoundsComputed((elementId, bounds, localBounds) => {
			this.spatialIndex.setTextBounds(elementId, bounds, localBounds);

			// Precise bounds also reshape ancestor group bboxes, so refresh the
			// selection when the text or any of its ancestors is selected.
			const selectedIds = this.rendererStore.selectedElementIds;
			let affectedId: string | null = elementId;
			while (affectedId) {
				if (selectedIds.includes(affectedId)) {
					this.selection.updateSelectionBounds();
					this.tool?.refreshUI?.();
					break;
				}
				affectedId = this.spatialIndex.getParentGroupId(affectedId);
			}
		});

		for (const entry of this.canvasTargets.values()) {
			entry.scheduler.revive();
			entry.scheduler.renderNow();
		}
	}

	private stopRendering(): void {
		this.renderChangeSubscriber.stop();
		for (const entry of this.canvasTargets.values()) {
			entry.scheduler.destroy();
		}
		for (const unsub of this.valtioUnsubscribes) {
			unsub();
		}
		this.valtioUnsubscribes = [];
	}

	private markDirty(reason: DirtyReason): void {
		for (const entry of this.canvasTargets.values()) {
			entry.scheduler.markDirty(reason);
		}
	}

	public setElementOverride(elementId: string, element: AnyArtObject): void {
		this.rendererStore.elementOverrides.set(elementId, element);
		this.markDirty("preview");
	}

	public clearElementOverride(elementId: string): void {
		if (this.rendererStore.elementOverrides.delete(elementId)) {
			this.markDirty("preview");
		}
	}

	public addTransientElement(layerId: string, element: AnyArtObject): void {
		// Replace the map with a fresh ref rather than mutating in place: the
		// frame-plan structure cache keys transient elements by map identity, so
		// an in-place set would leave the live preview frozen at its first frame.
		const next = new Map(this.rendererStore.transientElements);
		next.set(element.id, { layerId, element });
		this.rendererStore.transientElements = ref(next);
		this.markDirty("preview");
	}

	public clearTransientElement(elementId: string): void {
		if (!this.rendererStore.transientElements.has(elementId)) return;
		const next = new Map(this.rendererStore.transientElements);
		next.delete(elementId);
		this.rendererStore.transientElements = ref(next);
		this.markDirty("preview");
	}

	public clearAllOverrides(): void {
		const hadOverrides = this.rendererStore.elementOverrides.size > 0;
		const hadTransients = this.rendererStore.transientElements.size > 0;
		this.rendererStore.elementOverrides.clear();
		if (hadTransients) this.rendererStore.transientElements = ref(new Map());
		if (hadOverrides || hadTransients) {
			this.markDirty("preview");
		}
	}

	// ===== Reference3D subsystem =====

	/**
	 * Renderer-facing Reference3D accessor. Null until the lazy three.js runtime
	 * has loaded — the renderer skips reference3d elements in that window and a
	 * re-render is kicked when the load resolves.
	 */
	private buildReference3DRenderContext(): Reference3DRenderContext | null {
		const service = getReference3DServiceSync();
		if (!service) return null;
		const committed = this.rendererStore.document.references3d ?? {};
		return {
			service,
			references3d:
				this.reference3dDefPreviews.size === 0
					? committed
					: {
							...committed,
							...Object.fromEntries(this.reference3dDefPreviews),
						},
		};
	}

	/** Committed scene definition with any active drag preview applied. */
	private getReference3DDefWithPreview(sceneId: string): Reference3DDef | null {
		return (
			this.reference3dDefPreviews.get(sceneId) ??
			this.rendererStore.document.references3d?.[sceneId] ??
			null
		);
	}

	/** Kick the lazy three.js runtime load once; re-render when it lands. */
	private requestReference3DService(): void {
		if (this.reference3dLoadRequested) return;
		this.reference3dLoadRequested = true;
		loadReference3DService()
			.then(() => {
				// Reference3d elements were skipped while the runtime was absent —
				// invalidate the document cache so they render now.
				this.renderer.invalidateDocumentCache();
				this.markDirty("document");
			})
			.catch((error) => {
				this.reference3dLoadRequested = false;
				console.error("Failed to load Reference3D runtime:", error);
			});
	}

	/** Load the 3D runtime as soon as a document brings reference3d elements in. */
	private requestReference3DServiceIfDocumentNeedsIt(): void {
		if (this.reference3dLoadRequested) return;
		const objects = this.rendererStore.document.objects;
		for (const id in objects) {
			if (objects[id].type === "reference3d") {
				this.requestReference3DService();
				return;
			}
		}
	}

	/**
	 * Add a 3D model to the scene currently being edited with the Reference3D
	 * tool: .vrm files become poseable figure nodes, other glTF binaries
	 * (.glb) become static mesh nodes. Bytes come from the app layer (core
	 * never reads files itself); the binary is stored as an EmbeddedFile
	 * (hash-deduplicated) and the node is appended in one undo step.
	 */
	public async reference3dAddModelFromBytes(
		bytes: Uint8Array<ArrayBuffer>,
		fileName: string,
	): Promise<boolean> {
		const elementId = this.reference3dController.getEditingElementId();
		const element = elementId
			? this.rendererStore.document.objects[elementId]
			: undefined;
		if (!element || !isReference3D(element)) return false;

		const file = await createEmbeddedFileFromBytes(
			bytes,
			fileName,
			"model/gltf-binary",
		);
		const node = fileName.toLowerCase().endsWith(".vrm")
			? this.commands.reference3dAddFigure(element.sceneId, file)
			: this.commands.reference3dAddMesh(element.sceneId, file);
		if (!node) return false;

		this.requestReference3DService();
		this.markDirty("document");
		return true;
	}

	/**
	 * Patch a reference3d element (light direction, export inclusion, scene
	 * reference, …) regardless of whether it is being edited.
	 */
	public reference3dUpdateElement(
		elementId: string,
		patch: Partial<Reference3DElement>,
	): void {
		const layerId = this.rendererStore.document.layers.find((l) =>
			l.elementIds.includes(elementId),
		)?.id;
		if (!layerId) return;
		// Switching the edited element's referenced scene invalidates the node
		// selection.
		if (
			patch.sceneId !== undefined &&
			this.reference3dController.getEditingElementId() === elementId
		) {
			this.reference3dController.selectNode(null);
		}
		this.commands.updateElement(layerId, elementId, patch);
		// Overlay geometry (gizmo) may depend on the patched fields.
		this.tool?.refreshUI?.();
	}

	/**
	 * Patch the reference3d element currently being edited. No-op when no
	 * scene is being edited.
	 */
	public reference3dUpdateEditingElement(
		patch: Partial<Reference3DElement>,
	): void {
		const id = this.reference3dController.getEditingElementId();
		if (!id) return;
		this.reference3dUpdateElement(id, patch);
	}

	/**
	 * Duplicate the node selected inside the edited scene (small position
	 * offset, one undo step) and select the copy. No-op without a selection.
	 */
	public reference3dDuplicateSelectedNode(): void {
		const elementId = this.reference3dController.getEditingElementId();
		const nodeId = this.reference3dController.getSelectedNodeId();
		const element = elementId
			? this.rendererStore.document.objects[elementId]
			: undefined;
		if (!element || !isReference3D(element) || !nodeId) return;

		const duplicate = this.commands.reference3dDuplicateNode(
			element.sceneId,
			nodeId,
		);
		if (!duplicate) return;
		this.reference3dController.selectNode(duplicate.id);
		this.tool?.refreshUI?.();
		this.markDirty("document");
	}

	/** Delete the node selected inside the edited scene (one undo step). */
	public reference3dDeleteSelectedNode(): void {
		const elementId = this.reference3dController.getEditingElementId();
		const nodeId = this.reference3dController.getSelectedNodeId();
		const element = elementId
			? this.rendererStore.document.objects[elementId]
			: undefined;
		if (!element || !isReference3D(element) || !nodeId) return;

		this.commands.reference3dRemoveNode(element.sceneId, nodeId);
		this.reference3dController.selectNode(null);
		this.tool?.refreshUI?.();
		this.markDirty("document");
	}

	// ===== Gradient tool =====

	/**
	 * Delete the gradient stop / mesh vertex currently selected by the
	 * gradient tool, then clear the stop selection and rebuild the handle
	 * overlay. Returns true when a stop was removed.
	 */
	public gradientDeleteSelectedStop(): boolean {
		if (!this.commands.deleteSelectedGradientStop()) return false;
		if (this.tool instanceof GradientTool) {
			this.tool.clearStopSelection();
			this.tool.refreshUI();
		}
		return true;
	}

	// ===== Perspective ruler =====

	/**
	 * Set (or clear) the reference3d element the perspective ruler derives its
	 * vanishing points from. Guides recompute on every camera / transform
	 * change of the source element and clear automatically when it vanishes.
	 */
	public setPerspectiveGuideSource(elementId: string | null): void {
		this.perspectiveGuideSourceId = elementId;
		this.refreshPerspectiveGuides();
	}

	/**
	 * Horizon / vanishing-point guides follow the selected reference3d element
	 * (first one in the selection). An active scene edit session owns the
	 * source instead — the tool sets it explicitly on enter.
	 */
	private syncPerspectiveGuideSourceToSelection(): void {
		if (this.reference3dController.getEditingElementId()) return;
		const objects = this.rendererStore.document.objects;
		const selectedSceneId =
			this.rendererStore.selectedElementIds.find((id) => {
				const element = objects[id];
				return element != null && isReference3D(element);
			}) ?? null;
		if (selectedSceneId !== this.perspectiveGuideSourceId) {
			this.setPerspectiveGuideSource(selectedSceneId);
		}
	}

	/** Recompute guide data + the "sys/perspective-guides" overlay. */
	private refreshPerspectiveGuides(): void {
		const id = this.perspectiveGuideSourceId;
		let guides: PerspectiveGuideData | null = null;

		if (id) {
			// A live camera-drag preview (element override) wins over the store.
			const element =
				this.rendererStore.elementOverrides.get(id) ??
				this.rendererStore.document.objects[id];
			if (element && isReference3D(element)) {
				const ancestor = this.spatialIndex.getAncestorTransform(id);
				guides = computePerspectiveGuides({
					elementId: id,
					camera: element.camera,
					localRect: {
						cx: element.x,
						cy: element.y,
						width: element.width,
						height: element.height,
					},
					transform: ancestor
						? composeTransforms(ancestor, element.transform)
						: element.transform,
				});
			} else {
				this.perspectiveGuideSourceId = null;
			}
		}

		this.perspectiveGuides = guides;
		this.setUIOverlay(
			OVERLAY_KEYS.sysPerspectiveGuides,
			guides
				? {
						zIndex: OVERLAY_Z.perspectiveGuide,
						primitives: buildPerspectiveGuideOverlay(guides, UI_THEME),
					}
				: null,
		);
		this.markDirty("selection");
	}

	public async addCanvasTarget(
		canvas: HTMLCanvasElement,
		options?: { id?: string; viewport?: Viewport },
	): Promise<CanvasTarget> {
		const target = new CanvasTarget(canvas, options);
		await this.renderer.initCanvasTarget(target);

		const scheduler = new RenderScheduler(
			(strategy, changedElements) =>
				this.renderTarget(target.id, strategy, changedElements),
			() =>
				this.rendererStore.transientElements.size > 0 ||
				this.rendererStore.elementOverrides.size > 0,
		);

		const ui = new PaplicoUI(canvas, {
			getViewport: () => target.getViewport(),
			setViewport: (viewport) => {
				const zoomChanged =
					viewport.zoom !== undefined &&
					viewport.zoom !== target.getViewport().zoom;
				target.setViewport(viewport);
				// Only a zoom change may blit the cached composite; a pan
				// re-renders (see RenderScheduler.markViewportInteraction).
				scheduler.markViewportInteraction(zoomChanged);
				// Tool overlays with fixed on-screen sizes baked into world
				// coordinates (scene gizmo arrows/rings) rebuild at the new zoom.
				if (zoomChanged) this.tool?.refreshUI?.();
			},
			getCanvasSize: () => ({ width: target.width, height: target.height }),
			getTool: () => this.tool,
			isDrawing: () => this._isDrawing,
			setDrawing: (drawing) => {
				this._isDrawing = drawing;
			},
			setActiveTarget: () => {
				this.activeTarget = target;
			},
			requestRender: () => {
				scheduler.markDirty("selection");
			},
			getCurrentTool: () => this.toolSettings.currentTool,
			getToolWidth: () =>
				this.toolSettings.currentTool === "eraser"
					? this.toolSettings.eraserSize
					: this.tools.brushSettings.size,
			setToolWidth: (width) => {
				if (this.toolSettings.currentTool === "eraser") {
					this.tools.setEraserSize(Math.max(1, Math.min(100, width)));
				} else if (this.toolSettings.currentTool === "pen") {
					this.tools.setBrushSettings({ size: Math.max(0.01, width) });
				}
			},
			getToolColor: () => colorToRawRGBA(this.getToolColorOrDefault()),
			setShapeType: (shapeType) => this.tools.setShapeType(shapeType),
			transformPressure: (pressure) =>
				transformPressure(this.toolSettings.pressureCurvePoints, pressure),
			getTouchDrawOffsetScale: () => this.toolSettings.touchDrawOffsetScale,
			updateCursor: (x, y) => this.collaboration?.updateCursor(x, y),
			clearCursor: () => this.collaboration?.clearCursor(),
			getCommands: () => this.commands,
			filterShortcutEvents: this.filterShortcutEvents ?? undefined,
			getSelectedElementIds: () => this.rendererStore.selectedElementIds,
			getShortcuts: () => this.shortcuts,
			getSelectionBounds: () => {
				if (this.tool?.name === "select") {
					return (this.tool as SelectTool).getSelectionBounds();
				}
				return null;
			},
			restoreSelection: (ids, bounds) => {
				this.rendererStore.selectedElementIds = [...ids];
				this.rendererStore.selectionBounds = bounds;
				this.refreshSelectionUI(true);
			},
			isToolManagingFocus: () =>
				this.rendererStore.uiOverlayState.overlays?.[
					OVERLAY_KEYS.sysTextEdit
				] != null,
		});

		ui.on("toolCursorUpdate", (data) => {
			this.setUIOverlay(
				OVERLAY_KEYS.sysCursor,
				data
					? {
							zIndex: OVERLAY_Z.toolCursor,
							primitives: buildToolCursorOverlay(data, UI_THEME),
						}
					: null,
			);
		});
		ui.on("eraserToolUpdate", (data) => {
			this.setUIOverlay(
				OVERLAY_KEYS.sysEraser,
				data
					? {
							zIndex: OVERLAY_Z.eraser,
							primitives: buildEraserOverlay(data, UI_THEME),
						}
					: null,
			);
		});
		ui.on("fileDrop", (files) => {
			this.handleFileDrop(files);
		});
		ui.on("paste", ({ worldX, worldY, data }) => {
			const viewport = { x: worldX, y: worldY };
			switch (data.type) {
				case "artobject":
					this.commands.pasteElements(data.elements, { viewport });
					break;
				case "svg":
					void this.commands.pasteSvgString(
						data.svg,
						viewport,
						data.fallbackImageFile,
					);
					break;
				case "imagefile":
					void this.commands.pasteImageFile(data.file, viewport);
					break;
				case "text":
					this.commands.pasteText(data.text, viewport);
					break;
			}
		});

		target.on("viewportChanged", () => {
			this.tool?.refreshUI?.();
		});

		const resizeObserver = new ResizeObserver(() => {
			target.updateSize();
			scheduler.markDirty("resize");
		});
		resizeObserver.observe(canvas);

		this.canvasTargets.set(
			target.id,
			new CanvasTargetEntry(target, ui, scheduler, [], resizeObserver),
		);

		// Keep a stable primary target for tool UI refresh and viewport-dependent APIs.
		// This is required after CanvasPane reattaches the primary canvas target.
		this.primaryTargetId ??= target.id;

		return target;
	}

	public removeCanvasTarget(targetId: string): void {
		const entry = this.canvasTargets.get(targetId);
		if (!entry) return;

		if (this.activeTarget === entry.target) {
			this.activeTarget = null;
		}
		entry.destroy();
		this.canvasTargets.delete(targetId);

		if (this.primaryTargetId === targetId) {
			if (this.canvasTargets.size === 0) {
				this.primaryTargetId = null;
				return;
			}

			const nextPrimaryTargetId = this.canvasTargets.keys().next().value;
			assertNonNull(
				nextPrimaryTargetId,
				"Expected next primary target id after removing current target",
			);
			this.primaryTargetId = nextPrimaryTargetId;
		}
	}

	public getPrimaryTarget(): CanvasTarget | null {
		if (!this.primaryTargetId) return null;
		return this.canvasTargets.get(this.primaryTargetId)?.target ?? null;
	}

	public getCanvasTarget(targetId: string): CanvasTarget | null {
		return this.canvasTargets.get(targetId)?.target ?? null;
	}

	private getActiveViewportCenter(): { x: number; y: number } | null {
		const target = this.activeTarget ?? this.getPrimaryTarget();
		if (!target) return null;
		const viewport = target.getViewport();
		return { x: viewport.x, y: viewport.y };
	}

	private exitEditingScopeOneLevel(): boolean {
		if (this.rendererStore.editingScopeStack.length === 0) return false;
		// Sessions are closed by PaplicoSelection itself, so every route out of a
		// scope — this one, the breadcrumb, the select tool — gets it.
		this.selection.exitEditingScopeOneLevel();
		return true;
	}

	/**
	 * Toggle soft proof display (print simulation). When enabled, bakes an
	 * RGB→CMYK→RGB roundtrip 3D LUT from the document's proof profile and
	 * applies it as the final display pass. The LUT is rebuilt automatically
	 * when the document's colorProfile settings change.
	 *
	 * @returns `true` once soft proof is active. Returns `false` (leaving soft
	 * proof disabled) when enabling fails because no usable CMYK proof profile
	 * is available — i.e. the document has no proof profile set, the referenced
	 * embedded profile is missing, or it is not a CMYK profile. Paplico bundles
	 * no CMYK profile, so the UI should prompt the user to load a CMYK ICC
	 * profile when this returns `false`. Disabling (`enabled === false`) always
	 * returns `false`.
	 */
	/**
	 * Toggle pixel preview: display the canvas rasterized at the document's
	 * rasterization DPI with nearest-neighbor upscaling.
	 */
	public setPixelPreview(enabled: boolean): void {
		this.renderer.setPixelPreview(enabled);
		this.markDirty("render");
	}

	public async setSoftProof(enabled: boolean): Promise<boolean> {
		if (!enabled) {
			this.softProof.active = false;
			this.softProof.settingsKey = null;
			// Invalidate any in-flight LUT build so it can't re-enable proofing.
			this.softProof.generation++;
			this.renderer.setSoftProofLut(null);
			this.markDirty("render");
			return false;
		}
		const built = await this.rebuildSoftProofLut();
		this.softProof.active = built;
		return built;
	}

	/**
	 * Build and apply the soft proof LUT from the document's proof profile.
	 * @returns `true` when a LUT was built and applied, `false` when no usable
	 * CMYK proof profile could be resolved (soft proof must stay disabled).
	 */
	private async rebuildSoftProofLut(): Promise<boolean> {
		const generation = ++this.softProof.generation;
		const doc = this.rendererStore.document;
		const settingsKey = JSON.stringify(doc.colorProfile ?? null);

		const proofProfileBytes = await resolveProofProfileBytes(
			doc.colorProfile?.proofProfile,
			doc.files,
			this.getBuiltinProfileBytes,
		);
		if (!proofProfileBytes) return false;

		const workingSpace = doc.colorProfile?.workingSpace ?? "display-p3";
		const lut = await buildSoftProofLut({
			displaySpace: workingSpace,
			proofProfileBytes,
			intent: doc.colorProfile?.proofIntent ?? "relative-colorimetric",
			displayProfileBytes: await this.getBuiltinProfileBytes(workingSpace),
		});

		// A newer build or a disable superseded this one — discard the result.
		if (generation !== this.softProof.generation) return false;

		this.softProof.settingsKey = settingsKey;
		this.renderer.setSoftProofLut(lut);
		this.markDirty("render");
		return true;
	}

	/** Rebuild the soft proof LUT when colorProfile settings changed while proofing. */
	private syncSoftProofToDocument(document: Document): void {
		if (!this.softProof.active) return;
		const settingsKey = JSON.stringify(document.colorProfile ?? null);
		if (settingsKey === this.softProof.settingsKey) return;
		void this.rebuildSoftProofLut()
			.then((built) => {
				// The new settings no longer resolve to a usable CMYK profile:
				// disable proofing and drop the stale LUT.
				if (!built) void this.setSoftProof(false);
			})
			.catch((e) => console.error("Failed to rebuild soft proof LUT:", e));
	}

	private renderTarget(
		targetId: string,
		strategy: RenderStrategy = RenderStrategy.full,
		changedElements?: ChangedElements,
	): void {
		const entry = this.canvasTargets.get(targetId);
		if (!entry) return;
		if (entry.target.width === 0 || entry.target.height === 0) return;
		if (!this.spatialIndex) return;

		const doc = snapshot(this.rendererStore.document) as Document;
		this.renderer.setCanvasTarget(entry.target);

		this.renderer.render(
			{
				viewport: entry.target.getViewport(),
				document: doc,
				strategy,
				changedElements,
				getDefRevision: (defId) => this.defIndex.getRevision(defId),
				defRevision: this.defIndex.getGlobalRevision(),
				boundsCache: this.spatialIndex.getBoundsCache(),
				editingScopeStack: this.rendererStore.editingScopeStack,
				isolatedElementId: this.reference3dController.getEditingElementId(),
				elementOverrides:
					this.rendererStore.elementOverrides.size > 0
						? this.rendererStore.elementOverrides
						: undefined,
				transientElements:
					this.rendererStore.transientElements.size > 0
						? this.rendererStore.transientElements
						: undefined,
				// Soft proof and HDR exposure are mutually exclusive: print
				// simulation is inherently SDR, so soft proof suppresses the
				// HDR exposure pass.
				hdrExposure:
					!this.softProof.active && doc.hdr?.enabled
						? (doc.hdr.exposure ?? 0)
						: undefined,
				softProof: this.softProof.active,
			},
			this.rendererStore.uiOverlayState,
		);
	}

	/** Set or remove (null) a generic overlay channel entry (`overlays[key]`). */
	private setUIOverlay(key: OverlayKey, overlay: UIOverlay | null): void {
		setOverlayEntry(this.rendererStore.uiOverlayState, key, overlay);
	}

	private refreshSelectionUI(includeHandles: boolean): void {
		const selectedIds = this.rendererStore.selectedElementIds;
		if (selectedIds.length === 0) {
			setSelectionOverlay(this.rendererStore.uiOverlayState, null);
			return;
		}

		const bounds = this.rendererStore.selectionBounds;
		if (!bounds) {
			setSelectionOverlay(this.rendererStore.uiOverlayState, null);
			return;
		}

		const keyObjectId = this.rendererStore.keyObjectId;
		const pathSegments: SelectionUIData["pathSegments"] = [];
		const keyObjectSegments: SelectionUIData["keyObjectSegments"] = [];
		for (const id of selectedIds) {
			const element = this.rendererStore.document.objects[id];
			if (!element) continue;
			const outlines = collectSelectionOutlines(
				element,
				(oid) => this.rendererStore.document.objects[oid],
				(oid) => this.spatialIndex.getAncestorTransform(oid),
				(oid) => this.spatialIndex.getElementWorldSegments(oid),
			);
			if (id === keyObjectId) keyObjectSegments.push(...outlines);
			else pathSegments.push(...outlines);
		}

		const viewport = this.getPrimaryTarget()?.getViewport();

		setSelectionOverlay(this.rendererStore.uiOverlayState, {
			bounds,
			rotation: 0,
			rotationCenter: {
				x: (bounds.minX + bounds.maxX) / 2,
				y: (bounds.minY + bounds.maxY) / 2,
			},
			handles: includeHandles ? createResizeHandles(bounds) : [],
			rotationHandle: includeHandles
				? createRotationHandle(bounds, viewport?.zoom ?? 1)
				: undefined,
			pathSegments: pathSegments.length > 0 ? pathSegments : undefined,
			keyObjectSegments:
				keyObjectSegments.length > 0 ? keyObjectSegments : undefined,
			boundsDashed: shouldDashSelectionBounds(
				selectedIds.map((id) => this.rendererStore.document.objects[id]),
			),
		});
	}

	/**
	 * Refresh selection-related UI when document changes (undo/redo, remote sync, etc.).
	 */
	private refreshToolUI(): void {
		for (const elementId of this.rendererStore.selectedElementIds) {
			this.spatialIndex.invalidateBounds(elementId);
		}
		this.selection.updateSelectionBounds();
		this.refreshSelectionUI(this.currentToolType === "select");

		this.tool?.refreshUI?.();
	}

	/**
	 * Create the YjsProvider and register its callbacks. The callbacks close
	 * over this.spatialIndex and this.commands, so both must be assigned on
	 * the instance before syncInitialLayers() triggers its first transactions.
	 */
	private initYjsProvider(): void {
		this.yjsProvider = new YjsProvider({
			callbacks: {
				onDocumentUpdate: (document) => {
					document.timelapse = this.rendererStore.document.timelapse;
					document.objects = ref(document.objects);
					this.defIndex.rebuild(document);
					this.textDepIndex.rebuild(document);
					this.rendererStore.document = document;
					this.patternEdit.refreshSessionVisuals();
					this.renderChangeSubscriber.syncFullDocument();
					this.renderer.setColorSpace(
						document.colorProfile?.workingSpace ?? "display-p3",
					);
					void this.renderer
						.setHdrEnabled(!!document.hdr?.enabled)
						.catch((e) => console.error("Failed to switch HDR mode:", e));
					this.syncSoftProofToDocument(document);
					this.requestReference3DServiceIfDocumentNeedsIt();
					if (this.perspectiveGuideSourceId) this.refreshPerspectiveGuides();
				},
				onLayersUpdate: (layers) => {
					this.rendererStore.document.layers = layers;
					this.renderChangeSubscriber.syncLayersOnly();
				},
				onObjectsChange: (delta) => {
					const objects = this.rendererStore.document.objects;
					const layers = this.rendererStore.document.layers;

					// Snapshot deleted objects before mutation (for hasGroupMutation)
					const deletedSnapshot: Record<string, AnyArtObject> = {};
					for (const id of delta.deleted) {
						if (objects[id]) deletedSnapshot[id] = objects[id];
					}

					// In-place mutation of the ref'd object — Valtio does not
					// observe these writes, so subscribers don't fire until the
					// SpatialIndex / change subscriber notifies them below.
					for (const [id, obj] of delta.added) objects[id] = obj;
					for (const [id, obj] of delta.updated) objects[id] = obj;
					for (const id of delta.deleted) delete objects[id];

					// Undo reaches the document while a mask session is open, so it
					// can take away the very mask being edited.
					this.maskEdit?.leaveIfMaskGone();

					// Update the SpatialIndex cache incrementally
					this.spatialIndex.applyObjectsDelta(delta);
					this.defIndex.notifyDelta(delta);
					for (const staleTextId of this.textDepIndex.notifyDelta(delta)) {
						this.renderer.invalidateTextCache(staleTextId);
					}
					if (this.currentToolType === "text") {
						this.scheduleTextOverflowBadgeRefresh();
						this.scheduleFontMissingOutlineRefresh();
					}

					// Phase 3: SpatialIndex + rendering updates (bypasses proxy traps)
					this.renderChangeSubscriber.syncObjectsDelta(
						delta,
						layers,
						deletedSnapshot,
					);

					// Phase 4: Valtio notification for React UI panels
					this.rendererStore.document.objects = {
						...this.rendererStore.document.objects,
					};
					this.patternEdit.refreshSessionVisuals();

					if (!this.reference3dLoadRequested) {
						for (const [, obj] of delta.added) {
							if (obj.type === "reference3d") {
								this.requestReference3DService();
								break;
							}
						}
					}

					// Guide source camera edits arrive as per-object deltas; moving
					// an ancestor group shifts the composed transform, so the
					// (short) parent chain is checked too.
					const guideSourceId = this.perspectiveGuideSourceId;
					if (
						guideSourceId &&
						guideSourceAffectedByDelta(guideSourceId, delta, (id) =>
							this.spatialIndex.getParentGroupId(id),
						)
					) {
						this.refreshPerspectiveGuides();
					}
				},
				getCurrentLayerId: () => this.rendererStore.currentLayerId,
				setCurrentLayerId: (layerId) => {
					this.rendererStore.currentLayerId = layerId;
				},
				onUndoRedoStateChange: () => {
					this.commands.updateUndoRedoState();
				},
				onSyncApplied: (meta) => {
					this.renderChangeSubscriber.onSyncApplied(meta);

					// Undo/redo may delete elements that are still in selectedElementIds.
					// Prune stale IDs so tools don't reference deleted objects.
					if (meta.undoRedo) {
						this.selection.updateSelectionBounds();
					}
				},
				onUndoStackMetaPopped: (meta, type) => {
					if (type !== "undo") return;
					if (meta.pathEditSelection && this.tool instanceof PathEditTool) {
						const target = this.getPrimaryTarget();
						if (!target) return;
						this.tool.restoreAnchorSelectionAfterUndo(
							meta.pathEditSelection,
							target.getViewport(),
							target.width,
							target.height,
						);
					}
				},
			},
		});

		// Optionally attach collaboration layer (injected from outside)
		if (this.options?.collaboration) {
			this.collaboration = this.options.collaboration;
		}

		console.log("✅ YjsProvider initialized");
	}

	/**
	 * Inject document access into the renderer's TextRenderer so axisBinding
	 * path references and flow chains resolve at layout time. Called after
	 * every RenderOrchestrator (re)construction.
	 */
	private wireTextDocumentResolver(): void {
		this.renderer.setTextDocumentResolver({
			// Override-aware: chain member layouts must see a drag-previewed
			// head (touch-type/edit previews), not only the committed document
			getElementById: (id) =>
				this.rendererStore.elementOverrides.get(id) ??
				this.rendererStore.document.objects[id] ??
				null,
			getWorldSegments: (id) =>
				this.spatialIndex.getElementWorldPath(id)?.segments ?? null,
			getGeometryRevision: (id) => this.textDepIndex.getGeometryRevision(id),
			getTextTransform: (element) =>
				this.resolveTextTransform(element.id, element),
			findFlowSource: (textId) => {
				const sourceId = this.textDepIndex.findFlowSourceId(textId);
				if (!sourceId) return null;
				const source = this.rendererStore.document.objects[sourceId];
				return source?.type === "text" ? source : null;
			},
		});
		this.wireTextHitTester();
	}

	/**
	 * Bound texts hit-test on their axis path + glyph ink instead of the
	 * AABB (SelectTool clicks, PathEditTool's guide resolution, etc.).
	 * The constructor wires the resolver before spatialIndex exists, so this
	 * runs again right after spatialIndex construction.
	 */
	private wireTextHitTester(): void {
		this.spatialIndex?.setTextHitTester((element, x, y, tolerance) => {
			const textRenderer = this.renderer?.getTextRenderer();
			if (!textRenderer) return null;
			return textRenderer.hitTestBoundTextSync(element, x, y, tolerance);
		});
	}

	/**
	 * Recompute the red "…" overflow badges. Text-tool-only UI: badges show
	 * where content is actually lost (regions without an outgoing flow link).
	 * Async layout results are sequence-guarded; identical badge sets skip the
	 * overlay write to avoid flicker on every keystroke.
	 */
	/**
	 * Debounced badge refresh: object deltas arrive per keystroke while
	 * editing, and a full-document overflow pass per keystroke would thrash
	 * the layout caches the editor itself is racing on.
	 */
	private scheduleTextOverflowBadgeRefresh(): void {
		if (this.textOverflowRefreshTimer !== null) return;
		this.textOverflowRefreshTimer = setTimeout(() => {
			this.textOverflowRefreshTimer = null;
			void this.refreshTextOverflowBadges();
		}, 200);
	}

	private async refreshTextOverflowBadges(): Promise<void> {
		if (this.currentToolType !== "text") return;
		const textRenderer = this.renderer?.getTextRenderer();
		if (!textRenderer) return;
		const seq = ++this.textOverflowRefreshSeq;

		const badges: Array<{ textId: string; anchor: { x: number; y: number } }> =
			[];
		for (const obj of Object.values(this.rendererStore.document.objects)) {
			if (obj?.type !== "text") continue;
			// Regions with an outgoing link overflow into the next region
			if (obj.flow?.nextTextElementId) continue;
			// Skip the element being edited (override active): its layout is in
			// flux and recomputing it here races the editor's own extraction
			if (this.rendererStore.elementOverrides.has(obj.id)) continue;
			try {
				const state = await textRenderer.getOverflowState(obj);
				if (!state.hasOverflow) continue;
				// Worldize through the element transform like every other
				// text overlay — untransformed anchors land far off for
				// rotated/scaled texts
				const { t, origin, isIdentity } = this.resolveTextTransform(
					obj.id,
					obj,
				);
				const wx = state.anchorLocal.x + obj.x;
				const wy = state.anchorLocal.y + obj.y;
				badges.push({
					textId: obj.id,
					anchor: isIdentity
						? { x: wx, y: wy }
						: applyTransformToPoint(wx, wy, t, origin.x, origin.y),
				});
			} catch {
				// Layout failure (e.g. fonts still loading): skip this element
			}
		}

		if (seq !== this.textOverflowRefreshSeq) return;
		if (this.currentToolType !== "text") return;
		const key = JSON.stringify(badges);
		if (key === this.lastTextOverflowBadgeKey) return;
		this.lastTextOverflowBadgeKey = key;
		setTextOverflowOverlay(this.rendererStore.uiOverlayState, badges);
		this.markDirty("selection");
	}

	private scheduleFontMissingOutlineRefresh(): void {
		if (this.fontMissingRefreshTimer !== null) return;
		this.fontMissingRefreshTimer = setTimeout(() => {
			this.fontMissingRefreshTimer = null;
			this.refreshFontMissingOutlines();
		}, 200);
	}

	/**
	 * Outline (red box) each text element whose font could not be resolved —
	 * any run's fontSource is not currently loaded — while the text tool is
	 * active. Re-runs on document change and on FontManager "fontLoaded" so an
	 * outline clears once a still-loading font finishes loading.
	 */
	private refreshFontMissingOutlines(): void {
		if (this.currentToolType !== "text") return;
		const seq = ++this.fontMissingRefreshSeq;

		const bounds: WorldBounds[] = [];
		for (const obj of Object.values(this.rendererStore.document.objects)) {
			if (obj?.type !== "text") continue;
			if (!this.textHasUnresolvedFont(obj)) continue;
			const wb = this.spatialIndex.getWorldBounds(obj.id);
			if (!wb) continue;
			bounds.push({
				minX: wb.minX,
				minY: wb.minY,
				maxX: wb.maxX,
				maxY: wb.maxY,
			});
		}

		if (seq !== this.fontMissingRefreshSeq) return;
		if (this.currentToolType !== "text") return;
		const key = JSON.stringify(bounds);
		if (key === this.lastFontMissingKey) return;
		this.lastFontMissingKey = key;
		setFontMissingOverlay(this.rendererStore.uiOverlayState, bounds);
		this.markDirty("selection");
	}

	private textHasUnresolvedFont(text: TextElement): boolean {
		const fontManager = getFontManager();
		const sources = [
			text.defaultStyle.fontSource,
			...text.content.paragraphs.flatMap((p) =>
				p.runs.map((r) => r.style.fontSource),
			),
		];
		return sources.some((s) => !fontManager.getLoadedFont(s));
	}

	/**
	 * Register a fixed-box region's box as its initial bounds so an empty
	 * region is selectable/linkable before the async layout result arrives
	 * (the synchronous glyph-based estimate degenerates for empty content).
	 */
	private registerInitialTextRegionBounds(text: TextElement): void {
		const { boxWidth, boxHeight } = text.layout;
		if (boxWidth === "auto" && boxHeight === "auto") return;
		const w = boxWidth === "auto" ? 0 : boxWidth;
		const h = boxHeight === "auto" ? 0 : boxHeight;
		if (w <= 0 && h <= 0) return;
		this.spatialIndex.setBounds(
			text.id,
			brandWorldBBox({
				minX: text.x,
				minY: text.y - h,
				maxX: text.x + w,
				maxY: text.y,
				width: w,
				height: h,
			}),
		);
	}

	/**
	 * The flow-chain member whose world bounds contain the point (nearest
	 * bounds center as fallback). Non-chained elements map to themselves.
	 */
	private resolveTextRegionAtPoint(
		element: TextElement,
		worldX: number,
		worldY: number,
	): TextElement {
		const memberIds = this.textDepIndex.chainMemberIds(element.id);
		if (memberIds.length <= 1) return element;

		let nearest: TextElement | null = null;
		let nearestDist = Number.POSITIVE_INFINITY;
		for (const id of memberIds) {
			const member = this.rendererStore.document.objects[id];
			if (member?.type !== "text") continue;
			const bounds = this.spatialIndex.getWorldBounds(id);
			if (!bounds) continue;
			if (
				worldX >= bounds.minX &&
				worldX <= bounds.maxX &&
				worldY >= bounds.minY &&
				worldY <= bounds.maxY
			) {
				return member;
			}
			const cx = (bounds.minX + bounds.maxX) / 2;
			const cy = (bounds.minY + bounds.maxY) / 2;
			const dist = (worldX - cx) ** 2 + (worldY - cy) ** 2;
			if (dist < nearestDist) {
				nearestDist = dist;
				nearest = member;
			}
		}
		return nearest ?? element;
	}

	/**
	 * Sync initial layers to Yjs. Must be called after spatialIndex and
	 * commands are ready, because the transactions issued here fire the
	 * observers that close over both.
	 */
	private syncInitialLayers(): void {
		if (this.collaboration) {
			console.log("🔗 Yjs collaboration initialized");
		} else {
			this.yjsProvider.initializeDocument(this.rendererStore.document);
			console.log(
				`📝 Yjs initialized in local-only mode with ${this.rendererStore.document.layers.length} layer(s)`,
			);
		}
	}

	// ===== Public Accessors =====

	public getCollaboration(): ICollaboration | null {
		return this.collaboration;
	}

	public get isReadonly(): boolean {
		return this.collaboration?.isReadonly ?? false;
	}

	public getYjsProvider(): YjsProvider {
		return this.yjsProvider;
	}

	// ===== Collaboration (Dynamic) =====

	public setCollaboration(collab: ICollaboration): void {
		if (this.collaboration) {
			this.collaboration.destroy();
			this.collaboration = null;
		}

		this.collaboration = collab;
		this.emit("collaborationChanged", undefined);
	}

	public clearCollaboration(): void {
		if (!this.collaboration) return;

		this.collaboration.destroy();
		this.collaboration = null;
		this.emit("collaborationChanged", undefined);
	}

	// ===== Public Query Methods =====

	public findArtboardAtPoint(x: number, y: number): Artboard | null {
		for (
			let i = this.rendererStore.document.artboards.length - 1;
			i >= 0;
			i--
		) {
			const artboard = this.rendererStore.document.artboards[i];
			const bounds = getArtboardBounds(artboard);
			if (
				x >= bounds.minX &&
				x <= bounds.maxX &&
				y >= bounds.minY &&
				y <= bounds.maxY
			) {
				return artboard;
			}
		}
		return null;
	}

	// ===== Import/Export =====

	public async exportDocument(): Promise<Blob> {
		const primaryTarget = this.getPrimaryTarget();
		const doc = {
			...snapshot(this.rendererStore).document,
			viewport:
				primaryTarget?.getViewport() ?? this.rendererStore.document.viewport,
			timelapse: this.timelapseRecorder.getTimelapseData() ?? undefined,
		};
		const { document: gcedDoc } = gcDocument(doc as Document);
		return serializeDocument(gcedDoc);
	}

	public async importDocument(source: Blob | Document): Promise<void> {
		const doc =
			source instanceof Blob
				? await (await openPapf(source)).toDocument()
				: source;

		// Disconnect collaboration before replacing document to avoid broadcasting empty document
		this.clearCollaboration();

		this.stopRendering();

		if (doc.timelapse && this.timelapseRecorder) {
			this.timelapseRecorder.restoreFrom(doc.timelapse);
		}

		this.rendererStore.document.timelapse = doc.timelapse;

		// Clear all UI state
		this.selection.clear();
		this.clearAllOverrides();
		this.rendererStore.editingScopeStack = [];
		this.rendererStore.selectedArtboardId = null;
		this.rendererStore.uiOverlayState.isArtboardEditMode = false;
		this.rendererStore.uiOverlayState.overlays = {};
		this.rendererStore.toolSession = null;

		// The outgoing document's cache scope (GPU buffers included) would
		// otherwise linger until scope-LRU eviction.
		const outgoingDocumentId = this.rendererStore.document.id;

		// Replace document in Yjs
		this.yjsProvider.replaceDocument(doc);

		if (outgoingDocumentId !== doc.id) {
			this.renderer.dropDocumentCaches(outgoingDocumentId);
		}

		// Restore viewport
		const primaryTarget = this.getPrimaryTarget();
		if (primaryTarget && doc.viewport) {
			primaryTarget.setViewport({ ...doc.viewport });
		}

		this.yjsProvider.clearUndoHistory();

		this.rendererStore.currentLayerId =
			doc.layers.length > 0 ? doc.layers[0].id : null;

		this.createTool(this.toolSettings.currentTool);
		this.startRendering();
		this.setupBrushSettingsSubscription();
	}

	// ===== Tool Management =====

	private resolveTextTransform(
		elementId: string,
		element: TextElement,
	): {
		t: ElementTransform;
		origin: { x: number; y: number };
		isIdentity: boolean;
	} {
		const ancestorT = this.spatialIndex.getAncestorTransform(elementId);
		const elementT = element.transform;
		const t = ancestorT ? composeTransforms(ancestorT, elementT) : elementT;
		if (isIdentityTransform(t)) {
			return { t, origin: { x: 0, y: 0 }, isIdentity: true };
		}
		// Use pre-transform local bounds (same source as ViewportManager GPU origin)
		// to avoid origin mismatch when transform.x/y is non-zero.
		const localBounds = calculateLocalElementBounds(element);
		const origin = computeTransformOrigin(localBounds);
		return { t, origin, isIdentity: false };
	}

	/**
	 * Depth-first, front-to-back search for a text element under the pointer
	 * inside a container. findElementAtPoint promotes hits to their top-level
	 * container, so the text tool needs this to reach grouped texts.
	 */
	private findTextInContainerAtPoint(
		container: AnyArtObject,
		worldX: number,
		worldY: number,
		tolerance: number,
	): TextElement | null {
		const childIds = getContainerChildIds(container) ?? [];
		for (let i = childIds.length - 1; i >= 0; i--) {
			const child = this.rendererStore.document.objects[childIds[i]];
			if (!child || child.visible === false) continue;
			if (child.type === "text") {
				if (this.hitTestTextForPointer(child, worldX, worldY, tolerance)) {
					return child;
				}
				continue;
			}
			if (isContainer(child)) {
				const inner = this.findTextInContainerAtPoint(
					child,
					worldX,
					worldY,
					tolerance,
				);
				if (inner) return inner;
			}
		}
		return null;
	}

	/**
	 * Pointer hit test for a single text element: axis-bound texts hit on
	 * their path/region/glyph ink (same predicate SpatialIndex uses), plain
	 * texts on their world AABB.
	 */
	private hitTestTextForPointer(
		text: TextElement,
		worldX: number,
		worldY: number,
		tolerance: number,
	): boolean {
		const textRenderer = this.renderer?.getTextRenderer();
		if (text.axisBinding && textRenderer) {
			const { t, origin, isIdentity } = this.resolveTextTransform(
				text.id,
				text,
			);
			const local = isIdentity
				? { x: worldX, y: worldY }
				: inverseTransform(worldX, worldY, t, origin.x, origin.y);
			const hit = textRenderer.hitTestBoundTextSync(
				text,
				local.x,
				local.y,
				tolerance,
			);
			if (hit !== null) return hit;
		}
		const bounds = this.spatialIndex.getBounds(text.id);
		return (
			bounds != null &&
			worldX >= bounds.minX - tolerance &&
			worldX <= bounds.maxX + tolerance &&
			worldY >= bounds.minY - tolerance &&
			worldY <= bounds.maxY + tolerance
		);
	}

	private createToolContext(): ToolContext {
		return new ToolContext({
			textToolController: this.textToolController,
			reference3dController: this.reference3dController,

			strokeComplete: (path) => {
				this.clearAllOverrides();
				this.commands.addPath(path);
				this.spatialIndex.invalidateBounds(path.id);

				if (this.toolSettings.selectStrokeAfterDraw) {
					this.selection.selectElement(path.id);
					this.selection.updateSelectionBounds();
					this.refreshSelectionUI(this.currentToolType === "select");
				}
			},
			previewUpdate: (path) => {
				if (path) {
					const layerId = this.rendererStore.currentLayerId;
					if (layerId)
						this.addTransientElement(layerId, {
							...path,
							id: PREVIEW_ELEMENT_SENTINEL_ID,
						});
				} else {
					this.clearTransientElement(PREVIEW_ELEMENT_SENTINEL_ID);
				}
			},
			textPreviewUpdate: (text) => {
				if (text) {
					this.setElementOverride(text.id, text);
					this.renderer.invalidateTextCache(text.id);
				}
			},

			eraseElement: (id) => this.commands.deleteElements([id]),
			addEraseMask: (elementId, mask) => {
				const obj = this.rendererStore.document.objects[elementId];
				if (!obj || obj.type !== "path") return;
				const existing = obj.eraseMasks ?? [];

				this.commands.updateElement("", elementId, {
					eraseMasks: [...existing, mask],
				});
			},
			updateElement: (elementId, updates) => {
				const layerId = this.rendererStore.currentLayerId ?? "";
				this.commands.updateElement(layerId, elementId, updates);
			},
			addPaths: (paths) => {
				for (const path of paths) {
					this.commands.addPath(path);
				}
			},
			transact: (fn) => this.commands.transact(fn),
			getCurrentLayer: () => this.getCurrentLayer(),
			getLayers: () => this.rendererStore.document.layers,
			getObjects: () => this.rendererStore.document.objects,

			elementSelect: (id, bounds) => {
				this.selection.selectElement(id, bounds);
			},
			elementToggleSelect: (id, bounds) =>
				this.selection.toggleElement(id, bounds),
			elementMove: (id, dx, dy) => {
				const currentLayerId = this.rendererStore.currentLayerId;
				if (!currentLayerId) return;

				this.renderChangeSubscriber.withTransformOnlyChange(() => {
					const elementMoves = this.collectElementMoveUpdates(
						[{ layerId: currentLayerId, elementId: id }],
						dx,
						dy,
					);
					this.commands.batchUpdateElements(elementMoves);
				});

				// If the moved element is a blend key, reshape its spine to follow.
				this.commands.rebuildBlendSpineIfKey(id);

				const el = this.rendererStore.document.objects[id];
				if (el?.type === "group") {
					this.spatialIndex.invalidateBounds(id);
				}
			},
			elementsMove: (ids, dx, dy) => {
				const currentLayerId = this.rendererStore.currentLayerId;
				if (!currentLayerId) return;

				// Build set of all descendant IDs of groups in the selection
				// to prevent double-movement (collectElementMoveUpdates recurses into groups)
				const descendantIds = new Set<string>();
				const collectDescendants = (groupId: string) => {
					const el = this.rendererStore.document.objects[groupId];
					if (el?.type !== "group") return;
					for (const childId of el.childIds) {
						descendantIds.add(childId);
						collectDescendants(childId);
					}
				};
				for (const id of ids) {
					collectDescendants(id);
				}

				const elements = ids
					.filter((id) => !descendantIds.has(id))
					.map((id) => ({ layerId: currentLayerId, elementId: id }));

				this.renderChangeSubscriber.withTransformOnlyChange(() => {
					const elementMoves = this.collectElementMoveUpdates(elements, dx, dy);
					this.commands.batchUpdateElements(elementMoves);
				});

				// Reshape the spine to follow any moved blend keys.
				for (const id of ids) this.commands.rebuildBlendSpineIfKey(id);

				// Invalidate bounds for groups whose children moved
				for (const id of ids) {
					if (descendantIds.has(id)) continue;
					const el = this.rendererStore.document.objects[id];
					if (el?.type === "group") {
						this.spatialIndex.invalidateBounds(id);
					}
				}
			},
			elementResize: (id, originalBounds, newBounds) => {
				this.handleElementResize(id, originalBounds, newBounds);
			},
			elementsResize: (ids, originalBounds, newBounds) => {
				// Build set of all descendant IDs of groups in the selection
				// to prevent double-resize (handleElementResize recurses into groups)
				const descendantIds = new Set<string>();
				const collectDescendants = (groupId: string) => {
					const el = this.rendererStore.document.objects[groupId];
					if (el?.type !== "group") return;
					for (const childId of el.childIds) {
						descendantIds.add(childId);
						collectDescendants(childId);
					}
				};
				for (const id of ids) {
					collectDescendants(id);
				}

				const targetIds = ids.filter((id) => !descendantIds.has(id));
				for (const id of targetIds) {
					this.handleElementResize(id, originalBounds, newBounds);
				}
			},
			elementRotate: (id, angleDeg, cx, cy) => {
				const layerId = this.rendererStore.currentLayerId;
				if (!layerId) return;
				this.commands.rotateElement(layerId, id, angleDeg, cx, cy);
			},
			elementsRotate: (ids, angleDeg, cx, cy) => {
				// Build set of all descendant IDs of groups in the selection
				// to prevent double-rotation (rotateElements recurses into groups)
				const descendantIds = new Set<string>();
				const collectDescendants = (groupId: string) => {
					const el = this.rendererStore.document.objects[groupId];
					if (el?.type !== "group") return;
					for (const childId of el.childIds) {
						descendantIds.add(childId);
						collectDescendants(childId);
					}
				};
				for (const id of ids) {
					collectDescendants(id);
				}

				const targetIds = ids.filter((id) => !descendantIds.has(id));
				this.commands.rotateElements(targetIds, angleDeg, cx, cy);
			},
			uiUpdateSelectionUI: (ui) => {
				if (this.tool instanceof ArtboardTool) {
					setArtboardSelectionOverlay(
						this.rendererStore.uiOverlayState,
						ui as ArtboardSelectionUIData | null,
					);
					return;
				}
				setSelectionOverlay(
					this.rendererStore.uiOverlayState,
					ui as SelectionUIData | null,
				);
				this.rendererStore.selectionBounds =
					(ui as SelectionUIData | null)?.bounds ?? null;
			},
			selectionSelectMultiple: (ids) => {
				this.selection.selectMultiple(ids);
			},
			selectionClear: () => {
				this.selection.clear();
				if (this.tool instanceof GradientTool) {
					setSelectionOverlay(this.rendererStore.uiOverlayState, null);
				}
			},
			uiRefreshSelectionUI: (includeHandles) => {
				this.refreshSelectionUI(includeHandles);
			},
			getSelectedElementIds: () => this.rendererStore.selectedElementIds,
			setKeyObject: (id) => {
				this.selection.setKeyObject(id);
			},
			getKeyObjectId: () => this.rendererStore.keyObjectId,
			findElementAtPoint: (x, y, tolerance) => {
				const layers = this.rendererStore.document.layers;
				for (let i = layers.length - 1; i >= 0; i--) {
					const layer = layers[i];
					if (!layer.visible || layer.locked) continue;
					const element = this.spatialIndex.findElementAtPoint(
						layer.id,
						x,
						y,
						tolerance,
					);
					if (element) {
						if (this.rendererStore.currentLayerId !== layer.id) {
							this.rendererStore.currentLayerId = layer.id;
						}
						return element;
					}
				}
				return null;
			},
			findElementsInRect: (minX, minY, maxX, maxY) => {
				const layers = this.rendererStore.document.layers;
				const results: AnyArtObject[] = [];
				let topmostLayerId: string | null = null;
				for (let i = layers.length - 1; i >= 0; i--) {
					const layer = layers[i];
					if (!layer.visible || layer.locked) continue;
					const elements = this.spatialIndex.findElementsInRect(
						layer.id,
						minX,
						minY,
						maxX,
						maxY,
					);
					if (elements.length > 0) {
						topmostLayerId ??= layer.id;
						results.push(...elements);
					}
				}
				if (
					topmostLayerId &&
					this.rendererStore.currentLayerId !== topmostLayerId
				) {
					this.rendererStore.currentLayerId = topmostLayerId;
				}
				return results;
			},
			enterEditingScope: (elementId) =>
				this.selection.enterEditingScope(elementId),
			exitEditingScopeOneLevel: () => void this.exitEditingScopeOneLevel(),
			getEditingScopeId: () =>
				this.rendererStore.editingScopeStack.at(-1) ?? null,
			isElementEditable: (elementId) =>
				this.selection.isElementEditable(elementId),
			isElementLocked: (elementId) =>
				this.spatialIndex.isElementLocked(elementId),
			isCurrentLayerLocked: () => {
				const layerId = this.rendererStore.currentLayerId;
				if (!layerId) return false;
				const layer = this.rendererStore.document.layers.find(
					(l) => l.id === layerId,
				);
				if (layer?.locked) return true;
				const editingScopeId = this.rendererStore.editingScopeStack.at(-1);
				if (editingScopeId && this.spatialIndex.isElementLocked(editingScopeId))
					return true;
				return false;
			},
			isReadonly: () => this.isReadonly,
			getElement: (id) => this.rendererStore.document.objects[id] ?? null,
			getBounds: (id) => this.spatialIndex.getWorldBounds(id),
			getElementWorldSegments: (id) =>
				this.spatialIndex.getElementWorldSegments(id),
			getAncestorTransform: (id) => this.spatialIndex.getAncestorTransform(id),
			updateSelectedElementFilter: (index, params) =>
				this.commands.updateFilterForSelectedElement(index, { params }),
			addElementToLayer: (layerId, element) =>
				this.commands.addElementToLayer(layerId, element),
			addObjectToDocument: (element) =>
				this.commands.addObjectToDocument(element),
			duplicateElementsByIds: (elementIds, offset) =>
				this.commands.duplicateElementsByIds(elementIds, offset),
			textEdit: (element) => {
				if (element.type !== "text") return;
				this.updateToolState({ currentTool: "text" });
				if (this.tool instanceof TextTool) {
					this.tool.enterEditModeForElement(element);
				}
			},
			reference3dEdit: (element) => {
				if (!isReference3D(element)) return;
				this.updateToolState({ currentTool: "reference3d" });
				if (this.tool instanceof Reference3DTool) {
					this.tool.enterEditModeForElement(element);
				}
			},
			reference3dExitEdit: () => {
				this.tools.setCurrentTool("select");
			},
			reference3dCreate: (x, y, width, height) =>
				this.commands.createReference3DScene(x, y, width, height),
			reference3dGetDef: (sceneId) =>
				this.getReference3DDefWithPreview(sceneId),
			reference3dAddNode: (sceneId, node) =>
				this.commands.reference3dAddNode(sceneId, node),
			reference3dCommitNode: (sceneId, nodeId, patch) =>
				this.commands.reference3dCommitNode(sceneId, nodeId, patch),
			reference3dPreviewCamera: (elementId, camera) => {
				if (!camera) {
					this.clearElementOverride(elementId);
				} else {
					const element = this.rendererStore.document.objects[elementId];
					if (element && isReference3D(element)) {
						this.setElementOverride(elementId, { ...element, camera });
					}
				}
				// Perspective guides follow the live camera preview.
				if (this.perspectiveGuideSourceId === elementId) {
					this.refreshPerspectiveGuides();
				}
			},
			reference3dPreviewNodes: (sceneId, nodes) => {
				if (!nodes) {
					if (this.reference3dDefPreviews.delete(sceneId)) {
						this.markDirty("preview");
					}
					return;
				}
				const def = this.rendererStore.document.references3d?.[sceneId];
				if (!def) return;
				this.reference3dDefPreviews.set(sceneId, { ...def, nodes: [...nodes] });
				this.markDirty("preview");
			},
			reference3dRaycastNode: (request) =>
				getReference3DServiceSync()?.raycastNode(request) ?? null,
			reference3dSetGuideSource: (elementId) =>
				this.setPerspectiveGuideSource(elementId),
			getPerspectiveGuides: () => this.perspectiveGuides,
			reference3dGetFigureRig: (fileUid) =>
				getReference3DServiceSync()?.getFigureRig(fileUid) ?? null,
			snapElements: (movingIds, originalBounds, dx, dy, zoom) =>
				this.spatialIndex.snapElements(movingIds, originalBounds, dx, dy, zoom),

			pathSelect: (id) => {
				const bounds = this.spatialIndex.getBounds(id);
				this.selection.selectElement(id, bounds ?? undefined);
			},
			pathUpdate: (pathId, segments) => {
				this.clearElementOverride(pathId);
				this.commands.updateElement("", pathId, { segments });
				// Blend spine ↔ keys sync: editing the spine redistributes the keys;
				// editing/moving a key reshapes the spine through the keys.
				this.commands.reflowBlendsForSpine(pathId);
				this.commands.rebuildBlendSpineIfKey(pathId);
			},
			batchPathUpdate: (paths) => {
				const updates = paths.map(([pathId, segments]) => {
					this.clearElementOverride(pathId);
					return { elementId: pathId, updates: { segments } };
				});
				this.yjsProvider.batchUpdateElements(updates);
				for (const [pathId] of paths) {
					this.commands.reflowBlendsForSpine(pathId);
					this.commands.rebuildBlendSpineIfKey(pathId);
				}
			},
			previewSegments: (pathId, segments) => {
				const obj = this.rendererStore.document.objects[pathId];
				if (obj?.type === "path") {
					this.setElementOverride(pathId, {
						...obj,
						segments,
					} satisfies Path);
				}
			},
			findPathAtPoint: (x, y, tolerance, deepSearch) => {
				const layers = this.rendererStore.document.layers;
				for (let i = layers.length - 1; i >= 0; i--) {
					const layer = layers[i];
					if (!layer.visible || layer.locked) continue;
					const path = this.spatialIndex.findPathAtPoint(
						layer.id,
						x,
						y,
						tolerance,
						deepSearch,
					);
					if (path) {
						if (this.rendererStore.currentLayerId !== layer.id) {
							this.rendererStore.currentLayerId = layer.id;
						}
						return path;
					}
					// Bound texts occlude their (invisible) axis path: resolve
					// through the text so the guide path stays reachable
					const element = this.spatialIndex.findElementAtPoint(
						layer.id,
						x,
						y,
						tolerance,
					);
					if (element?.type === "text" && element.axisBinding) {
						const axisPath =
							this.rendererStore.document.objects[
								element.axisBinding.pathObjectId
							];
						if (axisPath?.type === "path" && !axisPath.locked) {
							if (this.rendererStore.currentLayerId !== layer.id) {
								this.rendererStore.currentLayerId = layer.id;
							}
							return axisPath;
						}
					}
				}
				return null;
			},
			replacePathWithPaths: (pathId, segmentLists) => {
				const currentLayerId = this.rendererStore.currentLayerId;
				if (!currentLayerId) return;
				this.commands.replacePathWithPaths(
					currentLayerId,
					pathId,
					segmentLists,
				);
			},
			pathEditGetSelectionMode: () => {
				return this.toolSettings.pathEditSelectionMode;
			},
			pathEditGetCutMode: () => {
				return this.toolSettings.pathEditCutMode;
			},
			pathEditSetCutMode: (enabled) => {
				this.toolSettings.pathEditCutMode = enabled;
			},
			stashPathEditUndoSelection: (handleKeys) =>
				this.yjsProvider.stashUndoMeta("pathEditSelection", handleKeys),
			selectGetSelectionMode: () => {
				return this.toolSettings.selectSelectionMode;
			},
			pathEditUpdateSelectedAnchors: (anchors) => {
				this.toolSettings.pathEditSelectedAnchors = anchors;
			},
			getPathById: (pathId) => {
				const obj = this.rendererStore.document.objects[pathId];
				return obj?.type === "path" ? obj : null;
			},
			getAllEditablePaths: () =>
				collectEditablePaths(
					this.rendererStore.document,
					this.rendererStore.editingScopeStack.at(-1) ?? null,
				),

			artboardCreate: (artboard) => this.commands.addArtboard(artboard),
			artboardSelect: (id) => this.selection.selectArtboard(id),
			artboardUpdate: (id, updates) =>
				this.commands.updateArtboard(id, updates),
			getArtboards: () => this.rendererStore.document.artboards,
			getSelectedArtboardId: () => this.rendererStore.selectedArtboardId,
			findArtboardAtPoint: (x, y) => this.findArtboardAtPoint(x, y),
			snapArtboard: (id, bounds, dx, dy, zoom) =>
				this.spatialIndex.snapArtboard(id, bounds, dx, dy, zoom),
			snapArtboardToElements: (bounds, zoom) =>
				this.spatialIndex.snapBoundsToElements(bounds, zoom),
			findElementsOnArtboard: (artboardBounds) =>
				this.spatialIndex.findElementsOverlappingArtboard(artboardBounds),
			artboardMoveCommit: (id, updates, elements, deltaX, deltaY) => {
				// Build set of all descendant IDs of groups in the selection
				// to prevent double-movement (collectElementMoveUpdates recurses into groups)
				const descendantIds = new Set<string>();
				const collectDescendants = (groupId: string) => {
					const el = this.rendererStore.document.objects[groupId];
					if (el?.type !== "group") return;
					for (const childId of el.childIds) {
						descendantIds.add(childId);
						collectDescendants(childId);
					}
				};
				for (const { elementId } of elements) {
					collectDescendants(elementId);
				}

				const targetElements = elements.filter(
					(e) => !descendantIds.has(e.elementId),
				);
				const elementMoves = this.collectElementMoveUpdates(
					targetElements,
					deltaX,
					deltaY,
				);
				const boundsBeforeMove = new Map<string, WorldBBox>();
				for (const { elementId } of targetElements) {
					const bounds = this.spatialIndex.getBounds(
						elementId,
						this.rendererStore.document.objects[elementId],
					);
					if (bounds) boundsBeforeMove.set(elementId, bounds);
				}

				this.commands.commitArtboardMove(id, updates, elementMoves);
				for (const { elementId } of targetElements) {
					const el = this.rendererStore.document.objects[elementId];
					if (el?.type === "group") {
						this.spatialIndex.invalidateBounds(elementId);
						continue;
					}
					const oldBounds = boundsBeforeMove.get(elementId);
					if (!oldBounds) continue;
					this.spatialIndex.setBounds(
						elementId,
						translateBounds(oldBounds, deltaX, deltaY),
					);
				}
			},

			pathDraftCreate: (path) => {
				const currentLayerId = this.rendererStore.currentLayerId;
				if (!currentLayerId) return;
				this.commands.addPath(path);
				this.commands.stopUndoCapture();
			},
			pathDraftUpdate: (layerId, pathId, segments) => {
				this.commands.updateElement(layerId, pathId, { segments });
				this.commands.stopUndoCapture();
			},
			pathDraftDelete: (_layerId, pathId) => {
				this.commands.deleteElements([pathId]);
				this.commands.stopUndoCapture();
			},
			pathComplete: (pathId) => {
				this.spatialIndex.invalidateBounds(pathId);
				this.selection.selectElement(pathId);
				this.selection.updateSelectionBounds();
				this.refreshSelectionUI(this.currentToolType === "select");
			},

			shapeComplete: (path) => {
				this.clearAllOverrides();
				this.commands.addPath(path);
				this.spatialIndex.invalidateBounds(path.id);
				this.selection.selectElement(path.id);
				this.selection.updateSelectionBounds();
				this.refreshSelectionUI(this.currentToolType === "select");
			},

			textCreate: (text) => {
				this.commands.addText(text);
				this.registerInitialTextRegionBounds(text);
				const bounds = this.spatialIndex.getBounds(text.id, text);
				this.selection.selectElement(text.id, bounds ?? undefined);
			},
			textCreateOnPath: (text, pathObjectId, mode, clickWorld) => {
				// onPath: anchor the text at the point on the path nearest the click
				if (mode === "onPath" && text.axisBinding?.mode === "onPath") {
					const worldPath = this.spatialIndex.getElementWorldPath(pathObjectId);
					if (worldPath) {
						const table = buildArcLengthTable(worldPath.segments);
						const total = table.at(-1)?.cumulativeLength ?? 0;
						if (total > 0) {
							const arc = arcLengthOfNearestSpinePoint(
								clickWorld,
								worldPath.segments,
								table,
								total,
							);
							text.axisBinding.startOffset = arc / total;
						}
					}
				}
				// The axis path keeps its own element but stops being painted, so
				// its appearance moves onto the text: the converted object keeps
				// the look it had as a path
				const axisPath = this.rendererStore.document.objects[pathObjectId];
				if (axisPath) {
					if (axisPath.filters?.length) {
						text.filters = deepClone(axisPath.filters);
					}
					text.opacity = axisPath.opacity;
					text.blendMode = axisPath.blendMode;
				}

				this.commands.transact((commands) => {
					commands.addText(text);
					if (!axisPath) return;
					commands.updateElement("", pathObjectId, {
						filters: [],
						opacity: 1,
						blendMode: "normal",
					});
				});
				// Until async layout lands, approximate the region with the axis
				// path's bounds so the empty text is selectable/linkable at once
				const pathBounds = this.spatialIndex.getBounds(pathObjectId);
				if (pathBounds) this.spatialIndex.setBounds(text.id, pathBounds);
				const bounds = this.spatialIndex.getBounds(text.id, text);
				this.selection.selectElement(text.id, bounds ?? undefined);
			},
			textFlowLink: (sourceTextId, targetTextId) => {
				this.commands.updateElement("", sourceTextId, {
					flow: { nextTextElementId: targetTextId },
				} as Partial<AnyArtObject>);
				void this.refreshTextOverflowBadges();
			},
			textFlowUnlink: (sourceTextId) => {
				this.commands.updateElement("", sourceTextId, {
					flow: undefined,
				} as Partial<AnyArtObject>);
				void this.refreshTextOverflowBadges();
			},
			textFindFlowSource: (textId) => {
				const sourceId = this.textDepIndex.findFlowSourceId(textId);
				if (!sourceId) return null;
				const source = this.rendererStore.document.objects[sourceId];
				return source?.type === "text" ? source : null;
			},
			listTextElements: () =>
				Object.values(this.rendererStore.document.objects).filter(
					(obj): obj is TextElement => obj?.type === "text",
				),
			textChainMembers: (textId) =>
				this.textDepIndex.chainMemberIds(textId).flatMap((id) => {
					const obj = this.rendererStore.document.objects[id];
					return obj?.type === "text" ? [obj] : [];
				}),
			hitTestTextGlyph: async (textElement, worldX, worldY) => {
				const textRenderer = this.renderer?.getTextRenderer();
				if (!textRenderer) return null;

				// Flow chains: pick within the region under the pointer
				const region = this.resolveTextRegionAtPoint(
					textElement,
					worldX,
					worldY,
				);
				const { t, origin, isIdentity } = this.resolveTextTransform(
					region.id,
					region,
				);
				let localX: number;
				let localY: number;
				if (isIdentity) {
					localX = worldX - region.x;
					localY = worldY - region.y;
				} else {
					const local = inverseTransform(worldX, worldY, t, origin.x, origin.y);
					localX = local.x - region.x;
					localY = local.y - region.y;
				}
				const zoom = this.getPrimaryTarget()?.getViewport()?.zoom ?? 1;
				return textRenderer.hitTestGlyph(
					region,
					localX,
					localY,
					UI_THEME.hitTolerancePx / zoom,
				);
			},
			getTextGlyphQuads: async (textElement, charIndices) => {
				const identityT = { rotation: 0, scaleX: 1, scaleY: 1 };
				const textRenderer = this.renderer?.getTextRenderer();
				if (!textRenderer) return { quads: [], elementTransform: identityT };

				// Flow chains: glyphs live in the member regions' layouts, each
				// worldized with its own position/transform
				const memberIds = this.textDepIndex.chainMemberIds(textElement.id);
				const members: TextElement[] =
					memberIds.length > 1
						? memberIds.flatMap((id) => {
								const obj = this.rendererStore.document.objects[id];
								return obj?.type === "text" ? [obj] : [];
							})
						: [textElement];

				const memberQuads = await Promise.all(
					members.map(async (member) => {
						const quads = await textRenderer.getGlyphQuads(member, charIndices);
						if (quads.length === 0) return [];
						const { t, origin, isIdentity } = this.resolveTextTransform(
							member.id,
							member,
						);
						const toWorld = (p: { x: number; y: number }) => {
							const wx = p.x + member.x;
							const wy = p.y + member.y;
							return isIdentity
								? { x: wx, y: wy }
								: applyTransformToPoint(wx, wy, t, origin.x, origin.y);
						};
						return quads.map((q) => ({
							...q,
							pivot: toWorld(q.pivot),
							rotation: q.rotation + (isIdentity ? 0 : t.rotation),
							corners: q.corners.map(toWorld) as typeof q.corners,
						}));
					}),
				);
				const worldQuads = memberQuads.flat();

				// Drag deltas convert through the session (head) element's transform
				const head = this.resolveTextTransform(textElement.id, textElement);
				return {
					quads: worldQuads,
					elementTransform: head.isIdentity
						? identityT
						: {
								rotation: head.t.rotation,
								scaleX: head.t.scaleX,
								scaleY: head.t.scaleY,
							},
				};
			},
			textCharTouchCommit: (text) => {
				const layerId = this.rendererStore.currentLayerId;
				if (!layerId) return undefined;
				// One drag = one undo step: break out of the capture-merge window
				this.commands.stopUndoCapture();
				this.commands.updateElement(layerId, text.id, text);
				const stored = this.rendererStore.document.objects[text.id];
				// Glyphs moved, so refresh precise bounds/selection like textComplete
				void (async () => {
					const textRenderer = this.renderer?.getTextRenderer();
					if (!textRenderer) return;
					try {
						const result = await textRenderer.textElementToPaths(text);
						this.spatialIndex.setBounds(text.id, result.bounds);
						if (this.rendererStore.selectedElementIds.includes(text.id)) {
							this.selection.selectElement(text.id, result.bounds);
							this.refreshSelectionUI(this.currentToolType === "select");
						}
					} catch (err) {
						console.error("Failed to compute text bounds:", err);
					}
				})();
				return stored ? deepClone(stored as TextElement) : undefined;
			},
			textCharTouchModeChange: (enabled) => {
				this.toolSettings.textCharTouchMode = enabled;
			},
			textComplete: async (text) => {
				this.clearElementOverride(text.id);
				const currentLayerId = this.rendererStore.currentLayerId;
				if (!currentLayerId) return;

				this.renderer.invalidateTextCache(text.id);
				this.commands.updateElement(currentLayerId, text.id, text);
				const textRenderer = this.renderer?.getTextRenderer();
				if (!textRenderer) return;

				try {
					const result = await textRenderer.textElementToPaths(text);
					this.spatialIndex.setBounds(text.id, result.bounds);
					// Only update selection if the element is still selected — user may
					// have switched to a different text element during async layout
					if (this.rendererStore.selectedElementIds.includes(text.id)) {
						this.selection.selectElement(text.id, result.bounds);
						// Rebuild the overlay quad like pathComplete/shapeComplete do —
						// selectElement only updates the store, so without this the
						// displayed bbox stays where it was built at edit start (visibly
						// wrong for center/right-aligned text, whose glyphs re-anchor)
						this.refreshSelectionUI(this.currentToolType === "select");
					}
				} catch (err) {
					console.error("Failed to compute text bounds:", err);
				}
			},
			persistTextEdit: (textElement) => {
				const layerId = this.rendererStore.currentLayerId;
				if (!layerId) return undefined;
				this.commands.updateElement(layerId, textElement.id, textElement);
				const stored = this.rendererStore.document.objects[textElement.id];
				return stored ? deepClone(stored as TextElement) : undefined;
			},
			textDelete: (id) => {
				this.clearElementOverride(id);
				this.commands.deleteElements([id]);
			},
			editStart: (text) => {
				const bounds = this.spatialIndex.getBounds(text.id, text);
				this.selection.selectElement(text.id, bounds ?? undefined);

				const { t, origin, isIdentity } = this.resolveTextTransform(
					text.id,
					text,
				);

				let cursorX = text.x;
				let cursorY = text.y;
				let cursorHeight = text.defaultStyle.fontSize;

				if (!isIdentity) {
					const world = applyTransformToPoint(
						text.x,
						text.y,
						t,
						origin.x,
						origin.y,
					);
					cursorX = world.x;
					cursorY = world.y;
					cursorHeight *= Math.abs(t.scaleY);
				}

				this.textToolController?.startTextEdit(
					text.id,
					cursorX,
					cursorY,
					cursorHeight,
					text.layout.writingMode,
					t.rotation,
				);
			},
			editEnd: () => {
				this.clearAllOverrides();
				this.textToolController?.endTextEdit();
			},
			findTextAtPoint: (x, y) => {
				for (const layer of this.rendererStore.document.layers) {
					const el = this.spatialIndex.findElementAtPoint(layer.id, x, y, 5);
					if (el?.type === "text") return el;
					// Grouped texts resolve to their top-level container; drill
					// into it so the text tool still targets them through groups
					if (el && isContainer(el)) {
						const inner = this.findTextInContainerAtPoint(el, x, y, 5);
						if (inner) return inner;
					}
				}
				return null;
			},
			updateTextCursor: (_cursorPos, x, y, fontSize, rotation) => {
				this.textToolController?.updateTextCursor(x, y, fontSize, rotation);
			},
			selectionStyleChange: (style, hasSelection) => {
				this.textToolController?.updateSelectionStyle(style, hasSelection);
			},
			selectionRangeChange: async (textElement, startIndex, endIndex) => {
				const controller = this.textToolController;
				if (!controller) return;

				if (startIndex >= endIndex) {
					controller.updateTextSelectionRects([]);
					return;
				}

				const textRenderer = this.renderer?.getTextRenderer();
				if (!textRenderer) {
					controller.updateTextSelectionRects([]);
					return;
				}

				try {
					// Flow chains: collect rects from every member region
					const memberIds = this.textDepIndex.chainMemberIds(textElement.id);
					const members: TextElement[] =
						memberIds.length > 1
							? memberIds.flatMap((id) => {
									const obj = this.rendererStore.document.objects[id];
									return obj?.type === "text" ? [obj] : [];
								})
							: [textElement];

					const worldRects: Array<{
						x: number;
						y: number;
						width: number;
						height: number;
					}> = [];
					for (const member of members) {
						const localRects = await textRenderer.getSelectionRects(
							member,
							startIndex,
							endIndex,
						);
						const { t, origin, isIdentity } = this.resolveTextTransform(
							member.id,
							member,
						);
						if (isIdentity) {
							for (const r of localRects) {
								worldRects.push({
									x: r.x + member.x,
									y: r.y + member.y,
									width: r.width,
									height: r.height,
								});
							}
						} else {
							for (const r of localRects) {
								const anchor = applyTransformToPoint(
									r.x + member.x,
									r.y + member.y,
									t,
									origin.x,
									origin.y,
								);
								worldRects.push({
									x: anchor.x,
									y: anchor.y,
									width: r.width * Math.abs(t.scaleX),
									height: r.height * Math.abs(t.scaleY),
								});
							}
						}
					}
					controller.updateTextSelectionRects(worldRects);
				} catch {
					controller.updateTextSelectionRects([]);
				}
			},
			getCursorWorldPosition: async (textElement, charIndex) => {
				const textRenderer = this.renderer?.getTextRenderer();
				if (!textRenderer) {
					return {
						x: textElement.x,
						y: textElement.y,
						height: textElement.defaultStyle.fontSize,
					};
				}

				// Flow chains: the caret may live in a downstream region
				let region = textElement;
				const regionId = await textRenderer.findRegionForCharIndex(
					textElement,
					charIndex,
				);
				if (regionId !== textElement.id) {
					const candidate = this.rendererStore.document.objects[regionId];
					if (candidate?.type === "text") region = candidate;
				}

				const localPos = await textRenderer.getCursorPosition(
					region,
					charIndex,
				);
				const { t, origin } = this.resolveTextTransform(region.id, region);
				const world = cursorLocalToWorld(
					localPos,
					region.x,
					region.y,
					t,
					origin,
					region.layout.writingMode,
				);
				// On-path carets tilt with the glyph tangent (plus element rotation)
				return localPos.rotation != null
					? { ...world, rotation: localPos.rotation + t.rotation }
					: world;
			},
			hitTestCharacter: async (textElement, worldX, worldY) => {
				const textRenderer = this.renderer?.getTextRenderer();
				if (!textRenderer) return null;

				// Flow chains: hit the region under the pointer, not the edited one
				const region = this.resolveTextRegionAtPoint(
					textElement,
					worldX,
					worldY,
				);

				const { t, origin, isIdentity } = this.resolveTextTransform(
					region.id,
					region,
				);

				let localX: number;
				let localY: number;

				if (isIdentity) {
					localX = worldX - region.x;
					localY = worldY - region.y;
				} else {
					const local = inverseTransform(worldX, worldY, t, origin.x, origin.y);
					localX = local.x - region.x;
					localY = local.y - region.y;
				}

				return textRenderer.hitTestCharacter(region, localX, localY);
			},
			getLineNavigationTarget: async (textElement, charIndex, direction) => {
				const textRenderer = this.renderer?.getTextRenderer();
				if (!textRenderer) return null;
				return textRenderer.getLineNavigationTarget(
					textElement,
					charIndex,
					direction,
				);
			},
			getLineStartEnd: async (textElement, charIndex, which) => {
				const textRenderer = this.renderer?.getTextRenderer();
				if (!textRenderer) return null;
				return textRenderer.getLineStartEnd(textElement, charIndex, which);
			},

			getSelectedElement: () => {
				if (this.rendererStore.selectedElementIds.length !== 1) return null;
				const id = this.rendererStore.selectedElementIds[0];
				return this.rendererStore.document.objects[id] ?? null;
			},
			getSelectedElementBounds: () => {
				if (this.rendererStore.selectedElementIds.length !== 1) return null;
				const id = this.rendererStore.selectedElementIds[0];
				// World bounds (including ancestor transforms, e.g. a parent blend or
				// group) so the gradient-edit handles align with where the element is
				// drawn. getBounds() omits ancestors and offsets the UI for nested
				// elements such as a blend's source.
				return this.spatialIndex.getWorldBounds(id);
			},
			updateFill: (fill) => {
				this.commands.updateSelectedElementsFill(fill);
			},
			setGradientSelectedStopId: (id) => {
				this.tools.setGradientSelectedStopId(id);
			},
			setGradientSelectedStopIndex: (index) => {
				this.tools.setGradientSelectedStopIndex(index);
			},
			deleteSelectedGradientStop: () => this.gradientDeleteSelectedStop(),
			getActiveStrokeAppearance: () => this.getActiveStrokeAppearance(),
			getActiveFillAppearance: () => this.getActiveFillAppearance(),
			requestRender: (reason) => {
				if (reason === "cursor") this.ui?.refreshToolCursor();
				if (reason === "document" || reason === "selection") {
					this.toolContext.cachedViewportImageData = null;
					this.toolContext.cachedRegionImageData = null;
				}
				this.markDirty(reason);
			},

			uiSetOverlay: (key, overlay) => this.setUIOverlay(key, overlay),
			uiSetToolSession: (session) => {
				this.rendererStore.toolSession = session;
			},
			uiHitTest: (point) => {
				const target = this.activeTarget ?? this.getPrimaryTarget();
				const overlays = this.rendererStore.uiOverlayState.overlays;
				if (!target || !overlays) return null;
				return hitTestOverlays(
					overlays,
					point,
					target.getViewport(),
					target.width,
					target.height,
				);
			},
			previewDeformation: (updates) => {
				for (const { elementId, updates: elUpdates } of updates) {
					const obj = this.rendererStore.document.objects[elementId];
					if (obj) {
						this.setElementOverride(elementId, {
							...obj,
							...elUpdates,
						} as AnyArtObject);
						this.spatialIndex.invalidateBounds(elementId);
					}
				}
			},
			clearDeformationPreview: (elementIds) => {
				for (const elementId of elementIds) {
					this.clearElementOverride(elementId);
				}
			},
			applyDeformation: (updates) => {
				for (const { elementId, layerId, updates: elUpdates } of updates) {
					this.clearElementOverride(elementId);
					this.commands.updateElement(layerId, elementId, elUpdates);
				}
			},
			restoreOriginal: (updates) => {
				for (const { elementId, updates: elUpdates } of updates) {
					const obj = this.rendererStore.document.objects[elementId];
					if (!obj) continue;
					for (const [key, value] of Object.entries(elUpdates)) {
						(obj as unknown as Record<string, unknown>)[key] = value;
					}
					this.spatialIndex.invalidateBounds(elementId);
				}
				this.markDirty("document");
			},
			perspectiveWarpCompute: (ids, corners, sourceCorners) => {
				const layerId = this.rendererStore.currentLayerId;
				if (!layerId) return [];
				return this.commands
					.computePerspectiveWarpUpdates(ids, corners, sourceCorners)
					.map((u) => ({ ...u, layerId }));
			},
			outlineTextElements: (ids) => this.outlineTextElements(ids),
			complete: () => {
				this.tools.setCurrentTool("select");
			},
			getCurrentLayerId: () => this.rendererStore.currentLayerId,

			getViewport: () => {
				const t = this.activeTarget ?? this.getPrimaryTarget();
				if (!t) return null;
				return {
					viewport: t.getViewport(),
					canvasWidth: t.width,
					canvasHeight: t.height,
				};
			},

			renderViewportToImageData: async () => {
				const vpInfo = this.toolContext.getViewport();
				if (!vpInfo) return null;

				const { viewport: vp, canvasWidth, canvasHeight } = vpInfo;
				const cache = this.toolContext.cachedViewportImageData;
				if (
					cache &&
					cache.viewport.x === vp.x &&
					cache.viewport.y === vp.y &&
					cache.viewport.zoom === vp.zoom &&
					cache.viewport.rotation === vp.rotation &&
					cache.imageData.width === canvasWidth &&
					cache.imageData.height === canvasHeight
				) {
					return cache.imageData;
				}

				const imageData = await this.renderer.renderViewportToImageData(
					vp,
					snapshot(this.rendererStore.document) as Document,
					canvasWidth,
					canvasHeight,
				);
				if (imageData) {
					this.toolContext.cachedViewportImageData = {
						imageData,
						viewport: { ...vp },
					};
				}
				return imageData;
			},

			renderWorldRegionToImageData: async (region, scale, opts) => {
				const key = [
					region.centerX,
					region.centerY,
					region.worldWidth,
					region.worldHeight,
					scale,
					opts?.paintArtboardBackgrounds ? 1 : 0,
				].join(",");
				const cache = this.toolContext.cachedRegionImageData;
				if (cache && cache.key === key) return cache.imageData;

				const imageData = await this.renderer.renderWorldRegionToImageData(
					region,
					scale,
					snapshot(this.rendererStore.document) as Document,
					opts,
				);
				if (imageData) {
					this.toolContext.cachedRegionImageData = { key, imageData };
				}
				return imageData;
			},
			getDocumentContentBounds: () =>
				this.renderer.computeDocumentContentBounds(
					snapshot(this.rendererStore.document) as Document,
				),
			getMaxRasterDimension: () => this.renderer.getMaxTextureDimension(),
			setBucketFillLeaks: (state) => {
				this.tools.setBucketFillLeaks(state);
			},
			setBucketFillComputing: (computing) => {
				this.tools.setBucketFillComputing(computing);
			},
			panToWorldPoint: (point, zoom) => {
				const t = this.activeTarget ?? this.getPrimaryTarget();
				if (!t) return;
				const vp = t.getViewport();
				t.setViewport({
					...vp,
					x: point.x,
					y: point.y,
					...(zoom !== undefined ? { zoom } : {}),
				});
				this.markDirty("viewport");
			},
			hintTransformOnlyChange: (fn) => {
				this.renderChangeSubscriber.withTransformOnlyChange(fn);
			},

			pickPixelColor: async (screenX, screenY) => {
				const imageData = await this.toolContext.renderViewportToImageData();
				if (!imageData) return null;

				const px = Math.round(screenX);
				const py = Math.round(screenY);
				if (px < 0 || px >= imageData.width || py < 0 || py >= imageData.height)
					return null;

				const i = (py * imageData.width + px) * 4;
				return {
					type: "rgb" as const,
					r: imageData.data[i] / 255,
					g: imageData.data[i + 1] / 255,
					b: imageData.data[i + 2] / 255,
					a: imageData.data[i + 3] / 255,
				};
			},
			emitColorPick: (data) => {
				this.emit("eyedropperPick", data);
			},
		});
	}

	private updateToolState(update: {
		currentTool?: ToolType;
		color?: StrokeColor | null;
		fillColor?: FillColor | null;
	}): void {
		if (update.currentTool !== undefined)
			this.tools.setCurrentTool(update.currentTool);
		if (update.color !== undefined) this.tools.setStrokeColor(update.color);
		if (update.fillColor !== undefined)
			this.tools.setFillColor(update.fillColor);
	}

	private setupBrushSettingsSubscription(): void {
		let previousState = snapshot(this.toolSettings);

		this.valtioUnsubscribes.push(
			subscribe(this.toolSettings, () => {
				const currentSnapshot = snapshot(this.toolSettings);

				if (currentSnapshot.currentTool !== previousState.currentTool) {
					this.createTool(
						currentSnapshot.currentTool,
						previousState.currentTool,
					);
					previousState = currentSnapshot;
					return;
				}

				if (this.tool) {
					if (this.tool instanceof PenTool) {
						this.tool.setOptions({
							strokeWidth: this.tools.brushSettings.size,
							stabilization: currentSnapshot.stabilization,
							smoothingMethod: currentSnapshot.smoothingMethod,
							perspectiveSnap: currentSnapshot.perspectiveSnap,
							opacity: currentSnapshot.opacity,
						});
					} else if (this.tool instanceof EraserTool) {
						this.tool.setOptions({
							width: currentSnapshot.eraserSize,
							mode: currentSnapshot.eraserMode,
							pierceAllLayers: currentSnapshot.eraserPierceAllLayers,
						});
					} else if (this.tool instanceof ShapeTool) {
						this.tool.setOptions({
							shapeType: currentSnapshot.shapeType,
						});
					} else if (this.tool instanceof TextTool) {
						this.tool.setCharTouchMode(currentSnapshot.textCharTouchMode);
					}
				}

				previousState = currentSnapshot;
			}),
		);
	}

	private createTool(
		toolType: ToolType,
		previousToolType = this.currentToolType,
	): void {
		if (previousToolType !== toolType) {
			if (
				previousToolType === "mesh-deform" &&
				this.tool instanceof MeshDeformTool
			) {
				this.tool.applyDeformation({ complete: false });
			} else if (previousToolType === "skew" && this.tool instanceof SkewTool) {
				this.tool.applyDeformation({ complete: false });
			} else if (
				previousToolType === "free-transform" &&
				this.tool instanceof FreeTransformTool
			) {
				// Mirror skew/mesh: settle without complete(), so switching tools
				// does not bounce the user back to select via onCancel→complete.
				this.tool.applyDeformation({ complete: false });
			} else {
				this.tool?.onCancel?.();
			}
			this.tool?.dispose?.();

			this.rendererStore.toolSession = null;
			const prevOverlays = this.rendererStore.uiOverlayState.overlays;
			this.rendererStore.uiOverlayState.overlays = {};
			// Selection overlays survive tool switches (the historical typed
			// fields were never cleared here); carry them across the wholesale
			// clear. The per-tool branches below still clear them when needed.
			for (const key of [
				OVERLAY_KEYS.sysSelection,
				OVERLAY_KEYS.sysArtboardSelection,
			]) {
				const entry = prevOverlays?.[key];
				if (entry) this.rendererStore.uiOverlayState.overlays[key] = entry;
			}
			// The wholesale overlays clear also removed the pattern-edit tile;
			// rebuild it — pattern-edit sessions survive tool switches.
			this.patternEdit?.refreshSessionVisuals();
		}

		// Disable artboard edit mode when switching away from artboard tool
		if (previousToolType === "artboard" && toolType !== "artboard") {
			this.selection.setArtboardEditMode(false);
		}

		// Touch-type mode is a text-tool session state; leaving the tool ends it
		if (previousToolType === "text" && toolType !== "text") {
			this.toolSettings.textCharTouchMode = false;
			setFontMissingOverlay(this.rendererStore.uiOverlayState, null);
			this.lastFontMissingKey = null;
		}

		if (toolType === "pen") {
			this.tool = new PenTool(this.toolContext, {
				strokeWidth: this.tools.brushSettings.size,
				stabilization: this.toolSettings.stabilization,
				smoothingMethod: this.toolSettings.smoothingMethod,
				perspectiveSnap: this.toolSettings.perspectiveSnap,
				opacity: this.toolSettings.opacity,
			});
		} else if (toolType === "eraser") {
			this.tool = new EraserTool(this.toolContext, {
				width: this.toolSettings.eraserSize,
				mode: this.toolSettings.eraserMode,
				pierceAllLayers: this.toolSettings.eraserPierceAllLayers,
			});
		} else if (toolType === "select") {
			this.tool = new SelectTool(this.toolContext);

			if (this.rendererStore.selectedElementIds.length > 0) {
				this.tool.refreshUI?.();
			}
		} else if (toolType === "path-edit") {
			// Clear selection UI when switching to path-edit tool
			setSelectionOverlay(this.rendererStore.uiOverlayState, null);

			this.tool = new PathEditTool(this.toolContext);

			// Carry over selected paths from SelectTool
			if (this.rendererStore.selectedElementIds.length > 0) {
				const selectedPaths: Path[] = [];
				const selectedMeshes: MeshArtObject[] = [];
				for (const id of this.rendererStore.selectedElementIds) {
					const obj = this.rendererStore.document.objects[id];
					if (obj?.type === "path") {
						selectedPaths.push(obj);
						continue;
					}
					// A selected mesh warp container hands its cage over for editing
					if (obj?.type === "mesh") {
						selectedMeshes.push(obj);
						continue;
					}
					// A selected bound text hands its (invisible) axis path over
					// so the guide geometry stays editable through the text
					if (obj?.type === "text" && obj.axisBinding) {
						const axisPath =
							this.rendererStore.document.objects[obj.axisBinding.pathObjectId];
						if (
							axisPath?.type === "path" &&
							!axisPath.locked &&
							!selectedPaths.some((p) => p.id === axisPath.id)
						) {
							selectedPaths.push(axisPath);
						}
					}
				}

				const primaryTarget = this.getPrimaryTarget();
				if (
					this.tool instanceof PathEditTool &&
					primaryTarget &&
					(selectedPaths.length > 0 || selectedMeshes.length > 0)
				) {
					this.tool.initWithSelectedPaths(
						selectedPaths,
						primaryTarget.getViewport(),
						primaryTarget.width,
						primaryTarget.height,
						selectedMeshes,
					);
				}
			}
		} else if (toolType === "artboard") {
			this.selection.setArtboardEditMode(true);
			this.tool = new ArtboardTool(this.toolContext);
		} else if (toolType === "path") {
			this.tool = new PathTool(this.toolContext);

			// Display the selected path's vertices for in-place node editing.
			if (this.rendererStore.selectedElementIds.length > 0) {
				this.tool.refreshUI?.();
			}
		} else if (toolType === "shape") {
			this.tool = new ShapeTool(this.toolContext, {
				shapeType: this.toolSettings.shapeType,
			});
		} else if (toolType === "text") {
			const textTool = new TextTool(this.toolContext, {
				defaultStyle: { ...this.toolSettings.textDefaultStyle },
			});
			this.tool = textTool;
			this.textToolController?.registerTextTool(textTool);
			this.lastTextOverflowBadgeKey = null;
			void this.refreshTextOverflowBadges();
			this.lastFontMissingKey = null;
			// Actual refresh happens after currentToolType is set below — the
			// refresh guards on currentToolType === "text", which isn't true yet.
		} else if (toolType === "gradient") {
			// selectionUIは選択引き継ぎ時に再構築する
			this.tool = new GradientTool(this.toolContext);

			// グラデーションを持つ選択オブジェクトを引き継ぐ
			// 選択中のオブジェクトにグラデーション塗りがない場合は選択解除
			if (this.rendererStore.selectedElementIds.length > 0) {
				const firstId = this.rendererStore.selectedElementIds[0];
				const element = this.rendererStore.document.objects[firstId];
				const fillApp = element?.filters?.find((f) => f.processor === "fill") as
					| FillAppearance
					| undefined;
				const fill = fillApp?.paramData.params.fill;
				if (!fill || isSolidColor(fill)) {
					this.selection.clear();
				} else {
					const primaryTarget = this.getPrimaryTarget();
					if (primaryTarget) {
						this.tool.refreshUI?.();
					}
				}
			}
		} else if (toolType === "mesh-deform") {
			setSelectionOverlay(this.rendererStore.uiOverlayState, null);

			const currentLayerId = this.rendererStore.currentLayerId;
			if (
				!currentLayerId ||
				this.rendererStore.selectedElementIds.length === 0
			) {
				// No selection, switch back to select
				this.tools.setCurrentTool("select");
				return;
			}

			this.tool = new MeshDeformTool(this.toolContext);
		} else if (toolType === "skew") {
			const currentLayerId = this.rendererStore.currentLayerId;
			if (!currentLayerId) {
				this.tools.setCurrentTool("select");
				return;
			}
			// Skew activates without a selection: the tool itself lets the user
			// click an object (Shift to multi-select) and skew it in one gesture.
			this.tool = new SkewTool(this.toolContext);
		} else if (toolType === "free-transform") {
			const currentLayerId = this.rendererStore.currentLayerId;
			if (!currentLayerId) {
				this.tools.setCurrentTool("select");
				return;
			}
			// Free-transform draws its own 4-corner warp gizmo (freeTransformHandles
			// overlay), so clear the carried-over sysSelection box. It activates
			// without a selection; clicking an object selects it.
			setSelectionOverlay(this.rendererStore.uiOverlayState, null);

			this.tool = new FreeTransformTool(this.toolContext);
		} else if (toolType === "bucket-fill") {
			this.tool = new BucketFillTool(this.toolContext, {
				gapClosing: this.toolSettings.bucketFillGapClosing,
				tolerance: this.toolSettings.bucketFillTolerance,
			});
		} else if (toolType === "stroke-width-edit") {
			setSelectionOverlay(this.rendererStore.uiOverlayState, null);

			this.tool = new StrokeWidthEditTool(this.toolContext);

			// Carry over selected path from SelectTool
			if (this.rendererStore.selectedElementIds.length > 0) {
				const firstId = this.rendererStore.selectedElementIds[0];
				const obj = this.rendererStore.document.objects[firstId];
				if (obj?.type === "path") {
					const primaryTarget = this.getPrimaryTarget();
					if (primaryTarget && this.tool instanceof StrokeWidthEditTool) {
						this.tool.initWithSelectedPath(
							obj,
							primaryTarget.getViewport(),
							primaryTarget.width,
							primaryTarget.height,
						);
					}
				} else {
					this.tools.setCurrentTool("select");
					return;
				}
			} else {
				this.tools.setCurrentTool("select");
				return;
			}
		} else if (toolType === "reference3d") {
			// The tool works without the runtime until it resolves (renderer
			// skips reference3d elements; raycast returns null meanwhile).
			this.requestReference3DService();
			this.tool = new Reference3DTool(this.toolContext);
		} else if (toolType === "eyedropper") {
			this.tool = new EyedropperTool(this.toolContext, {
				onPickForSelection: (target, selectedIds) => {
					this.applyEyedropperToSelection(target, selectedIds);
				},
				onPick: ({ strokeAppearance, fillAppearance, pickedColor }) => {
					if (strokeAppearance) {
						this.tools.setStrokeAppearance(cloneAppearance(strokeAppearance));
					} else if (pickedColor) {
						this.tools.setStrokeColor(pickedColor);
					}

					if (fillAppearance) {
						this.tools.setFillAppearance(cloneAppearance(fillAppearance));
					} else if (pickedColor) {
						this.tools.setFillColor(pickedColor);
					}

					const strokeColor =
						strokeAppearance?.paramData.params.strokeColor ??
						pickedColor ??
						null;
					const fillColor =
						fillAppearance?.paramData.params.fill ?? pickedColor ?? null;
					this.emit("eyedropperPick", { strokeColor, fillColor });
					this.ui?.refreshToolCursor();
				},
			});
		} else {
			// Default to pen
			this.tool = new PenTool(this.toolContext, {
				strokeWidth: this.tools.brushSettings.size,
				stabilization: this.toolSettings.stabilization,
				smoothingMethod: this.toolSettings.smoothingMethod,
				perspectiveSnap: this.toolSettings.perspectiveSnap,
				opacity: this.toolSettings.opacity,
			});
		}

		// Refresh selection UI for the new tool (handles only for select tool).
		// path-edit / mesh-deform / stroke-width-edit suppress the default
		// selection UI. Skew keeps the outline (handles suppressed via
		// includeHandles=false) so the sheared object stays visible and pickable.
		if (
			toolType !== "path-edit" &&
			toolType !== "mesh-deform" &&
			toolType !== "stroke-width-edit"
		) {
			this.refreshSelectionUI(toolType === "select");
		}

		this.currentToolType = toolType;
		// Font-missing outlines are shown for the whole text-tool session; run now
		// that currentToolType === "text" (the refresh guards on it).
		if (toolType === "text") this.refreshFontMissingOutlines();
		console.log(`🔧 Tool created: ${toolType}`);
	}

	// ===== Private Helpers =====

	private applyEyedropperToSelection(
		target: AnyArtObject,
		selectedIds: string[],
	): void {
		const source = extractAppearanceFromArtObject(target);
		const copyTargets = this.toolSettings.eyedropperCopyTargets;

		this.yjsProvider.transact(() => {
			for (const id of selectedIds) {
				const element = this.rendererStore.document.objects[id];
				if (!element) continue;

				const updates: Partial<AnyArtObject> = {};

				// Copy filters (stroke, fill, effects) except "content",
				// preserving existing uids where processor types match
				if (copyTargets.stroke || copyTargets.fill || copyTargets.filters) {
					const existingFilters = element.filters ?? [];
					const contentFilters = existingFilters.filter(
						(f) => f.processor === "content",
					);

					const isEffectFilter = (f: Filter) =>
						f.processor !== "stroke" &&
						f.processor !== "fill" &&
						f.processor !== "content";

					// Build new non-content filters from source, reusing existing uids
					const existingByProcessor = Object.groupBy(
						existingFilters,
						(f) => f.processor,
					);
					const usedIndexByProcessor = new Map<string, number>();
					const copiedFilters = source.allFilters
						.filter((f) => {
							if (f.processor === "stroke" && !copyTargets.stroke) return false;
							if (f.processor === "fill" && !copyTargets.fill) return false;
							if (isEffectFilter(f) && !copyTargets.filters) return false;
							return true;
						})
						.map((f) => {
							const idx = usedIndexByProcessor.get(f.processor) ?? 0;
							usedIndexByProcessor.set(f.processor, idx + 1);
							const existing = existingByProcessor[f.processor]?.at(idx);
							return { ...f, uid: existing?.uid ?? generateUid("app") };
						});

					// Keep non-content filters from element that weren't in copy targets
					const keptFilters = existingFilters.filter((f) => {
						if (f.processor === "content") return false;
						if (f.processor === "stroke" && copyTargets.stroke) return false;
						if (f.processor === "fill" && copyTargets.fill) return false;
						if (isEffectFilter(f) && copyTargets.filters) return false;
						return !copiedFilters.some((c) => c.processor === f.processor);
					});

					updates.filters = [
						...contentFilters,
						...keptFilters,
						...copiedFilters,
					] as Filter[];
				}

				if (copyTargets.appearance) {
					updates.opacity = source.opacity;
					updates.blendMode = source.blendMode;
				}

				if (
					copyTargets.fontStyle &&
					element.type === "text" &&
					source.textStyle
				) {
					const textUpdates = updates as Partial<TextElement>;
					textUpdates.defaultStyle = { ...source.textStyle };

					const textEl = element;
					if (textEl.content?.paragraphs) {
						textUpdates.content = {
							...textEl.content,
							paragraphs: textEl.content.paragraphs.map((p) => ({
								...p,
								runs: p.runs.map((r) => ({
									...r,
									style: { ...source.textStyle! },
								})),
							})),
						};
					}
				}

				this.yjsProvider.updateElement("", id, updates);
			}
		});
	}

	/**
	 * Return the active StrokeAppearance: the first selected element's stroke
	 * when a selection exists (null when it has none, e.g. a BlendObject —
	 * falling back to the tool color here would make the picker show a color the
	 * element does not have), otherwise the ToolSettings stroke for drawing.
	 */
	public getActiveStrokeAppearance(): StrokeAppearance | null {
		if (this.rendererStore.selectedElementIds.length > 0) {
			return this.getSelectedElementAppearance("strokeAppearance");
		}
		return this.toolSettings.strokeAppearance ?? null;
	}

	/**
	 * Return the active FillAppearance: the first selected element's fill when a
	 * selection exists (null when it has none, e.g. a BlendObject), otherwise the
	 * ToolSettings fill for drawing.
	 */
	public getActiveFillAppearance(): FillAppearance | null {
		if (this.rendererStore.selectedElementIds.length > 0) {
			return this.getSelectedElementAppearance("fillAppearance");
		}
		return this.toolSettings.fillAppearance;
	}

	/** Whether the common Appearance.applyToBackdrop toggle is meaningful for
	 *  this filter — derived from the registered filter handler (UI shows the
	 *  toggle only when this returns true). */
	public canApplyFilterToBackdrop(filter: Filter): boolean {
		return this.renderer.canApplyFilterToBackdrop(filter);
	}

	private syncToolAppearanceFromSelection(): void {
		const strokeApp = this.getSelectedElementAppearance("strokeAppearance");
		if (strokeApp) {
			this.tools.setStrokeAppearance(cloneAppearance(strokeApp));
		}
	}

	private getSelectedElementAppearance<K extends keyof ExtractedAppearance>(
		key: K,
	): ExtractedAppearance[K] | null {
		if (this.rendererStore.selectedElementIds.length === 0) return null;
		const firstId = this.rendererStore.selectedElementIds[0];
		const element = this.rendererStore.document.objects[firstId];
		if (!element) return null;
		return extractAppearanceFromArtObject(element)[key] ?? null;
	}

	private getToolColorOrDefault(): Color {
		const sc = this.getActiveStrokeAppearance()?.paramData.params.strokeColor;
		return sc?.type === "solid" ? sc.color : createDefaultColor();
	}

	private syncPathToolFromDocument(): void {
		if (!(this.tool instanceof PathTool)) return;

		const activePathId = this.tool.getActivePathId();
		if (!activePathId) return;

		const element = this.rendererStore.document.objects[activePathId];
		if (element?.type === "path") {
			this.tool.syncFromDocument(element);
		} else {
			this.tool.syncFromDocument(null);
		}
	}

	private getCurrentLayer(): Layer | null {
		const currentLayerId = this.rendererStore.currentLayerId;
		if (!currentLayerId) return null;
		return (
			this.rendererStore.document.layers.find((l) => l.id === currentLayerId) ||
			null
		);
	}

	/**
	 * Align the current multi-selection along `mode`. The reference is the key
	 * object's world bounds when one is set (and still selected), otherwise the
	 * selection's combined AABB. Needs at least 2 selected elements.
	 */
	public alignSelectedElements(mode: AlignMode): void {
		const layerId = this.rendererStore.currentLayerId;
		if (!layerId) return;

		const items = this.collectAlignItems(this.rendererStore.selectedElementIds);
		if (items.length < 2) return;

		const keyObjectId = this.rendererStore.keyObjectId;
		const keyItem =
			keyObjectId != null
				? items.find((it) => it.id === keyObjectId)
				: undefined;
		const reference = keyItem?.bounds ?? unionBounds(items);
		if (!reference) return;

		this.applyAlignDeltas(layerId, computeAlignDeltas(items, mode, reference));
	}

	/**
	 * Distribute the current multi-selection so element centers are evenly
	 * spaced along `axis`. The two extreme elements stay put. Needs at least 3
	 * selected elements.
	 */
	public distributeSelectedElements(axis: DistributeAxis): void {
		const layerId = this.rendererStore.currentLayerId;
		if (!layerId) return;

		const items = this.collectAlignItems(this.rendererStore.selectedElementIds);
		if (items.length < 3) return;

		this.applyAlignDeltas(layerId, computeDistributeDeltas(items, axis));
	}

	private collectAlignItems(elementIds: readonly string[]): AlignItem[] {
		const items: AlignItem[] = [];
		for (const id of elementIds) {
			const bounds = this.spatialIndex.getWorldBounds(id);
			if (bounds) items.push({ id, bounds });
		}
		return items;
	}

	private applyAlignDeltas(
		layerId: string,
		deltas: Map<string, AlignDelta>,
	): void {
		const updates: Array<{
			elementId: string;
			updates: Partial<AnyArtObject>;
		}> = [];
		for (const [elementId, { dx, dy }] of deltas) {
			if (dx === 0 && dy === 0) continue;
			// Reuse the shared move-update builder so blend baking and axis-path
			// following stay correct, applied per element with its own delta.
			updates.push(
				...this.collectElementMoveUpdates([{ layerId, elementId }], dx, dy),
			);
		}
		if (updates.length === 0) return;

		this.commands.batchUpdateElements(updates);

		for (const id of deltas.keys()) {
			this.spatialIndex.invalidateBounds(id);
			this.commands.rebuildBlendSpineIfKey(id);
		}
		this.selection.updateSelectionBounds();
		this.refreshSelectionUI(this.currentToolType === "select");
	}

	/**
	 * Collect element move updates without committing to Yjs.
	 * Used by elementMove, elementsMove, and commitArtboardMove
	 * to batch all moves in a single Yjs transaction.
	 */
	private collectElementMoveUpdates(
		elements: Array<{ layerId: string; elementId: string }>,
		deltaX: number,
		deltaY: number,
	): Array<{ elementId: string; updates: Partial<AnyArtObject> }> {
		const result: Array<{
			elementId: string;
			updates: Partial<AnyArtObject>;
		}> = [];
		const inputIds = new Set(elements.map((e) => e.elementId));
		const movedAxisPathIds = new Set<string>();

		for (const { elementId, layerId } of elements) {
			const element = this.rendererStore.document.objects[elementId];
			if (!element) continue;

			// Path-bound text: dragging the text moves the whole object — the
			// axis path is translated instead and the text follows through
			// re-layout (its glyph geometry derives from the path). Translating
			// both would double-move when path and text are selected together.
			if (element.type === "text" && element.axisBinding) {
				const pathId = element.axisBinding.pathObjectId;
				const path = this.rendererStore.document.objects[pathId];
				if (path?.type === "path") {
					if (!inputIds.has(pathId) && !movedAxisPathIds.has(pathId)) {
						movedAxisPathIds.add(pathId);
						const pt = getTransform(path);
						result.push({
							elementId: pathId,
							updates: {
								transform: { ...pt, x: pt.x + deltaX, y: pt.y + deltaY },
							} as Partial<AnyArtObject>,
						});
					}
					continue;
				}
				// Dangling binding: fall through to a normal text move
			}

			if (isBlend(element)) {
				const bt = getTransform(element);
				const isPureTranslate =
					bt.scaleX === 1 &&
					bt.scaleY === 1 &&
					(bt.rotation ?? 0) === 0 &&
					(bt.skewX ?? 0) === 0 &&
					(bt.skewY ?? 0) === 0;
				if (!isPureTranslate) {
					// Scaled/rotated blend: keep the legacy behavior (move its own
					// transform). Baking a non-translation matrix into the absorbed
					// sources is out of scope here.
					result.push({
						elementId,
						updates: {
							transform: { ...bt, x: bt.x + deltaX, y: bt.y + deltaY },
						} as Partial<AnyArtObject>,
					});
					continue;
				}
				// A blend's sources are absorbed and rendered (world-baked) under the
				// blend's transform index, so they have no transform slot of their
				// own. Keeping the translation on the blend desyncs the stored source
				// positions from what is drawn (breaking gradient-edit UI and release
				// placement). Bake any existing blend translation + this move into the
				// sources (and spine) and reset the blend to identity, so stored ==
				// displayed everywhere.
				const srcIds = element.spineSourceId
					? [...element.objectIds, element.spineSourceId]
					: element.objectIds;
				for (const srcId of srcIds) {
					const src = this.rendererStore.document.objects[srcId];
					if (!src) continue;
					const st = getTransform(src);
					result.push({
						elementId: srcId,
						updates: {
							transform: {
								...st,
								x: st.x + bt.x + deltaX,
								y: st.y + bt.y + deltaY,
							},
						} as Partial<AnyArtObject>,
					});
				}
				if (bt.x !== 0 || bt.y !== 0) {
					// The spine source is baked alongside the other sources above;
					// only the blend's own transform needs resetting to identity.
					result.push({
						elementId,
						updates: {
							transform: createIdentityTransform(),
						} as Partial<AnyArtObject>,
					});
				}
				continue;
			}

			if (isGroup(element)) {
				const t = getTransform(element);
				result.push({
					elementId,
					updates: {
						transform: { ...t, x: t.x + deltaX, y: t.y + deltaY },
					} as Partial<AnyArtObject>,
				});
				continue;
			}

			const t = getTransform(element);
			result.push({
				elementId,
				updates: {
					transform: { ...t, x: t.x + deltaX, y: t.y + deltaY },
				} as Partial<AnyArtObject>,
			});
		}

		return result;
	}

	private handleElementResize(
		elementId: string,
		originalBounds: BoundingBox,
		newBounds: BoundingBox,
	): void {
		this.applyElementResize(elementId, originalBounds, newBounds);
		// updateElement syncs the store and clears stale cache entries
		// synchronously, so recomputing here reads the resized geometry in the
		// element's parent space — pushing the world-space selection frame into
		// the cache instead would corrupt nested (editing-scope) elements.
		this.spatialIndex.invalidateBoundsWithAncestors(elementId);
	}

	private applyElementResize(
		elementId: string,
		originalBounds: BoundingBox,
		newBounds: BoundingBox,
	): void {
		const currentLayerId = this.rendererStore.currentLayerId;
		if (!currentLayerId) return;

		const layer = this.rendererStore.document.layers.find(
			(l) => l.id === currentLayerId,
		);
		if (!layer) return;

		const element = this.rendererStore.document.objects[elementId];
		if (!element) return;

		const transform = createScaleTransform(originalBounds, newBounds);
		const { scaleX, scaleY, mapX, mapY } = transform;
		const uniformScale = Math.sqrt(scaleX * scaleY);

		// Common properties that apply to all element types
		const commonUpdates: Record<string, unknown> = {};
		if (element.filters?.length) {
			commonUpdates.filters = this.renderer.scaleFilters(
				element.filters,
				scaleX,
				scaleY,
			);
		}

		if (element.type === "path") {
			// Bake transform into segments before scaling so that
			// originalBounds (world-space) and segment coordinates are in the same space.
			const worldPath = toWorldPath(element);
			const scaledFilters = scaleStrokeFilters(element.filters, uniformScale);
			this.commands.updateElement(currentLayerId, elementId, {
				segments: scaleSegments(worldPath.segments, transform),
				transform: worldPath.transform,
				...(scaledFilters ? { filters: scaledFilters } : {}),
				...commonUpdates,
			});
		} else if (element.type === "compound-path") {
			// Source paths are recursively resized.
			for (const { id: sourceId } of element.sources) {
				this.applyElementResize(sourceId, originalBounds, newBounds);
			}
			const scaledFilters = scaleStrokeFilters(element.filters, uniformScale);
			this.commands.updateElement(currentLayerId, elementId, {
				...(scaledFilters ? { filters: scaledFilters } : {}),
				...commonUpdates,
			});
		} else if (element.type === "image" || isReference3D(element)) {
			// Moves store their delta on transform.x/y while the placement rect
			// (x/y) stays put, but the bounds mapping is world-space — bake the
			// translation into the rect first (same spirit as the path branch)
			// so resizing a moved element keeps its anchor. Rotation about the
			// rect center commutes with this baking.
			const t = getTransform(element);
			this.commands.updateElement(currentLayerId, elementId, {
				x: mapX(element.x + t.x),
				y: mapY(element.y + t.y),
				width: element.width * scaleX,
				height: element.height * scaleY,
				transform: { ...t, x: 0, y: 0 },
				...commonUpdates,
			});
		} else if (element.type === "text") {
			// Same translation baking as the image/reference3d branch above.
			const t = getTransform(element);
			this.commands.updateElement(currentLayerId, elementId, {
				x: mapX(element.x + t.x),
				y: mapY(element.y + t.y),
				layout: scaleTextLayout(element.layout, transform, newBounds),
				defaultStyle: scaleTextStyle(element.defaultStyle, uniformScale),
				content: scaleTextContent(element.content, uniformScale),
				transform: { ...t, x: 0, y: 0 },
				...commonUpdates,
			});

			this.renderer.invalidateTextCache(elementId);
		} else if (element.type === "group") {
			for (const childId of element.childIds) {
				this.applyElementResize(childId, originalBounds, newBounds);
			}
		} else if (isBlend(element)) {
			// Keys and the absorbed spine live in objects (not in any layer); resize
			// them recursively so the whole blend scales. Intermediates recompute
			// from the scaled keys/spine.
			for (const keyId of element.objectIds) {
				this.applyElementResize(keyId, originalBounds, newBounds);
			}
			if (element.spineSourceId) {
				this.applyElementResize(
					element.spineSourceId,
					originalBounds,
					newBounds,
				);
			}
			const scaledFilters = scaleStrokeFilters(element.filters, uniformScale);
			this.commands.updateElement(currentLayerId, elementId, {
				...(scaledFilters ? { filters: scaledFilters } : {}),
				...commonUpdates,
			});
		} else if (isMesh(element)) {
			// Fold the resize's world affine into the container's own transform,
			// pivoted at the cage's local-bounds center (the renderer's transform
			// origin). The warped children ride the container's transform entry,
			// so the cage and everything it bends scale together — same approach
			// as repeat below.
			const localBounds = calculateLocalElementBounds(element);
			const center = {
				x: (localBounds.minX + localBounds.maxX) / 2,
				y: (localBounds.minY + localBounds.maxY) / 2,
			};
			const newTransform = applyWorldAffineToTransform(
				getTransform(element),
				center,
				null,
				{ m00: scaleX, m01: 0, m10: 0, m11: scaleY },
				mapX(0),
				mapY(0),
			);
			this.commands.updateElement(currentLayerId, elementId, {
				transform: newTransform,
				...commonUpdates,
			} as Partial<AnyArtObject>);
		} else if (isRepeat(element)) {
			// Scale the whole repeat uniformly by folding the resize's world affine
			// into the repeat's own transform, pivoted at the source union center
			// (the same pivot the renderer/bounds use). This scales both the tiles
			// and their spacing, unlike recursing into the absorbed sources.
			const union = calculateRepeatSourceUnion(
				element,
				new Map(Object.entries(this.rendererStore.document.objects)),
			);
			if (union) {
				const center = {
					x: (union.minX + union.maxX) / 2,
					y: (union.minY + union.maxY) / 2,
				};
				// mapX/mapY are affine maps (scale + translate); the world affine's
				// translation is their value at the origin.
				const newTransform = applyWorldAffineToTransform(
					getTransform(element),
					center,
					null,
					{ m00: scaleX, m01: 0, m10: 0, m11: scaleY },
					mapX(0),
					mapY(0),
				);
				this.commands.updateElement(currentLayerId, elementId, {
					transform: newTransform,
					...commonUpdates,
				} as Partial<AnyArtObject>);
			}
		}
	}

	/**
	 * Style source of a text element: the flow-chain head that owns content
	 * and styles, or the element itself outside a chain. UI style panels must
	 * read and write through this so flow targets never expose or receive
	 * dead member-local styles.
	 */
	public getTextStyleSource(element: TextElement): TextElement {
		return this.renderer?.getTextRenderer()?.getFlowHead(element) ?? element;
	}

	/**
	 * Convert text elements to outlined path groups.
	 * Each text element becomes an independent group containing its glyph paths
	 * plus the original (hidden) text element.
	 */
	public async outlineTextElements(elementIds: string[]): Promise<string[]> {
		const textRenderer = this.renderer?.getTextRenderer();
		if (!textRenderer) return [];

		const layerId = this.rendererStore.currentLayerId;
		if (!layerId) return [];

		const newGroupIds: string[] = [];

		for (const elementId of elementIds) {
			const element = this.rendererStore.document.objects[elementId];
			if (!element || element.type !== "text") continue;

			const textElement = element;
			const result = await textRenderer.textElementToOutlinedPaths(textElement);

			if (result.outlinedPaths.length === 0) continue;

			// Apply per-character paint from source Run styles. Runs and styles
			// live on the flow-chain head; flow targets have empty content.
			const paintSource = textRenderer.getFlowHead(textElement);
			const paths: Path[] = result.outlinedPaths.map(
				({ path, runIndex, paragraphIndex }) => {
					const run =
						paintSource.content.paragraphs[paragraphIndex]?.runs[runIndex];
					const style = run?.style ?? paintSource.defaultStyle;

					const fill = style.fill ?? paintSource.defaultStyle.fill ?? null;
					const stroke =
						style.stroke ?? paintSource.defaultStyle.stroke ?? null;

					const filters: Filter[] = [];
					if (fill) {
						filters.push({
							uid: generateUid("app"),
							processor: "fill",
							paramData: { version: "1", params: { fill } },
						} as FillAppearance);
					}
					if (stroke) {
						filters.push({
							uid: generateUid("app"),
							processor: "stroke",
							paramData: {
								version: "1",
								params: {
									strokeColor: stroke,
								},
							},
						} as StrokeAppearance);
					}

					return { ...path, filters };
				},
			);

			const group: Group = {
				type: "group",
				id: generateUid("group"),
				childIds: [...paths.map((p) => p.id), textElement.id],
				opacity: textElement.opacity,
				blendMode: textElement.blendMode,
				transform: textElement.transform,
				name: "Outlined Text",
				filters: [createDefaultContentAppearance()],
			};

			this.commands.outlineTextElement(layerId, textElement.id, paths, group);
			newGroupIds.push(group.id);
		}

		if (newGroupIds.length > 0) {
			this.rendererStore.selectedElementIds = newGroupIds;
		}
		return newGroupIds;
	}

	/**
	 * Handle file drop
	 */
	private async handleFileDrop(
		files: Array<{ file: File; worldX: number; worldY: number }>,
	): Promise<void> {
		for (const { file, worldX, worldY } of files) {
			try {
				// SVG files import as vector (paths, text, gradients, patterns);
				// fall back to rasterizing the file if nothing could be parsed.
				if (
					file.type === "image/svg+xml" ||
					file.name.toLowerCase().endsWith(".svg")
				) {
					const svgString = await file.text();
					if (svgString) {
						await this.commands.pasteSvgString(
							svgString,
							{ x: worldX, y: worldY },
							file,
						);
					}
					continue;
				}

				const arrayBuffer = await file.arrayBuffer();
				const bin = new Uint8Array(arrayBuffer);

				const hashBuffer = await crypto.subtle.digest("SHA-256", bin);
				const hashArray = Array.from(new Uint8Array(hashBuffer));
				const hash = hashArray
					.map((b) => b.toString(16).padStart(2, "0"))
					.join("");

				const embeddedFile: EmbeddedFile = {
					uid: `file-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
					name: file.name,
					type: file.type,
					hash,
					bin,
				};

				const fileUid = this.commands.addEmbeddedFile(embeddedFile);

				const imageBitmap = await createImageBitmap(file);
				const imageWidth = imageBitmap.width;
				const imageHeight = imageBitmap.height;
				imageBitmap.close();

				const _halfWidth = imageWidth / 2;
				const _halfHeight = imageHeight / 2;
				const imageObject: ImageObject = {
					type: "image",
					id: `image-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
					fileUid,
					x: worldX,
					y: worldY,
					width: imageWidth,
					height: imageHeight,
					transform: createIdentityTransform(),
					opacity: 1,
					blendMode: "normal",
				};

				this.commands.addImage(imageObject);

				console.log(
					`🖼️ Dropped image: ${file.name} at (${worldX.toFixed(0)}, ${worldY.toFixed(0)})`,
				);
			} catch (error) {
				console.error(`Failed to process image: ${file.name}`, error);
			}
		}
	}

	// --- Timelapse ---

	public createTimelapsePlayer(
		callbacks: {
			onFrame: (document: Document) => void;
			onStateChange: (state: PlaybackState) => void;
		},
		filterArtboard: Artboard | null,
	): TimelapsePlayer | null {
		const data = this.timelapseRecorder.getTimelapseData();
		if (!data) return null;
		return new TimelapsePlayer(data, callbacks, filterArtboard ?? undefined);
	}

	/** Render an artboard to ImageData for export or thumbnail. */
	public async renderArtboardToImageData(
		artboard: Artboard,
		document: Document,
	): Promise<ImageData | null> {
		return this.renderer.renderArtboardToImageData(artboard, document);
	}

	public async renderBrushStrokePreviewToImageData(
		options: BrushStrokePreviewOptions,
	): Promise<ImageData | null> {
		const scene = createBrushStrokePreviewScene(options);
		try {
			return await this.renderer.renderElementsToImageData(
				[scene.pathId],
				scene.document,
				scene.bounds,
				scene.scale,
				scene.backgroundColor,
			);
		} finally {
			// The preview document's constant element id stays "live" for its own
			// scope's liveness pruning, so per-brush-settings composite keys
			// (stroke/stamp) would accumulate forever without an explicit drop.
			// The readback has completed, so the GPU no longer needs the scope.
			this.renderer.dropDocumentCaches(scene.document.id);
		}
	}

	/** Create a TimelapseExporter for encoding timelapse MP4. */
	public createTimelapseExporter(player: TimelapsePlayer): TimelapseExporter {
		return new TimelapseExporter(this.renderer, player);
	}

	// ===== Document Persistence =====

	public getYjsDoc(): Y.Doc {
		return this.yjsProvider.ydoc;
	}

	public getYjsState(): Uint8Array {
		return Y.encodeStateAsUpdate(this.yjsProvider.ydoc);
	}

	public loadYjsState(
		yjsState: Uint8Array,
		viewport?: { x: number; y: number; zoom: number; rotation: number },
	): void {
		this.stopRendering();

		// Clear all UI state
		this.selection.clear();
		this.clearAllOverrides();
		this.rendererStore.editingScopeStack = [];
		this.rendererStore.selectedArtboardId = null;
		this.rendererStore.uiOverlayState.isArtboardEditMode = false;
		this.rendererStore.uiOverlayState.overlays = {};
		this.rendererStore.toolSession = null;

		// The outgoing document's cache scope (GPU buffers included) would
		// otherwise linger until scope-LRU eviction.
		const outgoingDocumentId = this.rendererStore.document.id;

		// Replace Yjs state
		this.yjsProvider.clearDocument();
		Y.applyUpdate(this.yjsProvider.ydoc, yjsState);

		if (outgoingDocumentId !== this.rendererStore.document.id) {
			this.renderer.dropDocumentCaches(outgoingDocumentId);
		}

		// Restore viewport (not stored in Yjs)
		if (viewport) {
			const primaryTarget = this.getPrimaryTarget();
			if (primaryTarget) {
				primaryTarget.setViewport({ ...viewport });
			}
		}

		// Clear undo history (previous document's history is irrelevant)
		this.yjsProvider.clearUndoHistory();

		// Set current layer to first layer
		if (this.rendererStore.document.layers.length > 0) {
			this.rendererStore.currentLayerId =
				this.rendererStore.document.layers[0].id;
		}

		// Recreate current tool (reset internal state)
		this.createTool(this.toolSettings.currentTool);

		this.startRendering();
		this.setupBrushSettingsSubscription();
	}

	public destroy(): void {
		console.log("🧹 Cleaning up Paplico...");

		this.stopRendering();
		this.spatialIndex.stop();

		for (const [id] of this.canvasTargets) {
			this.removeCanvasTarget(id);
		}

		this.renderer.destroy();
		this.collaboration?.destroy();
		this.collaboration = null;
		this.yjsProvider.destroy();
		this.tool = null;

		console.log("✅ Paplico cleaned up");
	}
}

function scaleStrokeFilters(
	filters: Filter[] | undefined,
	scale: number,
): Filter[] | undefined {
	return filters?.map((f) => {
		if (f.processor !== "stroke") return f;
		const params = (f as StrokeAppearance).paramData.params;
		if (!params.brushSettings) return f;
		return {
			...f,
			paramData: {
				...f.paramData,
				params: {
					...params,
					brushSettings: {
						...params.brushSettings,
						size: params.brushSettings.size * scale,
					},
				},
			},
		};
	});
}

/**
 * Resolve the ICC profile bytes for a proof profile reference (builtin or
 * embedded). Returns null when the ref is absent or the referenced embedded
 * file cannot be found. The color space is not constrained here: any
 * jscolorengine-loadable profile (CMYK / RGB / gray) is a valid proof target,
 * and the profile picker already excludes unsupported color spaces.
 */
export async function resolveProofProfileBytes(
	proofProfile: ProofProfileRef | undefined,
	files: readonly EmbeddedFile[],
	loadBuiltinProfile: (id: BuiltinIccProfileId) => Promise<Uint8Array>,
): Promise<Uint8Array | null> {
	if (proofProfile?.kind === "builtin") {
		return loadBuiltinProfile(proofProfile.id);
	}
	if (proofProfile?.kind === "embedded") {
		return files.find((f) => f.uid === proofProfile.fileUid)?.bin ?? null;
	}
	return null;
}

class CanvasTargetEntry {
	public constructor(
		public target: CanvasTarget,
		public ui: PaplicoUI,
		public scheduler: RenderScheduler,
		private valtioUnsubscribes: Array<() => void>,
		private resizeObserver: ResizeObserver,
	) {}

	public destroy() {
		this.scheduler.destroy();
		this.resizeObserver.disconnect();
		for (const unsub of this.valtioUnsubscribes) unsub();
		this.ui.destroy();
	}
}
