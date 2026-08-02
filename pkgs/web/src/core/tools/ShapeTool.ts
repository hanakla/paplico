/**
 * ShapeTool - 図形描画ツール
 * 矩形、楕円、直線、スター、スパイラルをサポート
 */

import { nanoid } from "nanoid";
import { createIdentityTransform } from "../document/factory";
import { buildSnapLineOverlay } from "../renderer/ui/builders/snapLine";
import { OVERLAY_KEYS } from "../renderer/ui/overlayKeys";
import { OVERLAY_Z, UI_THEME } from "../renderer/ui/theme";
import type { SnapLine } from "../renderer/ui/types";
import {
	type BezierPoint,
	type CubicBezierSegment,
	cloneAppearance,
	type Filter,
	type Path,
	type Viewport,
} from "../schema";
import { screenToWorld } from "../utils/geometry/geometry";
import type { PointerEventData, Tool } from "./Tool";
import type { ToolContext } from "./ToolContext";
import type { ShapeType } from "./toolSettings";

// --- Types ---

export interface ShapeToolOptions {
	shapeType: ShapeType;
	/** スター: 頂点数 (3以上) */
	starPoints?: number;
	/** スター: 内側半径の比率 (0-1) */
	starInnerRatio?: number;
	/** スパイラル: 回転数 */
	spiralTurns?: number;
	/** スパイラル: 方向 (1=時計回り, -1=反時計回り) */
	spiralDirection?: 1 | -1;
}

// --- Main ShapeTool Class ---

export class ShapeTool implements Tool {
	public readonly name = "shape";

	private context: ToolContext;
	private options: ShapeToolOptions;
	private dragStartWorld: { x: number; y: number } | null = null;
	private isDragging = false;
	private shiftKeyPressed = false;

	public constructor(context: ToolContext, options: ShapeToolOptions) {
		this.context = context;
		this.options = {
			starPoints: 5,
			starInnerRatio: 0.5,
			spiralTurns: 3,
			spiralDirection: 1,
			...options,
		};
	}

	// --- Public Methods ---
	public setOptions(options: Partial<ShapeToolOptions>): void {
		this.options.shapeType = options.shapeType ?? this.options.shapeType;
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

		this.dragStartWorld = worldPos;
		this.isDragging = true;
		this.shiftKeyPressed = event.shiftKey;
	}

	public onPointerMove(
		event: PointerEventData,
		viewport: Viewport,
		canvasWidth: number,
		canvasHeight: number,
	): void {
		if (!this.isDragging || !this.dragStartWorld) return;

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
		this.context.previewUpdate(null);
		this.updateSnapLineOverlay([]);
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

	private constrainToSquare(
		start: { x: number; y: number },
		end: { x: number; y: number },
	): { x: number; y: number } {
		const dx = end.x - start.x;
		const dy = end.y - start.y;

		if (this.options.shapeType === "line") {
			// 直線: 45度スナップ
			const angle = Math.atan2(dy, dx);
			const snappedAngle = Math.round(angle / (Math.PI / 4)) * (Math.PI / 4);
			const length = Math.sqrt(dx * dx + dy * dy);
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
		switch (this.options.shapeType) {
			case "rectangle":
				return generateRectangleSegments(start, end);
			case "ellipse":
				return generateEllipseSegments(start, end);
			case "line":
				return generateLineSegments(start, end);
			case "star":
				return generateStarSegments(
					start,
					end,
					this.options.starPoints!,
					this.options.starInnerRatio!,
				);
			case "spiral":
				return generateSpiralSegments(
					start,
					end,
					this.options.spiralTurns!,
					this.options.spiralDirection!,
				);
			default:
				return generateRectangleSegments(start, end);
		}
	}
}

// --- Shape Segment Generators ---

export function generateRectangleSegments(
	start: { x: number; y: number },
	end: { x: number; y: number },
): CubicBezierSegment[] {
	const minX = Math.min(start.x, end.x);
	const maxX = Math.max(start.x, end.x);
	const minY = Math.min(start.y, end.y);
	const maxY = Math.max(start.y, end.y);

	// 4つの角を結ぶ直線セグメント（閉じたパス）
	const corners: BezierPoint[] = [
		{ x: minX, y: maxY }, // 左上
		{ x: maxX, y: maxY }, // 右上
		{ x: maxX, y: minY }, // 右下
		{ x: minX, y: minY }, // 左下
	];

	return createClosedPolygonSegments(corners);
}

/** Approximated with 4 cubic Bezier curves */
function generateEllipseSegments(
	start: { x: number; y: number },
	end: { x: number; y: number },
): CubicBezierSegment[] {
	const cx = (start.x + end.x) / 2;
	const cy = (start.y + end.y) / 2;
	const rx = Math.abs(end.x - start.x) / 2;
	const ry = Math.abs(end.y - start.y) / 2;

	// ベジェ曲線で円を近似する際の制御点係数
	// κ ≈ 0.5522847498
	const kappa = 0.5522847498;
	const kx = rx * kappa;
	const ky = ry * kappa;

	// 4つの象限に分けて描画（cp1/cp2は相対オフセット）
	const segments: CubicBezierSegment[] = [
		// 右 → 上: start=(cx+rx, cy), end=(cx, cy+ry)
		{
			start: { x: cx + rx, y: cy },
			cp1: { x: 0, y: ky },
			cp2: { x: kx, y: 0 },
			end: { x: cx, y: cy + ry },
			isMoved: true,
			startTiltX: 0,
			startTiltY: 0,
			endTiltX: 0,
			endTiltY: 0,
			startDeltaTime: 0,
			endDeltaTime: 0,
		},
		// 上 → 左: start=prevEnd=(cx, cy+ry), end=(cx-rx, cy)
		{
			cp1: { x: -kx, y: 0 },
			cp2: { x: 0, y: ky },
			end: { x: cx - rx, y: cy },
			isMoved: false,
			startTiltX: 0,
			startTiltY: 0,
			endTiltX: 0,
			endTiltY: 0,
			startDeltaTime: 0,
			endDeltaTime: 0,
		},
		// 左 → 下: start=prevEnd=(cx-rx, cy), end=(cx, cy-ry)
		{
			cp1: { x: 0, y: -ky },
			cp2: { x: -kx, y: 0 },
			end: { x: cx, y: cy - ry },
			isMoved: false,
			startTiltX: 0,
			startTiltY: 0,
			endTiltX: 0,
			endTiltY: 0,
			startDeltaTime: 0,
			endDeltaTime: 0,
		},
		// 下 → 右（閉じる）: start=prevEnd=(cx, cy-ry), end=(cx+rx, cy)
		{
			cp1: { x: kx, y: 0 },
			cp2: { x: 0, y: -ky },
			end: { x: cx + rx, y: cy },
			isMoved: false,
			isClosed: true,
			startTiltX: 0,
			startTiltY: 0,
			endTiltX: 0,
			endTiltY: 0,
			startDeltaTime: 0,
			endDeltaTime: 0,
		},
	];

	return segments;
}

function generateLineSegments(
	start: { x: number; y: number },
	end: { x: number; y: number },
): CubicBezierSegment[] {
	// 直線: コントロールポイントを直線上に配置（相対オフセット）
	const dx = end.x - start.x;
	const dy = end.y - start.y;

	return [
		{
			start: { x: start.x, y: start.y },
			cp1: { x: dx / 2, y: dy / 2 },
			cp2: { x: -dx / 2, y: -dy / 2 },
			end: { x: end.x, y: end.y },
			isMoved: true,
			startTiltX: 0,
			startTiltY: 0,
			endTiltX: 0,
			endTiltY: 0,
			startDeltaTime: 0,
			endDeltaTime: 0,
		},
	];
}

/** Center at start, radius = distance to end, rotates toward mouse position */
function generateStarSegments(
	start: { x: number; y: number },
	end: { x: number; y: number },
	points: number,
	innerRatio: number,
): CubicBezierSegment[] {
	const cx = start.x;
	const cy = start.y;
	const dx = end.x - start.x;
	const dy = end.y - start.y;
	const outerRadius = Math.sqrt(dx * dx + dy * dy);
	const innerRadius = outerRadius * innerRatio;

	// マウス位置の角度を取得 (Y軸が下向き正なので符号反転)
	const mouseAngle = Math.atan2(-dy, dx);
	// 最初の頂点がマウス位置を向くように調整
	const startAngle = mouseAngle - Math.PI / 2;

	const vertices: BezierPoint[] = [];
	const angleStep = Math.PI / points;

	for (let i = 0; i < points * 2; i++) {
		const angle = startAngle + i * angleStep;
		const radius = i % 2 === 0 ? outerRadius : innerRadius;
		vertices.push({
			x: cx + Math.cos(angle) * radius,
			y: cy - Math.sin(angle) * radius, // Y軸反転
		});
	}

	return createClosedPolygonSegments(vertices);
}

/** Smooth approximation using cubic Bezier curves */
function generateSpiralSegments(
	start: { x: number; y: number },
	end: { x: number; y: number },
	turns: number,
	direction: 1 | -1,
): CubicBezierSegment[] {
	const cx = start.x;
	const cy = start.y;
	const dx = end.x - start.x;
	const dy = end.y - start.y;
	const maxRadius = Math.sqrt(dx * dx + dy * dy);
	const mouseAngle = Math.atan2(-dy, dx);

	const segments: CubicBezierSegment[] = [];
	const totalAngle = turns * 2 * Math.PI * direction;
	const steps = turns * 16;

	for (let i = 0; i < steps; i++) {
		const t0 = i / steps;
		const t1 = (i + 1) / steps;
		const r0 = maxRadius * t0;
		const r1 = maxRadius * t1;
		const dr = r1 - r0;

		const angle0 = mouseAngle + totalAngle * t0;
		const angle1 = mouseAngle + totalAngle * t1;
		const dTheta = angle1 - angle0;

		// World座標での位置 (angle は画面座標ベースなので Y軸反転が必要)
		const cos0 = Math.cos(angle0);
		const sin0 = Math.sin(angle0);
		const cos1 = Math.cos(angle1);
		const sin1 = Math.sin(angle1);

		const p0 = {
			x: cx + cos0 * r0,
			y: cy - sin0 * r0,
		};
		const p1 = {
			x: cx + cos1 * r1,
			y: cy - sin1 * r1,
		};

		// スパイラルの接線ベクトル (World座標系)
		// d/dt [(r·cos θ, r·(-sin θ))] = (dr·cos θ - r·dθ·sin θ, -dr·sin θ - r·dθ·cos θ)
		const tangent0 = {
			x: dr * cos0 - r0 * dTheta * sin0,
			y: -dr * sin0 - r0 * dTheta * cos0,
		};
		const tangent1 = {
			x: dr * cos1 - r1 * dTheta * sin1,
			y: -dr * sin1 - r1 * dTheta * cos1,
		};

		// 制御点の距離(経験的に1/3)、相対オフセット
		const cp1 = {
			x: tangent0.x / 3,
			y: tangent0.y / 3,
		};
		const cp2 = {
			x: -tangent1.x / 3,
			y: -tangent1.y / 3,
		};

		segments.push({
			start: i === 0 ? p0 : undefined,
			cp1,
			cp2,
			end: p1,
			isMoved: i === 0,
			startTiltX: 0,
			startTiltY: 0,
			endTiltX: 0,
			endTiltY: 0,
			startDeltaTime: 0,
			endDeltaTime: 0,
		});
	}

	return segments;
}

// --- Utility Functions ---

function createClosedPolygonSegments(
	vertices: BezierPoint[],
): CubicBezierSegment[] {
	const segments: CubicBezierSegment[] = [];

	for (let i = 0; i < vertices.length; i++) {
		const p1 = vertices[i];
		const p2 = vertices[(i + 1) % vertices.length];

		// 直線セグメント（cp1/cp2は相対オフセット）
		const dx = p2.x - p1.x;
		const dy = p2.y - p1.y;
		segments.push({
			start: i === 0 ? p1 : undefined,
			cp1: { x: dx * 0.33, y: dy * 0.33 },
			cp2: { x: -dx * 0.33, y: -dy * 0.33 },
			end: p2,
			isMoved: i === 0,
			isClosed: i === vertices.length - 1 || undefined,
			startTiltX: 0,
			startTiltY: 0,
			endTiltX: 0,
			endTiltY: 0,
			startDeltaTime: 0,
			endDeltaTime: 0,
		});
	}

	return segments;
}
