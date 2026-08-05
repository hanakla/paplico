import type { PaplicoCommands } from "../PaplicoCommands";
import type { Reference3DRaycastRequest } from "../reference3d";
import type { PerspectiveGuideData } from "../reference3d/perspective/vanishingPoints";
import type { IKRigData } from "../reference3d/vrm/ikSolver";
import type { DirtyReason } from "../renderer/RenderScheduler";
import type { ToolSession } from "../renderer/types";
import type { OverlayHit } from "../renderer/ui/hitTest";
import type { OverlayKey } from "../renderer/ui/overlayKeys";
import type { UIOverlay } from "../renderer/ui/primitives";
import type {
	ArtboardSelectionUIData,
	SelectionUIData,
	SnapResult,
} from "../renderer/ui/types";
import type {
	AnyArtObject,
	Artboard,
	BoundingBox,
	Color,
	CubicBezierSegment,
	ElementTransform,
	EraseMask,
	FillAppearance,
	FillColor,
	Layer,
	Path,
	Reference3DCamera,
	Reference3DDef,
	Reference3DNode,
	StrokeAppearance,
	StrokeColor,
	TextElement,
	TextStyle,
	Vec2,
	Viewport,
} from "../schema";
import type { TextGlyphQuad } from "../typography/glyphQuad";
import type { WorldBBox } from "../utils/geometry/bounds";
import type { WorldBezierSegment } from "../utils/geometry/geometry";
import type { Reference3DController } from "./Reference3DController";
import type { TextToolController } from "./TextToolController";
import type { BucketFillLeakState } from "./toolSettings";

type DeformationUpdate = Array<{
	elementId: string;
	layerId: string;
	updates: Partial<AnyArtObject>;
}>;
type ToolRenderRequestReason = Extract<
	DirtyReason,
	"document" | "selection" | "preview" | "cursor"
>;

export type ToolContextOptions = {
	textToolController: TextToolController | null;
	reference3dController: Reference3DController | null;

	strokeComplete: (path: Path) => void;
	previewUpdate: (preview: Path | null) => void;
	textPreviewUpdate: (preview: TextElement | null) => void;

	eraseElement: (elementId: string) => void;
	addPaths: (paths: Path[]) => void;
	addEraseMask: (elementId: string, mask: EraseMask) => void;
	updateElement: (elementId: string, updates: Partial<AnyArtObject>) => void;
	transact: (fn: (commands: PaplicoCommands) => void) => void;
	getCurrentLayer: () => Layer | null;
	/** All document layers in stacking order (used for cross-layer erase) */
	getLayers: () => Layer[];
	getObjects: () => Record<string, AnyArtObject>;

	elementSelect: (elementId: string, bounds: BoundingBox) => void;
	elementToggleSelect: (elementId: string, bounds: BoundingBox) => void;
	elementsMove: (elementIds: string[], deltaX: number, deltaY: number) => void;
	elementsResize: (
		elementIds: string[],
		originalBounds: WorldBBox,
		newBounds: WorldBBox,
	) => void;
	elementsRotate: (
		elementIds: string[],
		angleDeg: number,
		centerX: number,
		centerY: number,
	) => void;

	uiUpdateSelectionUI: (
		ui: SelectionUIData | ArtboardSelectionUIData | null,
	) => void;
	uiRefreshSelectionUI: (includeHandles: boolean) => void;
	/** Set or remove (null) a generic overlay channel entry. Keys come from
	 * the central `OVERLAY_KEYS` registry. The overlay is stored as an
	 * immutable snapshot — pass a fresh object on every update. */
	uiSetOverlay: (key: OverlayKey, overlay: UIOverlay | null) => void;
	/** Publish tool-session info for React overlays (single slot; null clears). */
	uiSetToolSession: (session: ToolSession | null) => void;
	/** Hit-test a screen-space point against all `hitId`-carrying overlay
	 * primitives. Returns the front-most hit or null. */
	uiHitTest: (point: { x: number; y: number }) => OverlayHit | null;

	selectionSelectMultiple: (elementIds: string[]) => void;
	selectionClear: () => void;
	getSelectedElementIds: () => string[];
	/** Mark a member of the multi-selection as the alignment key object (null clears). */
	setKeyObject: (elementId: string | null) => void;
	/** The current alignment key object id, or null. */
	getKeyObjectId: () => string | null;

	findElementAtPoint: (
		x: number,
		y: number,
		tolerance?: number,
	) => AnyArtObject | null;
	findElementsInRect: (
		minX: number,
		minY: number,
		maxX: number,
		maxY: number,
	) => AnyArtObject[];
	enterEditingScope: (elementId: string) => void;
	exitEditingScopeOneLevel: () => void;
	getEditingScopeId: () => string | null;
	isElementEditable: (elementId: string) => boolean;
	isElementLocked: (elementId: string) => boolean;
	isCurrentLayerLocked: () => boolean;
	isReadonly: () => boolean;
	getElement: (elementId: string) => AnyArtObject | null;
	getBounds: (elementId: string) => WorldBBox | null;
	/** World-space outline segments as drawn (blend-aware); null for non-paths. */
	getElementWorldSegments: (elementId: string) => WorldBezierSegment[] | null;
	getAncestorTransform: (elementId: string) => ElementTransform | null;
	/** Patch the selected element's filter at `index` (filter-panel-slider
	 *  path: writes per change, undo grouped by the Yjs capture window). */
	updateSelectedElementFilter: (
		index: number,
		params: Record<string, unknown>,
	) => void;
	addElementToLayer: (layerId: string, element: AnyArtObject) => void;
	addObjectToDocument: (element: AnyArtObject) => void;
	duplicateElementsByIds: (
		elementIds: string[],
		offset: { x: number; y: number },
	) => string[];
	textEdit: (element: AnyArtObject) => void;

	// reference3d tool
	/** Switch to the reference3d tool and enter edit mode for the element. */
	reference3dEdit: (element: AnyArtObject) => void;
	/** Leave reference3d editing (switches back to the select tool). */
	reference3dExitEdit: () => void;
	/** Create a shared scene (floor + box) + a viewing element centered at
	 *  world (x, y), optionally with an explicit element size. */
	reference3dCreate: (
		x: number,
		y: number,
		width?: number,
		height?: number,
	) => AnyArtObject | null;
	/** Scene definition lookup — returns the drag-preview state when active. */
	reference3dGetDef: (sceneId: string) => Reference3DDef | null;
	reference3dAddNode: (sceneId: string, node: Reference3DNode) => void;
	reference3dCommitNode: (
		sceneId: string,
		nodeId: string,
		patch: Partial<Reference3DNode>,
	) => void;
	/** Yjs-bypassing camera preview for drags (null = clear). */
	reference3dPreviewCamera: (
		elementId: string,
		camera: Reference3DCamera | null,
	) => void;
	/** Yjs-bypassing scene-node preview for gizmo drags (null = clear). */
	reference3dPreviewNodes: (
		sceneId: string,
		nodes: readonly Reference3DNode[] | null,
	) => void;
	/** Pick a scene node through the camera; null until the 3D runtime loads. */
	reference3dRaycastNode: (request: Reference3DRaycastRequest) => string | null;
	/** Set (or clear) the perspective-ruler guide source element. */
	reference3dSetGuideSource: (elementId: string | null) => void;
	/** Perspective ruler guides derived from the active guide source, if any. */
	getPerspectiveGuides: () => PerspectiveGuideData | null;
	/** Normalized rest rig of a loaded VRM figure; null until it has loaded. */
	reference3dGetFigureRig: (fileUid: string) => IKRigData | null;

	snapElements: (
		movingElementIds: string[],
		originalBounds: WorldBBox,
		proposedDeltaX: number,
		proposedDeltaY: number,
		zoom: number,
	) => SnapResult;

	pathSelect: (pathId: string) => void;
	pathUpdate: (pathId: string, segments: CubicBezierSegment[]) => void;
	batchPathUpdate: (
		paths: Array<[pathId: string, segments: CubicBezierSegment[]]>,
	) => void;
	previewSegments: (pathId: string, segments: CubicBezierSegment[]) => void;
	findPathAtPoint: (
		x: number,
		y: number,
		tolerance?: number,
		deepSearch?: boolean,
	) => Path | null;
	replacePathWithPaths: (
		pathId: string,
		segmentLists: CubicBezierSegment[][],
	) => void;

	// select tool
	selectGetSelectionMode: () => "lasso" | "rectangle";

	// path edit tool
	pathEditGetSelectionMode: () => "lasso" | "rectangle";
	pathEditGetCutMode: () => boolean;
	pathEditSetCutMode: (enabled: boolean) => void;
	/** Stash the anchor selection an upcoming deletion destroys (undo restore). */
	stashPathEditUndoSelection: (handleKeys: string[]) => void;
	pathEditUpdateSelectedAnchors: (
		anchors: Array<{
			pathId: string;
			segmentIndex: number;
			pointType: "start" | "end";
			isEndpoint: boolean;
		}>,
	) => void;
	getPathById: (pathId: string) => Path | null;
	/**
	 * All paths editable in the current context. In group edit mode this is
	 * scoped to the editing group's subtree; otherwise all visible/unlocked
	 * layers are walked.
	 */
	getAllEditablePaths: () => Array<{
		path: Path;
		ancestorTransform: ElementTransform | null;
	}>;
	// artboard tool
	artboardCreate: (artboard: Artboard) => void;
	artboardSelect: (id: string | null) => void;
	artboardUpdate: (id: string, updates: Partial<Artboard>) => void;
	snapArtboardToElements: (bounds: BoundingBox, zoom: number) => SnapResult;
	getArtboards: () => Artboard[];
	getSelectedArtboardId: () => string | null;
	findArtboardAtPoint: (x: number, y: number) => Artboard | null;
	snapArtboard: (
		id: string,
		bounds: BoundingBox,
		dx: number,
		dy: number,
		zoom: number,
	) => SnapResult;
	findElementsOnArtboard: (
		artboardBounds: BoundingBox,
	) => Array<{ layerId: string; elementId: string }>;
	artboardMoveCommit: (
		id: string,
		updates: Partial<Artboard>,
		elements: Array<{ layerId: string; elementId: string }>,
		deltaX: number,
		deltaY: number,
	) => void;

	pathDraftCreate: (path: Path) => void;
	pathDraftUpdate: (
		layerId: string,
		pathId: string,
		segments: CubicBezierSegment[],
	) => void;
	pathDraftDelete: (layerId: string | null, pathId: string) => void;
	pathComplete: (pathId: string) => void;

	shapeComplete: (path: Path) => void;

	textCreate: (text: TextElement) => void;
	textComplete: (text: TextElement) => void;
	textDelete: (id: string) => void;
	editStart: (text: TextElement) => void;
	editEnd: () => void;
	findTextAtPoint: (x: number, y: number) => TextElement | null;
	updateTextCursor: (
		cursorPos: number,
		x: number,
		y: number,
		fontSize?: number,
		rotation?: number,
	) => void;
	selectionStyleChange: (
		style: Partial<TextStyle> | null,
		hasSelection: boolean,
	) => void;
	selectionRangeChange: (
		textElement: TextElement,
		startIndex: number,
		endIndex: number,
	) => void | Promise<void>;
	getCursorWorldPosition: (
		textElement: TextElement,
		charIndex: number,
	) => Promise<{ x: number; y: number; height: number; rotation?: number }>;
	hitTestCharacter: (
		textElement: TextElement,
		worldX: number,
		worldY: number,
	) => Promise<number | null>;
	getLineNavigationTarget: (
		textElement: TextElement,
		charIndex: number,
		direction: "up" | "down",
	) => Promise<number | null>;
	getLineStartEnd: (
		textElement: TextElement,
		charIndex: number,
		which: "start" | "end",
	) => Promise<number | null>;

	/** Persist text content to Yjs for undo/redo tracking during editing.
	 * Returns the latest TextElement from the store after the update. */
	persistTextEdit: (textElement: TextElement) => TextElement | undefined;

	/** Create a path-bound text (guide-ifies the axis path in the same undo).
	 * clickWorld resolves startOffset for onPath bindings. */
	textCreateOnPath: (
		text: TextElement,
		pathObjectId: string,
		mode: "onPath" | "inShape",
		clickWorld: { x: number; y: number },
	) => void;
	/** Link sourceText's overflow into targetText (flow.nextTextElementId). */
	textFlowLink: (sourceTextId: string, targetTextId: string) => void;
	/** Remove sourceText's outgoing flow link. */
	textFlowUnlink: (sourceTextId: string) => void;
	/** The text element flowing into textId (deterministic on duplicates). */
	textFindFlowSource: (textId: string) => TextElement | null;
	/** Every text element in the document (link-candidate display) */
	listTextElements: () => TextElement[];
	/** Flow chain members containing textId, head first ([self] when unchained) */
	textChainMembers: (textId: string) => TextElement[];
	/** Touch-type: content index of the glyph under the world point, or null */
	hitTestTextGlyph: (
		textElement: TextElement,
		worldX: number,
		worldY: number,
	) => Promise<number | null>;
	/** Touch-type: world-space glyph quads plus the element transform needed
	 * to convert world drag deltas into element-local override values. */
	getTextGlyphQuads: (
		textElement: TextElement,
		charIndices: number[],
	) => Promise<{
		quads: TextGlyphQuad[];
		elementTransform: { rotation: number; scaleX: number; scaleY: number };
	}>;
	/** Touch-type: persist charOverride edits as one undo step; returns the
	 * stored clone (like persistTextEdit) and refreshes bounds/selection. */
	textCharTouchCommit: (text: TextElement) => TextElement | undefined;
	/** Touch-type: reflect tool-side mode exits back into toolSettings */
	textCharTouchModeChange: (enabled: boolean) => void;

	getSelectedElement: () => AnyArtObject | null;
	getSelectedElementBounds: () => BoundingBox | null;
	updateFill: (fill: FillColor) => void;
	setGradientSelectedStopId: (id: string | null) => void;
	setGradientSelectedStopIndex: (index: number | null) => void;
	/** Delete the currently selected gradient stop / mesh vertex; true when removed. */
	deleteSelectedGradientStop: () => boolean;
	getActiveStrokeAppearance: () => StrokeAppearance | null;
	getActiveFillAppearance: () => FillAppearance | null;
	requestRender: (reason: ToolRenderRequestReason) => void;

	previewDeformation: (updates: DeformationUpdate) => void;
	clearDeformationPreview: (elementIds: string[]) => void;
	applyDeformation: (updates: DeformationUpdate) => void;
	restoreOriginal: (updates: DeformationUpdate) => void;
	/** Build (but do not commit) vertex-bake updates that map the world-space
	 * `sourceCorners` quad onto `corners` (both TL, TR, BR, BL) via a
	 * homography. Feeds previewDeformation live and applyDeformation on
	 * release. */
	perspectiveWarpCompute: (
		elementIds: string[],
		corners: [Vec2, Vec2, Vec2, Vec2],
		sourceCorners: [Vec2, Vec2, Vec2, Vec2],
	) => DeformationUpdate;
	/** Outline text elements into path groups (the original text is kept hidden
	 * inside each group); resolves with the new group ids. */
	outlineTextElements: (elementIds: string[]) => Promise<string[]>;
	complete: () => void;
	getCurrentLayerId: () => string | null;

	getViewport: () => {
		viewport: Viewport;
		canvasWidth: number;
		canvasHeight: number;
	} | null;

	renderViewportToImageData: () => Promise<ImageData | null>;

	/** Render an axis-aligned world region to ImageData for raster analysis
	 *  (rotation-free, transparent background). Cached per region+scale until
	 *  the next document/selection render request. */
	renderWorldRegionToImageData: (
		region: {
			centerX: number;
			centerY: number;
			worldWidth: number;
			worldHeight: number;
		},
		scale: number,
		opts?: { paintArtboardBackgrounds?: boolean },
	) => Promise<ImageData | null>;
	/** Union bounds of all renderable document content incl. artboards. */
	getDocumentContentBounds: () => {
		centerX: number;
		centerY: number;
		width: number;
		height: number;
	} | null;
	/** Device texture-size limit for sizing analysis rasters. */
	getMaxRasterDimension: () => number;
	/** User-configured zoom ceiling for auto-zoom (e.g. bucket-fill leak jump). */
	getMaxZoomScale: () => number;
	/** Publish bucket-fill leak state to toolSettings for the toolbar panel. */
	setBucketFillLeaks: (state: BucketFillLeakState | null) => void;
	/** Publish whether a bucket-fill area compute is in flight (toolbar spinner). */
	setBucketFillComputing: (computing: boolean) => void;
	/** Center the viewport on a world point, optionally changing the zoom. */
	panToWorldPoint: (point: { x: number; y: number }, zoom?: number) => void;

	/** Run `fn` with transform-only hint so document invalidations skip boundsCache clearing. */
	hintTransformOnlyChange: (fn: () => void) => void;

	pickPixelColor: (screenX: number, screenY: number) => Promise<Color | null>;
	emitColorPick: (data: {
		strokeColor: StrokeColor | null;
		fillColor: FillColor | null;
		pixelPick?: boolean;
	}) => void;
};

export interface ToolContext extends ToolContextOptions {}

/**
 * Shared dependency container for tools.
 */
// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: intentional declaration merging for mixin pattern
export class ToolContext {
	public cachedViewportImageData: {
		imageData: ImageData;
		viewport: { x: number; y: number; zoom: number; rotation: number };
	} | null = null;

	/** Single-slot cache for renderWorldRegionToImageData, keyed by
	 *  region + scale + flags. Invalidated with cachedViewportImageData. */
	public cachedRegionImageData: {
		key: string;
		imageData: ImageData;
	} | null = null;

	public constructor(options: ToolContextOptions) {
		Object.assign(this, options);
	}

	public duplicateElements(elementIds: string[], offset = 10): string[] {
		// Clone / id-numbering / container handling (group children, blend
		// sources) is shared with copy-paste via duplicateElementsByIds. Kept
		// inside the transform-only hint to preserve the alt-drag gesture's
		// render batching.
		let newIds: string[] = [];
		this.hintTransformOnlyChange(() => {
			newIds = this.duplicateElementsByIds(elementIds, {
				x: offset,
				y: offset,
			});
		});
		return newIds;
	}
}
