import type { ElementTransform, Reference3DCamera, Vec3 } from "../../schema";
import {
	cameraBasis,
	dot3,
	type LocalRect,
	localToCanvasPoint,
	ndcToLocal,
	transformDirection,
	type Vec2,
} from "./projection";

/**
 * Vanishing point derivation for the perspective ruler.
 *
 * Each world axis is treated as a homogeneous direction [d, 0]: the view
 * translation drops out, leaving the view rotation followed by the
 * projection. When the projected homogeneous w (∝ view depth of the
 * direction) is above ε, the axis converges to a finite vanishing point;
 * otherwise (screen-parallel axis, or any axis under an orthographic
 * camera) parallel lines stay parallel and the axis contributes an
 * infinite direction instead.
 *
 * All outputs are in canvas world coordinates, mapped through the element's
 * local rect and composed transform — the same mapping the renderer's quad
 * blit uses, so guides stay glued to the rendered pixels of rotated/scaled
 * elements.
 */

type WorldAxis3 = "x" | "y" | "z";

type PerspectiveAxisGuide =
	| { axis: WorldAxis3; kind: "finite"; point: Vec2 }
	| { axis: WorldAxis3; kind: "infinite"; direction: Vec2 };

export interface PerspectiveGuideData {
	/** Reference3DElement the guides were derived from. */
	elementId: string;
	/** Per-world-axis guides. Degenerate axes (no direction in view) are omitted. */
	axes: PerspectiveAxisGuide[];
	/** Horizon line through the X/Z vanishing points, or null when undefined. */
	horizon: { point: Vec2; direction: Vec2 } | null;
}

interface PerspectiveGuideInput {
	elementId: string;
	camera: Reference3DCamera;
	/** Element placement rect (untransformed local canvas coordinates). */
	localRect: LocalRect;
	/** Composed ancestor ∘ self transform (pivot = local rect center). */
	transform: ElementTransform;
}

const DEPTH_EPSILON = 1e-6;

const WORLD_AXES: ReadonlyArray<{ axis: WorldAxis3; dir: Vec3 }> = [
	{ axis: "x", dir: [1, 0, 0] },
	{ axis: "y", dir: [0, 1, 0] },
	{ axis: "z", dir: [0, 0, 1] },
];

/**
 * True when an objects delta invalidates the current guide source: either
 * the source element itself changed, or any ancestor group did (ancestor
 * transforms shift the composed element transform and thus every guide).
 * Walks only the source's parent chain — never the whole delta.
 */
export function guideSourceAffectedByDelta(
	sourceId: string,
	delta: {
		updated: ReadonlyMap<string, unknown>;
		deleted: ReadonlySet<string>;
	},
	getParentGroupId: (elementId: string) => string | null,
): boolean {
	if (delta.updated.has(sourceId) || delta.deleted.has(sourceId)) return true;

	let parentId = getParentGroupId(sourceId);
	// Guard against corrupt parent maps (cycles) — ancestor chains are short.
	let guard = 0;
	while (parentId && guard++ < 256) {
		if (delta.updated.has(parentId) || delta.deleted.has(parentId)) return true;
		parentId = getParentGroupId(parentId);
	}
	return false;
}

export function computePerspectiveGuides(
	input: PerspectiveGuideInput,
): PerspectiveGuideData {
	const { camera, localRect, transform } = input;
	const basis = cameraBasis(camera);
	const aspect = localRect.width / localRect.height;
	const axes: PerspectiveAxisGuide[] = [];

	for (const { axis, dir } of WORLD_AXES) {
		// View-space direction R·d of the homogeneous direction [d, 0].
		let vx = dot3(dir, basis.right);
		let vy = dot3(dir, basis.up);
		let vz = dot3(dir, basis.forward);

		if (camera.projection === "perspective" && Math.abs(vz) > DEPTH_EPSILON) {
			// |w| > ε — finite vanishing point. Take the receding half of the
			// line (positive view depth); both halves share the same VP line.
			if (vz < 0) {
				vx = -vx;
				vy = -vy;
				vz = -vz;
			}
			const halfTan = Math.tan((camera.fovDeg * Math.PI) / 360);
			const ndc = {
				x: vx / (vz * halfTan * aspect),
				y: vy / (vz * halfTan),
			};
			axes.push({
				axis,
				kind: "finite",
				point: localToCanvasPoint(
					ndcToLocal(ndc, localRect),
					localRect,
					transform,
				),
			});
			continue;
		}

		// |w| ≤ ε or orthographic: parallel lines stay parallel. The NDC
		// direction is ∝ (vx / aspect, vy) for both projection kinds.
		const canvasDir = transformDirection(
			{
				x: (vx / aspect) * (localRect.width / 2),
				y: vy * (localRect.height / 2),
			},
			transform,
		);
		const len = Math.hypot(canvasDir.x, canvasDir.y);
		// Axis pointing along the view axis (orthographic): projects to a
		// point, contributes no direction — omit it.
		if (len < 1e-9) continue;
		axes.push({
			axis,
			kind: "infinite",
			direction: { x: canvasDir.x / len, y: canvasDir.y / len },
		});
	}

	return {
		elementId: input.elementId,
		axes,
		horizon: computeHorizon(axes),
	};
}

// Helpers

/** Horizon = line through the X and Z axis guides (ground-plane axes). */
function computeHorizon(
	axes: PerspectiveAxisGuide[],
): PerspectiveGuideData["horizon"] {
	const x = axes.find((a) => a.axis === "x");
	const z = axes.find((a) => a.axis === "z");
	if (!x || !z) return null;

	if (x.kind === "finite" && z.kind === "finite") {
		const dx = z.point.x - x.point.x;
		const dy = z.point.y - x.point.y;
		const len = Math.hypot(dx, dy);
		if (len < 1e-9) return null;
		return { point: x.point, direction: { x: dx / len, y: dy / len } };
	}
	if (x.kind === "finite" && z.kind === "infinite") {
		return { point: x.point, direction: z.direction };
	}
	if (z.kind === "finite" && x.kind === "infinite") {
		return { point: z.point, direction: x.direction };
	}
	// Both infinite (view axis vertical): no horizon in view.
	return null;
}
