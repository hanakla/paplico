import { withStoredBrushSize } from "../brush/access";
import { normalizeBrushSettingsV2 } from "../brush/migrate";
import { createIdentityTransform } from "../document/factory";
import type { PerspectiveGuideData } from "../reference3d/perspective/vanishingPoints";
import {
	bakeStrokeWidthProfile,
	polylineSegmentsFromPoints,
} from "../renderer/canvas/pipeline/brush/strokeHalfWidth";
import { BrushStrokeSession } from "../renderer/canvas/pipeline/stroke/BrushStrokeSession";
import { OVERLAY_KEYS } from "../renderer/ui/overlayKeys";
import type { UIPrimitive } from "../renderer/ui/primitives";
import { OVERLAY_Z, UI_THEME } from "../renderer/ui/theme";
import {
	type BezierPoint,
	cloneAppearance,
	colorToRawRGBA,
	type Filter,
	generateUid,
	type Path,
	type RawRGBA,
	type StrokeAppearance,
	type Viewport,
} from "../schema";
import { screenToWorld } from "../utils/geometry/geometry";
import {
	processStroke,
	type SmoothingMethod,
} from "../utils/geometry/strokeFitting";
import type { PointerEventData, Tool } from "./Tool";
import type { ToolContext } from "./ToolContext";

interface PenToolOptions {
	/** Stroke width override (used instead of activeStroke's brushSettings.size) */
	strokeWidth?: number;
	/** Stabilization strength (0 = none, 1 = strong). Default 0.5 */
	stabilization?: number;
	/** Smoothing method. Default "smooth" */
	smoothingMethod?: SmoothingMethod;
	/** Snap strokes to perspective-ruler directions. Default true */
	perspectiveSnap?: boolean;
	/** Opacity given to the created path object. Default 1 */
	opacity?: number;
}

/**
 * Raw input record of one committed stroke, kept so the exact pen input can
 * be exported and replayed. `points` is what the fitter saw; `path` is the
 * object the stroke produced.
 */
export interface PenStrokeRecord {
	points: BezierPoint[];
	path: Path;
	stabilization: number;
	smoothingMethod: SmoothingMethod;
	/** Viewport zoom the stroke was drawn at (drives the fit tolerance). */
	zoom: number;
}

/** Overlay channel key for perspective radial / lock guide lines. */
const PERSPECTIVE_PEN_OVERLAY_KEY = OVERLAY_KEYS.penPerspective;
/** Direction-lock engages once the stroke moved this many screen pixels. */
const PERSPECTIVE_LOCK_DISTANCE_PX = 8;
/** Max angle between the stroke and a candidate direction to lock (degrees). */
const PERSPECTIVE_LOCK_MAX_ANGLE_DEG = 10;
/** Half-extent of the locked direction guide line (world units). */
const PERSPECTIVE_LOCK_LINE_HALF_EXTENT = 100_000;
/** Airbrush hold-point injection interval while the pointer rests (ms). */
const HOLD_POINT_INTERVAL_MS = 25;

interface PerspectiveSnapState {
	/** Stroke start point P0 (world). Candidate directions anchor here. */
	origin: { x: number; y: number };
	/** True once the lock decision was made (at the distance threshold). */
	evaluated: boolean;
	/** Locked unit direction, oriented along the initial stroke motion. */
	lock: { direction: { x: number; y: number } } | null;
}

type DragState =
	| { mode: "idle" }
	| {
			mode: "drawing";
			session: BrushStrokeSession;
			startTime: number;
			/** Long-press timer (null after threshold exceeded or timer expired) */
			longPressTimer: ReturnType<typeof setTimeout> | null;
			/** Airbrush hold-point timer (null for brushes without timed dabs) */
			holdTimer: ReturnType<typeof setInterval> | null;
			startScreenX: number;
			startScreenY: number;
			perspective: PerspectiveSnapState;
	  }
	| {
			mode: "picking";
			pickedColor: RawRGBA | null;
	  };

export class PenTool implements Tool {
	public readonly name = "pen";

	// Long-press color pick constants
	private static readonly LONG_PRESS_DURATION = 500;
	private static readonly LONG_PRESS_MOVE_THRESHOLD = 5;

	private context: ToolContext;
	private strokeWidth: number | null;
	private stabilization: number;
	private smoothingMethod: SmoothingMethod;
	private perspectiveSnap: boolean;
	private opacity: number;

	private dragState: DragState = { mode: "idle" };
	private lastStroke: PenStrokeRecord | null = null;

	public constructor(context: ToolContext, options: PenToolOptions) {
		this.context = context;
		this.strokeWidth = options.strokeWidth ?? null;
		this.stabilization = options.stabilization ?? 0.5;
		this.smoothingMethod = options.smoothingMethod ?? "smooth";
		this.perspectiveSnap = options.perspectiveSnap ?? true;
		this.opacity = options.opacity ?? 1;

		// Freehand drawing never operates on the selection; drop it on activation
		// so stale selection frames don't linger while drawing.
		context.selectionClear();
	}

	public get isLongPicking(): boolean {
		return this.dragState.mode === "picking";
	}

	public get pickedColor(): RawRGBA | null {
		return this.dragState.mode === "picking"
			? this.dragState.pickedColor
			: null;
	}

	public setOptions(options: Partial<PenToolOptions>): void {
		this.strokeWidth = options.strokeWidth ?? this.strokeWidth;
		this.stabilization = options.stabilization ?? this.stabilization;
		this.smoothingMethod = options.smoothingMethod ?? this.smoothingMethod;
		this.perspectiveSnap = options.perspectiveSnap ?? this.perspectiveSnap;
		this.opacity = options.opacity ?? this.opacity;
	}

	public onPointerDown(
		event: PointerEventData,
		viewport: Viewport,
		canvasWidth: number,
		canvasHeight: number,
	): void {
		if (this.context.isReadonly() || this.context.isCurrentLayerLocked())
			return;

		const worldPos = screenToWorld(
			event.x,
			event.y,
			viewport,
			canvasWidth,
			canvasHeight,
		);

		this.cancelDrag();

		const session = new BrushStrokeSession({
			stabilization: this.stabilization,
			zoom: viewport.zoom,
			smoothingMethod: this.smoothingMethod,
		});
		session.append({
			x: worldPos.x,
			y: worldPos.y,
			pressure: event.pressure,
			tiltX: event.tiltX,
			tiltY: event.tiltY,
			twist: event.twist,
			deltaTime: 0,
		});

		this.dragState = {
			mode: "drawing",
			session,
			startTime: performance.now(),
			longPressTimer: setTimeout(
				() => this.triggerLongPress(),
				PenTool.LONG_PRESS_DURATION,
			),
			holdTimer: this.brushHasTimedDabs()
				? setInterval(() => this.injectHoldPoint(), HOLD_POINT_INTERVAL_MS)
				: null,
			startScreenX: event.x,
			startScreenY: event.y,
			perspective: {
				origin: { x: worldPos.x, y: worldPos.y },
				evaluated: false,
				lock: null,
			},
		};
	}

	public onPointerMove(
		event: PointerEventData,
		viewport: Viewport,
		canvasWidth: number,
		canvasHeight: number,
	): void {
		if (this.dragState.mode === "picking") {
			this.pickPixelColorAt(event.x, event.y);
			return;
		}

		if (this.dragState.mode === "drawing") {
			// Cancel long-press if pointer moved beyond threshold
			if (this.dragState.longPressTimer) {
				const dist = Math.hypot(
					event.x - this.dragState.startScreenX,
					event.y - this.dragState.startScreenY,
				);
				if (dist > PenTool.LONG_PRESS_MOVE_THRESHOLD) {
					clearTimeout(this.dragState.longPressTimer);
					this.dragState.longPressTimer = null;
				}
			}

			// Fast strokes deliver several raw samples per pointermove; append
			// them all so the fit sees the full input.
			const samples =
				event.coalesced && event.coalesced.length > 0 ? event.coalesced : null;
			let lastWorldPos: { x: number; y: number } | null = null;
			if (samples) {
				for (const sample of samples) {
					const rawWorldPos = screenToWorld(
						sample.x,
						sample.y,
						viewport,
						canvasWidth,
						canvasHeight,
					);
					const worldPos = this.applyPerspectiveSnap(
						rawWorldPos,
						event,
						viewport,
					);
					this.dragState.session.append({
						x: worldPos.x,
						y: worldPos.y,
						pressure: sample.pressure,
						tiltX: sample.tiltX,
						tiltY: sample.tiltY,
						twist: sample.twist,
						deltaTime: Math.max(sample.timeStamp - this.dragState.startTime, 0),
					});
					lastWorldPos = worldPos;
				}
			} else {
				const rawWorldPos = screenToWorld(
					event.x,
					event.y,
					viewport,
					canvasWidth,
					canvasHeight,
				);
				const worldPos = this.applyPerspectiveSnap(
					rawWorldPos,
					event,
					viewport,
				);
				// Perspective snap replaces only x/y — pressure and tilt pass through.
				this.dragState.session.append({
					x: worldPos.x,
					y: worldPos.y,
					pressure: event.pressure,
					tiltX: event.tiltX,
					tiltY: event.tiltY,
					twist: event.twist,
					deltaTime: performance.now() - this.dragState.startTime,
				});
				lastWorldPos = worldPos;
			}

			if (lastWorldPos) this.updatePerspectiveOverlay(lastWorldPos);
			this.updatePreview();
		}
	}

	public onPointerUp(
		_event: PointerEventData,
		viewport: Viewport,
		_canvasWidth: number,
		_canvasHeight: number,
	): void {
		if (this.dragState.mode === "picking") {
			this.dragState = { mode: "idle" };
			this.context.requestRender("cursor");
			return;
		}

		if (this.dragState.mode !== "drawing") return;

		if (this.dragState.longPressTimer) {
			clearTimeout(this.dragState.longPressTimer);
		}
		if (this.dragState.holdTimer) {
			clearInterval(this.dragState.holdTimer);
		}

		this.context.uiSetOverlay(PERSPECTIVE_PEN_OVERLAY_KEY, null);

		// Exit 1 (commit): the raw record re-fits through the full pipeline,
		// so the committed geometry is identical to the pre-session behavior.
		const points = this.dragState.session.commit();
		if (points.length < 2) {
			this.dragState = { mode: "idle" };
			this.context.previewUpdate(null);
			return;
		}

		const segments = processStroke(
			points,
			this.stabilization,
			viewport,
			this.smoothingMethod,
		);

		// Build filters from current appearances
		const stroke = this.resolveStroke();
		const fill = this.context.getActiveFillAppearance();

		// Materialize the size-curve width profile into strokeWidths, evaluated
		// on the raw input polyline: the fitted segments carry time only at
		// their endpoints, so speed-driven width would flatten to the segment
		// average, and a later vertex edit would drop pressure data too. The
		// appearance itself stays untouched — renderers skip the size curves
		// via strokeWidthsBaked.
		const bakedWidths = stroke
			? bakeStrokeWidthProfile(
					stroke.paramData.params.brushSettings,
					polylineSegmentsFromPoints(points),
				)
			: null;

		const filters: Filter[] = [];
		if (stroke) filters.push(stroke);
		if (fill) filters.push(cloneAppearance(fill));

		if (filters.length === 0) {
			this.dragState = { mode: "idle" };
			return;
		}

		// Create path object
		const path: Path = {
			type: "path",
			id: generateUid("obj"),
			transform: createIdentityTransform(),
			opacity: this.opacity,
			blendMode: "normal",
			segments,
			filters,
			strokeWidths: bakedWidths ?? undefined,
			strokeWidthsBaked: bakedWidths ? true : undefined,
		};

		this.lastStroke = {
			points,
			path,
			stabilization: this.stabilization,
			smoothingMethod: this.smoothingMethod,
			zoom: viewport.zoom,
		};

		// Notify completion
		this.context.strokeComplete(path);
		this.dragState = { mode: "idle" };
		this.context.previewUpdate(null);
	}

	public onCancel(): void {
		this.cancelDrag();
		this.context.previewUpdate(null);
	}

	public getCursor(): string {
		return "crosshair";
	}

	/** Raw input record of the last committed stroke (null before the first). */
	public getLastStroke(): PenStrokeRecord | null {
		return this.lastStroke;
	}

	public getCurrentStroke(): BezierPoint[] | null {
		return this.dragState.mode === "drawing"
			? this.dragState.session.rawPoints
			: null;
	}

	public dispose(): void {
		this.cancelDrag();
	}

	private triggerLongPress(): void {
		if (this.dragState.mode !== "drawing" || !this.dragState.longPressTimer)
			return;

		const { startScreenX, startScreenY } = this.dragState;
		if (this.dragState.holdTimer) clearInterval(this.dragState.holdTimer);
		this.dragState.session.abort();

		this.context.previewUpdate(null);
		this.context.uiSetOverlay(PERSPECTIVE_PEN_OVERLAY_KEY, null);
		this.dragState = { mode: "picking", pickedColor: null };
		this.pickPixelColorAt(startScreenX, startScreenY);
	}

	private async pickPixelColorAt(
		screenX: number,
		screenY: number,
	): Promise<void> {
		const color = await this.context.pickPixelColor(screenX, screenY);
		if (!color || this.dragState.mode !== "picking") return;

		this.dragState.pickedColor = colorToRawRGBA(color);
		this.context.emitColorPick({
			strokeColor: { type: "solid", color },
			fillColor: null,
		});

		this.context.requestRender("cursor");
	}

	/** Rebuild and publish the preview path from the session's segments. */
	private updatePreview(): void {
		if (this.dragState.mode !== "drawing") return;
		const segments = this.dragState.session.getPreviewSegments();
		if (segments.length === 0) return;

		const stroke = this.resolveStroke();
		const fill = this.context.getActiveFillAppearance();
		const filters: Filter[] = [];
		if (stroke) filters.push(stroke);
		if (fill) filters.push(cloneAppearance(fill));
		if (filters.length === 0) return;

		const previewPath: Path = {
			type: "path",
			id: "preview",
			transform: createIdentityTransform(),
			opacity: this.opacity,
			blendMode: "normal",
			segments,
			filters,
		};
		this.context.previewUpdate(previewPath);
	}

	/** Whether the active brush emits timed dabs (airbrush hold applies). */
	private brushHasTimedDabs(): boolean {
		const bs =
			this.context.getActiveStrokeAppearance()?.paramData.params.brushSettings;
		if (!bs) return false;
		const v2 = normalizeBrushSettingsV2(bs);
		if (v2.engine !== "dab") return false;
		const dps = v2.properties.dabsPerSecond;
		return dps != null && (dps.base > 0 || (dps.curves?.length ?? 0) > 0);
	}

	private injectHoldPoint(): void {
		if (this.dragState.mode !== "drawing") return;
		this.dragState.session.injectHold(
			performance.now() - this.dragState.startTime,
		);
		this.updatePreview();
	}

	private resolveStroke(): StrokeAppearance | null {
		const active = this.context.getActiveStrokeAppearance();
		if (!active) return null;

		if (this.strokeWidth != null) {
			const bs = active.paramData.params.brushSettings;
			return cloneAppearance(active, {
				brushSettings: bs
					? withStoredBrushSize(bs, this.strokeWidth)
					: undefined,
			});
		}
		return cloneAppearance(active);
	}

	private cancelDrag(): void {
		if (this.dragState.mode === "drawing") {
			if (this.dragState.longPressTimer) {
				clearTimeout(this.dragState.longPressTimer);
			}
			if (this.dragState.holdTimer) {
				clearInterval(this.dragState.holdTimer);
			}
			// Exit 2 (abort): discard the live stroke entirely.
			this.dragState.session.abort();
			this.context.uiSetOverlay(PERSPECTIVE_PEN_OVERLAY_KEY, null);
		}
		this.dragState = { mode: "idle" };
	}

	// --- Perspective ruler snap ---

	/**
	 * Direction-lock snap: at the stroke start P0 the candidate directions are
	 * fixed (finite VP → normalize(P0 − VP); infinite → the direction itself).
	 * Once the stroke moves beyond 8/zoom the closest candidate within 10°
	 * locks, and subsequent points are projected onto the locked line.
	 * Holding Alt bypasses both evaluation and projection.
	 */
	private applyPerspectiveSnap(
		worldPos: { x: number; y: number },
		event: PointerEventData,
		viewport: Viewport,
	): { x: number; y: number } {
		if (this.dragState.mode !== "drawing") return worldPos;
		const snap = this.dragState.perspective;

		if (!this.perspectiveSnap || event.altKey) return worldPos;
		const guides = this.context.getPerspectiveGuides();
		if (!guides) return worldPos;

		if (!snap.lock && !snap.evaluated) {
			const dx = worldPos.x - snap.origin.x;
			const dy = worldPos.y - snap.origin.y;
			if (Math.hypot(dx, dy) > PERSPECTIVE_LOCK_DISTANCE_PX / viewport.zoom) {
				snap.evaluated = true;
				snap.lock = findPerspectiveLock(snap.origin, { x: dx, y: dy }, guides);
			}
		}

		if (!snap.lock) return worldPos;
		const dir = snap.lock.direction;
		const t =
			(worldPos.x - snap.origin.x) * dir.x +
			(worldPos.y - snap.origin.y) * dir.y;
		return { x: snap.origin.x + dir.x * t, y: snap.origin.y + dir.y * t };
	}

	/** Radial lines from finite VPs to the cursor + the locked direction line. */
	private updatePerspectiveOverlay(current: { x: number; y: number }): void {
		if (this.dragState.mode !== "drawing" || !this.perspectiveSnap) return;
		const guides = this.context.getPerspectiveGuides();
		if (!guides) return;

		const snap = this.dragState.perspective;
		const primitives: UIPrimitive[] = [];

		for (const axis of guides.axes) {
			if (axis.kind !== "finite") continue;
			primitives.push({
				kind: "line",
				x1: axis.point.x,
				y1: axis.point.y,
				x2: current.x,
				y2: current.y,
				stroke: {
					color: UI_THEME.colors.perspectiveRadial,
					width: UI_THEME.strokeWidth.default,
				},
			});
		}

		if (snap.lock) {
			const dir = snap.lock.direction;
			primitives.push({
				kind: "line",
				x1: snap.origin.x - dir.x * PERSPECTIVE_LOCK_LINE_HALF_EXTENT,
				y1: snap.origin.y - dir.y * PERSPECTIVE_LOCK_LINE_HALF_EXTENT,
				x2: snap.origin.x + dir.x * PERSPECTIVE_LOCK_LINE_HALF_EXTENT,
				y2: snap.origin.y + dir.y * PERSPECTIVE_LOCK_LINE_HALF_EXTENT,
				stroke: {
					color: UI_THEME.colors.snapLine,
					width: UI_THEME.strokeWidth.default,
				},
				zIndex: 1,
			});
		}

		this.context.uiSetOverlay(PERSPECTIVE_PEN_OVERLAY_KEY, {
			zIndex: OVERLAY_Z.perspectiveGuide,
			primitives,
		});
	}
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/**
 * Pick the guide direction closest in angle to the initial stroke motion,
 * locking only under 10°. The comparison treats candidates as lines (both
 * orientations); the returned direction is oriented along the stroke.
 */
function findPerspectiveLock(
	origin: { x: number; y: number },
	delta: { x: number; y: number },
	guides: PerspectiveGuideData,
): { direction: { x: number; y: number } } | null {
	const deltaLen = Math.hypot(delta.x, delta.y);
	if (deltaLen < 1e-9) return null;
	const nd = { x: delta.x / deltaLen, y: delta.y / deltaLen };
	const minCos = Math.cos((PERSPECTIVE_LOCK_MAX_ANGLE_DEG * Math.PI) / 180);

	let best: { direction: { x: number; y: number }; cos: number } | null = null;
	for (const axis of guides.axes) {
		let dir: { x: number; y: number };
		if (axis.kind === "finite") {
			const dx = origin.x - axis.point.x;
			const dy = origin.y - axis.point.y;
			const len = Math.hypot(dx, dy);
			if (len < 1e-9) continue;
			dir = { x: dx / len, y: dy / len };
		} else {
			dir = axis.direction;
		}

		const dot = nd.x * dir.x + nd.y * dir.y;
		const cos = Math.abs(dot);
		if (cos < minCos) continue;
		if (!best || cos > best.cos) {
			best = {
				direction: dot >= 0 ? dir : { x: -dir.x, y: -dir.y },
				cos,
			};
		}
	}

	return best ? { direction: best.direction } : null;
}
