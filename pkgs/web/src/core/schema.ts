/**
 * @paplico/core - Shared types and utilities
 */

import { nanoid } from "nanoid";
import { deepClone } from "@/utils/lang";
import type { ProofProfileRef, RenderingIntent } from "./color/types";
import type { LengthUnit } from "./document/units";
import type { TimelapseData } from "./timelapse/types";

// --- Color Types ---

export interface RGBColor {
	type: "rgb";
	r: number; // 0.0~1.0
	g: number; // 0.0~1.0
	b: number; // 0.0~1.0
	a: number; // 0.0~1.0
}

export interface HSVColor {
	type: "hsv";
	h: number; // 0.0~1.0 (0.0=0°, 1.0=360°)
	s: number; // 0.0~1.0
	v: number; // 0.0~1.0
	a: number; // 0.0~1.0
}

export type Color = RGBColor | HSVColor;

/** Plain RGBA values (0.0-1.0) without color space discriminator.
 *  Used in renderer internals, GPU APIs, and numeric color operations. */
export interface RawRGBA {
	r: number; // 0.0~1.0
	g: number; // 0.0~1.0
	b: number; // 0.0~1.0
	a: number; // 0.0~1.0
}

/** Convert Color (RGB or HSV) to plain RawRGBA values. */
export function colorToRawRGBA(c: Color): RawRGBA {
	if (c.type === "rgb") return { r: c.r, g: c.g, b: c.b, a: c.a };

	const [r, g, b] = hsvToRgb(c.h, c.s, c.v);
	return { r, g, b, a: c.a };
}

/** Convert plain RawRGBA to discriminated RGBColor. */
export function toRGBColor(c: RawRGBA): RGBColor {
	return { type: "rgb", r: c.r, g: c.g, b: c.b, a: c.a };
}

export function hsvToRgb(
	h: number,
	s: number,
	v: number,
): [r: number, g: number, b: number] {
	const i = Math.floor(h * 6);
	const f = h * 6 - i;
	const p = v * (1 - s);
	const q = v * (1 - f * s);
	const t = v * (1 - (1 - f) * s);

	switch (i % 6) {
		case 0:
			return [v, t, p];
		case 1:
			return [q, v, p];
		case 2:
			return [p, v, t];
		case 3:
			return [p, q, v];
		case 4:
			return [t, p, v];
		case 5:
			return [v, p, q];
		default:
			return [0, 0, 0];
	}
}

export function rgbToHsv(
	r: number,
	g: number,
	b: number,
): [h: number, s: number, v: number] {
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const d = max - min;
	const v = max;
	const s = max === 0 ? 0 : d / max;

	if (d === 0) return [0, s, v];

	let h: number;
	if (max === r) {
		h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
	} else if (max === g) {
		h = ((b - r) / d + 2) / 6;
	} else {
		h = ((r - g) / d + 4) / 6;
	}

	return [h, s, v];
}

export interface ColorStop {
	offset: number; // 0.0~1.0
	color: Color;
	/**
	 * Piecewise-linear interpolation midpoint (Photoshop-style) toward the
	 * next stop, 0.0-1.0. 0.5 = linear (no bias). Meaningless on a
	 * gradient's last stop (no next stop to bias toward) but still stored
	 * for round-trip stability.
	 */
	midpoint: number;
}

export interface SolidColor {
	type: "solid";
	color: Color;
}

export interface LinearGradient {
	type: "linear";
	x1: number;
	y1: number;
	x2: number;
	y2: number;
	stops: ColorStop[];
}

export interface RadialGradient {
	type: "radial";
	cx: number; // Center X (0.0-1.0, bounds-relative)
	cy: number; // Center Y (0.0-1.0, bounds-relative)
	radiusX: number; // Horizontal radius (0.0-1.0, bounds-relative)
	radiusY: number; // Vertical radius (0.0-1.0, bounds-relative)
	rotation: number; // Rotation angle in radians
	stops: ColorStop[];
}

/** Individual ColorStop for free-form gradients. */
export interface FreeGradientStop {
	/** Stable reference ID. */
	id: string;
	/** 0-1 bounding-box relative X. */
	x: number;
	/** 0-1 bounding-box relative Y. */
	y: number;
	color: Color;
	/**
	 * Per-edge cubic Bezier control points.
	 *
	 * Key = adjacent stop's ID (i.e. the other endpoint of a Delaunay edge).
	 * Value = the CP coordinate on **this** stop's side of the edge.
	 *
	 * Each Delaunay edge becomes a cubic Bezier curve:
	 *   P0 (this stop) → CP0 (this entry) → CP1 (neighbor's edgeCPs[this.id]) → P3 (neighbor stop)
	 *
	 * Three such Bezier edges surrounding a Delaunay triangle form a
	 * Coons Patch, which is used to interpolate color inside the triangle.
	 *
	 * When an edge has no CPs defined, it defaults to linear interpolation
	 * (CPs placed at 1/3 and 2/3 along the straight line).
	 */
	edgeCPs?: Record<string, { x: number; y: number }>;
}

/**
 * Free-form gradient (point cloud + Delaunay triangulation + Coons Patch).
 *
 * ColorStops can be placed at any position within the object in any quantity.
 *
 * ## Rendering pipeline
 * 1. Delaunay triangulation is computed from the stops array at render time.
 * 2. Each edge of the triangulation is a cubic Bezier curve controlled by
 *    the two endpoint stops' `edgeCPs` entries.
 * 3. Three Bezier edges forming a triangle define a triangular Coons Patch.
 * 4. Inside each patch, color is interpolated via Coons Patch blending
 *    in OKLab perceptual color space.
 * 5. Pixels outside the convex hull take the color of the nearest stop.
 *
 * ## Behavior by stop count
 * - **1 stop**: The entire object is filled with that stop's color.
 * - **2 stops**: Each point takes the color of the nearest ColorStop.
 * - **3+ stops**: Delaunay triangulation → Coons Patch interpolation
 *   in OKLab space. Pixels outside the convex hull take the nearest
 *   stop's color.
 */
export interface FreeGradient {
	type: "free";
	stops: FreeGradientStop[];
}

/**
 * A face (quadrilateral or triangle) of a mesh, referencing vertices by index.
 *
 * - `quad`: 4 vertices in order [i00, i10, i11, i01] (CCW). Four Bézier edges
 *   form a quadrilateral Coons patch for position/color interpolation.
 * - `tri`: 3 vertices. Three Bézier edges form a triangular Coons patch.
 */
export interface MeshFace {
	type: "quad" | "tri";
	/** Vertex indices into the parent vertex array, ordered CCW. */
	verts: number[];
}

/**
 * Vertex of a MeshGradient fill. Self-contained: stores both position (as
 * bounds-relative coordinates) and color/handle data so the gradient can be
 * applied to any element's fill slot independently of that element's geometry.
 */
export interface MeshGradientVertex {
	/** Bounds-relative X (0..1 over the filled element's bounds). */
	x: number;
	/** Bounds-relative Y (0..1). */
	y: number;
	color: Color;
	/**
	 * - `explicit`: Color is user-specified and edited directly.
	 * - `derived`: Color is recomputed from `colorSource` whenever the source
	 *   geometry changes. Used for vertices introduced by face subdivision.
	 */
	colorMode: "explicit" | "derived";
	/** When true, hidden from rendering but remains addressable for edits. */
	hidden?: boolean;
	/**
	 * Describes how a `derived`-mode color is reconstructed from parent
	 * geometry. `quad` samples a Coons patch at (u, v); `edge` samples an
	 * edge-color interpolation at parameter `t`.
	 */
	colorSource?:
		| { kind: "quad"; faceVerts: number[]; u: number; v: number }
		| { kind: "edge"; edgeVerts: number[]; t: number };
	/** Derived-mode source describing this vertex's link to the outer mesh. */
	meshSource?: { edgeVerts: number[]; t: number };
	/** Derived-mode source for this vertex's position along a parent edge. */
	positionSource?: { edgeVerts: number[]; t: number };
	/** Shared identifier for vertices introduced by the same split operation. */
	splitLineId?: number;
	/** Identifier shared by every vertex created by one face subdivision. */
	subdivisionId?: number;
	/** Topology that existed immediately before this explicit vertex was added. */
	subdivisionSource?: {
		id: number;
		vertexCount: number;
		faces: MeshFace[];
	};
	/**
	 * Per-neighbor cubic Bézier control handle. Key = neighbor vertex's index
	 * within this gradient's vertex array. Edge construction mirrors
	 * MeshGeometryVertex.handles.
	 */
	handles: Record<number, { x: number; y: number }>;
}

/**
 * Mesh gradient fill using "Bézier polygon hit + Coons Patch color (no holes)"
 * rendering.
 *
 * ## Rendering pipeline (per pixel, on GPU)
 * 1. Each face's 4 (quad) or 3 (tri) Bézier edges form a polygon; the pixel
 *    is inside iff the ray-crossing count is odd.
 * 2. Inside a quad face, the pixel's (u, v) is recovered by Newton-iterating
 *    the inverse Coons map from a bilinear seed plus fallback seeds.
 * 3. Corner and edge colors are blended via the Coons patch formula in OKLab
 *    and converted back to sRGB.
 *
 * ## Self-contained
 * `vertices` and `faces` belong to the fill itself, so the fill can be applied
 * to any element's fill slot regardless of that element's geometry (Path,
 * CompoundPath, MeshArtObject, etc.).
 */
export interface MeshGradient {
	type: "mesh";
	/** Gradient vertices (position + color + handles). */
	vertices: MeshGradientVertex[];
	/** Faces (quads/tris) defining the Coons-patch topology. */
	faces: MeshFace[];
}

/**
 * Pattern fill that samples a `DefEntry` of kind `"pattern"` as a tiled
 * texture. The tile grid is anchored to the element's own world-space
 * bounding-box top-left corner, so the pattern follows the element when it
 * moves, rotates, or scales (unlike Illustrator's default "pattern does not
 * transform with the object" behavior). The pattern's own affine
 * (offset / rotation / scale) is applied in the element-local space before
 * tiling.
 */
export interface PatternFill {
	type: "pattern";
	/** Target def id (must reference a DefEntry of kind "pattern"). */
	defId: string | null;
	/** Horizontal scale factor (1 = tile rendered at its def-local size). */
	scaleX: number;
	/** Vertical scale factor (1 = tile rendered at its def-local size). */
	scaleY: number;
	/** Rotation in radians applied before tiling. */
	rotation: number;
	/** Horizontal offset in world units applied before tiling. */
	offsetX: number;
	/** Vertical offset in world units applied before tiling. */
	offsetY: number;
}

export type TexturedFill =
	| LinearGradient
	| RadialGradient
	| FreeGradient
	| MeshGradient
	| PatternFill;

export type FillColor = SolidColor | TexturedFill;

// --- Stroke Color Types ---

/**
 * Color mapping mode for stroke gradients.
 * Equivalent to Illustrator's "Apply Gradient To Stroke".
 *
 * - "within": apply the gradient to the stroke (a BBox-based gradient masked by the stroke)
 * - "along": apply the gradient along the path (t=0 at the start, t=1 at the end)
 * - "across": apply the gradient across the path (gradient runs in the stroke width direction)
 */
export type StrokeGradientMode = "within" | "along" | "across";

export interface StrokeGradient {
	type: "stroke-gradient";
	gradient: LinearGradient;
	/** Color mapping mode for the gradient. Default: "within" */
	mode: StrokeGradientMode;
}

export interface StrokePattern {
	type: "stroke-pattern";
	pattern: PatternFill;
	/** Color mapping mode for the pattern. Default: "within" */
	mode: StrokeGradientMode;
}

export type StrokeColor = SolidColor | StrokeGradient | StrokePattern;

// --- Path Types ---

/** Generic 2D point. Coordinate space depends on usage context. */
export interface Point {
	x: number;
	y: number;
}

export interface BezierPoint {
	/** World-space X coordinate (Y-axis up, origin at canvas center). */
	x: number;
	/** World-space Y coordinate (Y-axis up, origin at canvas center). */
	y: number;
	pressure?: number;
	tiltX?: number;
	tiltY?: number;
	/** Pen barrel rotation in degrees (0–359, PointerEvent.twist). */
	twist?: number;
	deltaTime?: number;
}

/**
 * Cubic Bézier segment. start/end are world-space anchor positions.
 * cp1 and cp2 are stored as relative offsets (world-space vectors):
 * - cp1: offset from the start anchor (start ?? prevSegment.end)
 * - cp2: offset from the end anchor
 *
 * Use resolveSegment() in utils/segmentOps.ts to obtain absolute world-space coordinates.
 */
export interface CubicBezierSegment {
	/** Start anchor in world space. Only present on the first segment of a subpath;
	 *  subsequent segments use the previous segment's `end` as their start. */
	start?: BezierPoint;
	/** Control point 1 — relative offset from the start anchor (world-space vector). */
	cp1: BezierPoint;
	/** Control point 2 — relative offset from the end anchor (world-space vector). */
	cp2: BezierPoint;
	/** End anchor in world space. */
	end: BezierPoint;
	/** Pressure at the start of this segment (0–1). */
	startPressure?: number;
	/** Pressure at the end of this segment (0–1). */
	endPressure?: number;
	/** Pen tilt X at the start of this segment (-90–90 degrees). */
	startTiltX: number;
	/** Pen tilt Y at the start of this segment (-90–90 degrees). */
	startTiltY: number;
	/** Pen tilt X at the end of this segment (-90–90 degrees). */
	endTiltX: number;
	/** Pen tilt Y at the end of this segment (-90–90 degrees). */
	endTiltY: number;
	/** Pen barrel rotation at the start of this segment (0–359 degrees). */
	startTwist?: number;
	/** Pen barrel rotation at the end of this segment (0–359 degrees). */
	endTwist?: number;
	/** Elapsed time from stroke start at segment start (ms). */
	startDeltaTime: number;
	/** Elapsed time from stroke start at segment end (ms). */
	endDeltaTime: number;
	/** Whether this segment begins a new subpath (equivalent to SVG moveTo). */
	isMoved: boolean;
	/** Whether this segment closes the current subpath (equivalent to SVG Z). */
	isClosed?: boolean;
}

/** CubicBezierSegment extension. Holds a corner radius on the end point (vertex) */
export interface PathSegment extends CubicBezierSegment {
	/** Corner radius of this vertex (the end point). 0 or undefined = no rounding */
	cornerRadius?: number;
	/**
	 * Superellipse exponent k for corner shape.
	 * k=2: circular arc (default), k=5: iOS-style squircle.
	 * Only effective when cornerRadius > 0.
	 */
	cornerSuperellipseN?: number;
}

/**
 * A control point for variable stroke width along a path.
 *
 * Similar to Illustrator's Variable Width Profile, extended with
 * independent left/right (Side 1/Side 2) control.
 *
 * Side 1 = left side of the path's travel direction (increasing t).
 * Side 2 = right side of the path's travel direction.
 *
 * Values are signed boundary offsets normalized by half of the base stroke width
 * (BrushSettings.properties.size.base / 2):
 *   1.0 = the boundary is one half-width from the centerline on its own side
 *   0.0 = the boundary lies on the centerline
 *  -0.5 = the boundary crossed the centerline by half a half-width
 *
 * A negative value on one side reduces the visible width on the opposite side.
 * The total visible width ratio is `Math.max(0, side1 + side2)`. A profile may
 * retain a zero-width point (`side1 + side2 === 0`), while intervals where the
 * sum becomes negative must be removed by splitting the path.
 *
 * Width is interpolated linearly between adjacent StrokeWidthPoints
 * along the path. Points must be sorted by ascending `t`.
 *
 * ## Implicit endpoints
 *
 * If the array does not contain a point at t=0, an implicit
 * {t:0, side1:1, side2:1} is assumed (full width at path start).
 * Likewise, if no point exists at t=1, an implicit
 * {t:1, side1:1, side2:1} is assumed (full width at path end).
 *
 * ## Composition with pressure
 *
 * strokeWidths acts as a per-side ratio applied ON TOP of the
 * pressure-computed width. The two systems compose multiplicatively:
 *
 *   effectiveHalfWidth(side) = stampHalfSize * sideRatio
 *
 * On brush-stroke commit, PenTool bakes the size-curve-evaluated width
 * profile into strokeWidths and marks the path strokeWidthsBaked, so the
 * drawn width survives vertex edits that rebuild the per-segment pressure
 * data (renderers skip the size curves for baked paths — see Path). It is
 * further modified by the eraser tool's width-adjust mode or manual editing
 * in PathEditTool. Live previews and curve-less strokes leave it undefined
 * (= full width on both sides).
 */
export interface StrokeWidthPoint {
	/** Position along the path, normalized to [0, 1] by total path length.
	 * Must be sorted in ascending order within the parent array. */
	t: number;
	/** Signed boundary offset for Side 1 (left of travel direction). */
	side1: number;
	/** Signed boundary offset for Side 2 (right of travel direction). */
	side2: number;
}

/**
 * A non-destructive erase mask that subtracts from an element's rendered output.
 *
 * The mask is defined by an eraser stroke path with brush settings.
 * During rendering, the mask path is rasterized using the existing brush
 * rendering pipeline (stamp-based), and the resulting alpha is used to
 * subtract from the target element's alpha channel.
 *
 * Rendering pipeline:
 *   1. Render the element to an offscreen texture (normal brush rendering)
 *   2. Render all eraseMasks to a separate mask texture (using brush renderer)
 *   3. Composite: finalAlpha = elementAlpha * (1 - maskAlpha * mask.opacity)
 *
 * Hard vs Soft erasing is controlled per-mask via the opacity property:
 *   - opacity = 1.0 → hard erase (fully transparent where mask covers)
 *   - opacity < 1.0 → soft erase (partially transparent, gradual fade)
 */
export interface EraseMask {
	/** Unique identifier for this mask */
	uid: string;

	/** Eraser stroke path segments in world coordinates.
	 * Uses the same PathSegment format as regular paths. */
	segments: PathSegment[];

	/** Stroke color for rendering the mask (only alpha channel matters). */
	strokeColor: StrokeColor;

	/** Brush settings for rendering the mask stroke. */
	brushSettings: BrushSettings;

	/**
	 * Mask opacity (0–1). Controls hard vs soft erasing:
	 *   1.0 = hard erase — fully transparent where mask covers
	 *   0.0 = no effect (invisible mask)
	 *
	 * Applied after mask rendering: resultAlpha = elementAlpha * (1 - maskSampleAlpha * opacity)
	 */
	opacity: number;
}

export type BlendMode =
	| "normal"
	| "multiply"
	| "screen"
	| "overlay"
	| "darken"
	| "lighten"
	| "color-dodge"
	| "color-burn"
	| "hard-light"
	| "soft-light"
	| "difference"
	| "exclusion";

export type CompositionMode = "normal" | "alpha-lock";

export const DEFAULT_COMPOSITION_MODE: CompositionMode = "normal";

/**
 * Axis-aligned bounding box in world space (Y-axis up, origin at canvas center).
 * When returned from SpatialIndex.getWorldBounds(), includes ancestor group transforms.
 */
export interface BoundingBox {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
	width: number;
	height: number;
}

// --- Document Types ---

export type AnyArtObject =
	| Path
	| Group
	| ImageObject
	| CompoundPath
	| TextElement
	| MeshArtObject
	| BlendObject
	| RepeatObject
	| Reference3DElement;

/**
 * Editing sessions that expand their subject onto a throwaway layer so the
 * ordinary tools can work on it. Declared here beside {@link Layer} because the
 * field is what the readers, the writer and the renderer all branch on; each
 * session module owns only its own entry.
 */
export const TRANSIENT_LAYER_KIND = {
	PATTERN_EDIT: "pattern-edit",
	MASK_EDIT: "mask-edit",
} as const;

export type TransientLayerKind =
	(typeof TRANSIENT_LAYER_KIND)[keyof typeof TRANSIENT_LAYER_KIND];

/**
 * Whether a value read back from storage names a transient layer kind. Derived
 * from the map rather than listed by hand, so a new kind cannot be written and
 * then silently dropped on the way back in.
 */
export function isTransientLayerKind(
	value: unknown,
): value is TransientLayerKind {
	return (
		typeof value === "string" &&
		(Object.values(TRANSIENT_LAYER_KIND) as string[]).includes(value)
	);
}

export interface Layer {
	id: string;
	name: string;
	visible: boolean;
	locked: boolean;
	opacity: number;
	blendMode?: BlendMode;
	/** IDs of the top-level elements (references into document.objects, in display order) */
	elementIds: string[];
	/**
	 * Marks this layer as the working surface of an editing session. Transient
	 * layers are excluded from the papf writer / image export so working state
	 * is never baked in. Always undefined for normal layers.
	 */
	transientKind?: TransientLayerKind;
	/**
	 * Yjs client ID that owns this transient layer (used to GC stale transient
	 * layers left behind by crashed peers). Undefined for normal layers.
	 */
	ownerClientId?: string;
}

/**
 * Camera viewport in world space. (x, y) is the world-space center of the view.
 * Y-axis up, origin at canvas center.
 */
export interface Viewport {
	/** World-space X of the viewport center. */
	x: number;
	/** World-space Y of the viewport center. */
	y: number;
	/** Zoom factor (1 = 100%). */
	zoom: number;
	/** Canvas rotation in radians. */
	rotation: number;
}

/**
 * Kind discriminator for a DefEntry. "pattern" definitions are used for fill /
 * stroke patterns; "vector-brush" definitions feed brush source rasterization
 * (BrushArtSource of kind "def").
 */
export type DefKind = "pattern" | "vector-brush";

/**
 * Off-canvas ArtObject definition. The actual elements live in document.objects
 * (absorbed-reference pattern, same as BlendObject.spineSourceId). Since DefEntry
 * elements are not referenced from any Layer.elementIds, they are structurally
 * excluded from rendering / hit-testing / export by every walker that starts
 * from layers — only def-aware code paths (DefRasterizer / pattern fill) reach
 * them via DefEntry.rootElementIds.
 */
export interface DefEntry {
	id: string;
	kind: DefKind;
	/** Optional human-readable name (UI). */
	name?: string;
	/** Z-ordered root element IDs into document.objects. */
	rootElementIds: string[];
	/**
	 * Pattern tile rectangle in def-local coordinates (origin at center).
	 * Only meaningful for kind === "pattern". Undefined for "vector-brush".
	 */
	tile?: { width: number; height: number };
}

export interface Document {
	id: string;
	/** Normalized store of all ArtObjects keyed by ID */
	objects: Record<string, AnyArtObject>;
	layers: Layer[];
	/** Main viewport state (saved from primary canvas) */
	viewport: Viewport;
	files: EmbeddedFile[];
	artboards: Artboard[];
	/** Brush presets (built-in + user-uploaded) */
	brushPresets: BrushPreset[];
	/**
	 * Appearance presets referenced by AppearancePresetRef stack entries.
	 * Optional for backward compatibility (treated as `[]` when absent).
	 */
	appearancePresets?: AppearancePreset[];
	timelapse?: TimelapseData;
	/** Schema version as YYYYMMDD date number. Undefined = legacy (pre-migration). */
	schemaVersion?: number;
	/** HDR rendering settings. */
	hdr?: HdrSettings;
	/** Color profile settings (working space, proof profile). */
	colorProfile?: ColorProfileSettings;
	/** Filter rasterization resolution in DPI. 72 = 1 texel per world px. Defaults to 72 when undefined. */
	rasterizationDpi?: number;
	/** Length unit used for display and input. Coordinates stay in world units. */
	units: LengthUnit;
	/**
	 * Off-canvas ArtObject definitions referenced by patterns and brush sources.
	 * Each DefEntry holds rootElementIds into document.objects (absorbed-reference
	 * pattern, same as BlendObject.spineSourceId). Optional for backward
	 * compatibility with legacy documents (treated as `{}` when absent).
	 */
	defs?: Record<string, DefEntry>;
	/**
	 * Shared 3D scene definitions referenced by Reference3DElement.sceneId.
	 * Optional — absent means no 3D scenes (treated as `{}`).
	 */
	references3d?: Record<string, Reference3DDef>;
}

export interface HdrSettings {
	/** Whether HDR rendering is enabled. */
	enabled: boolean;
	/** Exposure value in EV. 0 = no change, 1 = 2× brightness. */
	exposure: number;
}

export interface ColorProfileSettings {
	/** Working color space the document's RGB values are interpreted in. */
	workingSpace: "srgb" | "display-p3";
	/** Proof target profile for soft proofing / CMYK export. */
	proofProfile?: ProofProfileRef;
	/** Rendering intent for proof conversions. Default: "relative-colorimetric". */
	proofIntent?: RenderingIntent;
}

// --- Filter Types ---

/** Versioned parameter container for filter data migration */
interface ParamData<T = unknown> {
	version: string;
	params: T;
}

/** Base interface for all filters/appearances. Pre/post is determined by FilterHandler method existence. */
export interface Appearance<T = unknown> {
	/** Stable unique identifier for this filter instance */
	uid: string;
	processor: string;
	/** Whether the filter is enabled (undefined = true) */
	enabled?: boolean;
	/** Per-appearance opacity (0.0–1.0) */
	opacity: number;
	/** Per-appearance blend mode */
	blendMode: BlendMode;
	paramData: ParamData<T>;
	/** Run postProcess on the captured backdrop instead of the element's own
	 *  raster; the output is masked to the element shape. Ignored for
	 *  appearances without postProcess (geometry/fill/stroke) and for
	 *  render-replacing ones (e.g. extrude3d). undefined = false. */
	applyToBackdrop?: boolean;
	/** Sub-filters scoped to this appearance (e.g., blur on a single fill) */
	subFilters?: Filter[];
}

export function isFilterEnabled(filter: Appearance): boolean {
	return filter.enabled !== false;
}

/**
 * Backfill required opacity/blendMode fields on filters that
 * were serialized before these fields existed.
 * Mutates the array elements in place.
 */
export function normalizeAppearanceFields<T extends FilterEntry>(
	filters: T[],
): T[] {
	for (const f of filters) {
		if (isAppearancePresetRef(f)) continue;
		// Migration: old serialized data may lack these fields despite being required in the type
		(f as Partial<Pick<Appearance, "opacity" | "blendMode">>).opacity ??= 1;
		(f as Partial<Pick<Appearance, "opacity" | "blendMode">>).blendMode ??=
			"normal";
		if (f.subFilters) {
			for (const sf of f.subFilters) {
				(sf as Partial<Pick<Appearance, "opacity" | "blendMode">>).opacity ??=
					1;
				(sf as Partial<Pick<Appearance, "opacity" | "blendMode">>).blendMode ??=
					"normal";
			}
		}
	}
	return filters;
}

export function createDefaultContentAppearance(): Filter {
	return {
		uid: generateUid("app"),
		processor: "content",
		opacity: 1,
		blendMode: "normal",
		paramData: { version: "1", params: {} },
	};
}

/** Clone an Appearance with a fresh uid and optional param overrides. */
// biome-ignore lint/suspicious/noExplicitAny: generic constraint requires any for Appearance type parameter
export function cloneAppearance<T extends Appearance<any>>(
	source: T,
	paramOverrides?: Partial<T["paramData"]["params"]>,
): T {
	const cloned = deepClone(source);
	cloned.uid = generateUid("app");
	if (paramOverrides) {
		Object.assign(cloned.paramData.params, paramOverrides);
	}
	return cloned as T;
}

// --- Appearance Filters (Fill/Stroke/Content) ---

export interface FillParams {
	fill: FillColor;
}

export interface FillAppearance extends Appearance<FillParams> {
	processor: "fill";
}

export interface StrokeParams {
	strokeColor: StrokeColor;
	/** Documents saved before brush v2 are migrated on read, so a loaded
	 * document always holds this shape. */
	brushSettings?: BrushSettings;
}

export interface StrokeAppearance extends Appearance<StrokeParams> {
	processor: "stroke";
}

// --- Extrude 3D Appearance ---

/**
 * Lit-surface material shared by 3D-ish renderers (extrude appearance now,
 * a future first-class Mesh3DObject later). Not part of Reference3D.
 */
export interface Material3D {
	shading: "flat" | "lambert" | "blinn-phong";
	/** Direction toward the light (world space, normalized at render time). */
	lightDir: Vec3;
	/** Light color. Absent = white. */
	lightColor?: Color;
	/** Shaded-side (ambient) color. Absent = neutral 0.25 gray. */
	shadowColor?: Color;
	/** Blinn-Phong specular exponent. Ignored by other shading modes. */
	specularPower?: number;
	// --- PBR-ish surface (all optional; neutral defaults leave the classic
	//     lambert/blinn look pixel-identical). Only lit modes react. ---
	/** Analytic-env reflection sharpness (0 = mirror, 1 = flat). Default 0.5. */
	roughness?: number;
	/** 0 = dielectric, 1 = metal (kills diffuse, tints reflection). Default 0. */
	metalness?: number;
	/** Analytic hemisphere-env reflection strength. Default 0 (off). */
	reflectivity?: number;
	/** Coverage reduction so the real backdrop shows through. Default 0 (opaque). */
	glass?: number;
	/** Rim-light (fresnel) term. Absent/false = no rim. */
	fresnelEnabled?: boolean;
	/** Rim color. Absent = white. */
	fresnelColor?: Color;
	/** Rim falloff: rim = saturate(bias + scale·pow(1−N·V, factor)). */
	fresnelBias?: number;
	fresnelScale?: number;
	fresnelIntensity?: number;
	fresnelFactor?: number;
	// --- Glass distortion (needs the composited backdrop; see the refraction
	//     compositor). Any of these > 0 routes the extrude through the glass
	//     path. Default 0 = no distortion (plain transparency via `glass`). ---
	/** Index of refraction; the backdrop offset scales with (ior − 1). Default 1. */
	refraction?: number;
	/** Refraction depth multiplier for the backdrop offset. Default 0. */
	thickness?: number;
	/** Chromatic aberration: per-channel spread of the refraction offset. Default 0. */
	aberration?: number;
	/**
	 * Backdrop blur radius under the glass, in WORLD px. Default 0.
	 *
	 * The compositor multiplies it by the backdrop capture's actual
	 * texels-per-world-px, so the blur covers the same distance on the artboard
	 * at every viewport zoom and at every export scale — the same unit
	 * convention every other spatial appearance field in this schema uses.
	 */
	blur?: number;
	// --- Surface texture (Illustrator "Materials" style): a pattern def tiled
	//     across the 3D surfaces as the albedo, independent of the element's
	//     own fill. Absent/null defId = no surface texture (baseColor / baked
	//     fill unchanged). Reuses PatternFill so the tile transform
	//     (scale/rotation/offset) and the def picker UI are shared. ---
	pattern?: PatternFill | null;
	/** Surface pattern opacity, independent of the object/fill alpha. Default 1. */
	patternOpacity?: number;
}

/** Rounded bevel applied to the extrusion cap edges. */
export interface ExtrudeBevel {
	/** Bevel radius in world units (clamped to half the depth at render time). */
	size: number;
}

/**
 * Fields shared by every 3D solid appearance (extrude3d / revolve3d): the
 * view rotation, perspective projection, and the lit-surface material. The
 * mesh-shaping fields (depth/bevel vs angle/offset/axis/cap) live on the
 * per-processor param types.
 */
export interface Solid3DBaseParams {
	/**
	 * Rotation around the X/Y/Z axes in degrees, applied Z·Y·X around the
	 * solid's 3D center.
	 */
	rotationDeg: Vec3;
	/** Perspective FOV in degrees; 0 = orthographic, larger = stronger foreshortening. */
	perspective: number;
	material: Material3D;
}

/**
 * Extrusion appearance on a Path ("3D and Materials" style): the 2D outline
 * is extruded by `depth` world units and rendered with a simple lit
 * material. While enabled it replaces the flat fill/stroke look of the
 * element, like Illustrator's 3D effects.
 */
export interface Extrude3DParams extends Solid3DBaseParams {
	/** Extrusion depth in world units (along -Z before rotation). */
	depth: number;
	/** Rounded cap-edge bevel. Absent = hard edges. */
	bevel?: ExtrudeBevel;
}

export interface Extrude3DAppearance extends Appearance<Extrude3DParams> {
	processor: "extrude3d";
}

/**
 * Revolve appearance ("3D and Materials" Revolve style): the 2D outline is
 * swept around a vertical axis at its left/right edge into a solid of
 * revolution. While enabled it replaces the flat fill/stroke look of the
 * element, like extrude3d.
 */
export interface Revolve3DParams extends Solid3DBaseParams {
	/** Sweep angle around the revolve axis in degrees, clamped to (0, 360]. */
	angleDeg: number;
	/** Distance from the profile's edge to the revolve axis (world units, >= 0). */
	offset: number;
	/** Which side of the profile the revolve axis sits on. */
	axis: "left" | "right";
	/** Close a partial sweep (angleDeg < 360) with flat end caps. Inert at 360. */
	cap: boolean;
}

export interface Revolve3DAppearance extends Appearance<Revolve3DParams> {
	processor: "revolve3d";
}

export type Filter<T = unknown> = Appearance<T>;

/** Stack entry that pulls a document appearance preset's filters into this position. */
export interface AppearancePresetRef {
	type: "preset";
	/** Entry uid (sortable key, prefix of expanded filter uids) */
	uid: string;
	presetUid: string;
	/** Whether the ref is enabled (undefined = true) */
	enabled?: boolean;
}

/** One item of an element's appearance stack: a concrete filter or a preset ref. */
export type FilterEntry = Filter | AppearancePresetRef;

export function isAppearancePresetRef(
	entry: FilterEntry,
): entry is AppearancePresetRef {
	return "type" in entry && entry.type === "preset";
}
// --- Transform ---

/**
 * Element transform applied at render time. All fields default to identity.
 *
 * For top-level elements, offsets are in world space.
 * For children of a group, offsets are in the parent group's local space;
 * the renderer composes ancestor transforms at render time.
 */
export interface ElementTransform {
	/** Translation X offset (world units for top-level, group-local for children). Default: 0 */
	x: number;
	/** Translation Y offset (world units for top-level, group-local for children). Default: 0 */
	y: number;
	/** Rotation in radians. Default: 0 */
	rotation: number;
	/** Horizontal scale factor. Default: 1 */
	scaleX: number;
	/** Vertical scale factor. Default: 1 */
	scaleY: number;
	/**
	 * Horizontal shear angle in radians (x sheared proportional to y). Default: 0.
	 * Optional so pre-skew documents deserialize without a migration; absent is 0.
	 */
	skewX?: number;
	/**
	 * Vertical shear angle in radians (y sheared proportional to x). Default: 0.
	 * Optional so pre-skew documents deserialize without a migration; absent is 0.
	 */
	skewY?: number;
}

export const IDENTITY_TRANSFORM: Readonly<ElementTransform> = Object.freeze({
	x: 0,
	y: 0,
	rotation: 0,
	scaleX: 1,
	scaleY: 1,
	skewX: 0,
	skewY: 0,
});

export function isIdentityTransform(t: ElementTransform): boolean {
	return (
		t.x === 0 &&
		t.y === 0 &&
		t.rotation === 0 &&
		t.scaleX === 1 &&
		t.scaleY === 1 &&
		(t.skewX ?? 0) === 0 &&
		(t.skewY ?? 0) === 0
	);
}

export function getTransform(obj: ArtObject): ElementTransform {
	return obj.transform;
}

// --- Element Types ---

/**
 * Grayscale mask attached to an ArtObject.
 *
 * The mask elements are rendered with their real appearance (fills, gradients,
 * filters) rather than as a flat silhouette, and the luminance of that result
 * drives the owner's alpha: white keeps the pixel, black removes it. Because
 * the render target holds premultiplied alpha, a transparent area yields zero
 * luminance too, so "luminance x opacity" falls out of a single dot product.
 *
 * Mask elements live in `document.objects` but belong to no `Layer.elementIds`
 * — they are reachable only through this reference (the same arrangement
 * pattern defs use). Their transforms are owner-local: `ViewportManager`
 * registers the owner as their parent so they follow it around.
 */
export interface ObjectMask {
	/** Root element ids of the mask content. Empty = the owner is fully hidden. */
	elementIds: string[];
	/** Default: true (undefined = enabled) */
	enabled?: boolean;
	/** Default: false (undefined = not inverted) */
	inverted?: boolean;
}

/**
 * ArtObject - properties shared by every Element type
 */
export interface ArtObject {
	id: string;
	name?: string;
	opacity: number;
	blendMode: BlendMode;
	compositionMode?: CompositionMode;
	/** Default: true (undefined = visible) */
	visible?: boolean;
	/** Default: false (undefined = unlocked) */
	locked?: boolean;
	/** Appearance stack. Preset refs are expanded at document entry points (see core/document/appearancePresets.ts). */
	filters?: FilterEntry[];
	/** Element transform. Applied at render time. */
	transform: ElementTransform;
	/** Grayscale mask applied to this element's rendered output. */
	mask?: ObjectMask | null;
}

export interface Path extends ArtObject {
	type: "path";
	segments: PathSegment[];
	/** When true, rendered as a cyan guide line on top of all layers. Excluded from export. */
	isGuide?: boolean;

	/**
	 * Normalized position [0, 1] within the original full stroke where this path begins.
	 *
	 * ## PathStart / PathEnd
	 *
	 * When a continuous stroke is split (e.g., by the eraser tool), the resulting
	 * fragments must remember their position within the original stroke to prevent
	 * brush pressure ramp-in/ramp-out from being incorrectly re-applied
	 * to what is effectively the middle of a stroke.
	 *
	 * Example — a stroke erased at 30%–70% of its total length, producing two fragments:
	 * - Fragment 1 (0%–30%):   pathStart=0,   pathEnd=0.3
	 *   → Normal ramp-in at start. No ramp-out at the cut point.
	 * - Fragment 2 (70%–100%): pathStart=0.7, pathEnd=1
	 *   → No ramp-in (stroke was already in progress). Normal ramp-out at end.
	 *
	 * Rules for brush rendering:
	 * - pathStart > 0 → treat the beginning as mid-stroke; suppress ramp-in.
	 * - pathEnd < 1   → treat the end as mid-stroke; suppress ramp-out.
	 *
	 * Defaults: pathStart=0, pathEnd=1 (full stroke; normal ramp-in/out applied).
	 */
	pathStart?: number;
	/** @see pathStart */
	pathEnd?: number;

	/**
	 * Variable width profile for this stroke.
	 *
	 * An array of control points defining the stroke width at arbitrary
	 * positions along the path. Width between adjacent points is interpolated
	 * linearly. Both sides of the stroke can be controlled independently.
	 *
	 * The rendering pipeline samples this profile at each stamp's pathT
	 * position and uses the interpolated side1/side2 ratios to modulate
	 * the stamp's alpha in the fragment shader.
	 *
	 * Default when undefined or empty: full width on both sides.
	 */
	strokeWidths?: StrokeWidthPoint[];

	/**
	 * True when strokeWidths carries the brush's size-curve evaluation, baked
	 * at commit from the raw input's pressure/speed. Renderers then SKIP the
	 * size curves and treat the profile as the width itself: dab/ribbon scale
	 * the stamp size by the ratios, geometric drops its pressure term. The stored brush settings stay untouched, so adopting
	 * this stroke's appearance (selection follow) keeps the live curves.
	 * Unset/false: strokeWidths composes multiplicatively on top of the live
	 * curve evaluation (eraser width-adjust, manual edits).
	 */
	strokeWidthsBaked?: boolean;

	/**
	 * Non-destructive erase masks applied to this element's rendered output.
	 *
	 * Each mask represents an eraser stroke that subtracts from the element's
	 * alpha channel during compositing. The element's path geometry and
	 * strokeWidths are NOT modified — masks only affect the final rendered
	 * appearance.
	 */
	eraseMasks?: EraseMask[];
}

export interface Group extends ArtObject {
	type: "group";
	/** UIDs of the child elements (references into document.objects) */
	childIds: string[];
	collapsed?: boolean;
	/** ID of the element used as the clipping mask (must be one of childIds) */
	clipPathId?: string | null;
}

// --- Boolean Operation Types ---

export type BooleanOperation = "union" | "subtract" | "intersect" | "exclude";

export interface CompoundPathSource {
	id: string;
	op: BooleanOperation;
}

/**
 * CompoundPath - Non-destructive boolean operations on paths.
 * Each source has its own boolean operation. sources[0] is the base path (its op is ignored).
 * Operations are applied sequentially: result = base → sources[1].op → sources[2].op → ...
 */
export interface CompoundPath extends ArtObject {
	type: "compound-path";
	/** Source paths with per-source boolean operation. sources[0].op is ignored (base path). */
	sources: CompoundPathSource[];
}

// --- Blend Types ---

/** Spacing mode for blend intermediate steps. Applied per adjacent pair. */
export type BlendSpacing =
	| { type: "steps"; count: number }
	| { type: "distance"; spacing: number }
	| { type: "smooth" };

/**
 * Blend - Non-destructive interpolation between multiple Path objects.
 * Generates intermediate shapes at render time; editing a source object
 * triggers automatic re-computation via cache fingerprint invalidation.
 *
 * Like Illustrator's Blend, the source objects (and an optional spine path)
 * are absorbed into the blend: removed from layer.elementIds but kept in
 * document.objects so they can be restored on release.
 */
export interface BlendObject extends ArtObject {
	type: "blend";
	/** Ordered element IDs to blend through (A→B→C→...). Min 2 entries. */
	objectIds: string[];
	/**
	 * Front-to-back paint order of the keys, as a permutation of objectIds. Only
	 * affects render stacking (each key is drawn with its trailing intermediates
	 * as one cell); the morph chain, positions and intermediate geometry come from
	 * objectIds and are unaffected. Absent means paint in objectIds order.
	 */
	renderOrder?: string[];
	/** Spacing mode. For "steps", count is applied per adjacent pair. */
	spacing: BlendSpacing;
	/**
	 * ID of the absorbed spine source path (kept in document.objects but removed
	 * from layer.elementIds, like a group's clipPathId). Intermediate centers are
	 * distributed along this path; it is edited through the normal path tools and
	 * restored to the layer on release.
	 */
	spineSourceId?: string;
	/**
	 * When true, intermediate objects rotate to follow the spine tangent. Key
	 * objects always stay upright regardless of this flag. Defaults to false.
	 */
	tiltToSpine?: boolean;
}

// --- Repeat Types ---

/** Repeat arrangement mode (mirrors Illustrator's Repeat: Grid / Radial / Mirror). */
export type RepeatMode = "grid" | "radial" | "mirror";

/**
 * Rectangular grid that fills a region with copies. The row/column COUNT is
 * derived from the region size and spacing (`cols = floor(width / spacingX) + 1`),
 * so resizing the region reflows the copies. The region extends right and down
 * from the source (top-left).
 */
export interface RepeatGridParams {
	/** Fill-region width in world units (source authored space); >= 0. */
	width: number;
	/** Fill-region height in world units (source authored space); >= 0. */
	height: number;
	/** Horizontal gap between adjacent instance centers, in world units. */
	spacingX: number;
	/** Vertical gap between adjacent instance centers, in world units. */
	spacingY: number;
	/**
	 * Brick offset: odd rows are shifted horizontally by this amount (world
	 * units). 0 = aligned columns, spacingX/2 = classic half-brick. Default 0.
	 */
	offsetX?: number;
	/** Brick offset: odd columns are shifted vertically by this amount (world
	 *  units, downward positive). Default 0. */
	offsetY?: number;
}

/** Copies arranged evenly around a pivot point. */
export interface RepeatRadialParams {
	/** Total number of instances around the ring (>= 1, includes the original). */
	count: number;
	/** Distance from the source center to the pivot, in world units. */
	radius: number;
	/** Angle of the first instance, in radians. */
	startAngle: number;
	/**
	 * Total angular span the instances cover, in radians. 2*PI spreads them over a
	 * full circle (last instance does not overlap the first); a smaller value packs
	 * them into an arc.
	 */
	sweep: number;
	/**
	 * When true each copy is a rigid rotation about the pivot (it faces outward,
	 * like Illustrator). When false copies keep their upright orientation and only
	 * their position rotates around the ring.
	 */
	rotateInstances: boolean;
}

/** Source plus a single reflected copy across an axis. */
export interface RepeatMirrorParams {
	/** Orientation of the mirror axis, in radians. */
	axisAngle: number;
	/**
	 * Signed distance from the source center to the mirror axis along the axis
	 * normal, in world units. 0 places the axis through the source center.
	 */
	offset: number;
}

/**
 * Repeat - Non-destructive replication of source artwork, like Illustrator's
 * Repeat. The source elements are absorbed (removed from layer.elementIds but
 * kept in document.objects, like a blend's keys) and re-rendered once per
 * computed instance. All three arrangements are stored so switching mode keeps
 * each mode's settings; only `mode` selects which one is active.
 */
export interface RepeatObject extends ArtObject {
	type: "repeat";
	/** Absorbed source element IDs, rendered as one unit per instance. Min 1. */
	sourceIds: string[];
	mode: RepeatMode;
	grid: RepeatGridParams;
	radial: RepeatRadialParams;
	mirror: RepeatMirrorParams;
}

export interface ImageObject extends ArtObject {
	type: "image";
	/** Reference to an EmbeddedFile.uid */
	fileUid: string;
	/** World coordinate (center X) */
	x: number;
	/** World coordinate (center Y) */
	y: number;
	/** Render width */
	width: number;
	/** Render height */
	height: number;
	/**
	 * Free-transform vertex data: the image's four corners in the same space as
	 * the x/y/width/height rectangle, ordered TL, TR, BR, BL. Absent = the
	 * plain rectangle. The renderer maps the texture onto this quad with a
	 * perspective-correct blit, so the corners behave as editable vertices.
	 */
	corners?: [Vec2, Vec2, Vec2, Vec2];
}

// --- Text Types ---

/**
 * Font source
 * Specifies where the font is obtained from
 */
export type FontSource =
	| { type: "google"; family: string; variants: string[] }
	| { type: "local"; postScriptName: string }
	| { type: "embedded"; fileUid: string };

/**
 * Text style
 * Style settings applied to each TextRun
 */
export interface TextStyle {
	fontFamily: string;
	fontSource: FontSource;
	fontSize: number; // px
	fontWeight: number; // Variable fonts use their declared weight range.
	/** Explicit variable coordinates other than wght, which is stored in fontWeight. */
	fontVariationSettings?: Record<string, number>;
	fontStyle: "normal" | "italic" | "oblique";
	fill: FillColor | null;
	stroke?: StrokeColor | null;
	strokeWidth?: number;
	underline: boolean;
	strikethrough: boolean;
	letterSpacing: number; // in em (0 = default)
	lineHeight?: number; // line height multiplier (1.0 = 100%)
	baselineShift: number; // px (superscript / subscript)
	/** Tate-chu-yoko: fit this run's text into a single character cell, kept horizontal within vertical writing */
	tateChuYoko?: boolean;
	openTypeFeatures?: Record<string, boolean>;
}

/**
 * Per-character adjustment
 * Adjusts kerning, size and so on per character
 */
export interface CharOverride {
	charIndex: number;
	kerningAdjust?: number; // in em
	sizeMultiplier?: number; // 1.0 = 100%
	baselineShift?: number; // px
	rotation?: number; // degrees
	/** Per-char horizontal shear angle in degrees (x sheared proportional to y) — touch-type skew */
	skewX?: number;
	/** Per-char vertical shear angle in degrees (y sheared proportional to x) — touch-type skew */
	skewY?: number;
	/** Per-char visual offset (px, element-local axes, Y-up) — touch-type move */
	offsetX?: number;
	offsetY?: number;
}

/**
 * Text run
 * A contiguous span of text sharing the same style
 */
export interface TextRun {
	text: string;
	style: TextStyle;
	charOverrides?: CharOverride[];
}

/**
 * Text paragraph
 */
export interface TextParagraph {
	runs: TextRun[];
	alignment: "left" | "center" | "right" | "justify";
	lineHeight: number; // 1.0 = 100%
	indent: number; // first-line indent (px)
	spacing: {
		before: number; // space before the paragraph
		after: number; // space after the paragraph
	};
}

/**
 * Text content
 * An array of paragraphs
 */
export interface TextContent {
	paragraphs: TextParagraph[];
	charOverrides?: CharOverride[]; // per-character adjustments
}

/**
 * Text layout settings
 */
export interface TextLayout {
	writingMode: "horizontal-tb" | "vertical-rl" | "vertical-lr";
	boxWidth: number | "auto";
	boxHeight: number | "auto";
	overflow: "visible" | "hidden" | "ellipsis";
	wordWrap: boolean;
}

interface TextAxisBindingBase {
	/** ID of the Path element used as the axis */
	pathObjectId: string;
}

/** Placement along an open path (text on path) */
export interface TextOnPathBinding extends TextAxisBindingBase {
	mode: "onPath";
	startOffset: number; // 0.0-1.0
	offset?: number; // additional offset (px)
	alignment: "left" | "center" | "right";
	offsetDistance: number; // px (positive = outward, negative = inward)
	orientation: "upright" | "rotate";
}

/** Flowing text inside a closed path (area text) */
export interface TextInShapeBinding extends TextAxisBindingBase {
	mode: "inShape";
	/** Inset from the inner edge of the shape (px) */
	inset?: number;
}

export type TextAxisBinding = TextOnPathBinding | TextInShapeBinding;

export interface TextFlow {
	/** ID of the TextElement that overflowing text flows into */
	nextTextElementId?: string;
}

/**
 * Text element
 */
export interface TextElement extends ArtObject {
	type: "text";
	/** World coordinates */
	x: number;
	y: number;
	content: TextContent;
	/** Default style (applied where a Run does not override it) */
	defaultStyle: TextStyle;
	layout: TextLayout;
	axisBinding?: TextAxisBinding;
	/** Link of the flow chain (only the head element holds content) */
	flow?: TextFlow;
	/** ID of the element used as the clipping path */
	clipPathId?: string | null;
}

// --- Mesh Art Object ---

/**
 * Vertex used by MeshArtObject's geometric mesh. Stores position and per-edge
 * control handles only — no color information. Color for mesh-based fills is
 * stored independently inside MeshGradient.
 */
export interface MeshGeometryVertex {
	/** Local X coordinate in the parent MeshArtObject's local space. */
	x: number;
	/** Local Y coordinate in the parent MeshArtObject's local space. */
	y: number;
	/**
	 * Undeformed source-space position. Fixed when the vertex is created
	 * (cage creation or face subdivision) and never edited afterward — the
	 * warp maps source space onto the current vertex/handle geometry.
	 */
	src: { x: number; y: number };
	/**
	 * Per-neighbor cubic Bézier control handle.
	 *
	 * Key = neighbor vertex's index within the same mesh.
	 * Value = the control point coordinate on *this* vertex's side of the edge.
	 *
	 * Each adjacent edge becomes a cubic Bézier curve:
	 *   P0 (this vertex) → CP0 (this entry) → CP1 (neighbor's handles[this])
	 *   → P3 (neighbor vertex)
	 *
	 * Missing entries default to linear interpolation (1/3 and 2/3 along the
	 * straight line).
	 */
	handles: Record<number, { x: number; y: number }>;
	/** When true, the vertex is skipped during face rendering but remains addressable for edits. */
	hidden?: boolean;
	/**
	 * Derived-mode source for this vertex's position along a parent edge.
	 * Set when the vertex was introduced by face subdivision.
	 */
	positionSource?: { edgeVerts: number[]; t: number };
	/** Mesh-topology source recorded by face subdivision (mirrors positionSource). */
	meshSource?: { edgeVerts: number[]; t: number };
	/** Shared identifier for vertices that were created together by a single split operation. */
	splitLineId?: number;
	/** Identifier of the subdivision operation that introduced this vertex. */
	subdivisionId?: number;
	/** Pre-subdivision topology snapshot recorded on the split's center vertex. */
	subdivisionSource?: {
		id: number;
		vertexCount: number;
		faces: MeshFace[];
	};
}

/**
 * Mesh warp container — holds child elements (like Group) and deforms them
 * non-destructively at render time through a Coons-patch cage. Child data is
 * never modified; every child geometry point is mapped "source space → cage"
 * via the cage's current vertex/handle positions.
 *
 * ## Coordinate space
 * Cage vertices live in the container's local space, which is the same space
 * the children's coordinates are expressed in (no 0..width normalization).
 * `transform` composes on top like a Group's.
 *
 * ## Source space
 * Each vertex carries `src` — its undeformed position, fixed at creation or
 * subdivision. Since the initial cage is one rectangle and subdivision cuts
 * at constant u/v, every face's source image is an axis-aligned rectangle
 * (see `utils/geometry/meshWarp.ts`).
 */
export interface MeshArtObject extends ArtObject {
	type: "mesh";
	/** UIDs of the child elements (references into document.objects). */
	childIds: string[];
	/** Cage vertices, positioned in local space. */
	vertices: MeshGeometryVertex[];
	/** Faces referencing the vertex array by index (quad only). */
	faces: MeshFace[];
}

// --- 3D Types (Reference3D subsystem) ---
// World unit: 1 unit = 1 meter (matches the VRM / glTF convention).

export type Vec2 = [x: number, y: number];
export type Vec3 = [x: number, y: number, z: number];

/** Quaternion, [x, y, z, w]. */
export type Quat = [x: number, y: number, z: number, w: number];

export interface Transform3D {
	position: Vec3;
	rotation: Quat;
	scale: Vec3;
}

/**
 * Pose stored relative to the rest pose, as a sparse dictionary keyed by
 * VRM normalized bone name. Normalized poses are T-pose relative, so a pose
 * can be transplanted between different VRM models.
 */
export interface VRMPoseData {
	bones: Record<string, Quat>;
	hipsPosition?: Vec3;
}

export type Reference3DPrimitiveShape =
	| "box"
	| "sphere"
	| "cylinder"
	| "cone"
	| "plane";

/**
 * A node inside a shared 3D scene definition. The `kind` union is open by
 * design so future node kinds (e.g. "mesh" referencing an EmbeddedFile) can
 * be added without restructuring.
 */
export type Reference3DNode =
	| {
			id: string;
			kind: "primitive";
			shape: Reference3DPrimitiveShape;
			transform: Transform3D;
			/** Shape-specific size overrides (meters). Defaults applied per shape. */
			params?: Record<string, number>;
	  }
	| {
			id: string;
			kind: "figure";
			/** EmbeddedFile.uid referencing a VRM binary. */
			fileUid: string;
			transform: Transform3D;
			pose: VRMPoseData;
	  }
	| {
			id: string;
			kind: "mesh";
			/** EmbeddedFile.uid referencing a static glTF binary (.glb). */
			fileUid: string;
			transform: Transform3D;
	  };

/**
 * Document-level shared 3D scene definition. Reference3DElements reference a
 * scene by id and carry their own camera, so one scene can appear in
 * multiple panels from different angles.
 */
export interface Reference3DDef {
	id: string;
	name?: string;
	nodes: Reference3DNode[];
}

export interface Reference3DCamera {
	projection: "perspective" | "orthographic";
	position: Vec3;
	target: Vec3;
	up?: Vec3;
	/** Vertical field of view in degrees (perspective projection). */
	fovDeg: number;
	/** Visible world height in meters (orthographic projection). */
	orthoHeight?: number;
}

/** Parameters for the depth/normal edge-detection lineart post-process. */
export interface Lineart3DParams {
	lineWidthPx: number;
	depthEdgeThreshold: number;
	normalEdgeThreshold: number;
	creaseAngleDeg: number;
	color?: Color;
}

/**
 * A 2D placement rectangle showing a rendered view of a shared 3D scene.
 * From the 2D pipeline's perspective this behaves like an ImageObject —
 * the 3D subsystem renders the scene into a texture off the main pipeline.
 */
export interface Reference3DElement extends ArtObject {
	type: "reference3d";
	/** Document.references3d key of the scene this element renders. */
	sceneId: string;
	/** Per-element camera (one scene, many cameras). */
	camera: Reference3DCamera;
	/** World coordinate (center X) */
	x: number;
	/** World coordinate (center Y) */
	y: number;
	/** Render width */
	width: number;
	/** Render height */
	height: number;
	displayMode: "lineart" | "flat";
	lineart?: Lineart3DParams;
	/** Direction toward the shadow-casting key light (world space). Absent =
	 *  the service default. Objects always ground themselves via an invisible
	 *  shadow catcher; this only steers the shadow direction. */
	lightDir?: Vec3;
	/** Include this scene in image export. Absent/false = excluded (3D scenes
	 *  are draft/atari references and stay out of exports by default). */
	includeInExport?: boolean;
}

// --- Embedded File Types ---

export interface EmbeddedFile {
	uid: string;
	name: string;
	type: string; // MIME type (e.g., "image/png")
	hash: string; // SHA-256 hash (used for deduplication)
	bin: Uint8Array;
}

// --- Brush Types ---
// Stamp-based brush rendering settings. All brushes reference an EmbeddedFile
// in document.files via textureFileUid. Built-in brushes use fixed UIDs and
// are auto-initialized on project creation.

/** Fixed UIDs for built-in brush textures */
export const BUILTIN_BRUSH_IDS = {
	svg: "builtin-brush-svg",
	hardCircle: "builtin-brush-hard-circle",
	softCircle: "builtin-brush-soft-circle",
	pencil: "builtin-brush-pencil",
	airbrush: "builtin-brush-airbrush",
	calligraphy: "builtin-brush-calligraphy",
} as const;

export type BuiltinBrushId =
	(typeof BUILTIN_BRUSH_IDS)[keyof typeof BUILTIN_BRUSH_IDS];

/** Built-in paper grain textures (GrainConfig.source), seeded alongside the
 *  brush textures so a fresh document can use them without an import. */
export const BUILTIN_PAPER_IDS = {
	finePaper: "builtin-paper-fine",
	coarsePaper: "builtin-paper-coarse",
} as const;

// Stamp rotation mode
// - none: No rotation (fixed at 0)
// - tangent: Rotate along path tangent direction
// - random: Random rotation per stamp instance
export type StampRotation = "none" | "tangent" | "random";

/**
 * Brush texture color processing mode.
 * - tinting: Use texture luminance as alpha, apply brush color (existing behavior)
 * - color: Use texture RGB as-is, texture alpha controls transparency
 */
export type BrushColorMode = "tinting" | "color";

export type LineCap = "butt" | "round" | "square";
export type LineJoin = "miter" | "round" | "bevel";

/**
 * SVG stroke geometry settings.
 * Only effective when the brush is SVG (textureFileUid === BUILTIN_BRUSH_IDS.svg).
 * Ignored for stamp-based brushes.
 */
export interface BrushStroking {
	lineCap: LineCap;
	lineJoin: LineJoin;
	miterLimit: number;
	dashArray?: readonly number[];
	dashOffset?: number;
}

/** Brush art source: raster (EmbeddedFile UID) or vector (defs entry, wired in a later step). */
export type BrushArtSource =
	| { kind: "file"; fileUid: string }
	| { kind: "def"; defId: string };

/**
 * Small edits callers make without holding the whole brush: the base size,
 * the taper, the dash, and swapping the tip's texture. Everything with a
 * curve behind it goes through a complete BrushSettings instead.
 */
export type BrushSettingsPatch = {
	size?: number;
	taperStart?: number;
	taperEnd?: number;
	stroking?: BrushStroking;
	/** Replaces the tip's own texture, keeping its variants. */
	tipSource?: BrushArtSource;
	colorMode?: BrushColorMode;
};

/** Whether a brush uses geometric stroke expansion instead of stamp-based rendering. */
export function isGeometricBrush(settings: BrushSettings): boolean {
	return settings.engine === "geometric";
}

export type BrushPresetCategory =
	| "pen"
	| "airbrush"
	| "watercolor"
	| "calligraphy"
	| "effect";

export interface BrushPreset {
	uid: string;
	name: string;
	/** Optional shelf grouping for builtin presets. */
	category?: BrushPresetCategory;
	/** Brush settings applied when selecting this preset */
	settings: BrushSettings;
}

/** Document-level reusable appearance stack. Holds only concrete filters (no nested refs). */
export interface AppearancePreset {
	uid: string;
	name: string;
	filters: Filter[];
}

// --- Brush Engine v2 Types ---

/**
 * Inputs of the brush curve matrix. All values are normalized to 0..1 before
 * curve evaluation (angular inputs are wrapped into 0..1; accel is computed
 * once per dab by the CPU input sampler and shared with the dab layout).
 */
export type BrushInputId =
	| "pressure"
	| "speedFine"
	| "speedGross"
	| "accel"
	| "tiltMagnitude"
	| "tiltAzimuth"
	| "twist"
	| "direction"
	| "strokeT"
	| "fade"
	| "distance"
	| "randomPerDab"
	| "randomPerStroke";

/** Curve-modulatable brush properties. Domains/ranges live in brush/properties.ts. */
export type BrushPropertyId =
	| "size"
	| "ratio"
	| "angle"
	| "flow"
	| "spacing"
	| "scatterOffset"
	| "scatterAlong"
	| "hueShift"
	| "satShift"
	| "valShift"
	| "grainStrength"
	| "hardness"
	| "colorRate"
	| "alphaRate"
	| "smudgeLength"
	| "dabsPerSecond"
	| "wetness"
	| "directionality"
	| "grainAmount"
	| "absorption"
	| "granulation"
	| "bleedSoftness"
	| "edgeDarkening"
	| "edgeRoughness";

/** One input-to-property connection: a piecewise linear curve (max 16 points). */
export interface BrushCurve {
	input: BrushInputId;
	points: [number, number][];
}

/** Base value plus optional modulation curves. Evaluation: brush/curves.ts. */
export interface BrushPropertyConfig {
	base: number;
	curves?: BrushCurve[];
}

export type BrushEngineKind = "dab" | "ribbon" | "geometric";

export type BrushTipConfig =
	| {
			kind: "procedural";
			/** Falloff hardness 0..1 (2-segment MyPaint falloff baked into a LUT). */
			hardness: number;
			/** Optional custom falloff curve (Krita curve-circle style). */
			softnessCurve?: [number, number][];
			angleMode: "fixed" | "tangent";
	  }
	| {
			kind: "image";
			sources: BrushArtSource[];
			selection: "sequence" | "random";
			startSource?: BrushArtSource;
			endSource?: BrushArtSource;
			angleMode: "fixed" | "tangent";
	  };

/** Ribbon engine (art/pattern) configuration. */
export interface RibbonConfig {
	source: BrushArtSource;
	uvMode: "repeat" | "stretch";
	tileScale: number;
	tileSpacing: number;
	uvOffset?: number;
	flipU?: boolean;
	flipV?: boolean;
}

/** Paper grain applied per dab with canvas-locked UVs. */
export interface GrainConfig {
	source: BrushArtSource;
	/** Grain UV scale in world units. */
	scale: number;
	mode: "multiply" | "subtract";
	randomOffsetPerStroke: boolean;
}

/** CSP-style watercolor edge. Stroke-level; ignored while wet.enabled (exclusive). */
export interface WetEdgeConfig {
	width: number;
	intensity: number;
	darkening: number;
	blur: number;
}

/**
 * Color mixing (dulling sample). Enablement is the explicit boolean only —
 * presence of this object does NOT enable mixing. Modulatable bases
 * (colorRate/alphaRate/smudgeLength) live in `properties`.
 */
export interface MixingConfig {
	enabled: boolean;
	mode: "dulling";
	sampleRadius: number;
	/** Sample position trail along stroke direction (-2..2, forward positive). */
	sampleTrail: number;
	/** 0 = vivid (OkLCH), 1 = muted (OkLAB). */
	blendStyle: number;
}

/**
 * Wet layer stroke-level config. The 8 modulatable wet parameters live in
 * `properties`; `enabled` is the only activation gate (never inferred from
 * property values or curves).
 */
export interface WetConfig {
	enabled: boolean;
	/** Bleed radius as a ratio of size. Decides the sim domain allocation. */
	bleedRadius: number;
	/** Pigment density to visible alpha conversion strength (composite time). */
	pigmentLoad: number;
	/** Grain noise UV frequency in world units. */
	grainScale: number;
	/** How far each texel's pigment is displaced when the layer is composited,
	 *  as a ratio of the brush radius. Shuffling texels is what scatters the
	 *  paint into grain; moving whole dabs cannot. */
	scatter?: number;
}

/**
 * Backdrop blur stroke-level config. The stroke's dab coverage masks a
 * Gaussian blur of the composite below it; the brush lays down no colour.
 * `enabled` is the only activation gate.
 */
export interface BackdropBlurConfig {
	enabled: boolean;
	/** Blur radius as a ratio of the brush size. */
	radius: number;
}

/**
 * Non-modulated settings that feed input computation itself. These must not
 * be curve targets (a speed curve wired into speedRef would recurse).
 * Undefined fields mean "auto/engine default"; speedRef auto derives from
 * brushSize via the current clamp(size*0.06, 0.5, 2.0) formula.
 */
export interface InputDynamicsConfig {
	speedRef?: number;
	speedFineTau?: number;
	speedGrossTau?: number;
	directionFilter?: number;
}

/**
 * Brush settings v2: curve-matrix based engine settings. See
 * .claude/memos/new-brush-engine.md for the full design.
 */
export interface BrushSettings {
	version: 2;
	engine: BrushEngineKind;
	/** Stroke-level opacity cap (wash composite). Base value only, no curves. */
	strokeOpacity: number;
	paintMode: "buildup" | "wash";
	properties: Partial<Record<BrushPropertyId, BrushPropertyConfig>>;
	/** Dab engine tip. Absent for ribbon/geometric engines. */
	tip?: BrushTipConfig;
	ribbon?: RibbonConfig;
	stroking?: BrushStroking;
	grain?: GrainConfig;
	wetEdge?: WetEdgeConfig;
	mixing?: MixingConfig;
	wet?: WetConfig;
	backdropBlur?: BackdropBlurConfig;
	inputDynamics?: InputDynamicsConfig;
	randomSeed: number;
	taperStart?: number;
	taperEnd?: number;
	colorMode?: BrushColorMode;
}

// --- Artboard Types ---

export interface Artboard {
	id: string;
	name: string;
	/** Center X position in world coordinates */
	x: number;
	/** Center Y position in world coordinates */
	y: number;
	/** Width in world units */
	width: number;
	/** Height in world units */
	height: number;
	/** Background color (default: white) */
	backgroundColor?: RGBColor;
}

// --- Utility Functions ---

/**
 * Generate entity id
 * @param prefix id prefix (auto `-` suffixing)
 */
export function generateUid(prefix?: string, size: number = 30) {
	const id = nanoid(size);
	prefix = prefix ? `${prefix}-` : "";
	return `${prefix}${id}`;
}

/**
 * Get bounding box for an artboard
 */
export function getArtboardBounds(artboard: Artboard): BoundingBox {
	const halfW = artboard.width / 2;
	const halfH = artboard.height / 2;
	return {
		minX: artboard.x - halfW,
		minY: artboard.y - halfH,
		maxX: artboard.x + halfW,
		maxY: artboard.y + halfH,
		width: artboard.width,
		height: artboard.height,
	};
}

// --- Type Guards ---

export function isPath(element: AnyArtObject): element is Path {
	return element.type === "path";
}

export function isGroup(element: AnyArtObject): element is Group {
	return element.type === "group";
}

export function hasGroupAppearances(group: Group): boolean {
	return (
		group.filters?.some(
			(f) =>
				!isAppearancePresetRef(f) &&
				(f.processor === "fill" || f.processor === "stroke") &&
				f.enabled !== false,
		) ?? false
	);
}

export function isCompoundPath(element: AnyArtObject): element is CompoundPath {
	return element.type === "compound-path";
}

export function isBlend(element: AnyArtObject): element is BlendObject {
	return element.type === "blend";
}

export function isRepeat(element: AnyArtObject): element is RepeatObject {
	return element.type === "repeat";
}

/** Type guard for container elements that hold child element IDs (Group, CompoundPath, Blend, Repeat, or Mesh). */
export function isContainer(
	element: AnyArtObject,
): element is
	| Group
	| CompoundPath
	| BlendObject
	| RepeatObject
	| MeshArtObject {
	return (
		element.type === "group" ||
		element.type === "compound-path" ||
		element.type === "blend" ||
		element.type === "repeat" ||
		element.type === "mesh"
	);
}

/** Return the child element IDs for a container, or null for non-containers. */
/**
 * Returns the IDs of child elements held by a container-like entity, or null if
 * the input is not a container. Accepts ArtObjects (group / compound-path /
 * blend) and DefEntry (rootElementIds). Centralizing this lets SpatialIndex /
 * GC / change-delta route def-internal elements through the same parent-mapping
 * code path as Blend.
 */
export function getContainerChildIds(
	element: AnyArtObject | DefEntry,
): string[] | null {
	// DefEntry has no `type` field; detect by presence of rootElementIds.
	if ("rootElementIds" in element) return element.rootElementIds;
	if (isGroup(element)) return element.childIds;
	if (isCompoundPath(element)) return element.sources.map((s) => s.id);
	if (isBlend(element)) {
		return element.spineSourceId
			? [...element.objectIds, element.spineSourceId]
			: element.objectIds;
	}
	if (isRepeat(element)) return element.sourceIds;
	if (isMesh(element)) return element.childIds;
	return null;
}

export function isText(element: AnyArtObject): element is TextElement {
	return element.type === "text";
}

export function isMesh(element: AnyArtObject): element is MeshArtObject {
	return element.type === "mesh";
}

export function isReference3D(
	element: AnyArtObject,
): element is Reference3DElement {
	return element.type === "reference3d";
}

// --- FillColor type guards ---

export function isSolidColor(fill: FillColor): fill is SolidColor {
	return fill.type === "solid";
}

export function isLinearGradient(fill: FillColor): fill is LinearGradient {
	return fill.type === "linear";
}

export function isRadialGradient(fill: FillColor): fill is RadialGradient {
	return fill.type === "radial";
}

export function isFreeGradient(fill: FillColor): fill is FreeGradient {
	return fill.type === "free";
}

export function isMeshGradient(fill: FillColor): fill is MeshGradient {
	return fill.type === "mesh";
}

/**
 * Whether a fill appearance contributes any visible pixels: enabled, has
 * appearance opacity, and its color is not fully transparent. Pattern fills
 * are treated as visible (their pixels are not statically known).
 */
export function isVisibleFill(appearance: FillAppearance): boolean {
	if (appearance.enabled === false) return false;
	if (appearance.opacity <= 0) return false;

	const fill = appearance.paramData.params.fill;
	switch (fill.type) {
		case "solid":
			return colorToRawRGBA(fill.color).a > 0;
		case "linear":
		case "radial":
			return fill.stops.some((s) => colorToRawRGBA(s.color).a > 0);
		case "free":
			return fill.stops.some((s) => colorToRawRGBA(s.color).a > 0);
		case "mesh":
			return fill.vertices.some((v) => colorToRawRGBA(v.color).a > 0);
		case "pattern":
			return true;
	}
}
