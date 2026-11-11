import {
	type AnyArtObject,
	type BoundingBox,
	type CubicBezierSegment,
	type ElementTransform,
	isCompoundPath,
	isGroup,
	isIdentityTransform,
} from "../../schema";
import {
	calculateLocalElementBounds,
	calculatePlacedBounds,
	type LocalBoundsCache,
} from "../../utils/geometry/elementBounds";
import { bakeCompoundPathSegments } from "../../utils/geometry/generate/compoundBake";
import {
	brandWorldBBox,
	type WorldBBox,
} from "../../utils/geometry/primitives/box";
import {
	applyTransformToPoint,
	placeElement,
} from "../../utils/geometry/space/coordinates";
import type { FilterCapabilityLookup } from "./filterCapabilities";
import { resolveImageGeometry } from "./imageGeometry";
import {
	geometryFilters,
	resolveCompoundDrawnShape,
	resolvePathGeometryVariants,
	subtreeHasPreFilter,
	toCompoundSourceWorldPath,
	withInheritedPreFilters,
} from "./preFilters";

/**
 * Collect filter plans and backdrop entries for all elements in a layer.
 * Recursion into groups mirrors the original collectFilteredElements logic.
 * Pure function — no GPU operations.
 */
/** Cached pre-filter-deformed local bounds. Keyed by element object identity — document
 *  mutations produce new element objects, so entries self-invalidate and the
 *  WeakMap never outlives the element. */
const preFilteredLocalBoundsCache = new WeakMap<AnyArtObject, BoundingBox>();

/**
 * Element bounds for filter planning. Pre-filters (3d-rotate, zigzag, …)
 * deform the geometry at render time, so plan bounds — which size the
 * offscreen texture for any post-filter chain — must come from the deformed
 * segments, or the deformed render clips at the flat outline's bbox.
 * For groups, group-level pre-filters propagate to every child at render
 * time, so the deformed bounds are the union of each child's deformed bounds
 * with the group's pre-filters appended (matching the renderers' child-first
 * merge order).
 */
export function calculatePreFilteredElementBounds(
	element: AnyArtObject,
	elementsMap: ReadonlyMap<string, AnyArtObject>,
	filterRenderer: FilterCapabilityLookup,
	localBoundsCache?: LocalBoundsCache,
): WorldBBox {
	return planBoundsOf(element, elementsMap, filterRenderer, localBoundsCache);
}

/**
 * World-space bounds a filter plan is sized from: the pre-filter-deformed
 * local bounds carried through the element's placement under its enclosing
 * containers. That is the single application the GPU transform buffer
 * performs, so the plan lands where the element is drawn even under a
 * rotated or scaled group.
 */
export function planBoundsOf(
	element: AnyArtObject,
	elementsMap: ReadonlyMap<string, AnyArtObject>,
	filterRenderer: FilterCapabilityLookup | null,
	localBoundsCache?: LocalBoundsCache,
	/** The chain the enclosing containers place the element under (see
	 *  childrenMatrixOf), or null at top level. */
	parentMatrix: ElementTransform | null = null,
): WorldBBox {
	const placement = placeElement(parentMatrix, element);
	// A repeat bakes its own transform into its instances, so its extent is
	// not its local box placed.
	if (element.type === "repeat") {
		return calculatePlacedBounds(
			element,
			placement,
			elementsMap,
			localBoundsCache,
		);
	}
	return transformDeformedLocalBounds(
		calculatePreFilteredLocalBounds(
			element,
			elementsMap,
			filterRenderer,
			localBoundsCache,
		),
		placement,
	);
}

/** Pre-filter-deformed bounds in the element's own local space. */

function calculatePreFilteredLocalBounds(
	element: AnyArtObject,
	elementsMap: ReadonlyMap<string, AnyArtObject>,
	filterRenderer: FilterCapabilityLookup | null,
	localBoundsCache?: LocalBoundsCache,
): BoundingBox {
	const flat = calculateLocalElementBounds(
		element,
		elementsMap,
		localBoundsCache,
	);
	if (!filterRenderer) return flat;

	if (isGroup(element)) {
		if (!subtreeHasPreFilter(element, elementsMap, filterRenderer)) {
			return flat;
		}
		const cached = preFilteredLocalBoundsCache.get(element);
		if (cached) return cached;

		const groupPreFilters = geometryFilters(element, filterRenderer);
		// Children live in group-local space (own transforms applied, the
		// group's own transform not yet), so union the deformed bounds there.
		let deformed: BoundingBox = flat;
		for (const id of element.childIds) {
			const child = elementsMap.get(id);
			if (!child) continue;
			deformed = unionBoxes(
				deformed,
				calculatePreFilteredElementBounds(
					withInheritedPreFilters(child, groupPreFilters),
					elementsMap,
					filterRenderer,
					localBoundsCache,
				),
			);
		}
		preFilteredLocalBoundsCache.set(element, deformed);
		return deformed;
	}

	if (isCompoundPath(element)) {
		if (!subtreeHasPreFilter(element, elementsMap, filterRenderer)) {
			return flat;
		}
		const cached = preFilteredLocalBoundsCache.get(element);
		if (cached) return cached;

		const { path, geometries } = resolveCompoundDrawnShape(
			element,
			bakeCompoundPathSegments(
				element,
				(id) => elementsMap.get(id),
				(source) => toCompoundSourceWorldPath(source, filterRenderer),
			),
			filterRenderer,
			false,
		);
		let deformed: BoundingBox = flat;
		for (const segments of geometries) {
			deformed = unionBoxes(
				deformed,
				calculateLocalElementBounds({ ...path, segments }, elementsMap),
			);
		}
		preFilteredLocalBoundsCache.set(element, deformed);
		return deformed;
	}

	if (element.type !== "path" && element.type !== "image") {
		return flat;
	}
	const cached = preFilteredLocalBoundsCache.get(element);
	if (cached) return cached;

	let deformed: BoundingBox;
	if (element.type === "path") {
		const variants = resolvePathGeometryVariants(element, filterRenderer);
		if (!variants) return flat;
		// Appearance-level pre sub-filters deform per appearance on top of the
		// element-level pre-filters, so union every variant's local extent.
		deformed = flat;
		for (const segments of variants) {
			deformed = unionBoxes(
				deformed,
				calculateLocalElementBounds({ ...element, segments }, elementsMap),
			);
		}
	} else {
		const geometry = resolveImageGeometry(element, filterRenderer);
		if (geometry.deformed === geometry.quad) return flat;
		deformed = unionBoxes(flat, segmentControlBounds(geometry.deformed));
	}
	// The union with the flat bounds keeps strokes and effects anchored to the
	// original outline inside the plan bounds.
	preFilteredLocalBoundsCache.set(element, deformed);
	return deformed;
}

function unionBoxes(a: BoundingBox, b: BoundingBox): BoundingBox {
	const minX = Math.min(a.minX, b.minX);
	const minY = Math.min(a.minY, b.minY);
	const maxX = Math.max(a.maxX, b.maxX);
	const maxY = Math.max(a.maxY, b.maxY);
	return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

/** Apply an element's transform to deformed local bounds, so the deformed
 *  extent lands where the renderer actually draws it. */
function transformDeformedLocalBounds(
	bounds: { minX: number; minY: number; maxX: number; maxY: number },
	t: ElementTransform,
): WorldBBox {
	if (isIdentityTransform(t)) {
		return brandWorldBBox({
			...bounds,
			width: bounds.maxX - bounds.minX,
			height: bounds.maxY - bounds.minY,
		});
	}
	const corners = [
		[bounds.minX, bounds.minY],
		[bounds.maxX, bounds.minY],
		[bounds.maxX, bounds.maxY],
		[bounds.minX, bounds.maxY],
	] as const;
	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (const [px, py] of corners) {
		const p = applyTransformToPoint(px, py, t);
		minX = Math.min(minX, p.x);
		minY = Math.min(minY, p.y);
		maxX = Math.max(maxX, p.x);
		maxY = Math.max(maxY, p.y);
	}
	return brandWorldBBox({
		minX,
		minY,
		maxX,
		maxY,
		width: maxX - minX,
		height: maxY - minY,
	});
}

/** Local extent of deformed image segments, control points included —
 *  mirroring ImageElementRenderer, which draws the image rect as a 4-sided
 *  quad path. */
function segmentControlBounds(segments: CubicBezierSegment[]): BoundingBox {
	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	const include = (x: number, y: number) => {
		if (x < minX) minX = x;
		if (y < minY) minY = y;
		if (x > maxX) maxX = x;
		if (y > maxY) maxY = y;
	};
	let prevEnd: CubicBezierSegment["end"] | undefined;
	for (const segment of segments) {
		const start = segment.start ?? prevEnd;
		if (start) {
			include(start.x, start.y);
			include(start.x + segment.cp1.x, start.y + segment.cp1.y);
		}
		include(segment.end.x, segment.end.y);
		include(segment.end.x + segment.cp2.x, segment.end.y + segment.cp2.y);
		prevEnd = segment.end;
	}
	return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}
