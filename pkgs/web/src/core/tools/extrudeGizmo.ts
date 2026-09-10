import type { UIPrimitive } from "../renderer/ui/primitives";
import { type RGBA, UI_THEME } from "../renderer/ui/theme";
import {
	type AnyArtObject,
	type ElementTransform,
	type Extrude3DParams,
	isAppearancePresetRef,
	type Revolve3DParams,
	type Solid3DBaseParams,
	type Vec3,
} from "../schema";
import { calculateLocalElementBounds } from "../utils/geometry/bounds";
import {
	applyTransformToPoint,
	composeTransforms,
} from "../utils/geometry/geometry";
import {
	type Mat4,
	mat4Multiply,
	mat4PerspectiveDistanceFromFov,
	mat4RotationX,
	mat4RotationY,
	mat4RotationZ,
	mat4SimplePerspective,
	mat4Translation,
} from "../utils/geometry/mat4";
import {
	type GizmoProjectFn,
	projectRingPoints,
	ringOrientationSign,
} from "./gizmoRings";

/**
 * On-canvas gizmo for the select tool controlling a path's or group's first
 * 3D solid appearance (extrude3d / revolve3d): XYZ rotation rings — plus a
 * depth handle for extrusions — projected through the exact matrix the solid
 * renderer uses (P·model linearized at the solid's center), so the gizmo sits
 * on the rendered solid at any rotation, perspective, zoom, or element
 * transform. A group's solid sweeps its world-space outline, so its gizmo
 * projects in world space (see createExtrudeGizmoFrame).
 */

export type ExtrudeGizmoHandle =
	| "extrude-rotate-x"
	| "extrude-rotate-y"
	| "extrude-rotate-z"
	| "extrude-depth";

/** On-screen ring radius (slightly inside the reference3d gizmo's 78). */
const EXTRUDE_RING_SCREEN_PX = 64;
/** Depth handle: arrow length and box offset past the back cap (screen px). */
const DEPTH_ARROW_SCREEN_PX = 26;

const ROTATE_AXES: ReadonlyArray<{
	handle: ExtrudeGizmoHandle;
	axisIndex: 0 | 1 | 2;
	dir: Vec3;
	color: RGBA;
}> = [
	{
		handle: "extrude-rotate-x",
		axisIndex: 0,
		dir: [1, 0, 0],
		color: UI_THEME.colors.reference3dAxisX,
	},
	{
		handle: "extrude-rotate-y",
		axisIndex: 1,
		dir: [0, 1, 0],
		color: UI_THEME.colors.reference3dAxisY,
	},
	{
		handle: "extrude-rotate-z",
		axisIndex: 2,
		dir: [0, 0, 1],
		color: UI_THEME.colors.reference3dAxisZ,
	},
];

/** The 3D solid processors the gizmo serves, in appearance-priority order. */
const SOLID3D_GIZMO_PROCESSORS = ["extrude3d", "revolve3d"] as const;
type Solid3DGizmoProcessor = (typeof SOLID3D_GIZMO_PROCESSORS)[number];

interface Solid3DGizmoTarget {
	filterIndex: number;
	processor: Solid3DGizmoProcessor;
	params: Solid3DBaseParams;
}

/** First enabled 3D solid appearance (extrude3d / revolve3d) of a path or
 *  group element, or null when none produces a solid. */
export function resolveSolid3DTarget(
	element: AnyArtObject,
): Solid3DGizmoTarget | null {
	if (
		(element.type !== "path" && element.type !== "group") ||
		!element.filters
	) {
		return null;
	}
	const filterIndex = element.filters.findIndex(
		(f) =>
			!isAppearancePresetRef(f) &&
			(SOLID3D_GIZMO_PROCESSORS as readonly string[]).includes(f.processor) &&
			f.enabled !== false,
	);
	if (filterIndex < 0) return null;
	const filter = element.filters[filterIndex];
	if (!filter || isAppearancePresetRef(filter)) return null;
	const processor = filter.processor as Solid3DGizmoProcessor;
	const params = filter.paramData.params as Solid3DBaseParams;
	if (processor === "extrude3d") {
		if (!((params as Extrude3DParams).depth > 0)) return null;
	} else if (!((params as Revolve3DParams).angleDeg > 0)) {
		return null;
	}
	return { filterIndex, processor, params };
}

/**
 * Projection frame shared by overlay construction and drag begin: maps
 * solid-space 3D points to canvas-world 2D through the renderer's matrix and
 * element transform.
 */
export interface ExtrudeGizmoFrame {
	params: Solid3DBaseParams;
	/** Extrusion depth, or null when the solid has no depth handle (revolve). */
	depth: number | null;
	/** Solid center: its 3D bounding-box center (rotation pivot). */
	pivot: Vec3;
	project: GizmoProjectFn;
	/** Projected pivot in canvas-world coordinates (ring/angle center). */
	centerCanvas: { x: number; y: number };
}

export function createExtrudeGizmoFrame(
	element: AnyArtObject,
	target: Pick<Solid3DGizmoTarget, "processor" | "params">,
	ancestorTransform: ElementTransform | null,
	/**
	 * World bounds of a group's solid outline. A group sweeps its world-space
	 * outline directly, so the gizmo projects in world space with no element
	 * transform. Null/absent for paths (element-local outline + composed
	 * element transform).
	 */
	worldBounds?: {
		minX: number;
		minY: number;
		maxX: number;
		maxY: number;
	} | null,
): ExtrudeGizmoFrame | null {
	const { processor, params } = target;
	const worldSpace = element.type === "group" && worldBounds != null;
	const bounds = worldSpace
		? worldBounds
		: calculateLocalElementBounds(element);
	// The element transform rotates around the PROFILE bounds center (the GPU
	// transforms-buffer convention); the solid's own rotation pivots around its
	// 3D box center. They coincide for an extrusion, but a revolved solid is
	// centered on its axis, off the profile.
	const originX = (bounds.minX + bounds.maxX) / 2;
	const originY = (bounds.minY + bounds.maxY) / 2;
	const b3 = solid3DBounds(processor, params, bounds);
	const pivot: Vec3 = [
		(b3.minX + b3.maxX) / 2,
		(b3.minY + b3.maxY) / 2,
		(b3.minZ + b3.maxZ) / 2,
	];
	const halfDiagonal = Math.hypot(b3.maxX - b3.minX, b3.maxY - b3.minY) / 2;

	// Same construction as the solid renderer: rotate Z·Y·X around the solid's
	// center, then perspective around the solid's screen-space center.
	const [rxDeg, ryDeg, rzDeg] = params.rotationDeg;
	const rotation = mat4Multiply(
		mat4RotationZ((rzDeg * Math.PI) / 180),
		mat4Multiply(
			mat4RotationY((ryDeg * Math.PI) / 180),
			mat4RotationX((rxDeg * Math.PI) / 180),
		),
	);
	const model = mat4Multiply(
		mat4Translation(pivot[0], pivot[1], pivot[2]),
		mat4Multiply(rotation, mat4Translation(-pivot[0], -pivot[1], -pivot[2])),
	);
	const projected =
		params.perspective > 0 && halfDiagonal > 1e-9
			? mat4Multiply(
					mat4SimplePerspective(
						ensurePerspectiveDistance(
							boxCorners3d(b3),
							model,
							mat4PerspectiveDistanceFromFov(params.perspective, halfDiagonal),
							halfDiagonal,
						),
						pivot[0],
						pivot[1],
					),
					model,
				)
			: model;

	// Groups extrude the world-space outline directly (no element transform);
	// paths extrude element-local and get the composed element transform.
	const composed = worldSpace
		? null
		: ancestorTransform
			? composeTransforms(ancestorTransform, element.transform)
			: element.transform;

	const project: GizmoProjectFn = (point) => {
		const p = transformPointGuarded(projected, point);
		if (!p) return null;
		return composed
			? applyTransformToPoint(p.x, p.y, composed, originX, originY)
			: p;
	};

	const centerCanvas = project(pivot);
	if (!centerCanvas) return null;
	return {
		params,
		depth: processor === "extrude3d" ? (params as Extrude3DParams).depth : null,
		pivot,
		project,
		centerCanvas,
	};
}

/** Ring probe for one axis (drag-sign + geometry), in canvas-world space. */
export function extrudeRingPoints(
	frame: ExtrudeGizmoFrame,
	axisIndex: 0 | 1 | 2,
	zoom: number,
): Array<{ x: number; y: number }> | null {
	return projectRingPoints(
		frame.pivot,
		ROTATE_AXES[axisIndex].dir,
		EXTRUDE_RING_SCREEN_PX / zoom,
		frame.project,
	);
}

/**
 * Canvas-space direction the back cap moves per +1 depth, and its length
 * (canvas units per depth unit). When the depth axis points at the viewer
 * (head-on, no perspective) it degenerates to a point — fall back to a
 * screen-diagonal mapping at 1 canvas unit per depth so depth stays
 * grabbable in the default front view. Null when the back cap itself does
 * not project.
 */
export function extrudeDepthAxis(
	frame: ExtrudeGizmoFrame,
): { dir: { x: number; y: number }; unitPerDepth: number } | null {
	if (frame.depth == null) return null;
	const back: Vec3 = [frame.pivot[0], frame.pivot[1], -frame.depth];
	const from = frame.project(back);
	const to = frame.project([back[0], back[1], back[2] - 1]);
	if (!from || !to) return null;
	const dx = to.x - from.x;
	const dy = to.y - from.y;
	const len = Math.hypot(dx, dy);
	if (len < 1e-6) {
		return { dir: { x: Math.SQRT1_2, y: Math.SQRT1_2 }, unitPerDepth: 1 };
	}
	return { dir: { x: dx / len, y: dy / len }, unitPerDepth: len };
}

export function buildExtrudeGizmoPrimitives(
	frame: ExtrudeGizmoFrame,
	zoom: number,
	hovered: ExtrudeGizmoHandle | null,
): UIPrimitive[] {
	const primitives: UIPrimitive[] = [];
	const colorFor = (handle: ExtrudeGizmoHandle, base: RGBA): RGBA =>
		hovered === handle ? UI_THEME.colors.reference3dHandleHover : base;

	for (const { handle, axisIndex, color } of ROTATE_AXES) {
		const points = extrudeRingPoints(frame, axisIndex, zoom);
		if (!points) continue;
		primitives.push({
			kind: "polyline",
			points,
			closed: true,
			stroke: { color: colorFor(handle, color), width: 1.5 },
			hitId: handle,
			hitPadding: { screen: 5 },
		});
	}

	const depthAxis = frame.depth != null ? extrudeDepthAxis(frame) : null;
	if (depthAxis && frame.depth != null) {
		const back = frame.project([frame.pivot[0], frame.pivot[1], -frame.depth]);
		if (back) {
			const arrowLen = DEPTH_ARROW_SCREEN_PX / zoom;
			const tip = {
				x: back.x + depthAxis.dir.x * arrowLen,
				y: back.y + depthAxis.dir.y * arrowLen,
			};
			primitives.push({
				kind: "arrow",
				x1: back.x,
				y1: back.y,
				x2: tip.x,
				y2: tip.y,
				color: colorFor("extrude-depth", UI_THEME.colors.reference3dPlaneFill),
				width: 2,
				headLength: { screen: 9 },
				headWidth: { screen: 7 },
				hitId: "extrude-depth",
				hitPadding: { screen: 6 },
				zIndex: 1,
			});
		}
	}

	return primitives;
}

/** Wrap an angle into the slider range (-180, 180]. */
export function wrapAngleDeg(deg: number): number {
	const wrapped = ((deg % 360) + 540) % 360;
	return wrapped - 180 === -180 ? 180 : wrapped - 180;
}

/** mat4TransformPoint with a homogeneous-w guard (behind-eye → null). */
function transformPointGuarded(
	m: Mat4,
	point: Vec3,
): { x: number; y: number } | null {
	const [x, y, z] = point;
	const w = m[3] * x + m[7] * y + m[11] * z + m[15];
	if (w < 1e-4) return null;
	return {
		x: (m[0] * x + m[4] * y + m[8] * z + m[12]) / w,
		y: (m[1] * x + m[5] * y + m[9] * z + m[13]) / w,
	};
}

interface Bounds3D {
	minX: number;
	minY: number;
	minZ: number;
	maxX: number;
	maxY: number;
	maxZ: number;
}

/**
 * Analytic 3D bounding box of the solid, matching the mesh builders' bounds3d
 * (used by the renderer as the rotation pivot): an extrusion spans the profile
 * × [-depth, 0]; a revolved solid sweeps every profile radius r ∈ [offset,
 * offset + width] through θ ∈ [0, angle] (x' = axisX + d·r·cosθ,
 * z' = -r·sinθ), so its box follows the cos/sin extremes over the sweep.
 */
function solid3DBounds(
	processor: Solid3DGizmoProcessor,
	params: Solid3DBaseParams,
	bounds: { minX: number; minY: number; maxX: number; maxY: number },
): Bounds3D {
	if (processor === "extrude3d") {
		return { ...bounds, minZ: -(params as Extrude3DParams).depth, maxZ: 0 };
	}
	const p = params as Revolve3DParams;
	const offset = Math.max(p.offset, 0);
	const width = Math.max(bounds.maxX - bounds.minX, 0);
	const d = p.axis === "left" ? 1 : -1;
	const axisX = p.axis === "left" ? bounds.minX - offset : bounds.maxX + offset;
	const rMin = offset;
	const rMax = offset + width;
	const a = (Math.min(Math.max(p.angleDeg, 0), 360) * Math.PI) / 180;

	// cos/sin ranges over θ ∈ [0, a] (θ=0 included, so cosMax = 1, sinMin ≤ 0).
	const cosMin = a >= Math.PI ? -1 : Math.cos(a);
	const cosMax = 1;
	const sinMax = a >= Math.PI / 2 ? 1 : Math.sin(a);
	const sinMin = a >= Math.PI * 1.5 ? -1 : Math.min(0, Math.sin(a));

	// Extremes of r·f(θ) with r ∈ [rMin, rMax] ≥ 0.
	const scaleMax = (f: number) => (f > 0 ? rMax * f : rMin * f);
	const scaleMin = (f: number) => (f < 0 ? rMax * f : rMin * f);
	const rcMin = scaleMin(cosMin);
	const rcMax = scaleMax(cosMax);
	const rsMin = scaleMin(sinMin);
	const rsMax = scaleMax(sinMax);

	return {
		minX: axisX + (d === 1 ? rcMin : -rcMax),
		maxX: axisX + (d === 1 ? rcMax : -rcMin),
		minY: bounds.minY,
		maxY: bounds.maxY,
		// z' = -r·sinθ flips the sin range.
		minZ: -rsMax,
		maxZ: -rsMin,
	};
}

function boxCorners3d(bounds: Bounds3D): Vec3[] {
	const corners: Vec3[] = [];
	for (const x of [bounds.minX, bounds.maxX]) {
		for (const y of [bounds.minY, bounds.maxY]) {
			for (const z of [bounds.minZ, bounds.maxZ]) {
				corners.push([x, y, z]);
			}
		}
	}
	return corners;
}

function ensurePerspectiveDistance(
	corners: Vec3[],
	model: Mat4,
	distance: number,
	halfDiagonal: number,
): number {
	let maxZ = -Infinity;
	for (const [x, y, z] of corners) {
		maxZ = Math.max(
			maxZ,
			model[2] * x + model[6] * y + model[10] * z + model[14],
		);
	}
	return Math.max(distance, maxZ + Math.max(halfDiagonal * 0.05, 1e-3));
}

export { ringOrientationSign };
