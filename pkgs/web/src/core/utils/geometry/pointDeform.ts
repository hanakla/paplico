/**
 * Shared machinery for destructively baking a world-space deformation into
 * element geometry (vertex editing). Used by MeshDeformTool (TPS/RBF field)
 * and the free-transform perspective warp (homography): the caller supplies a
 * world-space point map, and these helpers handle local↔world round-trips
 * through composed ancestor transforms, path-segment rewriting, transform
 * re-resolution after the local bounds shift, and gradient-fill tracking.
 */

import type {
	AnyArtObject,
	BezierPoint,
	CubicBezierSegment,
	ElementTransform,
	FillAppearance,
	FreeGradient,
	ImageObject,
	MeshArtObject,
	MeshGradient,
	Path,
	TextElement,
} from "../../schema";
import type { LocalBBox } from "./bounds";
import { defaultEdgeCP, freeGradientAdjacency } from "./freeGradient";
import {
	applyTransformToPoint,
	computeTransformOrigin,
	inverseTransformPoint,
	solveChildTransform,
	transformLinearMatrix,
} from "./geometry";
import {
	getBaseHandle,
	getRootSegmentInfo,
	syncDerivedVertices,
} from "./meshGradient";
import { resolveSegment, toRelativeCP1, toRelativeCP2 } from "./segmentOps";

export type DeformableElement =
	| Path
	| ImageObject
	| TextElement
	| MeshArtObject;

/**
 * The per-element coordinate context a bake needs: the element's transform
 * composed through its ancestors, and its pre-deform local bounds (whose
 * centre is the transform origin).
 */
export interface DeformFrame {
	ancestorTransform: ElementTransform | null;
	composedTransform: ElementTransform;
	localBounds: LocalBBox;
}

export function isDeformableElement(
	element: AnyArtObject,
): element is DeformableElement {
	return (
		element.type === "path" ||
		element.type === "image" ||
		element.type === "text" ||
		element.type === "mesh"
	);
}

/** Recursively flatten groups to leaf element IDs. */
export function flattenElementIds(
	ids: string[],
	getElement: (id: string) => AnyArtObject | null,
): string[] {
	const result: string[] = [];
	const visit = (id: string) => {
		const el = getElement(id);
		if (!el) return;
		if (el.type === "group") {
			for (const childId of el.childIds) {
				visit(childId);
			}
		} else {
			result.push(id);
		}
	};
	for (const id of ids) visit(id);
	return result;
}

/**
 * Wrap a world-space point map into an element-local one: local point →
 * composed-transform world point → deformed world point → back to local.
 */
export function createLocalPointDeformer(
	frame: DeformFrame,
	worldDeform: (x: number, y: number) => { x: number; y: number },
): (point: { x: number; y: number }) => { x: number; y: number } {
	const origin = computeTransformOrigin(frame.localBounds);
	return (point) => {
		const world = applyTransformToPoint(
			point.x,
			point.y,
			frame.composedTransform,
			origin.x,
			origin.y,
		);
		const deformed = worldDeform(world.x, world.y);
		return inverseTransformPoint(
			deformed.x,
			deformed.y,
			frame.composedTransform,
			origin.x,
			origin.y,
		);
	};
}

/**
 * Re-resolve the stored (parent-local) transform after a bake changed the
 * element's local bounds: the transform origin (bounds centre) moved, so the
 * translation must absorb the origin shift or the element jumps on commit.
 */
export function resolveStoredTransform(
	frame: DeformFrame,
	newLocalBounds: LocalBBox,
	localOffset: { x: number; y: number },
): ElementTransform {
	const oldOrigin = computeTransformOrigin(frame.localBounds);
	const newOrigin = computeTransformOrigin(newLocalBounds);
	const originDeltaX = localOffset.x + newOrigin.x - oldOrigin.x;
	const originDeltaY = localOffset.y + newOrigin.y - oldOrigin.y;
	// Map the origin delta through the composed linear part (rotation · shear · scale).
	const m = transformLinearMatrix(frame.composedTransform);
	const mappedX = m.m00 * originDeltaX + m.m01 * originDeltaY;
	const mappedY = m.m10 * originDeltaX + m.m11 * originDeltaY;
	const composedTransform = {
		...frame.composedTransform,
		x: frame.composedTransform.x + mappedX + oldOrigin.x - newOrigin.x,
		y: frame.composedTransform.y + mappedY + oldOrigin.y - newOrigin.y,
	};
	return frame.ancestorTransform
		? solveChildTransform(frame.ancestorTransform, composedTransform)
		: composedTransform;
}

/** Rewrite path segments through a local-space point map (anchors + CPs). */
export function deformPathSegments(
	segments: CubicBezierSegment[],
	deformPoint: (point: { x: number; y: number }) => { x: number; y: number },
): CubicBezierSegment[] {
	const result: CubicBezierSegment[] = [];
	let prevOrigEnd: BezierPoint | undefined;
	let prevDeformedEnd: { x: number; y: number } | undefined;

	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i];
		const {
			start: origStart,
			cp1: origCp1,
			cp2: origCp2,
			end: origEnd,
		} = resolveSegment(seg, prevOrigEnd);

		// Every segment carrying a start opens a sub-path — a glyph's next
		// contour, a compound path's next ring — and its opening point has to
		// travel with the rest, or that contour reaches back to where the shape
		// used to be.
		const newStart =
			i === 0 || seg.start !== undefined ? deformPoint(origStart) : undefined;
		// biome-ignore lint/style/noNonNullAssertion: prevDeformedEnd always exists when i>0
		const newStartAnchor = newStart ?? prevDeformedEnd!;
		const newCp1Abs = deformPoint(origCp1);
		const newCp2Abs = deformPoint(origCp2);
		const newEnd = deformPoint(origEnd);

		result.push({
			...seg,
			start: newStart
				? { ...(seg.start ?? origStart), x: newStart.x, y: newStart.y }
				: undefined,
			cp1: toRelativeCP1(
				{ ...seg.cp1, x: newCp1Abs.x, y: newCp1Abs.y },
				{ x: newStartAnchor.x, y: newStartAnchor.y },
			),
			cp2: toRelativeCP2(
				{ ...seg.cp2, x: newCp2Abs.x, y: newCp2Abs.y },
				{ x: newEnd.x, y: newEnd.y },
			),
			end: { ...seg.end, x: newEnd.x, y: newEnd.y },
		});

		prevOrigEnd = seg.end;
		prevDeformedEnd = newEnd;
	}

	return result;
}

/**
 * Track free/mesh gradient fills through the deformation so painted gradients
 * follow the geometry. Returns undefined when no fill needed rewriting.
 */
export function deformGradientFilters(
	element: DeformableElement,
	deformPoint: (point: { x: number; y: number }) => { x: number; y: number },
	oldLocalBounds: LocalBBox,
	newLocalBounds: LocalBBox,
	localOffset: { x: number; y: number },
): DeformableElement["filters"] | undefined {
	if (!element.filters) return undefined;

	const deformBoundsRelativePoint = createBoundsRelativePointDeformer(
		deformPoint,
		oldLocalBounds,
		newLocalBounds,
		localOffset,
	);
	let changed = false;
	const filters = element.filters.map((filter) => {
		if (filter.processor !== "fill") return filter;
		const appearance = filter as FillAppearance;
		const { fill } = appearance.paramData.params;
		if (fill.type !== "free" && fill.type !== "mesh") return filter;

		changed = true;
		return {
			...appearance,
			paramData: {
				...appearance.paramData,
				params: {
					...appearance.paramData.params,
					fill:
						fill.type === "free"
							? deformFreeGradient(fill, deformBoundsRelativePoint)
							: deformMeshGradient(fill, deformBoundsRelativePoint),
				},
			},
		};
	});

	return changed ? filters : undefined;
}

// --- Private helpers ---

function createBoundsRelativePointDeformer(
	deformPoint: (point: { x: number; y: number }) => { x: number; y: number },
	oldLocalBounds: LocalBBox,
	newLocalBounds: LocalBBox,
	localOffset: { x: number; y: number },
): (point: { x: number; y: number }) => { x: number; y: number } {
	return (point) => {
		const deformed = deformPoint({
			x: oldLocalBounds.minX + point.x * oldLocalBounds.width,
			y: oldLocalBounds.minY + point.y * oldLocalBounds.height,
		});
		return {
			x: normalizeBoundsCoordinate(
				deformed.x - localOffset.x,
				newLocalBounds.minX,
				newLocalBounds.width,
				point.x,
			),
			y: normalizeBoundsCoordinate(
				deformed.y - localOffset.y,
				newLocalBounds.minY,
				newLocalBounds.height,
				point.y,
			),
		};
	};
}

function deformFreeGradient(
	gradient: FreeGradient,
	deformPoint: (point: { x: number; y: number }) => { x: number; y: number },
): FreeGradient {
	// Cell edges with no stored CP are regenerated by the renderer as the
	// straight 1/3 default between the stops it sees — i.e. between the
	// DEFORMED stops. Mapping only the stored CPs would therefore flatten every
	// implicit edge the deformation should have bent (the same materialization
	// deformMeshGradient does for mesh gradients). Compute the implicit CPs from
	// the undeformed stops first, then map them through the field.
	const adjacency = freeGradientAdjacency(gradient.stops);
	return {
		...gradient,
		stops: gradient.stops.map((stop, index) => {
			const point = deformPoint(stop);
			const edgeCPs: NonNullable<(typeof stop)["edgeCPs"]> = {};
			for (const neighborIndex of adjacency.get(index) ?? []) {
				const neighbor = gradient.stops[neighborIndex];
				edgeCPs[neighbor.id] = deformPoint(
					stop.edgeCPs?.[neighbor.id] ?? defaultEdgeCP(stop, neighbor),
				);
			}
			// Stored CPs toward a non-neighbor survive: the triangulation of the
			// deformed stops may differ from this one.
			for (const [neighborId, handle] of Object.entries(stop.edgeCPs ?? {})) {
				edgeCPs[neighborId] ??= deformPoint(handle);
			}
			return Object.keys(edgeCPs).length > 0
				? { ...stop, ...point, edgeCPs }
				: { ...stop, ...point };
		}),
	};
}

function deformMeshGradient(
	gradient: MeshGradient,
	deformPoint: (point: { x: number; y: number }) => { x: number; y: number },
): MeshGradient {
	// Which handle keys the display/render actually reads for each vertex. The
	// old code only transformed already-stored handles, so an unstored edge
	// (implicit 1/3-straight-line default) was never materialized — after a
	// deform getBaseHandle regenerated `F(P0) + (F(P3)-F(P0))/3`, which is always
	// on the deformed root-root line (a snap). Because TPS is non-affine that is
	// NOT `F(default CP)`, so the edge lost its curvature.
	//
	// getDisplayedMeshHandle resolves every boundary edge to its ROOT segment
	// endpoints via getRootSegmentInfo, so on a subdivided edge (root → derived →
	// … → root) it reads `vertices[rootStart].handles[rootEnd]`, NOT the direct
	// face-neighbor key. Enumerate the SAME root-resolved keys here so the exact
	// implicit CPs the display can read get materialized and mapped through the
	// field (matching the editor, which materializes on drag).
	const requiredTargets = gradient.vertices.map(() => new Set<number>());
	for (const face of gradient.faces) {
		const n = face.verts.length;
		for (let e = 0; e < n; e++) {
			const a = face.verts[e];
			const b = face.verts[(e + 1) % n];
			const [ownerStart, ownerEnd] = getRootSegmentInfo(
				gradient.vertices,
				gradient.faces,
				a,
				b,
			)?.rootEdge ?? [a, b];
			requiredTargets[ownerStart].add(ownerEnd);
			requiredTargets[ownerEnd].add(ownerStart);
		}
	}

	const vertices = gradient.vertices.map((vertex, i) => {
		const handles: Record<number, { x: number; y: number }> = {};
		// Stored handles: absolute-map through the field (unchanged behavior).
		for (const [neighborIndex, handle] of Object.entries(vertex.handles)) {
			handles[Number(neighborIndex)] = deformPoint(handle);
		}
		// Implicit defaults the display can read: materialize + absolute-map.
		// getBaseHandle is evaluated on the PRE-deform vertices.
		for (const j of requiredTargets[i]) {
			if (Object.hasOwn(handles, j)) continue;
			handles[j] = deformPoint(getBaseHandle(gradient.vertices, i, j));
		}
		return { ...vertex, ...deformPoint(vertex), handles };
	});
	syncDerivedVertices(vertices, gradient.faces);
	return { ...gradient, vertices };
}

function normalizeBoundsCoordinate(
	value: number,
	min: number,
	size: number,
	fallback: number,
): number {
	return size === 0 ? fallback : (value - min) / size;
}
