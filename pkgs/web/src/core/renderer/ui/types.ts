import type { BoundingBox, TextLayout } from "../../schema";
import type { WorldBezierSegment } from "../../utils/geometry/geometry";

export interface SelectionUIData {
	/** Local-space bounds (pre-rotation) for single element, AABB for multi-select */
	bounds: BoundingBox;
	/** Rotation angle in radians (0 for multi-select) */
	rotation: number;
	/** World-space center of rotation */
	rotationCenter: { x: number; y: number };
	handles: Array<{
		x: number;
		y: number;
		position: "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
	}>;
	/** Position of the rotation handle (above "n" handle) */
	rotationHandle?: { x: number; y: number };
	/** Bezier segments of all selected paths (for outline display), grouped by path */
	pathSegments?: WorldBezierSegment[][];
	/** Outline segments of the key object (alignment reference), drawn in a
	 *  distinct color to mark it apart from the rest of the selection. */
	keyObjectSegments?: WorldBezierSegment[][];
	/** Draw the bounding box dashed (mesh warp container selections). */
	boundsDashed?: boolean;
}

export interface ControlPointHandle {
	type: "anchor" | "control" | "corner-radius" | "corner-superellipse-k";
	pathId: string;
	segmentIndex: number;
	pointType:
		| "start"
		| "cp1"
		| "cp2"
		| "end"
		| "corner-radius"
		| "corner-superellipse-k";
	worldX: number;
	worldY: number;
	screenX: number;
	screenY: number;
	selected: boolean;
}

export interface MeshCageHandle {
	/** "meshv:{meshId}:{vi}" or "meshcp:{meshId}:{vi}:{ni}" */
	id: string;
	handleType: "mesh-vertex" | "mesh-cp";
	worldX: number;
	worldY: number;
	/** Owning vertex position a CP handle stems from (mesh-cp only). */
	stemWorldX?: number;
	stemWorldY?: number;
	isDerived?: boolean;
	selected: boolean;
}

export interface PathEditUIData {
	paths: Array<{
		pathId: string;
		controlPoints: ControlPointHandle[];
		segments: Array<{
			start?: { x: number; y: number };
			cp1: { x: number; y: number };
			cp2: { x: number; y: number };
			end: { x: number; y: number };
		}>;
	}>;
	/** Mesh warp cages edited alongside paths: edge curves + vertex/CP handles. */
	meshCages?: Array<{
		meshId: string;
		/** World AABB of the cage, drawn dashed like the selection bounding box. */
		bounds: BoundingBox;
		edges: Array<{
			start: { x: number; y: number };
			cp1: { x: number; y: number };
			cp2: { x: number; y: number };
			end: { x: number; y: number };
		}>;
		handles: MeshCageHandle[];
	}>;
	/** Extra context outlines drawn but not editable — e.g. a blend's key/spine
	 *  outlines while editing a path inside the blend. */
	additionalOutlines?: WorldBezierSegment[][];
	longPressRing?: { worldX: number; worldY: number };
	lassoPath?: Array<{ x: number; y: number }>;
}

export interface ToolCursorUIData {
	worldX: number;
	worldY: number;
	radius: number;
	color: [number, number, number, number];
	/** Picked color to display as filled circle above cursor */
	pickedColor?: [number, number, number, number];
}

export interface EraserToolUIData {
	worldX: number;
	worldY: number;
	/** Eraser visual radius (world units) */
	radius: number;
	color: [number, number, number, number];
}

export interface MarqueeSelectionUIData {
	startX: number;
	startY: number;
	endX: number;
	endY: number;
	lassoPath?: Array<{ x: number; y: number }>;
}

export interface ArtboardSelectionUIData {
	bounds: BoundingBox;
	handles: Array<{
		x: number;
		y: number;
		position: "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
	}>;
}

export interface HoverUIData {
	bounds?: BoundingBox;
	pathSegments?: WorldBezierSegment[][];
}

export interface SnapLine {
	/** "horizontal" = horizontal line at aligned Y, "vertical" = vertical line at aligned X */
	axis: "horizontal" | "vertical";
	/** Snap position (world coordinates) */
	position: number;
	/** Line drawing extent start (perpendicular axis) */
	extentMin: number;
	/** Line drawing extent end */
	extentMax: number;
}

export interface SnapResult {
	deltaX: number;
	deltaY: number;
	snapLines: SnapLine[];
}

export interface SnapLineUIData {
	lines: SnapLine[];
}

export interface GradientEditUIHandle {
	/** Unique identifier for hit testing */
	id: string;
	/** World coordinate X */
	worldX: number;
	/** World coordinate Y */
	worldY: number;
	/** Handle type determines rendering style */
	handleType:
		| "linear-start"
		| "linear-end"
		| "linear-stop"
		| "linear-midpoint"
		| "radial-center"
		| "radial-radius"
		| "radial-rotation"
		| "radial-stop"
		| "radial-midpoint"
		| "free-stop"
		| "free-cp"
		| "mesh-vertex"
		| "mesh-cp";
	/** Fill color for the handle (RGBA 0-1) */
	color: [number, number, number, number];
	/** Whether this handle is currently selected */
	selected: boolean;
	/**
	 * For mesh-vertex handles: true when the vertex's color is auto-derived
	 * (positionSource / colorSource). Derived vertices are rendered with a
	 * smaller dashed ring and white fill to distinguish them from explicit
	 * user-set vertices.
	 */
	isDerived?: boolean;
}

interface GradientEditUILine {
	x1: number;
	y1: number;
	x2: number;
	y2: number;
	/** Line color (RGBA 0-1) */
	color: [number, number, number, number];
	/** Screen-pixel stroke width. Defaults to the shared connector width. */
	width?: number;
	/** Draw a gray outline stroke beneath this line, for visibility against
	 *  busy canvas content. */
	outlined?: boolean;
}

interface GradientEditUICircle {
	cx: number;
	cy: number;
	radius: number;
	color: [number, number, number, number];
}

interface GradientEditUIEllipse {
	centerX: number;
	centerY: number;
	radiusX: number;
	radiusY: number;
	rotation: number;
	color: [number, number, number, number];
	/** Screen-pixel stroke width. Defaults to the shared connector width. */
	width?: number;
}

interface GradientEditUICubicEdge {
	start: { x: number; y: number };
	cp1: { x: number; y: number };
	cp2: { x: number; y: number };
	end: { x: number; y: number };
	/** Whether this edge is part of the outer mesh boundary. */
	boundary: boolean;
	/** Whether an incident vertex is currently selected (rendered brighter). */
	highlighted: boolean;
}

export interface GradientEditUIData {
	handles: GradientEditUIHandle[];
	lines: GradientEditUILine[];
	/** Dashed circles (for radial gradient radius display) */
	circles: GradientEditUICircle[];
	/** Dashed ellipses (for elliptical radial gradient display) */
	ellipses: GradientEditUIEllipse[];
	/** Cubic Bézier edges of a mesh gradient (drawn beneath handles). */
	bezierEdges?: GradientEditUICubicEdge[];
}

/**
 * Pattern-edit overlay data shown while the user is inside an isolated
 * pattern-edit session. Draws the tile rectangle in world coordinates so the
 * user sees the wrap region they are composing.
 */
export interface PatternEditUIData {
	/** Tile center in world coordinates (where the def origin maps to). */
	centerX: number;
	centerY: number;
	/** Tile width in world units. */
	tileWidth: number;
	/** Tile height in world units. */
	tileHeight: number;
}

export interface MeshDeformHandle {
	id: string;
	/** Original world position when placed */
	originalX: number;
	originalY: number;
	/** Current world position (after dragging) */
	currentX: number;
	currentY: number;
	selected: boolean;
}

interface MeshEdge {
	x1: number;
	y1: number;
	x2: number;
	y2: number;
}

export interface MeshDeformUIData {
	/** Triangle mesh edges (deformed coordinates) */
	edges: MeshEdge[];
	/** User-placed control handles */
	handles: MeshDeformHandle[];
	/** Original bounding box outline (faded reference) */
	originalBounds: BoundingBox;
	/** Lasso selection path (world coordinates), shown while dragging */
	lassoPath?: Array<{ x: number; y: number }>;
	/** Long press ring position (world coordinates), shown during long press delete */
	longPressRing?: { worldX: number; worldY: number };
}

export interface FreeTransformUIData {
	/** The four warped corners in world space, ordered TL, TR, BR, BL. */
	corners: ReadonlyArray<{ x: number; y: number }>;
	/** Indices of the corners currently being dragged (drawn emphasised). */
	activeCorners?: ReadonlyArray<number>;
	/** Shift-selected handle indices (drawn with a selection ring). */
	selectedCorners?: ReadonlyArray<number>;
}

export interface StrokeWidthHandle {
	/** Index into effective array: -1 = implicit t=0, -2 = implicit t=1, 0+ = explicit index */
	pointIndex: number;
	side: "side1" | "side2";
	worldX: number;
	worldY: number;
	selected: boolean;
}

/** Handle sitting on the path itself, which slides the point along the path. */
export interface StrokeWidthCenterHandle {
	/** Index into effective array: -1 = implicit t=0, -2 = implicit t=1, 0+ = explicit index */
	pointIndex: number;
	worldX: number;
	worldY: number;
	selected: boolean;
	/** The implicit endpoints define where the profile starts and ends, so they
	 * are drawn but cannot be picked up. */
	fixed: boolean;
}

export interface StrokeWidthEditUIData {
	pathSegments: Array<{
		start?: { x: number; y: number };
		cp1: { x: number; y: number };
		cp2: { x: number; y: number };
		end: { x: number; y: number };
	}>;
	handles: StrokeWidthHandle[];
	centerHandles: StrokeWidthCenterHandle[];
	crossLines: Array<{ x1: number; y1: number; x2: number; y2: number }>;
	/** Width profile envelope outline (side1 then side2, as connected line segments) */
	envelopeLines: Array<{ x1: number; y1: number; x2: number; y2: number }>;
}

export interface TextEditUIData {
	cursor: {
		x: number;
		y: number;
		height: number;
		visible: boolean;
		writingMode: TextLayout["writingMode"];
		rotation: number;
	} | null;
	selectionRects: Array<{
		x: number;
		y: number;
		width: number;
		height: number;
		rotation: number;
	}>;
	compositionUnderline: {
		x: number;
		y: number;
		width: number;
		rotation: number;
	} | null;
}

export interface BucketFillUIData {
	/** Confirmed cut paths (guard lines) — rendered as orange polylines */
	cutPaths: Array<Array<{ x: number; y: number }>>;
	/** Active cut path being drawn (live drag) */
	activeCutPath?: Array<{ x: number; y: number }>;
	/** Gap barrier line segments detected by gap distance map — rendered as yellow lines */
	gapBarrierSegments: Array<{
		x1: number;
		y1: number;
		x2: number;
		y2: number;
	}>;
	/** Leak markers (world coords) shown when a fill was unbounded: a
	 *  screen-fixed ring + dot, plus a circle showing the real gap extent. */
	leaks?: Array<{ x: number; y: number; gapWidthWorld: number }>;
}
