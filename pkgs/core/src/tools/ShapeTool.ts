/**
 * ShapeTool - draws polygons, ellipses, lines, stars and spirals.
 */

import { nanoid } from "nanoid";
import { createIdentityTransform } from "../document/factory";
import type { SnapLine } from "../document/SpatialIndex";
import { buildSnapLineOverlay } from "../renderer/ui/builders/snapLine";
import { OVERLAY_KEYS } from "../renderer/ui/overlayKeys";
import { OVERLAY_Z, UI_THEME } from "../renderer/ui/theme";
import {
	type CubicBezierSegment,
	cloneAppearance,
	type Filter,
	type Path,
	type Viewport,
} from "../schema";
import {
	generateEllipseSegments,
	generateLineSegments,
	generatePolygonSegments,
	generateSpiralSegments,
	generateStarSegments,
} from "../utils/geometry/generate/shapeSegments";
import { screenToWorld } from "../utils/geometry/space/coordinates";
import type { PointerEventData, Tool } from "./Tool";
import type { ToolContext } from "./ToolContext";
import type { ShapeOption } from "./toolSettings";

// --- Types ---

export interface ShapeToolOptions {
	shapeOption: ShapeOption;
}

/** Shapes Shift stands upright: their part facing the drag end turns straight up. */
const SHIFT_UPRIGHT_SHAPE_TYPES: ReadonlySet<ShapeOption["type"]> = new Set([
	"star",
	"spiral",
]);

const SHIFT_ANGLE_STEP = Math.PI / 4;
/** Screen distance a drag needs before its direction is steady enough to be a Shift base. */
const SHIFT_BASE_MIN_SCREEN_DISTANCE = 16;

// --- Main ShapeTool Class ---

export class ShapeTool implements Tool {
	public readonly name = "shape";

	private context: ToolContext;
	private options: ShapeToolOptions;
	private dragStartWorld: { x: number; y: number } | null = null;
	private isDragging = false;
	private shiftKeyPressed = false;
	/** Pointer direction when Shift took effect, which an upright shape's Shift lean counts from. */
	private shiftBaseAngle: number | null = null;

	public constructor(context: ToolContext, options: ShapeToolOptions) {
		this.context = context;
		this.options = options;
	}

	// --- Public Methods ---
	public setOptions(options: Partial<ShapeToolOptions>): void {
		this.options = { ...this.options, ...options };
	}

	// --- Tool Interface Implementation ---

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
		const snapped = this.snapPoint(worldPos, viewport.zoom);
		this.updateSnapLineOverlay(snapped.snapLines);

		this.dragStartWorld = snapped.point;
		this.isDragging = true;
		this.shiftKeyPressed = event.shiftKey;
	}

	public onPointerMove(
		event: PointerEventData,
		viewport: Viewport,
		canvasWidth: number,
		canvasHeight: number,
	): void {
		if (!this.isDragging || !this.dragStartWorld) {
			this.updateHoverSnap(event, viewport, canvasWidth, canvasHeight);
			return;
		}

		this.shiftKeyPressed = event.shiftKey;

		const worldPos = screenToWorld(
			event.x,
			event.y,
			viewport,
			canvasWidth,
			canvasHeight,
		);
		const snapped = this.snapEndPoint(
			this.dragStartWorld,
			worldPos,
			viewport.zoom,
		);
		this.updateSnapLineOverlay(snapped.snapLines);
		this.trackShiftBaseAngle(this.dragStartWorld, snapped.point, viewport.zoom);

		const previewPath = this.createShapePath(
			this.dragStartWorld,
			snapped.point,
			"preview",
		);
		this.context.previewUpdate(previewPath);
	}

	public onPointerUp(
		event: PointerEventData,
		viewport: Viewport,
		canvasWidth: number,
		canvasHeight: number,
	): void {
		if (!this.isDragging || !this.dragStartWorld) {
			this.reset();
			return;
		}

		this.shiftKeyPressed = event.shiftKey;

		const worldPos = screenToWorld(
			event.x,
			event.y,
			viewport,
			canvasWidth,
			canvasHeight,
		);
		const snapped = this.snapEndPoint(
			this.dragStartWorld,
			worldPos,
			viewport.zoom,
		);
		this.trackShiftBaseAngle(this.dragStartWorld, snapped.point, viewport.zoom);

		// 最小サイズチェック（ドラッグが短すぎる場合は無視）
		const dx = snapped.point.x - this.dragStartWorld.x;
		const dy = snapped.point.y - this.dragStartWorld.y;
		if (Math.sqrt(dx * dx + dy * dy) < 3) {
			this.reset();
			return;
		}

		const path = this.createShapePath(
			this.dragStartWorld,
			snapped.point,
			nanoid(),
		);
		this.context.shapeComplete(path);
		this.reset();
	}

	public onCancel(): void {
		this.reset();
	}

	public getCursor(): string {
		return "crosshair";
	}

	public onKeyDown?(event: KeyboardEvent): boolean {
		// Shiftキーの状態を更新（プレビュー更新用）
		if (event.key === "Shift") {
			this.shiftKeyPressed = true;
			return false;
		}
		return false;
	}

	// --- Private Methods ---

	private reset(): void {
		this.dragStartWorld = null;
		this.isDragging = false;
		this.shiftKeyPressed = false;
		this.shiftBaseAngle = null;
		this.context.previewUpdate(null);
		this.updateSnapLineOverlay([]);
	}

	/**
	 * Preview snap lines while hovering, before the creation drag begins
	 * (mirrors ArtboardTool's hover snap).
	 */
	private updateHoverSnap(
		event: PointerEventData,
		viewport: Viewport,
		canvasWidth: number,
		canvasHeight: number,
	): void {
		if (this.context.isReadonly() || this.context.isCurrentLayerLocked()) {
			this.updateSnapLineOverlay([]);
			return;
		}

		const worldPos = screenToWorld(
			event.x,
			event.y,
			viewport,
			canvasWidth,
			canvasHeight,
		);
		const { snapLines } = this.snapPoint(worldPos, viewport.zoom);
		this.updateSnapLineOverlay(snapLines);
	}

	/** Snap a single point to artboard/element edges on both axes. */
	private snapPoint(
		point: { x: number; y: number },
		zoom: number,
	): { point: { x: number; y: number }; snapLines: SnapLine[] } {
		const snapResult = this.context.snapArtboardToElements(
			{
				minX: point.x,
				maxX: point.x,
				minY: point.y,
				maxY: point.y,
				width: 0,
				height: 0,
			},
			zoom,
		);

		return {
			point: {
				x: point.x + snapResult.deltaX,
				y: point.y + snapResult.deltaY,
			},
			snapLines: snapResult.snapLines,
		};
	}

	/**
	 * Snap the drag end point to artboard/element edges, independently on
	 * each axis (mirrors ArtboardTool's create-drag snapping): the bounding
	 * box formed by start/end is probed at the end point's edge on each axis,
	 * and only that edge moves — start stays put as the shape's anchor.
	 */
	private snapEndPoint(
		start: { x: number; y: number },
		end: { x: number; y: number },
		zoom: number,
	): { point: { x: number; y: number }; snapLines: SnapLine[] } {
		const snapLines: SnapLine[] = [];

		const xSnap = this.context.snapArtboardToElements(
			{
				minX: end.x,
				maxX: end.x,
				minY: Math.min(start.y, end.y),
				maxY: Math.max(start.y, end.y),
				width: 0,
				height: Math.abs(end.y - start.y),
			},
			zoom,
		);
		const verticalLine = xSnap.snapLines.find(
			(line) => line.axis === "vertical",
		);
		if (verticalLine) snapLines.push(verticalLine);

		const ySnap = this.context.snapArtboardToElements(
			{
				minX: Math.min(start.x, end.x),
				maxX: Math.max(start.x, end.x),
				minY: end.y,
				maxY: end.y,
				width: Math.abs(end.x - start.x),
				height: 0,
			},
			zoom,
		);
		const horizontalLine = ySnap.snapLines.find(
			(line) => line.axis === "horizontal",
		);
		if (horizontalLine) snapLines.push(horizontalLine);

		return {
			point: {
				x: end.x + xSnap.deltaX,
				y: end.y + ySnap.deltaY,
			},
			snapLines,
		};
	}

	private updateSnapLineOverlay(lines: SnapLine[]): void {
		this.context.uiSetOverlay(
			OVERLAY_KEYS.shapeSnapLines,
			lines.length > 0
				? {
						zIndex: OVERLAY_Z.snapLine,
						primitives: buildSnapLineOverlay({ lines }, UI_THEME),
					}
				: null,
		);
	}

	private createShapePath(
		start: { x: number; y: number },
		end: { x: number; y: number },
		id: string,
	): Path {
		let adjustedEnd = end;

		// Shift: 正方形/正円/45度スナップ
		if (this.shiftKeyPressed) {
			adjustedEnd = this.constrainToSquare(start, end);
		}

		const segments = this.generateShapeSegments(start, adjustedEnd);

		const activeStroke = this.context.getActiveStrokeAppearance();
		const activeFill = this.context.getActiveFillAppearance();

		const filters: Filter[] = [];

		if (activeStroke) {
			filters.push(cloneAppearance(activeStroke));
		}
		if (activeFill) {
			filters.push(cloneAppearance(activeFill));
		}

		return {
			type: "path",
			id,
			transform: createIdentityTransform(),
			opacity: 1.0,
			blendMode: "normal",
			segments,
			filters,
		};
	}

	/**
	 * Remembers the pointer direction at the moment Shift takes effect, and
	 * forgets it once Shift is released. A drag too short to have a steady
	 * direction, such as one started with Shift already held, waits until it
	 * is long enough; the shape stays upright meanwhile.
	 */
	private trackShiftBaseAngle(
		start: { x: number; y: number },
		end: { x: number; y: number },
		zoom: number,
	): void {
		if (!this.shiftKeyPressed) {
			this.shiftBaseAngle = null;
			return;
		}
		if (this.shiftBaseAngle !== null) return;

		const dx = end.x - start.x;
		const dy = end.y - start.y;
		if (Math.hypot(dx, dy) * zoom < SHIFT_BASE_MIN_SCREEN_DISTANCE) return;
		this.shiftBaseAngle = Math.atan2(dy, dx);
	}

	private constrainToSquare(
		start: { x: number; y: number },
		end: { x: number; y: number },
	): { x: number; y: number } {
		const dx = end.x - start.x;
		const dy = end.y - start.y;
		const angle = Math.atan2(dy, dx);
		const length = Math.sqrt(dx * dx + dy * dy);

		// A star or a spiral stands upright when Shift takes effect, then leans by
		// the 45° steps the pointer has turned since, toward the side the pointer
		// moves to. Its upright part sits opposite a pointer below the center, so
		// the turn is mirrored there. A star's first tip and a spiral's outer end
		// face the returned end point.
		if (SHIFT_UPRIGHT_SHAPE_TYPES.has(this.options.shapeOption.type)) {
			const base = this.shiftBaseAngle ?? angle;
			const lean = Math.sin(base) < 0 ? base - angle : angle - base;
			const tipAngle =
				Math.PI / 2 + Math.round(lean / SHIFT_ANGLE_STEP) * SHIFT_ANGLE_STEP;
			return {
				x: start.x + Math.cos(tipAngle) * length,
				y: start.y + Math.sin(tipAngle) * length,
			};
		}

		// A line takes its direction from start to end, so Shift snaps that
		// direction to 45° steps instead of squaring the box.
		if (this.options.shapeOption.type === "line") {
			const snappedAngle =
				Math.round(angle / SHIFT_ANGLE_STEP) * SHIFT_ANGLE_STEP;
			return {
				x: start.x + Math.cos(snappedAngle) * length,
				y: start.y + Math.sin(snappedAngle) * length,
			};
		}

		// 他の図形: 正方形制約
		const size = Math.max(Math.abs(dx), Math.abs(dy));
		return {
			x: start.x + Math.sign(dx || 1) * size,
			y: start.y + Math.sign(dy || 1) * size,
		};
	}

	private generateShapeSegments(
		start: { x: number; y: number },
		end: { x: number; y: number },
	): CubicBezierSegment[] {
		const shape = this.options.shapeOption;
		switch (shape.type) {
			case "polygon":
				return generatePolygonSegments(start, end, shape.sides);
			case "ellipse":
				return generateEllipseSegments(start, end);
			case "line":
				return generateLineSegments(start, end);
			case "star":
				return generateStarSegments(start, end, shape.points, shape.depth);
			case "spiral":
				return generateSpiralSegments(start, end, shape.turns, shape.direction);
		}
	}
}

// --- Shape Segment Generators ---
// --- Utility Functions ---
