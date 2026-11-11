import type {
	BoundingBox,
	CubicBezierSegment,
	ImageObject,
	Vec2,
} from "../../schema";
import { localAppearances } from "../appearancePresets";
import type { FilterCapabilityLookup } from "./filterCapabilities";
import { applyPreFilters } from "./preFilters";

/**
 * The rectangle an image is drawn as, in its local space, before and after its
 * geometry filters: `quad` traces the (possibly free-transformed) corners as
 * a 4-sided path, `deformed` is that quad after the filters — the same
 * reference as `quad` when nothing deforms it. `localBounds` is the flat
 * rect. Rendering, bounds and hit testing all read the image shape here.
 */
export function resolveImageGeometry(
	image: ImageObject,
	filterRenderer: FilterCapabilityLookup,
): {
	localBounds: BoundingBox;
	quad: CubicBezierSegment[];
	deformed: CubicBezierSegment[];
} {
	const halfWidth = image.width / 2;
	const halfHeight = image.height / 2;
	const localBounds = {
		minX: image.x - halfWidth,
		minY: image.y - halfHeight,
		maxX: image.x + halfWidth,
		maxY: image.y + halfHeight,
		width: image.width,
		height: image.height,
	};
	const quad = buildImageQuadSegments(localBounds, image.corners);
	// applyPreFilters returns the input by reference when no enabled geometry
	// filter applies; a filter that leaves the geometry unchanged is treated
	// as no deformation either.
	const filtered = applyPreFilters(
		quad,
		localAppearances(image.filters),
		filterRenderer,
	);
	const deformed =
		filtered === quad || hasSameSegmentGeometry(filtered, quad)
			? quad
			: filtered;
	return { localBounds, quad, deformed };
}

/**
 * Build 4 separate cubic bezier sub-paths (one per side) tracing TL→TR→BR→BL→TL.
 * Each side is its own isMoved sub-path so preProcess output can be split back
 * into exactly 4 pieces after any adaptive subdivision. Control points are
 * offset by ±1/3 of the side vector so that non-linear deformations (e.g.
 * perspective projection) produce visually smooth curves.
 */
export function buildImageQuadSegments(
	bounds: {
		minX: number;
		minY: number;
		maxX: number;
		maxY: number;
	},
	corners?: [Vec2, Vec2, Vec2, Vec2],
): CubicBezierSegment[] {
	// Free-transform vertex data replaces the rectangle's corners; geometry
	// filters (e.g. 3d-rotate) still compose on top of the warped quad.
	const tl = corners
		? { x: corners[0][0], y: corners[0][1] }
		: { x: bounds.minX, y: bounds.maxY };
	const tr = corners
		? { x: corners[1][0], y: corners[1][1] }
		: { x: bounds.maxX, y: bounds.maxY };
	const br = corners
		? { x: corners[2][0], y: corners[2][1] }
		: { x: bounds.maxX, y: bounds.minY };
	const bl = corners
		? { x: corners[3][0], y: corners[3][1] }
		: { x: bounds.minX, y: bounds.minY };

	const sideSegment = (
		from: { x: number; y: number },
		to: { x: number; y: number },
		isLast: boolean,
	): CubicBezierSegment => {
		const dx = (to.x - from.x) / 3;
		const dy = (to.y - from.y) / 3;
		return {
			start: { x: from.x, y: from.y },
			cp1: { x: dx, y: dy },
			cp2: { x: -dx, y: -dy },
			end: { x: to.x, y: to.y },
			startTiltX: 0,
			startTiltY: 0,
			endTiltX: 0,
			endTiltY: 0,
			startDeltaTime: 0,
			endDeltaTime: 0,
			isMoved: true,
			isClosed: isLast ? true : undefined,
		};
	};

	return [
		sideSegment(tl, tr, false),
		sideSegment(tr, br, false),
		sideSegment(br, bl, false),
		sideSegment(bl, tl, true),
	];
}

function hasSameSegmentGeometry(
	a: CubicBezierSegment[],
	b: CubicBezierSegment[],
): boolean {
	if (a.length !== b.length) return false;

	for (let i = 0; i < a.length; i++) {
		if (!hasSamePointGeometry(a[i].start, b[i].start)) return false;
		if (!hasSamePointGeometry(a[i].cp1, b[i].cp1)) return false;
		if (!hasSamePointGeometry(a[i].cp2, b[i].cp2)) return false;
		if (!hasSamePointGeometry(a[i].end, b[i].end)) return false;
		if (a[i].isMoved !== b[i].isMoved) return false;
		if (a[i].isClosed !== b[i].isClosed) return false;
	}

	return true;
}

function hasSamePointGeometry(
	a: { x: number; y: number } | undefined,
	b: { x: number; y: number } | undefined,
): boolean {
	return a?.x === b?.x && a?.y === b?.y;
}
