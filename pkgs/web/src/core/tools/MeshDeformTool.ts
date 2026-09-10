import { deepClone } from "valtio/utils";
import { buildMeshDeformOverlay } from "../renderer/ui/builders/meshDeform";
import { OVERLAY_KEYS } from "../renderer/ui/overlayKeys";
import { OVERLAY_Z, UI_THEME } from "../renderer/ui/theme";
import type { MeshDeformHandle, MeshDeformUIData } from "../renderer/ui/types";
import {
	type AnyArtObject,
	type BoundingBox,
	type ElementTransform,
	generateUid,
	type ImageObject,
	type MeshArtObject,
	type Path,
	type TextElement,
	type Viewport,
} from "../schema";
import {
	brandLocalBBox,
	calculateLocalElementBounds,
	calculateMeshCoordinateBounds,
	type LocalBBox,
	pointInPolygon,
	type WorldBBox,
} from "../utils/geometry/bounds";
import {
	composeTransforms,
	screenToWorld,
	solveChildTransform,
} from "../utils/geometry/geometry";
import {
	createLocalPointDeformer,
	type DeformableElement,
	deformGradientFilters,
	deformPathSegments,
	flattenElementIds,
	isDeformableElement,
	resolveStoredTransform,
} from "../utils/geometry/pointDeform";
import type { PointerEventData, Tool } from "./Tool";
import type { ToolContext } from "./ToolContext";

// --- Types ---

interface DragTarget {
	handleId: string;
	startX: number;
	startY: number;
}

type DragState =
	| { mode: "placing" }
	| {
			mode: "pending-drag";
			targets: DragTarget[];
			hitHandleId: string;
			startWorldX: number;
			startWorldY: number;
	  }
	| {
			mode: "dragging";
			targets: DragTarget[];
			hitHandleId: string;
			startWorldX: number;
			startWorldY: number;
	  }
	| {
			mode: "pending-lasso";
			startWorldX: number;
			startWorldY: number;
			shiftKey: boolean;
	  }
	| {
			mode: "lasso";
			path: Array<{ x: number; y: number }>;
			shiftKey: boolean;
	  };

interface OriginalGeometry {
	element: DeformableElement;
	ancestorTransform: ElementTransform | null;
	composedTransform: ElementTransform;
	localBounds: LocalBBox;
	worldBounds: WorldBBox;
}

// --- Main class ---

export class MeshDeformTool implements Tool {
	public readonly name = "mesh-deform";

	private context: ToolContext;
	private dragState: DragState = { mode: "placing" };

	private elementIds: string[] = [];
	private combinedBounds: BoundingBox | null = null;
	private originalGeometries: OriginalGeometry[] = [];

	private mesh: TriangleMesh | null = null;
	private uniqueEdges: Array<[number, number]> = [];
	private handles: MeshDeformHandle[] = [];

	private initialized = false;

	private lastClick: { handleId: string; time: number } | null = null;
	private longPressTimer: ReturnType<typeof setTimeout> | null = null;
	private longPressHandleId: string | null = null;
	private longPressRing: { worldX: number; worldY: number } | null = null;

	public constructor(context: ToolContext) {
		this.context = context;

		const selectedIds = context.getSelectedElementIds();
		if (selectedIds.length === 0) {
			context.complete();
			return;
		}

		// Collect elements and compute combined bounds
		let combinedMinX = Infinity;
		let combinedMinY = Infinity;
		let combinedMaxX = -Infinity;
		let combinedMaxY = -Infinity;

		// グループを再帰的にflattenしてリーフ要素IDを収集
		const leafIds = flattenElementIds(selectedIds, context.getElement);

		for (const id of leafIds) {
			const element = context.getElement(id);
			const bounds = context.getBounds(id);
			if (!element || !bounds) continue;

			this.elementIds.push(id);

			if (isDeformableElement(element)) {
				const ancestorTransform = context.getAncestorTransform(id);
				this.originalGeometries.push({
					element: deepClone(element),
					ancestorTransform,
					composedTransform: ancestorTransform
						? composeTransforms(ancestorTransform, element.transform)
						: element.transform,
					localBounds: calculateLocalElementBounds(element),
					worldBounds: { ...bounds },
				});
			}

			combinedMinX = Math.min(combinedMinX, bounds.minX);
			combinedMinY = Math.min(combinedMinY, bounds.minY);
			combinedMaxX = Math.max(combinedMaxX, bounds.maxX);
			combinedMaxY = Math.max(combinedMaxY, bounds.maxY);
		}

		if (this.elementIds.length === 0) {
			context.complete();
			return;
		}

		this.combinedBounds = {
			minX: combinedMinX,
			minY: combinedMinY,
			maxX: combinedMaxX,
			maxY: combinedMaxY,
			width: combinedMaxX - combinedMinX,
			height: combinedMaxY - combinedMinY,
		};

		// Create triangle mesh from combined bounds
		this.mesh = createTriangleMesh(this.combinedBounds, 10, 10);
		this.uniqueEdges = getUniqueEdges(this.mesh);

		// Build initial UI (no initial handles — user adds them manually)
		this.updateUI();
		this.initialized = true;
	}

	public onPointerDown(
		event: PointerEventData,
		viewport: Viewport,
		canvasWidth: number,
		canvasHeight: number,
	): void {
		if (!this.initialized) return;
		if (this.context.isReadonly()) return;
		if (this.elementIds.some((id) => this.context.isElementLocked(id))) return;

		const world = screenToWorld(
			event.x,
			event.y,
			viewport,
			canvasWidth,
			canvasHeight,
		);

		// Hit-test existing handles via the overlay channel (hitId = handle.id)
		const hit = this.context.uiHitTest({ x: event.x, y: event.y });
		const hitHandle: MeshDeformHandle | null =
			hit?.overlayKey === OVERLAY_KEYS.meshDeformHandles
				? (this.handles.find((h) => h.id === hit.hitId) ?? null)
				: null;

		if (hitHandle) {
			// ヒットしたハンドルが選択済み → 選択中の全ハンドルを同時移動対象
			// 未選択 → そのハンドル単体を移動対象
			const targets: DragTarget[] = hitHandle.selected
				? this.handles
						.filter((h) => h.selected)
						.map((h) => ({
							handleId: h.id,
							startX: h.currentX,
							startY: h.currentY,
						}))
				: [
						{
							handleId: hitHandle.id,
							startX: hitHandle.currentX,
							startY: hitHandle.currentY,
						},
					];

			this.dragState = {
				mode: "pending-drag",
				targets,
				hitHandleId: hitHandle.id,
				startWorldX: world.x,
				startWorldY: world.y,
			};

			this.startLongPressTimer(hitHandle.id);
		} else {
			// 空き領域: pending-lasso (ドラッグで投げ縄、クリックで新ハンドル)
			this.dragState = {
				mode: "pending-lasso",
				startWorldX: world.x,
				startWorldY: world.y,
				shiftKey: event.shiftKey,
			};
		}
	}

	public onPointerMove(
		event: PointerEventData,
		viewport: Viewport,
		canvasWidth: number,
		canvasHeight: number,
	): void {
		if (!this.initialized) return;
		if (this.dragState.mode === "placing") return;

		const world = screenToWorld(
			event.x,
			event.y,
			viewport,
			canvasWidth,
			canvasHeight,
		);

		if (this.dragState.mode === "pending-lasso") {
			const worldDist = Math.hypot(
				world.x - this.dragState.startWorldX,
				world.y - this.dragState.startWorldY,
			);
			if (worldDist * viewport.zoom > 3) {
				this.dragState = {
					mode: "lasso",
					shiftKey: this.dragState.shiftKey,
					path: [
						{ x: this.dragState.startWorldX, y: this.dragState.startWorldY },
						{ x: world.x, y: world.y },
					],
				};
				this.updateUI();
			}
			return;
		}

		if (this.dragState.mode === "lasso") {
			this.dragState.path.push({ x: world.x, y: world.y });
			this.updateUI();
			return;
		}

		if (this.dragState.mode === "pending-drag") {
			const worldDist = Math.hypot(
				world.x - this.dragState.startWorldX,
				world.y - this.dragState.startWorldY,
			);
			const screenDist = worldDist * viewport.zoom;

			if (screenDist > 3) {
				this.cancelLongPressTimer();
				this.dragState = { ...this.dragState, mode: "dragging" };
			} else {
				return;
			}
		}

		const state = this.dragState;
		if (state.mode !== "dragging") return;

		// Update all drag target handles
		const deltaX = world.x - state.startWorldX;
		const deltaY = world.y - state.startWorldY;

		for (const target of state.targets) {
			const handle = this.handles.find((h) => h.id === target.handleId);
			if (!handle) continue;
			handle.currentX = target.startX + deltaX;
			handle.currentY = target.startY + deltaY;
		}

		// Build RBFDeformer from all handles
		const deformer = RBFDeformer.fromHandles(this.handles);

		// Update mesh vertices
		if (this.mesh) {
			for (const vertex of this.mesh.vertices) {
				const deformed = deformer.transform(vertex.originalX, vertex.originalY);
				vertex.currentX = deformed.x;
				vertex.currentY = deformed.y;
			}
		}

		// Apply deformation to elements for preview
		const updates = this.computeDeformedUpdates(deformer);
		if (updates.length > 0) {
			this.context.previewDeformation(updates);
		}

		this.updateUI();
	}

	public onPointerUp(
		event: PointerEventData,
		viewport: Viewport,
		canvasWidth: number,
		canvasHeight: number,
	): void {
		if (!this.initialized) return;

		this.clearLongPressRing();

		if (this.dragState.mode === "pending-lasso") {
			// ドラッグなしのクリック → 新ハンドル追加
			const world = screenToWorld(
				event.x,
				event.y,
				viewport,
				canvasWidth,
				canvasHeight,
			);
			this.handles.push({
				id: generateUid("mesh-pt"),
				originalX: world.x,
				originalY: world.y,
				currentX: world.x,
				currentY: world.y,
				selected: false,
			});
			this.updateUI();
			this.dragState = { mode: "placing" };
			return;
		}

		if (this.dragState.mode === "lasso") {
			const polygon = this.dragState.path;

			if (this.dragState.shiftKey) {
				// Shift+投げ縄: 投げ縄内のハンドルの選択をトグル
				for (const handle of this.handles) {
					if (pointInPolygon(handle.currentX, handle.currentY, polygon)) {
						handle.selected = !handle.selected;
					}
				}
			} else {
				// 通常投げ縄: リプレース選択（既存選択を解除し、投げ縄内のみ選択）
				for (const handle of this.handles) {
					handle.selected = pointInPolygon(
						handle.currentX,
						handle.currentY,
						polygon,
					);
				}
			}

			this.dragState = { mode: "placing" };
			this.updateUI();
			return;
		}

		if (this.dragState.mode === "pending-drag") {
			this.cancelLongPressTimer();
			const hitId = this.dragState.hitHandleId;
			const now = performance.now();
			const isDoubleClick =
				this.lastClick !== null &&
				this.lastClick.handleId === hitId &&
				now - this.lastClick.time < 300;

			if (isDoubleClick) {
				// ダブルクリック → そのハンドルを削除
				this.lastClick = null;
				this.removeHandles(new Set([hitId]));
			} else {
				// シングルクリック → 選択トグル & クリック記録
				const handle = this.handles.find((h) => h.id === hitId);
				if (handle) handle.selected = !handle.selected;
				this.lastClick = { handleId: hitId, time: now };
				this.updateUI();
			}
		}

		this.dragState = { mode: "placing" };
	}

	public onKeyDown(
		event: KeyboardEvent,
		_viewport: Viewport,
		_canvasWidth: number,
		_canvasHeight: number,
	): boolean {
		if (!this.initialized) return false;

		if (event.code === "Delete" || event.code === "Backspace") {
			const selectedIds = new Set(
				this.handles.filter((h) => h.selected).map((h) => h.id),
			);
			if (selectedIds.size === 0) return false;

			this.removeHandles(selectedIds);
			return true;
		}

		if (event.code === "Enter") {
			this.applyDeformation();
			return true;
		}

		if (event.code === "Escape") {
			return false; // Let onCancel handle it
		}

		return false;
	}

	public onCancel(): void {
		if (!this.initialized) return;
		this.clearLongPressRing();
		this.initialized = false; // 二重呼び出し防止
		this.context.clearDeformationPreview(this.elementIds);
		this.restoreOriginal();
		this.updateDeformOverlay(null);
		this.context.complete();
	}

	public getCursor(): string {
		if (this.dragState.mode === "dragging") return "grabbing";
		if (this.dragState.mode === "pending-drag") return "grab";
		if (this.dragState.mode === "lasso") return "crosshair";
		return "crosshair";
	}

	/**
	 * Apply the current deformation and finalize.
	 * Called by Paplico on tool switch as well.
	 */
	public applyDeformation(options: { complete?: boolean } = {}): void {
		const shouldComplete = options.complete ?? true;
		if (!this.initialized) {
			if (shouldComplete) this.context.complete();
			return;
		}
		this.initialized = false;

		const deformer = RBFDeformer.fromHandles(this.handles);
		if (deformer.isIdentity) {
			this.context.clearDeformationPreview(this.elementIds);
			this.updateDeformOverlay(null);
			if (shouldComplete) this.context.complete();
			return;
		}

		const updates = this.computeDeformedUpdates(deformer);
		if (updates.length > 0) {
			this.context.applyDeformation(updates);
		}

		this.updateDeformOverlay(null);
		if (shouldComplete) this.context.complete();
	}

	// --- Private helpers ---

	private startLongPressTimer(handleId: string): void {
		this.cancelLongPressTimer();
		this.longPressHandleId = handleId;
		this.longPressTimer = setTimeout(() => {
			this.longPressTimer = null;
			if (
				this.dragState.mode === "pending-drag" &&
				this.longPressHandleId === handleId
			) {
				const handle = this.handles.find((h) => h.id === handleId);
				if (handle) {
					this.longPressRing = {
						worldX: handle.currentX,
						worldY: handle.currentY,
					};
				}
				this.longPressHandleId = null;
				this.lastClick = null;
				this.removeHandles(new Set([handleId]));
				this.dragState = { mode: "placing" };
			}
		}, 500);
	}

	private cancelLongPressTimer(): void {
		if (this.longPressTimer != null) {
			clearTimeout(this.longPressTimer);
			this.longPressTimer = null;
		}
		this.longPressHandleId = null;
	}

	private clearLongPressRing(): void {
		this.cancelLongPressTimer();
		this.longPressRing = null;
	}

	/**
	 * 指定IDのハンドルを削除し、RBFを再計算してプレビューを更新する。
	 * Delete/Backspaceキー、ダブルクリック削除、長押し削除の共通処理。
	 */
	private removeHandles(idsToRemove: Set<string>): void {
		if (idsToRemove.size === 0) return;

		this.handles = this.handles.filter((h) => !idsToRemove.has(h.id));

		const deformer = RBFDeformer.fromHandles(this.handles);
		if (deformer.isIdentity) {
			this.restoreOriginal();
		} else {
			if (this.mesh) {
				for (const vertex of this.mesh.vertices) {
					const deformed = deformer.transform(
						vertex.originalX,
						vertex.originalY,
					);
					vertex.currentX = deformed.x;
					vertex.currentY = deformed.y;
				}
			}
			const updates = this.computeDeformedUpdates(deformer);
			if (updates.length > 0) {
				this.context.previewDeformation(updates);
			}
		}

		this.updateUI();
	}

	private restoreOriginal(): void {
		const layerId = this.context.getCurrentLayerId();
		if (!layerId) return;

		const updates: Array<{
			elementId: string;
			layerId: string;
			updates: Partial<AnyArtObject>;
		}> = [];

		for (const original of this.originalGeometries) {
			const { element } = original;
			if (element.type === "path") {
				updates.push({
					elementId: element.id,
					layerId,
					updates: {
						segments: structuredClone(element.segments),
						transform: { ...element.transform },
					} as Partial<Path>,
				});
			} else if (element.type === "image") {
				updates.push({
					elementId: element.id,
					layerId,
					updates: {
						transform: { ...element.transform },
					} as Partial<ImageObject>,
				});
			} else if (element.type === "text") {
				updates.push({
					elementId: element.id,
					layerId,
					updates: {
						transform: { ...element.transform },
					} as Partial<TextElement>,
				});
			} else if (element.type === "mesh") {
				updates.push({
					elementId: element.id,
					layerId,
					updates: {
						vertices: structuredClone(element.vertices),
						transform: { ...element.transform },
					} as Partial<MeshArtObject>,
				});
			}
		}

		if (updates.length > 0) {
			this.context.restoreOriginal(updates);
		}
	}

	private computeDeformedUpdates(deformer: RBFDeformer): Array<{
		elementId: string;
		layerId: string;
		updates: Partial<AnyArtObject>;
	}> {
		const layerId = this.context.getCurrentLayerId();
		if (!layerId) return [];

		const updates: Array<{
			elementId: string;
			layerId: string;
			updates: Partial<AnyArtObject>;
		}> = [];

		for (const original of this.originalGeometries) {
			const { element } = original;
			if (element.type === "path") {
				const deformPoint = createLocalPointDeformer(original, (x, y) =>
					deformer.transform(x, y),
				);
				const segments = deformPathSegments(element.segments, deformPoint);
				const newLocalBounds = calculateLocalElementBounds({
					...element,
					segments,
				});
				const filters = deformGradientFilters(
					element,
					deformPoint,
					original.localBounds,
					newLocalBounds,
					{ x: 0, y: 0 },
				);
				updates.push({
					elementId: element.id,
					layerId,
					updates: {
						segments,
						transform: resolveStoredTransform(original, newLocalBounds, {
							x: 0,
							y: 0,
						}),
						...(filters ? { filters } : {}),
					} as Partial<Path>,
				});
			} else if (element.type === "image" || element.type === "text") {
				const center = {
					x: (original.worldBounds.minX + original.worldBounds.maxX) / 2,
					y: (original.worldBounds.minY + original.worldBounds.maxY) / 2,
				};
				const deformed = deformer.transform(center.x, center.y);
				const composedTransform = {
					...original.composedTransform,
					x: original.composedTransform.x + deformed.x - center.x,
					y: original.composedTransform.y + deformed.y - center.y,
				};
				const transform = original.ancestorTransform
					? solveChildTransform(original.ancestorTransform, composedTransform)
					: composedTransform;
				updates.push({
					elementId: element.id,
					layerId,
					updates: { transform },
				});
			} else if (element.type === "mesh") {
				const deformPoint = createLocalPointDeformer(original, (x, y) =>
					deformer.transform(x, y),
				);
				// Warp cage vertices + handles only; `src` must stay untouched so
				// the source parametrization (and therefore the children's warp)
				// follows the moved cage.
				const vertices = element.vertices.map((vertex) => {
					const point = deformPoint(vertex);
					const handles: Record<number, { x: number; y: number }> = {};
					for (const [key, handle] of Object.entries(vertex.handles)) {
						handles[Number(key)] = deformPoint(handle);
					}
					return { ...vertex, ...point, handles };
				});
				const newLocalBounds = brandLocalBBox(
					calculateMeshCoordinateBounds(vertices),
				);
				const filters = deformGradientFilters(
					element,
					deformPoint,
					original.localBounds,
					newLocalBounds,
					{ x: 0, y: 0 },
				);
				updates.push({
					elementId: element.id,
					layerId,
					updates: {
						vertices,
						transform: resolveStoredTransform(original, newLocalBounds, {
							x: 0,
							y: 0,
						}),
						...(filters ? { filters } : {}),
					} as Partial<MeshArtObject>,
				});
			}
		}

		return updates;
	}

	private updateUI(): void {
		if (!this.mesh || !this.combinedBounds) return;

		const edges = buildEdgeLines(this.mesh, this.uniqueEdges);

		this.updateDeformOverlay({
			edges,
			handles: this.handles.map((h) => ({ ...h })),
			originalBounds: { ...this.combinedBounds },
			lassoPath:
				this.dragState.mode === "lasso"
					? this.dragState.path.map((p) => ({ ...p }))
					: undefined,
			longPressRing: this.longPressRing ?? undefined,
		});
	}

	private updateDeformOverlay(data: MeshDeformUIData | null): void {
		this.context.uiSetOverlay(
			OVERLAY_KEYS.meshDeformHandles,
			data
				? {
						zIndex: OVERLAY_Z.meshDeform,
						primitives: buildMeshDeformOverlay(data, UI_THEME),
					}
				: null,
		);
		// Session info for React overlays (MeshDeformHintOverlay shows the
		// "click to add handles" hint while handleCount === 0).
		this.context.uiSetToolSession(
			data
				? {
						type: "mesh-deform",
						originalBounds: data.originalBounds,
						handleCount: data.handles.length,
					}
				: null,
		);
	}
}

// ============================================================
// Mesh Grid
// ============================================================

// --- Types ---

interface MeshVertex {
	originalX: number;
	originalY: number;
	currentX: number;
	currentY: number;
}

interface MeshTriangle {
	v0: number;
	v1: number;
	v2: number;
}

interface MeshEdge {
	x1: number;
	y1: number;
	x2: number;
	y2: number;
}

export interface TriangleMesh {
	vertices: MeshVertex[];
	triangles: MeshTriangle[];
}

// --- Main functions ---

/**
 * バウンディングボックスを cols x rows のグリッドに分割し、
 * 各セルを2つの三角形に分割した三角形メッシュを生成する。
 */
export function createTriangleMesh(
	bounds: {
		minX: number;
		minY: number;
		maxX: number;
		maxY: number;
		width: number;
		height: number;
	},
	cols = 10,
	rows = 10,
): TriangleMesh {
	const vertices: MeshVertex[] = [];
	const triangles: MeshTriangle[] = [];

	const cellW = bounds.width / cols;
	const cellH = bounds.height / rows;

	// (cols+1) x (rows+1) の頂点を生成
	for (let row = 0; row <= rows; row++) {
		for (let col = 0; col <= cols; col++) {
			const x = bounds.minX + col * cellW;
			const y = bounds.minY + row * cellH;
			vertices.push({
				originalX: x,
				originalY: y,
				currentX: x,
				currentY: y,
			});
		}
	}

	// 各セルを2つの三角形に分割
	const stride = cols + 1;
	for (let row = 0; row < rows; row++) {
		for (let col = 0; col < cols; col++) {
			const tl = row * stride + col;
			const tr = tl + 1;
			const bl = (row + 1) * stride + col;
			const br = bl + 1;

			// triangle 1: top-left, top-right, bottom-right
			triangles.push({ v0: tl, v1: tr, v2: br });
			// triangle 2: top-left, bottom-right, bottom-left
			triangles.push({ v0: tl, v1: br, v2: bl });
		}
	}

	return { vertices, triangles };
}

/**
 * 三角形メッシュからユニークなエッジ（頂点インデックスペア）を抽出する。
 * 各エッジは共有する三角形の数に関係なく1回だけ含まれる。
 */
export function getUniqueEdges(mesh: TriangleMesh): Array<[number, number]> {
	const seen = new Set<string>();
	const edges: Array<[number, number]> = [];

	for (const tri of mesh.triangles) {
		addEdge(tri.v0, tri.v1, seen, edges);
		addEdge(tri.v1, tri.v2, seen, edges);
		addEdge(tri.v2, tri.v0, seen, edges);
	}

	return edges;
}

/**
 * 頂点インデックスペアのエッジ配列を、現在の頂点座標を使った座標ペアに変換する。
 */
export function buildEdgeLines(
	mesh: TriangleMesh,
	edges: Array<[number, number]>,
): MeshEdge[] {
	return edges.map(([a, b]) => {
		const va = mesh.vertices[a];
		const vb = mesh.vertices[b];
		return {
			x1: va.currentX,
			y1: va.currentY,
			x2: vb.currentX,
			y2: vb.currentY,
		};
	});
}

// --- Mesh Grid helpers ---

/** エッジを重複排除付きで追加する */
function addEdge(
	a: number,
	b: number,
	seen: Set<string>,
	edges: Array<[number, number]>,
): void {
	const lo = Math.min(a, b);
	const hi = Math.max(a, b);
	const key = `${lo}-${hi}`;
	if (seen.has(key)) return;
	seen.add(key);
	edges.push([lo, hi]);
}

// ============================================================
// RBF Deformer
// ============================================================

interface RBFHandle {
	readonly originalX: number;
	readonly originalY: number;
	readonly currentX: number;
	readonly currentY: number;
}

export class RBFDeformer {
	public readonly isIdentity: boolean;

	private readonly originX: Float64Array;
	private readonly originY: Float64Array;
	private readonly weightsX: Float64Array;
	private readonly weightsY: Float64Array;
	private readonly n: number;

	// Affine terms: a0 + a1*x + a2*y
	private readonly affineX: [a0: number, a1: number, a2: number];
	private readonly affineY: [a0: number, a1: number, a2: number];

	private constructor(
		originX: Float64Array,
		originY: Float64Array,
		weightsX: Float64Array,
		weightsY: Float64Array,
		affineX: [number, number, number],
		affineY: [number, number, number],
		isIdentity: boolean,
	) {
		this.originX = originX;
		this.originY = originY;
		this.weightsX = weightsX;
		this.weightsY = weightsY;
		this.n = originX.length;
		this.affineX = affineX;
		this.affineY = affineY;
		this.isIdentity = isIdentity;
	}

	/**
	 * Build an RBF deformer from a set of control handles.
	 * Each handle has original position and current (displaced) position.
	 * Returns an identity deformer if handles array is empty or no displacement exists.
	 */
	public static fromHandles(handles: ReadonlyArray<RBFHandle>): RBFDeformer {
		const empty = new Float64Array(0);
		const identity = new RBFDeformer(
			empty,
			empty,
			empty,
			empty,
			[0, 0, 0],
			[0, 0, 0],
			true,
		);

		if (handles.length === 0) return identity;

		const n = handles.length;
		const EPS = 1e-10;

		// Check if any handle has non-zero displacement
		let hasDisplacement = false;
		for (let i = 0; i < n; i++) {
			const dx = handles[i].currentX - handles[i].originalX;
			const dy = handles[i].currentY - handles[i].originalY;
			if (Math.abs(dx) > EPS || Math.abs(dy) > EPS) {
				hasDisplacement = true;
				break;
			}
		}

		if (!hasDisplacement) return identity;

		const originX = new Float64Array(n);
		const originY = new Float64Array(n);
		const dispX = new Float64Array(n);
		const dispY = new Float64Array(n);

		for (let i = 0; i < n; i++) {
			originX[i] = handles[i].originalX;
			originY[i] = handles[i].originalY;
			dispX[i] = handles[i].currentX - handles[i].originalX;
			dispY[i] = handles[i].currentY - handles[i].originalY;
		}

		const size = n + 3;

		// Build the augmented matrix [K P; P^T 0]
		const matX = buildAugmentedMatrix(n, size, originX, originY, dispX);
		const matY = buildAugmentedMatrix(n, size, originX, originY, dispY);

		solveInPlace(matX, size);
		solveInPlace(matY, size);

		const weightsX = new Float64Array(n);
		const weightsY = new Float64Array(n);

		for (let i = 0; i < n; i++) {
			weightsX[i] = matX[i * (size + 1) + size];
			weightsY[i] = matY[i * (size + 1) + size];
		}

		const affineX: [number, number, number] = [
			matX[n * (size + 1) + size],
			matX[(n + 1) * (size + 1) + size],
			matX[(n + 2) * (size + 1) + size],
		];
		const affineY: [number, number, number] = [
			matY[n * (size + 1) + size],
			matY[(n + 1) * (size + 1) + size],
			matY[(n + 2) * (size + 1) + size],
		];

		return new RBFDeformer(
			originX,
			originY,
			weightsX,
			weightsY,
			affineX,
			affineY,
			false,
		);
	}

	/**
	 * Transform a world-space point through the deformation field.
	 * Returns the deformed position.
	 */
	public transform(x: number, y: number): { x: number; y: number } {
		if (this.isIdentity) return { x, y };

		let dx = this.affineX[0] + this.affineX[1] * x + this.affineX[2] * y;
		let dy = this.affineY[0] + this.affineY[1] * x + this.affineY[2] * y;

		for (let i = 0; i < this.n; i++) {
			const ex = x - this.originX[i];
			const ey = y - this.originY[i];
			const phi = thinPlateSpline(ex, ey);
			dx += this.weightsX[i] * phi;
			dy += this.weightsY[i] * phi;
		}

		return { x: x + dx, y: y + dy };
	}
}

// --- RBF helpers ---

/** Thin-plate spline basis function: r^2 * ln(r), where r = sqrt(ex^2 + ey^2).
 *  Returns 0 when r is near zero. */
function thinPlateSpline(ex: number, ey: number): number {
	const r2 = ex * ex + ey * ey;
	if (r2 < 1e-20) return 0;
	return 0.5 * r2 * Math.log(r2); // r^2 * ln(r) = 0.5 * r^2 * ln(r^2)
}

/**
 * Build the augmented matrix [A | b] for the TPS linear system.
 * A is (N+3)x(N+3), b is the displacement vector padded with zeros.
 * Stored as a flat row-major array with (size+1) columns (last column = RHS).
 */
function buildAugmentedMatrix(
	n: number,
	size: number,
	originX: Float64Array,
	originY: Float64Array,
	disp: Float64Array,
): Float64Array {
	const cols = size + 1;
	const mat = new Float64Array(size * cols);
	const REG = 1e-8;

	// Fill K block (N x N) with regularization on diagonal
	for (let i = 0; i < n; i++) {
		for (let j = i; j < n; j++) {
			if (i === j) {
				mat[i * cols + j] = REG;
			} else {
				const phi = thinPlateSpline(
					originX[i] - originX[j],
					originY[i] - originY[j],
				);
				mat[i * cols + j] = phi;
				mat[j * cols + i] = phi;
			}
		}
	}

	// Fill P block (N x 3) and P^T block (3 x N)
	for (let i = 0; i < n; i++) {
		mat[i * cols + n] = 1;
		mat[i * cols + n + 1] = originX[i];
		mat[i * cols + n + 2] = originY[i];

		mat[n * cols + i] = 1;
		mat[(n + 1) * cols + i] = originX[i];
		mat[(n + 2) * cols + i] = originY[i];
	}

	// RHS: displacements for first N rows, 0 for last 3
	for (let i = 0; i < n; i++) {
		mat[i * cols + size] = disp[i];
	}

	return mat;
}

/**
 * Solve the linear system in-place using Gaussian elimination with partial pivoting.
 * The matrix is stored as a flat row-major array with (size+1) columns.
 * After solving, the last column contains the solution.
 */
function solveInPlace(mat: Float64Array, size: number): void {
	const cols = size + 1;

	for (let col = 0; col < size; col++) {
		// Partial pivoting: find the row with the largest absolute value in this column
		let maxVal = Math.abs(mat[col * cols + col]);
		let maxRow = col;

		for (let row = col + 1; row < size; row++) {
			const val = Math.abs(mat[row * cols + col]);
			if (val > maxVal) {
				maxVal = val;
				maxRow = row;
			}
		}

		// Swap rows if needed
		if (maxRow !== col) {
			for (let k = col; k < cols; k++) {
				const tmp = mat[col * cols + k];
				mat[col * cols + k] = mat[maxRow * cols + k];
				mat[maxRow * cols + k] = tmp;
			}
		}

		const pivot = mat[col * cols + col];
		if (Math.abs(pivot) < 1e-20) continue;

		// Eliminate below
		for (let row = col + 1; row < size; row++) {
			const factor = mat[row * cols + col] / pivot;
			for (let k = col; k < cols; k++) {
				mat[row * cols + k] -= factor * mat[col * cols + k];
			}
		}
	}

	// Back substitution
	for (let row = size - 1; row >= 0; row--) {
		const pivot = mat[row * cols + row];
		if (Math.abs(pivot) < 1e-20) {
			mat[row * cols + size] = 0;
			continue;
		}

		let sum = mat[row * cols + size];
		for (let k = row + 1; k < size; k++) {
			sum -= mat[row * cols + k] * mat[k * cols + size];
		}
		mat[row * cols + size] = sum / pivot;
	}
}
