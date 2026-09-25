import type {
	AnyArtObject,
	BoundingBox,
	Document,
	RawRGBA,
	Viewport,
} from "../schema";
import type { WorldBoundsCache } from "../utils/geometry/bounds";
import type { RenderStrategy } from "./RenderOrchestrator";
import type { OverlayKey } from "./ui/overlayKeys";
import type { UIOverlay } from "./ui/primitives";

/**
 * HDR PQ encoding constants shared by the exposure shader and AVIF exporter.
 * Changing one without the other breaks Canvas↔AVIF color matching.
 */
/** BT.2408 reference white in cd/m². PQ signal 0.58 = this luminance. */
export const HDR_MAX_NITS = 203;
/** Maximum linear value as a multiple of SDR white (1600 nits / 203 nits).
 *  Covers MacBook Pro XDR peak brightness. */
export const HDR_EDR_HEADROOM = 1600 / HDR_MAX_NITS;

/**
 * A transient (frame-only) element rendered within a layer.
 * Entries with `topLevel: false` are resolvable by ID (e.g. children of a
 * preview clone group) but are not appended to the layer's top-level
 * element list.
 */
export interface TransientElementEntry {
	layerId: string;
	element: AnyArtObject;
	topLevel?: boolean;
}

/**
 * Engine-side tool session info surfaced to React overlays (single slot).
 * Currently only the mesh-deform hint uses it; extend the union per tool.
 */
export type ToolSession = {
	type: "mesh-deform";
	originalBounds: BoundingBox;
	handleCount: number;
};

/**
 * Element-granularity document changes accumulated since a frame's previous
 * render. Added and updated elements share `upserted` (consumers re-process
 * both the same way); removed ids are separated for pruning.
 */
export interface ChangedElements {
	upserted: ReadonlySet<string>;
	deleted: ReadonlySet<string>;
}

/** Core rendering parameters for a single frame. */
export interface FrameRequest {
	viewport: Viewport;
	document: Document;
	strategy: RenderStrategy;
	/**
	 * Document-content changes since this target's previous frame, when the
	 * dirty pipeline could track them. `undefined` means tracking was lost
	 * (full document sync, device restore, …) and EVERY element may have
	 * changed; empty sets mean the document content itself is unchanged
	 * (viewport/overlay-only frames). Non-content dirt (pan/zoom, previews,
	 * selection) never affects this set.
	 */
	changedElements?: ChangedElements;
	getDefRevision?: (defId: string) => number;
	/** Monotonic def-generation counter (DefIndex.getGlobalRevision). Changes
	 *  when any shared def edit alters pixels without a per-element document
	 *  delta — the tile cache watches it to invalidate def-sourced tiles that
	 *  changedElements alone would miss. */
	defRevision?: number;
	boundsCache?: WorldBoundsCache;
	editingScopeStack?: string[];
	/** Element rendered at full opacity while the rest of the document is
	 *  dimmed (Reference3D edit isolation — same look as group editing). */
	isolatedElementId?: string | null;
	/** Transient overrides for existing elements (keyed by element ID).
	 *  Replaces the corresponding entry in document.objects for this frame only. */
	elementOverrides?: ReadonlyMap<string, AnyArtObject>;
	/** Transient new elements to render within specific layers.
	 *  Appended to the layer's element list for this frame only. */
	transientElements?: ReadonlyMap<string, TransientElementEntry>;
	/** Disable viewport culling (for export/offscreen rendering where
	 *  transforms may place elements inside target bounds post-transform). */
	disableViewportCulling?: boolean;
	/** Render only elements with these IDs (for clipboard export). */
	elementFilter?: ReadonlySet<string>;
	/** True while rendering to an image export. Reference3D elements not flagged
	 *  `includeInExport` are skipped (drafts stay out of the output). */
	isExport?: boolean;
	/** Override the clear color instead of deriving it from artboards. */
	clearColorOverride?: RawRGBA;
	/** Paint artboard backgrounds even when clearColorOverride is set (raster
	 *  analysis renders that need artboard edges to act as color barriers). */
	paintArtboardBackgrounds?: boolean;
	/** HDR exposure in EV stops. When defined (even 0), the HDR post-process
	 *  pass runs (sRGB linearize → PQ roundtrip → sRGB re-encode).
	 *  undefined = HDR disabled, skip the pass entirely. */
	hdrExposure?: number;
	/** Apply the soft proof 3D LUT (CMYK print simulation) as the final
	 *  display pass. No-op while no LUT is uploaded. Mutually exclusive with
	 *  hdrExposure — if both are set, exposure wins and proof is skipped. */
	softProof?: boolean;
	/** True while the user is actively panning/zooming. Tile rendering bakes
	 *  at a reduced budget during interaction and fully at settle. When unset,
	 *  the renderer derives it from the frame strategy (fullInteraction). */
	interacting?: boolean;
}

/** UI overlay state passed to UILayer for rendering tool-specific overlays. */
export interface UIOverlayState {
	isArtboardEditMode?: boolean;
	/**
	 * Generic overlay channel keyed by the central `OVERLAY_KEYS` registry.
	 * Values are stored with valtio `ref()` and treated as immutable — replace
	 * whole entries, never mutate in place (dev builds freeze stored overlays).
	 */
	overlays?: Partial<Record<OverlayKey, UIOverlay>>;
}
