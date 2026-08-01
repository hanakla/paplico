import { interpolateStrokeWidths } from "../renderer/geometry/strokeTessellator";
import { buildStrokeWidthEditOverlay } from "../renderer/ui/builders/strokeWidthEdit";
import type { OverlayHit } from "../renderer/ui/hitTest";
import { OVERLAY_KEYS } from "../renderer/ui/overlayKeys";
import { OVERLAY_Z, UI_THEME } from "../renderer/ui/theme";
import type {
	StrokeWidthCenterHandle,
	StrokeWidthEditUIData,
	StrokeWidthHandle,
} from "../renderer/ui/types";
import type {
	Path,
	StrokeAppearance,
	StrokeWidthPoint,
	Viewport,
} from "../schema";
import {
	screenToWorld,
	type WorldBezierSegment,
} from "../utils/geometry/geometry";
import { evalBezier } from "../utils/geometry/pathOps";
import { getWorldSegments } from "../utils/geometry/segmentOps";
import type { PointerEventData, Tool } from "./Tool";
import type { ToolContext } from "./ToolContext";

/** The part of a width point a drag has hold of. */
type WidthHandlePart = "side1" | "side2" | "center";

const DUPLICATE_T_THRESHOLD = 0.005;

/**
 * A single side boundary may cross the centerline (a negative offset) and eat
 * into the opposite side — see StrokeWidthPoint in schema.ts. What may not go
 * negative is their sum: an interval whose sum drops below zero is not a thin
 * stroke but a deleted one, and removing it means splitting the path, which is
 * the eraser's job. A drag therefore pinches down to zero width and stops.
 */
const MAX_SIDE = 1;

export class StrokeWidthEditTool implements Tool {
	public readonly name = "stroke-width-edit";

	private ctx: ToolContext;
	private targetPath: Path | null = null;
	private targetElementId: string | null = null;
	private selectedPointIndex: number | null = null;
	private selectedPart: WidthHandlePart | null = null;
	private dragging = false;
	private dragInitialWidths: StrokeWidthPoint[] | null = null;
	private worldSegments: WorldBezierSegment[] = [];
	/** Cumulative arc-lengths per segment for arc-length parameterization */
	private segArcLengths: Float64Array = new Float64Array(0);
	private totalArcLength = 0;

	public constructor(ctx: ToolContext) {
		this.ctx = ctx;
	}

	public initWithSelectedPath(
		path: Path,
		_viewport: Viewport,
		_canvasWidth: number,
		_canvasHeight: number,
	): void {
		this.targetPath = path;
		this.targetElementId = path.id;
		this.selectedPointIndex = null;
		this.selectedPart = null;
		this.dragging = false;
		this.rebuildWorldSegments();
		this.refreshUI();
	}

	public onPointerDown(
		event: PointerEventData,
		_viewport: Viewport,
		_canvasWidth: number,
		_canvasHeight: number,
	): void {
		if (!this.targetPath) return;

		const hit = this.resolveOverlayHit(
			this.ctx.uiHitTest({ x: event.x, y: event.y }),
		);

		if (hit) {
			this.selectedPointIndex = hit.pointIndex;
			this.selectedPart = hit.part;
			this.dragging = true;
			this.dragInitialWidths = [...(this.targetPath.strokeWidths ?? [])];
			this.refreshUI();
		} else {
			this.selectedPointIndex = null;
			this.selectedPart = null;
			this.refreshUI();
		}
	}

	public onPointerMove(
		event: PointerEventData,
		viewport: Viewport,
		canvasWidth: number,
		canvasHeight: number,
	): void {
		if (
			!this.dragging ||
			!this.targetPath ||
			this.selectedPointIndex == null ||
			!this.selectedPart
		)
			return;

		const world = screenToWorld(
			event.x,
			event.y,
			viewport,
			canvasWidth,
			canvasHeight,
		);

		const point = this.getEffectiveWidths()[this.selectedPointIndex];
		if (!point) return;

		const strokeWidths =
			this.selectedPart === "center"
				? this.resolveSlideDrag(point.t, world.x, world.y)
				: this.resolveWidthDrag(point.t, this.selectedPart, world, event);
		if (!strokeWidths) return;

		this.ctx.updateElement(this.targetElementId!, { strokeWidths });
		const updated = this.ctx.getPathById(this.targetElementId!);
		if (updated) this.targetPath = updated;
		this.ctx.requestRender("document");
		this.refreshUI();
	}

	public onPointerUp(
		_event: PointerEventData,
		_viewport: Viewport,
		_canvasWidth: number,
		_canvasHeight: number,
	): void {
		if (this.dragging) {
			// Wrap the final state in a transaction for undo/redo
			const finalWidths = [...(this.targetPath?.strokeWidths ?? [])];
			const initialWidths = this.dragInitialWidths;

			if (initialWidths) {
				// Restore initial state, then apply final in a single transaction
				this.ctx.updateElement(this.targetElementId!, {
					strokeWidths: initialWidths,
				});
				const layer = this.ctx.getCurrentLayer();
				if (!layer) return;
				this.ctx.transact((commands) => {
					commands.updateElement(layer.id, this.targetElementId!, {
						strokeWidths: finalWidths,
					});
				});
				const updated = this.ctx.getPathById(this.targetElementId!);
				if (updated) this.targetPath = updated;
			}

			this.dragging = false;
			this.dragInitialWidths = null;
		}
	}

	public onDoubleClick(
		event: PointerEventData,
		viewport: Viewport,
		canvasWidth: number,
		canvasHeight: number,
	): void {
		if (!this.targetPath) return;

		const world = screenToWorld(
			event.x,
			event.y,
			viewport,
			canvasWidth,
			canvasHeight,
		);

		const closestT = this.findClosestT(world.x, world.y);
		if (closestT == null) return;

		// Check for duplicate t values
		const existing = this.targetPath.strokeWidths ?? [];
		if (
			existing.some((p) => Math.abs(p.t - closestT) < DUPLICATE_T_THRESHOLD)
		) {
			return;
		}

		const strokeWidths = [...existing];
		const interp = interpolateStrokeWidths(strokeWidths, closestT);

		strokeWidths.push({
			t: closestT,
			side1: interp.side1,
			side2: interp.side2,
		});
		strokeWidths.sort((a, b) => a.t - b.t);

		const layer = this.ctx.getCurrentLayer();
		if (!layer) return;
		this.ctx.transact((commands) => {
			commands.updateElement(layer.id, this.targetElementId!, { strokeWidths });
		});

		const updated = this.ctx.getPathById(this.targetElementId!);
		if (updated) this.targetPath = updated;
		this.ctx.requestRender("document");
		this.refreshUI();
	}

	public onKeyDown(
		event: KeyboardEvent,
		_viewport: Viewport,
		_canvasWidth: number,
		_canvasHeight: number,
	): boolean {
		if (
			(event.key === "Delete" || event.key === "Backspace") &&
			this.selectedPointIndex != null &&
			this.targetPath
		) {
			const effective = this.getEffectiveWidths();
			const point = effective[this.selectedPointIndex];
			if (!point) return false;

			// Don't delete implicit endpoints
			const explicitIndex = this.findExplicitIndex(point.t);
			if (explicitIndex < 0) return false;

			const strokeWidths = [...(this.targetPath.strokeWidths ?? [])];
			strokeWidths.splice(explicitIndex, 1);

			const layer = this.ctx.getCurrentLayer();
			if (!layer) return false;
			this.ctx.transact((commands) => {
				commands.updateElement(layer.id, this.targetElementId!, {
					strokeWidths,
				});
			});

			const updated = this.ctx.getPathById(this.targetElementId!);
			if (updated) this.targetPath = updated;
			this.selectedPointIndex = null;
			this.selectedPart = null;
			this.ctx.requestRender("document");
			this.refreshUI();
			return true;
		}

		return false;
	}

	public onCancel(): void {
		this.targetPath = null;
		this.targetElementId = null;
		this.selectedPointIndex = null;
		this.selectedPart = null;
		this.dragging = false;
		this.dragInitialWidths = null;
		this.worldSegments = [];
		this.segArcLengths = new Float64Array(0);
		this.totalArcLength = 0;
		this.updateStrokeWidthOverlay(null);
	}

	public getCursor(): string {
		if (!this.dragging) return "default";
		return this.selectedPart === "center" ? "grabbing" : "ns-resize";
	}

	public refreshUI(): void {
		if (!this.targetPath) {
			this.updateStrokeWidthOverlay(null);
			return;
		}

		this.updateStrokeWidthOverlay(this.buildUIData());
	}

	/**
	 * Widths after moving the dragged point's boundary to the pointer. The drag
	 * is measured against the state at pointer-down so that the delta does not
	 * accumulate across moves.
	 */
	private resolveWidthDrag(
		pointT: number,
		side: "side1" | "side2",
		world: { x: number; y: number },
		event: PointerEventData,
	): StrokeWidthPoint[] | null {
		const evalResult = this.evaluateWorldPath(pointT);
		if (!evalResult) return null;

		const brushHalf = this.getBrushHalfSize();
		if (brushHalf <= 0) return null;

		// Project pointer position onto the normal direction
		const dx = world.x - evalResult.x;
		const dy = world.y - evalResult.y;

		const sign = side === "side1" ? 1 : -1;
		const projected = dx * evalResult.nx * sign + dy * evalResult.ny * sign;

		const sides = resolveDraggedSides(
			interpolateStrokeWidths(this.dragInitialWidths ?? [], pointT),
			projected / brushHalf,
			side,
			event,
		);

		const strokeWidths = [...(this.targetPath?.strokeWidths ?? [])];
		const explicitIndex = this.findExplicitIndex(pointT);

		if (explicitIndex >= 0) {
			strokeWidths[explicitIndex] = {
				...strokeWidths[explicitIndex],
				...sides,
			};
		} else {
			// Implicit point (t=0 or t=1) — create explicit entry
			strokeWidths.push({ t: pointT, ...sides });
			strokeWidths.sort((a, b) => a.t - b.t);
		}

		return strokeWidths;
	}

	/**
	 * Widths after sliding the dragged point along the path. It stays between
	 * its neighbours, so the profile keeps its order and the point keeps its
	 * place in the effective array for the rest of the drag.
	 */
	private resolveSlideDrag(
		pointT: number,
		worldX: number,
		worldY: number,
	): StrokeWidthPoint[] | null {
		// The endpoints anchor the profile to the ends of the path.
		if (pointT <= 0 || pointT >= 1) return null;

		const explicitIndex = this.findExplicitIndex(pointT);
		if (explicitIndex < 0) return null;

		const closestT = this.findClosestT(worldX, worldY);
		if (closestT == null) return null;

		const strokeWidths = [...(this.targetPath?.strokeWidths ?? [])];
		strokeWidths[explicitIndex] = {
			...strokeWidths[explicitIndex],
			t: clamp(
				closestT,
				(strokeWidths[explicitIndex - 1]?.t ?? 0) + DUPLICATE_T_THRESHOLD,
				(strokeWidths[explicitIndex + 1]?.t ?? 1) - DUPLICATE_T_THRESHOLD,
			),
		};

		return strokeWidths;
	}

	private updateStrokeWidthOverlay(data: StrokeWidthEditUIData | null): void {
		this.ctx.uiSetOverlay(
			OVERLAY_KEYS.strokeWidthHandles,
			data
				? {
						zIndex: OVERLAY_Z.strokeWidthEdit,
						primitives: buildStrokeWidthEditOverlay(data, UI_THEME),
					}
				: null,
		);
	}

	private rebuildWorldSegments(): void {
		if (!this.targetPath || !this.targetElementId) {
			this.worldSegments = [];
			this.segArcLengths = new Float64Array(0);
			this.totalArcLength = 0;
			return;
		}

		const ancestorTransform = this.ctx.getAncestorTransform(
			this.targetElementId,
		);
		this.worldSegments = getWorldSegments(
			this.targetPath,
			ancestorTransform ?? undefined,
		);

		// Compute per-segment arc lengths (10-sample approximation per segment)
		const ws = this.worldSegments;
		this.segArcLengths = new Float64Array(ws.length);
		this.totalArcLength = 0;
		for (let si = 0; si < ws.length; si++) {
			const p0 = ws[si].start ?? (si > 0 ? ws[si - 1].end : ws[si].end);
			const p1 = ws[si].cp1;
			const p2 = ws[si].cp2;
			const p3 = ws[si].end;

			let len = 0;
			let px = p0.x;
			let py = p0.y;
			for (let i = 1; i <= 10; i++) {
				const t = i * 0.1;
				const pos = evalBezier(p0, p1, p2, p3, t);
				const dx = pos.x - px;
				const dy = pos.y - py;
				len += Math.sqrt(dx * dx + dy * dy);
				px = pos.x;
				py = pos.y;
			}
			this.segArcLengths[si] = len;
			this.totalArcLength += len;
		}
	}

	// Evaluate path position and normal in world space using cached world segments.
	// Uses arc-length parameterization to match StampGenerator's pathT.
	private evaluateWorldPath(
		pathT: number,
	): { x: number; y: number; nx: number; ny: number } | null {
		const ws = this.worldSegments;
		if (ws.length === 0) return null;

		// Convert arc-length pathT to (segIndex, localT)
		const targetLen = Math.max(0, Math.min(1, pathT)) * this.totalArcLength;
		let cumLen = 0;
		let segIndex = 0;
		let localT = 0;
		for (let i = 0; i < ws.length; i++) {
			const segLen = this.segArcLengths[i];
			if (cumLen + segLen >= targetLen || i === ws.length - 1) {
				segIndex = i;
				localT = segLen > 0 ? (targetLen - cumLen) / segLen : 0;
				localT = Math.max(0, Math.min(1, localT));
				break;
			}
			cumLen += segLen;
		}

		const p0 =
			ws[segIndex].start ??
			(segIndex > 0 ? ws[segIndex - 1].end : ws[segIndex].end);
		const p1 = ws[segIndex].cp1;
		const p2 = ws[segIndex].cp2;
		const p3 = ws[segIndex].end;

		const pos = evalBezier(p0, p1, p2, p3, localT);

		// Tangent (derivative)
		const u = 1 - localT;
		const tx =
			3 * u * u * (p1.x - p0.x) +
			6 * u * localT * (p2.x - p1.x) +
			3 * localT * localT * (p3.x - p2.x);
		const ty =
			3 * u * u * (p1.y - p0.y) +
			6 * u * localT * (p2.y - p1.y) +
			3 * localT * localT * (p3.y - p2.y);

		const tLen = Math.sqrt(tx * tx + ty * ty);
		if (tLen < 1e-8) {
			return { x: pos.x, y: pos.y, nx: 0, ny: 1 };
		}

		// Normal = perpendicular to tangent (rotate 90° CCW)
		const nx = -ty / tLen;
		const ny = tx / tLen;

		return { x: pos.x, y: pos.y, nx, ny };
	}

	private getEffectiveWidths(): Array<
		StrokeWidthPoint & { implicit?: boolean }
	> {
		const explicit = this.targetPath?.strokeWidths ?? [];
		const result: Array<StrokeWidthPoint & { implicit?: boolean }> = [];

		// Add implicit t=0 if not present
		if (explicit.length === 0 || explicit[0].t > 1e-6) {
			const interp = interpolateStrokeWidths(explicit, 0);
			result.push({
				t: 0,
				side1: interp.side1,
				side2: interp.side2,
				implicit: true,
			});
		}

		for (const p of explicit) {
			result.push({ ...p });
		}

		// Add implicit t=1 if not present
		if (explicit.length === 0 || explicit[explicit.length - 1].t < 1 - 1e-6) {
			const interp = interpolateStrokeWidths(explicit, 1);
			result.push({
				t: 1,
				side1: interp.side1,
				side2: interp.side2,
				implicit: true,
			});
		}

		return result;
	}

	/**
	 * Map an overlay hit (hitId = "<uiPointIndex>:<part>") back to the
	 * effective-array index used by drag and keyboard handling.
	 */
	private resolveOverlayHit(
		hit: OverlayHit | null,
	): { pointIndex: number; part: WidthHandlePart } | null {
		if (
			!this.targetPath ||
			hit?.overlayKey !== OVERLAY_KEYS.strokeWidthHandles
		) {
			return null;
		}
		const sep = hit.hitId.lastIndexOf(":");
		const uiPointIndex = Number(hit.hitId.slice(0, sep));
		const part = hit.hitId.slice(sep + 1) as WidthHandlePart;

		const effective = this.getEffectiveWidths();
		for (let i = 0; i < effective.length; i++) {
			if (this.uiPointIndexOf(effective[i]) === uiPointIndex) {
				return { pointIndex: i, part };
			}
		}
		return null;
	}

	/** UI-facing point index: -1/-2 = implicit t=0/t=1, 0+ = explicit index. */
	private uiPointIndexOf(
		point: StrokeWidthPoint & { implicit?: boolean },
	): number {
		if (point.implicit && point.t < 0.5) return -1;
		if (point.implicit) return -2;
		return this.findExplicitIndex(point.t);
	}

	private getBrushHalfSize(): number {
		if (!this.targetPath) return 1;

		const strokeFilter = this.targetPath.filters?.find(
			(f) => f.processor === "stroke",
		) as StrokeAppearance | undefined;

		const size = strokeFilter?.paramData.params.brushSettings?.size ?? 2;
		return size / 2;
	}

	private buildUIData(): StrokeWidthEditUIData {
		const effective = this.getEffectiveWidths();
		const brushHalf = this.getBrushHalfSize();

		// Use world-space resolved segments for correct rendering
		const pathSegments: StrokeWidthEditUIData["pathSegments"] =
			this.worldSegments.map((ws) => ({
				start: ws.start ? { x: ws.start.x, y: ws.start.y } : undefined,
				cp1: { x: ws.cp1.x, y: ws.cp1.y },
				cp2: { x: ws.cp2.x, y: ws.cp2.y },
				end: { x: ws.end.x, y: ws.end.y },
			}));

		const handles: StrokeWidthHandle[] = [];
		const centerHandles: StrokeWidthCenterHandle[] = [];
		const crossLines: StrokeWidthEditUIData["crossLines"] = [];

		for (let i = 0; i < effective.length; i++) {
			const point = effective[i];
			const evalResult = this.evaluateWorldPath(point.t);
			if (!evalResult) continue;

			const cx = evalResult.x;
			const cy = evalResult.y;

			const s1x = cx + evalResult.nx * point.side1 * brushHalf;
			const s1y = cy + evalResult.ny * point.side1 * brushHalf;
			const s2x = cx - evalResult.nx * point.side2 * brushHalf;
			const s2y = cy - evalResult.ny * point.side2 * brushHalf;

			const isSelected = this.selectedPointIndex === i;
			const pointIndex = this.uiPointIndexOf(point);

			handles.push({
				pointIndex,
				side: "side1",
				worldX: s1x,
				worldY: s1y,
				selected: isSelected && this.selectedPart === "side1",
			});

			handles.push({
				pointIndex,
				side: "side2",
				worldX: s2x,
				worldY: s2y,
				selected: isSelected && this.selectedPart === "side2",
			});

			centerHandles.push({
				pointIndex,
				worldX: cx,
				worldY: cy,
				selected: isSelected && this.selectedPart === "center",
				fixed: point.t <= 0 || point.t >= 1,
			});

			crossLines.push({ x1: s1x, y1: s1y, x2: s2x, y2: s2y });
		}

		// Build envelope outline by sampling the width profile along the path
		const envelopeLines: StrokeWidthEditUIData["envelopeLines"] = [];
		const strokeWidths = this.targetPath?.strokeWidths ?? [];
		const envelopeSamples = 60;

		const side1Points: Array<{ x: number; y: number }> = [];
		const side2Points: Array<{ x: number; y: number }> = [];

		for (let i = 0; i <= envelopeSamples; i++) {
			const t = i / envelopeSamples;
			const evalResult = this.evaluateWorldPath(t);
			if (!evalResult) continue;

			const { side1, side2 } = interpolateStrokeWidths(strokeWidths, t);
			side1Points.push({
				x: evalResult.x + evalResult.nx * side1 * brushHalf,
				y: evalResult.y + evalResult.ny * side1 * brushHalf,
			});
			side2Points.push({
				x: evalResult.x - evalResult.nx * side2 * brushHalf,
				y: evalResult.y - evalResult.ny * side2 * brushHalf,
			});
		}

		for (let i = 0; i < side1Points.length - 1; i++) {
			envelopeLines.push({
				x1: side1Points[i].x,
				y1: side1Points[i].y,
				x2: side1Points[i + 1].x,
				y2: side1Points[i + 1].y,
			});
			envelopeLines.push({
				x1: side2Points[i].x,
				y1: side2Points[i].y,
				x2: side2Points[i + 1].x,
				y2: side2Points[i + 1].y,
			});
		}

		return { pathSegments, handles, centerHandles, crossLines, envelopeLines };
	}

	private findExplicitIndex(t: number): number {
		const explicit = this.targetPath?.strokeWidths ?? [];
		return explicit.findIndex((p) => Math.abs(p.t - t) < 1e-6);
	}

	private findClosestT(worldX: number, worldY: number): number | null {
		if (this.worldSegments.length === 0) return null;

		const coarseStep = 0.01;
		const coarse = this.closestTInRange(worldX, worldY, 0, 1, 100);
		if (coarse == null) return null;

		// Search again inside the winning step, so a dragged point follows the
		// pointer instead of snapping to whole percents of the path.
		return (
			this.closestTInRange(
				worldX,
				worldY,
				coarse - coarseStep,
				coarse + coarseStep,
				20,
			) ?? coarse
		);
	}

	private closestTInRange(
		worldX: number,
		worldY: number,
		from: number,
		to: number,
		samples: number,
	): number | null {
		let bestT: number | null = null;
		let bestDist = Number.POSITIVE_INFINITY;

		for (let i = 0; i <= samples; i++) {
			const t = clamp(from + ((to - from) * i) / samples, 0, 1);
			const result = this.evaluateWorldPath(t);
			if (!result) continue;

			const dx = worldX - result.x;
			const dy = worldY - result.y;
			const dist = dx * dx + dy * dy;

			if (dist < bestDist) {
				bestDist = dist;
				bestT = t;
			}
		}

		return bestT;
	}
}

/**
 * Resolve both side values for the current drag position.
 *
 * - plain drag: both sides move by the same delta, keeping their difference
 * - Alt+drag: only the dragged side moves
 * - Shift+drag: both sides snap to the dragged value
 */
function resolveDraggedSides(
	initial: { side1: number; side2: number },
	draggedValue: number,
	side: "side1" | "side2",
	event: PointerEventData,
): { side1: number; side2: number } {
	if (event.altKey) {
		// The floor is where this side meets the opposite one and the stroke
		// closes. A profile handed over with a negative sum — the eraser writes
		// those before splitting — keeps its own value as the floor, so the drag
		// can only ease it back.
		const opposite = side === "side1" ? initial.side2 : initial.side1;
		const value = clamp(
			draggedValue,
			Math.min(-opposite, initial[side]),
			MAX_SIDE,
		);
		return side === "side1"
			? { side1: value, side2: initial.side2 }
			: { side1: initial.side1, side2: value };
	}

	if (event.shiftKey) {
		// Both sides take the same value, so any negative one is a negative sum.
		const value = clamp(draggedValue, 0, MAX_SIDE);
		return { side1: value, side2: value };
	}

	// Clamp the delta instead of each side so that both sides keep the
	// difference they had when the drag started. Moving both by d shifts the sum
	// by 2d, hence the halved floor.
	const delta = clamp(
		draggedValue - initial[side],
		Math.min(0, -(initial.side1 + initial.side2) / 2),
		Math.max(0, MAX_SIDE - Math.max(initial.side1, initial.side2)),
	);
	return { side1: initial.side1 + delta, side2: initial.side2 + delta };
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}
