import { cornersFromBounds } from "../renderer/filters/perspectiveWarp";
import { buildPerspectiveWarpOverlay } from "../renderer/ui/builders/perspectiveWarp";
import { OVERLAY_KEYS } from "../renderer/ui/overlayKeys";
import { OVERLAY_Z, UI_THEME } from "../renderer/ui/theme";
import type { Vec2, Viewport } from "../schema";
import {
	applyTransformToPoint,
	composeTransforms,
	screenToWorld,
} from "../utils/geometry/geometry";
import { constrainAxis } from "./SelectTool";
import type { PointerEventData, Tool } from "./Tool";
import type { ToolContext } from "./ToolContext";

/** Screen-space pick radius for corner handles and click-to-select. */
const HANDLE_HIT_SCREEN_PX = 10;

interface Corner {
	x: number;
	y: number;
}

/**
 * Free-transform tool: CLIP STUDIO「自由変形」/ Illustrator Free Distort. Drag
 * any of the four corner handles independently to warp the selected element(s)
 * with a real projective transform (perspective foreshortening) — something the
 * affine transform cannot express. The warp is baked into vertex data on
 * commit (no live filter): path anchors/CPs are re-projected with adaptive
 * subdivision, an image's four corner vertices are rewritten (and re-grabbable
 * for further editing), mesh vertices are warped, and text is auto-outlined
 * into paths first (the original text stays hidden inside the group).
 *
 * MVP: corners are treated in world space, which matches identity-transform
 * elements (the common case). A non-handle press only changes the selection —
 * move/rotate stay on the SelectTool.
 */
export class FreeTransformTool implements Tool {
	public readonly name = "free-transform";

	private context: ToolContext;
	private selectedIds: string[] = [];
	/** The un-warped reference quad the drag maps from (fixed during a drag). */
	private sourceCorners: Corner[] = [];
	/** Current warped corners in world space, ordered TL, TR, BR, BL. */
	private corners: Corner[] = [];
	/** Handle indices toggled with Shift+click; they drag together as one. */
	private selectedCornerIndices = new Set<number>();
	private drag: {
		/** Corner indices moving with this drag (the grabbed one, or the
		 * Shift-selected set when the grabbed handle is part of it). */
		indices: number[];
		startWorld: Corner;
		startCorners: Corner[];
	} | null = null;

	public constructor(context: ToolContext) {
		this.context = context;
		this.rebuildTargets();
		this.emitGizmo();
	}

	/**
	 * Snapshot the selection into ids + source/current corner quads. A single
	 * selected image with baked corner vertices restores them so the quad can
	 * be re-grabbed; anything else starts from the selection's AABB corners.
	 */
	private rebuildTargets(): void {
		const ids = this.context.getSelectedElementIds();
		const prevIds = this.selectedIds;
		this.selectedIds = [];
		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		for (const id of ids) {
			const bounds = this.context.getBounds(id);
			if (!bounds) continue;
			this.selectedIds.push(id);
			minX = Math.min(minX, bounds.minX);
			minY = Math.min(minY, bounds.minY);
			maxX = Math.max(maxX, bounds.maxX);
			maxY = Math.max(maxY, bounds.maxY);
		}

		// Corner-handle selection belongs to one element selection: switching
		// to another object (or clearing) drops it.
		if (
			this.selectedIds.length !== prevIds.length ||
			this.selectedIds.some((id, i) => prevIds[i] !== id)
		) {
			this.selectedCornerIndices.clear();
		}

		if (this.selectedIds.length === 0) {
			this.sourceCorners = [];
			this.corners = [];
			return;
		}

		const single =
			this.selectedIds.length === 1
				? this.context.getElement(this.selectedIds[0])
				: null;
		let restored: Corner[] | null = null;
		if (single?.type === "image" && single.corners) {
			// Stored corners live in the rect's local space while the gizmo works
			// in world space: map them through the composed transform around the
			// rect centre (the renderer's transform origin). Without this, an
			// image previously moved with the SelectTool (move delta lives on
			// transform.x/y) restores its quad offset by that delta.
			const ancestorT = this.context.getAncestorTransform(single.id);
			const t = ancestorT
				? composeTransforms(ancestorT, single.transform)
				: single.transform;
			restored = single.corners.map(([x, y]) =>
				applyTransformToPoint(x, y, t, single.x, single.y),
			);
		}

		const base =
			restored ??
			cornersFromBounds({ minX, minY, maxX, maxY }).map((p) => ({ ...p }));
		this.sourceCorners = base.map((c) => ({ ...c }));
		this.corners = base.map((c) => ({ ...c }));
	}

	/**
	 * Rebuild the gizmo from the current selection. Called by many engine events
	 * (selection/zoom/document changes); must never disturb a live drag.
	 */
	public refreshUI(): void {
		if (this.drag) return;
		this.rebuildTargets();
		this.emitGizmo();
	}

	public onPointerDown(
		event: PointerEventData,
		viewport: Viewport,
		canvasWidth: number,
		canvasHeight: number,
	): void {
		if (event.button !== undefined && event.button !== 0) return;
		if (this.context.isReadonly()) return;

		const world = screenToWorld(
			event.x,
			event.y,
			viewport,
			canvasWidth,
			canvasHeight,
		);

		// A press on a handle — a corner, or an edge midpoint standing for both
		// corners of that edge — toggles the vertex selection (Shift) or begins
		// a warp drag: of the grabbed vertices alone, or of the whole
		// Shift-selected set when every grabbed vertex belongs to it (unless a
		// target is locked).
		if (this.selectedIds.length && this.corners.length === 4) {
			const handleIndices = this.hitTestHandle(world, viewport);
			if (handleIndices !== null) {
				const allSelected = handleIndices.every((i) =>
					this.selectedCornerIndices.has(i),
				);
				if (event.shiftKey) {
					for (const i of handleIndices) {
						if (allSelected) this.selectedCornerIndices.delete(i);
						else this.selectedCornerIndices.add(i);
					}
					this.emitGizmo();
					return;
				}
				if (!this.selectedIds.some((id) => this.context.isElementLocked(id))) {
					this.drag = {
						indices: allSelected
							? [...this.selectedCornerIndices]
							: handleIndices,
						startWorld: world,
						startCorners: this.corners.map((c) => ({ ...c })),
					};
					this.emitGizmo();
				}
				return;
			}
		}

		// Otherwise the press is a selection gesture (no transform).
		const tolerance = HANDLE_HIT_SCREEN_PX / viewport.zoom;
		const hit = this.context.findElementAtPoint(world.x, world.y, tolerance);
		const selectedIds = this.context.getSelectedElementIds();

		if (event.shiftKey) {
			if (hit && this.context.isElementEditable(hit.id)) {
				const bounds = this.context.getBounds(hit.id);
				if (bounds) {
					this.context.elementToggleSelect(hit.id, bounds);
					this.refreshUI();
				}
			}
			return;
		}

		if (
			hit &&
			this.context.isElementEditable(hit.id) &&
			!selectedIds.includes(hit.id)
		) {
			const bounds = this.context.getBounds(hit.id);
			if (bounds) {
				this.context.elementSelect(hit.id, bounds);
				this.refreshUI();
			}
			return;
		}

		if (!hit) {
			this.context.selectionClear();
			this.refreshUI();
		}
	}

	public onPointerMove(
		event: PointerEventData,
		viewport: Viewport,
		canvasWidth: number,
		canvasHeight: number,
	): void {
		if (!this.drag || this.sourceCorners.length !== 4) return;

		const world = screenToWorld(
			event.x,
			event.y,
			viewport,
			canvasWidth,
			canvasHeight,
		);

		// Every dragged corner moves by the same delta from its drag-start
		// position (two corners = edge move, four = whole-quad move).
		let dx = world.x - this.drag.startWorld.x;
		let dy = world.y - this.drag.startWorld.y;
		// Shift constrains the move to the dominant axis (45° snapping, same as
		// the SelectTool's move drag).
		if (event.shiftKey) {
			[dx, dy] = constrainAxis(dx, dy);
		}
		const candidate = this.drag.startCorners.map((c) => ({ ...c }));
		for (const i of this.drag.indices) {
			candidate[i] = {
				x: this.drag.startCorners[i].x + dx,
				y: this.drag.startCorners[i].y + dy,
			};
		}
		// Reject non-convex (bow-tie) configurations: the perspective quad blit
		// and homography break down when the quad self-intersects.
		if (!isConvexQuad(candidate)) return;

		this.corners = candidate;
		this.context.previewDeformation(
			this.context.perspectiveWarpCompute(
				this.selectedIds,
				quadToVec(this.corners),
				quadToVec(this.sourceCorners),
			),
		);
		this.emitGizmo();
	}

	public onPointerUp(): void {
		if (!this.drag) return;
		this.commitDrag();
		this.refreshUI();
	}

	public onCancel(): void {
		if (this.selectedIds.length) {
			this.context.clearDeformationPreview(this.selectedIds);
		}
		this.drag = null;
		this.refreshUI();
	}

	public getCursor(): string {
		return this.drag ? "grabbing" : "default";
	}

	/**
	 * Settle any in-flight warp. Called by Paplico when switching away from the
	 * tool (mirrors MeshDeformTool / SkewTool) so a tool switch commits instead
	 * of bouncing to select via onCancel.
	 */
	public applyDeformation(options: { complete?: boolean } = {}): void {
		this.commitDrag();
		if (options.complete ?? true) this.context.complete();
	}

	public dispose(): void {
		this.context.uiSetOverlay(OVERLAY_KEYS.freeTransformHandles, null);
	}

	private commitDrag(): void {
		if (this.drag && this.sourceCorners.length === 4) {
			// Snapshot the quads: refreshUI (selection changes, the outline flow)
			// resets this.corners before an async commit lands.
			const corners = quadToVec(this.corners);
			const sourceCorners = quadToVec(this.sourceCorners);
			const ids = [...this.selectedIds];
			const textIds = ids.filter(
				(id) => this.context.getElement(id)?.type === "text",
			);

			if (textIds.length > 0) {
				void this.commitWithOutlinedText(ids, textIds, corners, sourceCorners);
			} else {
				this.bake(ids, corners, sourceCorners);
			}
		}
		this.drag = null;
	}

	/** Outline text elements into path groups, then bake the warp into them. */
	private async commitWithOutlinedText(
		ids: string[],
		textIds: string[],
		corners: [Vec2, Vec2, Vec2, Vec2],
		sourceCorners: [Vec2, Vec2, Vec2, Vec2],
	): Promise<void> {
		const otherIds = ids.filter((id) => !textIds.includes(id));
		const groupIds = await this.context.outlineTextElements(textIds);
		this.bake([...otherIds, ...groupIds], corners, sourceCorners);
		this.refreshUI();
	}

	private bake(
		ids: string[],
		corners: [Vec2, Vec2, Vec2, Vec2],
		sourceCorners: [Vec2, Vec2, Vec2, Vec2],
	): void {
		const updates = this.context.perspectiveWarpCompute(
			ids,
			corners,
			sourceCorners,
		);
		if (updates.length) this.context.applyDeformation(updates);
		else this.context.clearDeformationPreview(ids);
	}

	/**
	 * Hit a handle of the 8-point gizmo: a corner returns its single vertex
	 * index, an edge-midpoint handle returns the edge's two corner indices
	 * (they move together). Corners win over edges.
	 */
	private hitTestHandle(world: Corner, viewport: Viewport): number[] | null {
		const tol = HANDLE_HIT_SCREEN_PX / viewport.zoom;
		let bestCorner: number | null = null;
		let bestDist = tol;
		for (let i = 0; i < this.corners.length; i++) {
			const dist = Math.hypot(
				world.x - this.corners[i].x,
				world.y - this.corners[i].y,
			);
			if (dist <= bestDist) {
				bestDist = dist;
				bestCorner = i;
			}
		}
		if (bestCorner !== null) return [bestCorner];

		let bestEdge: number[] | null = null;
		bestDist = tol;
		for (let i = 0; i < 4; i++) {
			const a = this.corners[i];
			const b = this.corners[(i + 1) % 4];
			const dist = Math.hypot(
				world.x - (a.x + b.x) / 2,
				world.y - (a.y + b.y) / 2,
			);
			if (dist <= bestDist) {
				bestDist = dist;
				bestEdge = [i, (i + 1) % 4];
			}
		}
		return bestEdge;
	}

	private emitGizmo(): void {
		if (!this.selectedIds.length || this.corners.length !== 4) {
			this.context.uiSetOverlay(OVERLAY_KEYS.freeTransformHandles, null);
			return;
		}
		this.context.uiSetOverlay(OVERLAY_KEYS.freeTransformHandles, {
			zIndex: OVERLAY_Z.selection,
			primitives: buildPerspectiveWarpOverlay(
				{
					corners: this.corners,
					activeCorners: this.drag?.indices,
					selectedCorners: [...this.selectedCornerIndices],
				},
				UI_THEME,
			),
		});
	}
}

function quadToVec(corners: Corner[]): [Vec2, Vec2, Vec2, Vec2] {
	return [
		[corners[0].x, corners[0].y],
		[corners[1].x, corners[1].y],
		[corners[2].x, corners[2].y],
		[corners[3].x, corners[3].y],
	];
}

/** True when the 4 ordered points form a convex (non-self-intersecting) quad. */
function isConvexQuad(pts: Corner[]): boolean {
	let sign = 0;
	for (let i = 0; i < 4; i++) {
		const a = pts[i];
		const b = pts[(i + 1) % 4];
		const c = pts[(i + 2) % 4];
		const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
		if (Math.abs(cross) < 1e-9) continue;
		const s = cross > 0 ? 1 : -1;
		if (sign === 0) sign = s;
		else if (s !== sign) return false;
	}
	return sign !== 0;
}
