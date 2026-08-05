import {
	BUCKET_FILL_LEAK_HIT_PREFIX,
	buildBucketFillOverlay,
} from "../renderer/ui/builders/bucketFill";
import { OVERLAY_KEYS } from "../renderer/ui/overlayKeys";
import { OVERLAY_Z, UI_THEME } from "../renderer/ui/theme";
import type { BucketFillUIData } from "../renderer/ui/types";
import {
	type BoundingBox,
	type FillAppearance,
	type FillColor,
	generateUid,
	getArtboardBounds,
	type Path,
	type PathSegment,
	type Viewport,
} from "../schema";
import { screenToWorld } from "../utils/geometry/geometry";
import {
	buildAlphaMap,
	buildCutMask,
	buildGapDistanceMap,
	floodFill,
	gapClosingFloodFill,
	type SeedColor,
	sampleSeedColor,
} from "./bucketFill/fill";
import {
	findLeaks,
	findSpillLeaks,
	type LeakPoint,
} from "./bucketFill/leakDetection";
import { computeMaskBounds, maskToPath } from "./bucketFill/maskToPath";
import {
	expandRegion,
	type FillRasterSpace,
	inflateRegion,
	maskTouchedEdges,
	unionRegion,
	type WorldRegion,
	worldToRaster,
} from "./bucketFill/rasterSpace";
import type { PointerEventData, Tool } from "./Tool";
import type { ToolContext } from "./ToolContext";

// --- Types ---

interface BucketFillToolOptions {
	tolerance?: number;
	/** Pixel radius for gap closing. Dilates opaque barriers before flood
	 *  fill so that small gaps in line art are treated as closed. 0 = disabled. */
	gapClosing?: number;
}

interface FillArea {
	id: string;
	/** Seed point in world coordinates. */
	seedWorld: { x: number; y: number };
	/** Viewport zoom when the area was created. Converts px-based settings
	 *  (gap closing radius, cut stroke width) to world units so they stay
	 *  consistent across raster scales, and caps the exploration raster
	 *  resolution. */
	zoomAtCreation: number;
	/** Seed-centered initial window (viewport-sized world AABB at creation);
	 *  the expanding-window search starts here on every (re)compute. */
	window0: WorldRegion;
	cutPaths: Array<Array<{ x: number; y: number }>>;
	/** Seed color fixed at the first successful sample so re-fills on a
	 *  re-rendered raster stay consistent. */
	seedColor: SeedColor | null;
	/** Bumped on every compute request; stale async runs check it after each
	 *  await and drop their results. */
	computeGeneration: number;
	mask: Uint8Array | null;
	/** Raster space of the last successful fill (indexes {@link mask}). */
	space: FillRasterSpace | null;
	cachedPath: Path | null;
	cachedBounds: BoundingBox | null;
	/** Set when the last compute found the fill leaking: where it leaks, plus
	 *  a virtually-sealed fill mask for the "seal and fill" action. For an
	 *  unbounded fill the area has no mask; a spill (bounded fill that flooded
	 *  an artboard background through a gap) keeps its mask and preview. */
	leakState: {
		leaks: LeakPoint[];
		noBarriers: boolean;
		/** True for the bounded artboard-spill case (mask/preview kept). */
		spill: boolean;
		sealedMask: Uint8Array | null;
		sealedSpace: FillRasterSpace | null;
		/** Raster the sealed mask was computed on; lets the seal-and-fill
		 *  commit vectorize with sub-pixel colour information. */
		sealedImageData: ImageData | null;
	} | null;
}

interface FillOnRegionResult {
	mask: Uint8Array;
	space: FillRasterSpace;
	imageData: ImageData;
	cutMask: Uint8Array | null;
	/** Alpha map built for the gap-closing fill; null when the plain flood
	 *  fill ran. Leak/spill analysis reuses (and may mutate) it instead of
	 *  rebuilding the same map — each result feeds at most one analysis. */
	alphaMap: Uint8Array | null;
}

type DragState =
	| { mode: "idle" }
	| {
			mode: "pending";
			downScreenX: number;
			downScreenY: number;
			targetAreaId: string | null;
			hitExisting: boolean;
	  }
	| {
			mode: "cutting";
			targetAreaId: string;
			points: Array<{ x: number; y: number }>;
	  };

/** Cut stroke width in screen px at area creation zoom. */
const CUT_STROKE_SCREEN_WIDTH = 2;

/** Raster budget (max texture dimension) for the expanding-window search. */
const EXPLORE_RASTER_BUDGET = 2048;

/** Raster budget for the final quality pass over the tight result bbox. */
const FINAL_RASTER_BUDGET = 4096;

/** Window doubling iterations; 2^8 covers any realistic document extent. */
const MAX_EXPAND_ITERATIONS = 8;

/** Run the final pass only when it gains at least this scale factor. */
const FINAL_PASS_MIN_GAIN = 1.25;

/** World-space margin around the result bbox, in exploration-raster px. */
const FINAL_PASS_MARGIN_PX = 8;

/** On-screen size the gap should span after a leak-marker click zoom. */
const LEAK_ZOOM_TARGET_PX = 48;

/** Raster inset of the artboard-edge band used for spill detection. */
const ARTBOARD_EDGE_INSET_PX = 2;

/** Preview fill color for uncommitted areas. */
const PREVIEW_FILL: FillColor = {
	type: "solid",
	color: { type: "rgb", r: 0.23, g: 0.51, b: 0.96, a: 0.35 },
};

// --- BucketFillTool ---

/**
 * Bucket fill tool that creates filled Path elements from flood-filled regions
 * on the rendered canvas.
 *
 * ## Basic usage
 * 1. **Click** on the canvas to flood-fill the area under the cursor.
 *    A semi-transparent blue preview overlay appears immediately.
 * 2. **Click again on an existing fill area** to deselect (remove) it.
 * 3. Call {@link confirmFill} with the desired fill color to commit all
 *    previewed areas as Path elements. Each area becomes one Path.
 * 4. Call {@link onCancel} to discard all fill areas without creating any
 *    element.
 *
 * ## Multiple fill areas
 * Multiple areas can be created in a single session by clicking different
 * regions before confirming. All areas are committed together by
 * {@link confirmFill}.
 *
 * ## Cut paths (drag to subtract)
 * After a fill area has been created, drag across it to draw a freehand
 * **cut path**. The stroke is rasterized into a barrier mask that prevents
 * the flood fill from crossing it, effectively splitting or trimming the
 * filled region. Multiple cut paths can be drawn on the same area.
 * The area is recomputed every time a cut path is completed (pointer up).
 *
 * ## Flood fill algorithm (document-wide expanding window)
 * - Renders a seed-centered, viewport-sized world region offscreen via
 *   {@link ToolContext.renderWorldRegionToImageData} and flood fills it with
 *   a queue-based 4-directional fill (RGBA distance vs `tolerance`).
 * - When the filled mask touches a raster edge, the window grows toward the
 *   touched edges (doubling per pass) and the fill reruns, clamped to the
 *   document content bounds plus a margin — so closedness is judged against
 *   the whole document, not just the visible viewport.
 * - If the fill still reaches the edge of the maximum window, the region is
 *   unbounded (not enclosed by anything) and no fill is produced.
 * - Bounded results are re-filled once over their tight bbox at a higher
 *   resolution when that meaningfully improves quality.
 * - The resulting pixel mask is converted to a closed Path via marching
 *   squares contour extraction followed by corner-preserving cubic bezier
 *   fitting (see `bucketFill/maskToPath.ts`).
 *
 * ## Selection handling
 * When the tool is constructed, the current element selection is saved and
 * immediately cleared. This prevents the fill color picker (shown while the
 * tool is active) from accidentally modifying the fill of already-selected
 * elements instead of the new fill area. On cancel the original selection is
 * restored. On confirm, the newly created paths are selected.
 */
export class BucketFillTool implements Tool {
	public readonly name = "bucket-fill";

	private fillAreas: FillArea[] = [];
	private dragState: DragState = { mode: "idle" };
	private savedSelection: string[] = [];
	private inFlightComputes = 0;

	public tolerance: number;
	public gapClosing: number;

	public constructor(
		private readonly context: ToolContext,
		options: BucketFillToolOptions = {},
	) {
		this.tolerance = options.tolerance ?? 30;
		this.gapClosing = options.gapClosing ?? 0;
		this.savedSelection = context.getSelectedElementIds();
		context.selectionClear();
	}

	public onPointerDown(
		event: PointerEventData,
		viewport: Viewport,
		canvasWidth: number,
		canvasHeight: number,
	): void {
		// Clicking a leak marker jumps the view to the gap (and keeps the
		// markers visible).
		const hit = this.context.uiHitTest({ x: event.x, y: event.y });
		if (hit?.hitId.startsWith(BUCKET_FILL_LEAK_HIT_PREFIX)) {
			const index = Number(hit.hitId.slice(BUCKET_FILL_LEAK_HIT_PREFIX.length));
			const leak = this.fillAreas.flatMap((a) => a.leakState?.leaks ?? [])[
				index
			];
			if (leak) {
				const targetZoom = Math.min(
					Math.max(
						viewport.zoom,
						LEAK_ZOOM_TARGET_PX / Math.max(leak.gapWidthWorld, 1e-3),
					),
					this.context.getMaxZoomScale(),
				);
				this.context.panToWorldPoint({ x: leak.x, y: leak.y }, targetZoom);
				return;
			}
		}

		// Any new interaction dismisses leak markers from a previous compute.
		// Unbounded areas have nothing to keep; spill areas keep their fill.
		if (this.fillAreas.some((a) => a.leakState)) {
			this.fillAreas = this.fillAreas.filter(
				(a) => a.leakState === null || a.mask !== null,
			);
			for (const a of this.fillAreas) {
				a.leakState = null;
			}
			this.publishLeakState();
			this.refreshPreview();
		}

		const clickWorld = screenToWorld(
			event.x,
			event.y,
			viewport,
			canvasWidth,
			canvasHeight,
		);

		const hitArea = this.fillAreas.find((a) => {
			if (!a.mask || !a.space) return false;
			const px = worldToRaster(a.space, clickWorld.x, clickWorld.y);
			const ix = Math.round(px.x);
			const iy = Math.round(px.y);
			if (ix < 0 || ix >= a.space.width || iy < 0 || iy >= a.space.height)
				return false;
			return a.mask[iy * a.space.width + ix] === 1;
		});

		this.dragState = {
			mode: "pending",
			downScreenX: event.x,
			downScreenY: event.y,
			targetAreaId: hitArea?.id ?? this.fillAreas.at(-1)?.id ?? null,
			hitExisting: hitArea != null,
		};
	}

	public onPointerMove(
		event: PointerEventData,
		viewport: Viewport,
		canvasWidth: number,
		canvasHeight: number,
	): void {
		if (this.dragState.mode === "idle") return;

		if (this.dragState.mode === "pending") {
			const dx = event.x - this.dragState.downScreenX;
			const dy = event.y - this.dragState.downScreenY;
			if (dx * dx + dy * dy < 16) return;

			if (this.dragState.targetAreaId === null) {
				this.dragState = { mode: "idle" };
				return;
			}

			this.dragState = {
				mode: "cutting",
				targetAreaId: this.dragState.targetAreaId,
				points: [
					screenToWorld(event.x, event.y, viewport, canvasWidth, canvasHeight),
				],
			};
			this.context.requestRender("cursor");
			return;
		}

		if (this.dragState.mode === "cutting") {
			this.dragState.points.push(
				screenToWorld(event.x, event.y, viewport, canvasWidth, canvasHeight),
			);
			const allCutPaths = this.fillAreas.flatMap((a) => a.cutPaths);
			this.updateBucketFillOverlay({
				cutPaths: allCutPaths,
				// Copy: the overlay is stored as a frozen snapshot (dev deep-freeze),
				// so passing the live points array would freeze it and make the
				// next onPointerMove push throw "object is not extensible".
				activeCutPath: [...this.dragState.points],
				gapBarrierSegments: [],
			});
			this.context.requestRender("cursor");
		}
	}

	public onPointerUp(
		_event: PointerEventData,
		viewport: Viewport,
		canvasWidth: number,
		canvasHeight: number,
	): void {
		if (this.dragState.mode === "pending") {
			// No drag — treat as a plain click
			if (this.dragState.hitExisting) {
				// Click on existing area: remove it
				const { targetAreaId } = this.dragState;
				this.fillAreas = this.fillAreas.filter((a) => a.id !== targetAreaId);
				this.refreshPreview();
			} else {
				// Click on empty space: create a new fill area
				const seedWorld = screenToWorld(
					this.dragState.downScreenX,
					this.dragState.downScreenY,
					viewport,
					canvasWidth,
					canvasHeight,
				);
				const newArea: FillArea = {
					id: generateUid("obj"),
					seedWorld,
					zoomAtCreation: viewport.zoom,
					window0: seedWindowRegion(
						seedWorld,
						viewport,
						canvasWidth,
						canvasHeight,
					),
					cutPaths: [],
					seedColor: null,
					computeGeneration: 0,
					mask: null,
					space: null,
					cachedPath: null,
					cachedBounds: null,
					leakState: null,
				};
				this.fillAreas.push(newArea);
				this.computeAndPreviewArea(newArea).catch((err) => {
					console.error("[BucketFillTool] computeAndPreviewArea failed:", err);
				});
			}
		} else if (
			this.dragState.mode === "cutting" &&
			this.dragState.points.length > 2
		) {
			const { targetAreaId } = this.dragState;
			const area = this.fillAreas.find((a) => a.id === targetAreaId);
			if (area) {
				area.cutPaths.push([...this.dragState.points]);
				this.computeAndPreviewArea(area).catch((err) => {
					console.error(
						"[BucketFillTool] computeAndPreviewArea after cut failed:",
						err,
					);
				});
			}
		}
		this.dragState = { mode: "idle" };
	}

	public onCancel(): void {
		this.context.previewUpdate(null);
		this.updateBucketFillOverlay(null);
		this.fillAreas = [];
		this.dragState = { mode: "idle" };
		this.publishLeakState();
		this.restoreSelection();
	}

	public saveInterruptibleState(): unknown {
		return {
			fillAreas: this.fillAreas,
			savedSelection: this.savedSelection,
		};
	}

	public restoreFromInterrupt(state: unknown): void {
		const s = state as {
			fillAreas: FillArea[];
			savedSelection: string[];
		};
		this.fillAreas = s.fillAreas;
		this.savedSelection = s.savedSelection;
		// onCancel restored the pre-tool selection; clear it again so the fill
		// color picker keeps targeting the revived fill session (see the
		// "Selection handling" note above).
		this.context.selectionClear();
		this.refreshPreview();
		this.publishLeakState();
	}

	/** Recompute all existing fill areas (e.g. after gapClosing changes). */
	public recomputeAllAreas(): void {
		for (const area of this.fillAreas) {
			this.computeAndPreviewArea(area).catch((err) => {
				console.error("[BucketFillTool] recomputeAllAreas failed:", err);
			});
		}
	}

	public getCursor(): string {
		return "crosshair";
	}

	public confirmFill(fillColor: FillColor): void {
		const paths = this.collectCommitPaths(fillColor, false);
		this.resetSession();
		this.commitPaths(paths);
	}

	/**
	 * Commit the fills with their detected leaks virtually sealed (the
	 * "seal gaps and fill" action). Leaky areas use the sealed mask leak
	 * detection produced; ordinary bounded areas commit as-is.
	 */
	public confirmSealedFill(fillColor: FillColor): void {
		const paths = this.collectCommitPaths(fillColor, true);
		this.resetSession();
		this.commitPaths(paths);
	}

	/** Build the paths a confirm action commits. With `useSealed`, areas with
	 *  a sealed leak mask commit that mask instead of their (leaky) fill. */
	private collectCommitPaths(fillColor: FillColor, useSealed: boolean): Path[] {
		return this.fillAreas.flatMap((a) => {
			if (useSealed && a.leakState?.sealedMask && a.leakState.sealedSpace) {
				const path = maskToPath(
					a.leakState.sealedMask,
					a.leakState.sealedSpace,
					fillColor,
					a.leakState.sealedImageData && a.seedColor
						? {
								imageData: a.leakState.sealedImageData,
								seedColor: a.seedColor,
								tolerance: this.tolerance,
							}
						: undefined,
				);
				return path ? [path] : [];
			}

			if (!a.cachedPath) return [];

			// Update FillAppearance in filters with the confirmed fill color
			const updatedFilters = (a.cachedPath.filters ?? []).map((f) => {
				if (f.processor === "fill") {
					return {
						...f,
						paramData: {
							...f.paramData,
							params: { fill: fillColor },
						},
					} as FillAppearance;
				}
				return f;
			});

			return [
				{ ...a.cachedPath, id: generateUid("app"), filters: updatedFilters },
			];
		});
	}

	/** Clear all session state (areas, previews, overlays, leak display). */
	private resetSession(): void {
		this.context.previewUpdate(null);
		this.updateBucketFillOverlay(null);
		this.fillAreas = [];
		this.dragState = { mode: "idle" };
		this.publishLeakState();
	}

	private commitPaths(paths: Path[]): void {
		if (paths.length === 0) return;
		this.context.addPaths(paths);
		for (let i = 0; i < paths.length; i++) {
			const bounds = this.context.getBounds(paths[i].id);
			if (!bounds) continue;
			if (i === 0) {
				this.context.elementSelect(paths[i].id, bounds);
			} else {
				this.context.elementToggleSelect(paths[i].id, bounds);
			}
		}
	}

	private restoreSelection(): void {
		if (this.savedSelection.length === 0) return;
		for (let i = 0; i < this.savedSelection.length; i++) {
			const bounds = this.context.getBounds(this.savedSelection[i]);
			if (!bounds) continue;
			if (i === 0) {
				this.context.elementSelect(this.savedSelection[i], bounds);
			} else {
				this.context.elementToggleSelect(this.savedSelection[i], bounds);
			}
		}
	}

	private async computeAndPreviewArea(area: FillArea): Promise<void> {
		this.inFlightComputes++;
		this.context.setBucketFillComputing(true);
		try {
			await this.computeAndPreviewAreaBody(area);
		} finally {
			if (--this.inFlightComputes === 0) {
				this.context.setBucketFillComputing(false);
			}
		}
	}

	private async computeAndPreviewAreaBody(area: FillArea): Promise<void> {
		const gen = ++area.computeGeneration;
		const docBounds = this.context.getDocumentContentBounds();
		const budget = Math.min(
			EXPLORE_RASTER_BUDGET,
			this.context.getMaxRasterDimension(),
		);

		// Maximum search window: document content + margin. Union with window0
		// so a seed outside the document bounds still lands inside the raster.
		const maxRegion = docBounds
			? unionRegion(
					inflateRegion(
						{
							centerX: docBounds.centerX,
							centerY: docBounds.centerY,
							worldWidth: docBounds.width,
							worldHeight: docBounds.height,
						},
						Math.max(64, 0.05 * Math.max(docBounds.width, docBounds.height)),
					),
					area.window0,
				)
			: area.window0;

		let region = area.window0;
		let bounded: FillOnRegionResult | null = null;
		let lastFilled: FillOnRegionResult | null = null;

		for (let iter = 0; iter < MAX_EXPAND_ITERATIONS; iter++) {
			const scale = Math.min(
				area.zoomAtCreation,
				budget / region.worldWidth,
				budget / region.worldHeight,
			);
			const filled = await this.fillOnRegion(area, region, scale);
			if (gen !== area.computeGeneration || !this.fillAreas.includes(area))
				return;
			if (!filled) return;
			lastFilled = filled;

			const touched = maskTouchedEdges(
				filled.mask,
				filled.space.width,
				filled.space.height,
			);
			if (!touched.left && !touched.right && !touched.top && !touched.bottom) {
				bounded = filled;
				break;
			}

			const next = expandRegion(region, touched, maxRegion);
			if (next === null) break; // escapes the maximum window → unbounded
			region = next;
		}

		if (!bounded) {
			this.markAreaUnbounded(area, lastFilled);
			return;
		}

		const refined = await this.refineFill(area, bounded);
		if (gen !== area.computeGeneration || !this.fillAreas.includes(area))
			return;
		const result = refined ?? bounded;

		area.mask = result.mask;
		area.space = result.space;
		area.cachedPath = maskToPath(
			result.mask,
			result.space,
			PREVIEW_FILL,
			area.seedColor
				? {
						imageData: result.imageData,
						seedColor: area.seedColor,
						tolerance: this.tolerance,
					}
				: undefined,
		);
		area.cachedBounds = computeMaskBounds(result.mask, result.space);
		// A bounded fill can still have leaked: a gap in a shape lets it flood
		// the artboard background around it. Detect and surface that spill.
		area.leakState = this.detectArtboardSpill(area, result);

		this.publishLeakState();
		this.refreshPreview();
	}

	/**
	 * The expanding-window search escaped the maximum window: locate the leaks
	 * on the last (largest) raster, keep the area in an unbounded state for
	 * marker display and the seal-and-fill action, and publish the state.
	 */
	private markAreaUnbounded(
		area: FillArea,
		lastFilled: FillOnRegionResult | null,
	): void {
		if (!lastFilled || !area.seedColor) {
			// Rendering never succeeded — nothing to analyze
			this.fillAreas = this.fillAreas.filter((a) => a !== area);
			this.publishLeakState();
			this.refreshPreview();
			return;
		}

		const { imageData, cutMask, space } = lastFilled;
		const fillable =
			lastFilled.alphaMap ??
			buildAlphaMap(imageData, area.seedColor, this.tolerance);
		if (cutMask) {
			for (let i = 0; i < fillable.length; i++) {
				if (cutMask[i] === 1) fillable[i] = 0;
			}
		}
		const seedPx = worldToRaster(space, area.seedWorld.x, area.seedWorld.y);
		const result = findLeaks({
			fillable,
			width: space.width,
			height: space.height,
			seedX: Math.round(seedPx.x),
			seedY: Math.round(seedPx.y),
			space,
		});

		area.mask = null;
		area.space = null;
		area.cachedPath = null;
		area.cachedBounds = null;
		area.leakState = {
			leaks: result.leaks,
			noBarriers: result.noBarriers,
			spill: false,
			sealedMask: result.sealedMask,
			sealedSpace: result.sealedMask ? space : null,
			sealedImageData: result.sealedMask ? imageData : null,
		};

		this.publishLeakState();
		this.refreshPreview();
	}

	/**
	 * Detect a bounded fill that flooded an artboard background: the mask
	 * reaches an artboard's edge, and the seed connects to the wide background
	 * only through a passage decisively narrower than that area's clearance.
	 * Returns the leak display state, or null for an intentional fill.
	 */
	private detectArtboardSpill(
		area: FillArea,
		result: FillOnRegionResult,
	): FillArea["leakState"] {
		if (!area.seedColor) return null;
		if (!this.maskTouchesArtboardEdge(result.mask, result.space)) return null;

		const { imageData, cutMask, space } = result;
		const fillable =
			result.alphaMap ??
			buildAlphaMap(imageData, area.seedColor, this.tolerance);
		if (cutMask) {
			for (let i = 0; i < fillable.length; i++) {
				if (cutMask[i] === 1) fillable[i] = 0;
			}
		}
		const seedPx = worldToRaster(space, area.seedWorld.x, area.seedWorld.y);
		const spill = findSpillLeaks({
			fillable,
			width: space.width,
			height: space.height,
			seedX: Math.round(seedPx.x),
			seedY: Math.round(seedPx.y),
			space,
			fillMask: result.mask,
		});
		if (!spill || spill.leaks.length === 0) return null;

		return {
			leaks: spill.leaks,
			noBarriers: false,
			spill: true,
			sealedMask: spill.sealedMask,
			sealedSpace: spill.sealedMask ? space : null,
			sealedImageData: spill.sealedMask ? imageData : null,
		};
	}

	/** True when any mask cell lies on an artboard's inner edge band. */
	private maskTouchesArtboardEdge(
		mask: Uint8Array,
		space: FillRasterSpace,
	): boolean {
		const { width, height } = space;
		for (const artboard of this.context.getArtboards()) {
			const b = getArtboardBounds(artboard);
			const tl = worldToRaster(space, b.minX, b.maxY);
			const br = worldToRaster(space, b.maxX, b.minY);
			const left = Math.round(tl.x) + ARTBOARD_EDGE_INSET_PX;
			const right = Math.round(br.x) - ARTBOARD_EDGE_INSET_PX;
			const top = Math.round(tl.y) + ARTBOARD_EDGE_INSET_PX;
			const bottom = Math.round(br.y) - ARTBOARD_EDGE_INSET_PX;
			if (left >= right || top >= bottom) continue;

			const y0 = Math.max(0, top);
			const y1 = Math.min(height - 1, bottom);
			const x0 = Math.max(0, left);
			const x1 = Math.min(width - 1, right);
			// Only walk sides whose true artboard edge lies inside the raster
			if (top >= 0 && top < height) {
				for (let x = x0; x <= x1; x++)
					if (mask[top * width + x] === 1) return true;
			}
			if (bottom >= 0 && bottom < height) {
				for (let x = x0; x <= x1; x++)
					if (mask[bottom * width + x] === 1) return true;
			}
			if (left >= 0 && left < width) {
				for (let y = y0; y <= y1; y++)
					if (mask[y * width + left] === 1) return true;
			}
			if (right >= 0 && right < width) {
				for (let y = y0; y <= y1; y++)
					if (mask[y * width + right] === 1) return true;
			}
		}
		return false;
	}

	/** Aggregate per-area leak state into toolSettings for the toolbar. */
	private publishLeakState(): void {
		const leakAreas = this.fillAreas.filter((a) => a.leakState);
		if (leakAreas.length === 0) {
			this.context.setBucketFillLeaks(null);
			return;
		}
		const count = leakAreas.reduce(
			(n, a) => n + (a.leakState?.leaks.length ?? 0),
			0,
		);
		this.context.setBucketFillLeaks({
			count,
			noBarriers: count === 0,
			spill: leakAreas.some((a) => a.leakState?.spill),
			canSealFill: leakAreas.some((a) => a.leakState?.sealedMask != null),
		});
	}

	/**
	 * Render the region offscreen and flood fill it from the area's seed.
	 * Returns null when rendering failed or the seed fell outside the raster.
	 */
	private async fillOnRegion(
		area: FillArea,
		region: WorldRegion,
		scale: number,
	): Promise<FillOnRegionResult | null> {
		const imageData = await this.context.renderWorldRegionToImageData(
			region,
			scale,
			{ paintArtboardBackgrounds: true },
		);
		if (!imageData) return null;

		// The readback is authoritative for raster dimensions (float roundoff in
		// worldWidth * scale can make Math.ceil land one pixel off).
		const space: FillRasterSpace = {
			...region,
			scale,
			width: imageData.width,
			height: imageData.height,
		};

		const seedPx = worldToRaster(space, area.seedWorld.x, area.seedWorld.y);
		const startX = Math.round(seedPx.x);
		const startY = Math.round(seedPx.y);
		if (
			startX < 0 ||
			startX >= space.width ||
			startY < 0 ||
			startY >= space.height
		)
			return null;

		area.seedColor ??= sampleSeedColor(imageData, startX, startY);

		let cutMask: Uint8Array | null = null;
		if (area.cutPaths.length > 0) {
			cutMask = buildCutMask(
				area.cutPaths,
				space,
				CUT_STROKE_SCREEN_WIDTH / area.zoomAtCreation,
			);
		}

		// Gap closing radius is defined in screen px at creation zoom; convert to
		// raster px so the same world-space gap closes at every raster scale.
		const gapRadiusPx = Math.min(
			20,
			Math.max(
				0,
				Math.round((this.gapClosing / area.zoomAtCreation) * space.scale),
			),
		);

		let mask: Uint8Array;
		let alphaMap: Uint8Array | null = null;
		if (gapRadiusPx > 0) {
			alphaMap = buildAlphaMap(imageData, area.seedColor, this.tolerance);
			const gapDistMap = buildGapDistanceMap(
				alphaMap,
				space.width,
				space.height,
				gapRadiusPx,
			);
			mask = gapClosingFloodFill(
				alphaMap,
				gapDistMap,
				space.width,
				space.height,
				startX,
				startY,
				cutMask,
			);
		} else {
			mask = floodFill(
				imageData,
				startX,
				startY,
				area.seedColor,
				this.tolerance,
				cutMask,
			);
		}

		return { mask, space, imageData, cutMask, alphaMap };
	}

	/**
	 * Re-fill the tight bbox of a bounded coarse result at a higher resolution.
	 * Returns null when the pass would not gain meaningful resolution, or when
	 * the hi-res fill reaches the tight window's edge (an anti-aliasing-closed
	 * gap reopened) — the caller then keeps the coarse result for determinism.
	 */
	private async refineFill(
		area: FillArea,
		coarse: FillOnRegionResult,
	): Promise<FillOnRegionResult | null> {
		const bbox = computeMaskBounds(coarse.mask, coarse.space);
		const marginWorld = FINAL_PASS_MARGIN_PX / coarse.space.scale;
		const region: WorldRegion = {
			centerX: (bbox.minX + bbox.maxX) / 2,
			centerY: (bbox.minY + bbox.maxY) / 2,
			worldWidth: bbox.width + marginWorld * 2,
			worldHeight: bbox.height + marginWorld * 2,
		};

		const budget = Math.min(
			FINAL_RASTER_BUDGET,
			this.context.getMaxRasterDimension(),
		);
		const finalScale = Math.min(
			budget / region.worldWidth,
			budget / region.worldHeight,
			Math.max(area.zoomAtCreation, 1),
		);
		if (finalScale <= coarse.space.scale * FINAL_PASS_MIN_GAIN) return null;

		const filled = await this.fillOnRegion(area, region, finalScale);
		if (!filled) return null;

		const touched = maskTouchedEdges(
			filled.mask,
			filled.space.width,
			filled.space.height,
		);
		if (touched.left || touched.right || touched.top || touched.bottom)
			return null;

		return filled;
	}

	private refreshPreview(): void {
		const paths = this.fillAreas
			.map((a) => a.cachedPath)
			.filter((p): p is Path => p !== null);
		const leaks = this.fillAreas.flatMap((a) => a.leakState?.leaks ?? []);

		if (paths.length === 0) {
			this.context.previewUpdate(null);
		} else {
			const mergedSegments: PathSegment[] = [];
			for (const p of paths) {
				const [first, ...rest] = p.segments;
				if (!first) continue;
				mergedSegments.push({ ...first, isMoved: true });
				mergedSegments.push(...rest);
			}

			this.context.previewUpdate({
				...paths[0],
				id: "preview-merged",
				segments: mergedSegments,
			});
		}

		// Update bucket fill UI overlay (cut paths + leak markers)
		const allCutPaths = this.fillAreas.flatMap((a) => a.cutPaths);
		if (paths.length === 0 && allCutPaths.length === 0 && leaks.length === 0) {
			this.updateBucketFillOverlay(null);
			return;
		}
		this.updateBucketFillOverlay({
			cutPaths: allCutPaths,
			gapBarrierSegments: [],
			leaks: leaks.length > 0 ? leaks : undefined,
		});
	}

	private updateBucketFillOverlay(ui: BucketFillUIData | null): void {
		this.context.uiSetOverlay(
			OVERLAY_KEYS.bucketFillPreview,
			ui
				? {
						zIndex: OVERLAY_Z.bucketFill,
						primitives: buildBucketFillOverlay(ui, UI_THEME),
					}
				: null,
		);
	}
}

// --- Helper functions ---

/** Seed-centered world region sized to the viewport's world-space AABB
 *  (rotation-aware: the AABB of the rotated screen rect). */
function seedWindowRegion(
	seedWorld: { x: number; y: number },
	viewport: Viewport,
	canvasWidth: number,
	canvasHeight: number,
): WorldRegion {
	const cos = Math.abs(Math.cos(viewport.rotation));
	const sin = Math.abs(Math.sin(viewport.rotation));
	return {
		centerX: seedWorld.x,
		centerY: seedWorld.y,
		worldWidth: (cos * canvasWidth + sin * canvasHeight) / viewport.zoom,
		worldHeight: (sin * canvasWidth + cos * canvasHeight) / viewport.zoom,
	};
}
