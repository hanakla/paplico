import type {
	Artboard,
	CubicBezierSegment,
	ElementTransform,
} from "../../../schema";
import { transformLinearMatrix } from "../../../utils/geometry/geometry";
import { resolveSegment } from "../../../utils/geometry/segmentOps";

/** Row-major 2D affine map in world space: p' = [m00 m01; m10 m11]·p + (tx, ty). */
export interface WorldAffine {
	m00: number;
	m01: number;
	m10: number;
	m11: number;
	tx: number;
	ty: number;
}

/** SVG `matrix(a b c d e f)` coefficients: (x, y) → (a·x + c·y + e, b·x + d·y + f). */
interface SvgMatrix {
	a: number;
	b: number;
	c: number;
	d: number;
	e: number;
	f: number;
}

/**
 * Maps world space (Y-up, origin at canvas center) to SVG viewBox space
 * (Y-down, origin at the artboard's top-left corner).
 */
export interface SvgCoordMapper {
	point(p: { x: number; y: number }): { x: number; y: number };
	/**
	 * Compose the world→SVG map F with an affine map W whose OUTPUT is world
	 * space (F · W). The result maps W's input space (a gradient's unit space,
	 * an image's content space, …) directly into SVG coordinates, suitable
	 * for `transform` / `gradientTransform` / `patternTransform` attributes.
	 */
	composeWorld(world: WorldAffine): SvgMatrix;
}

export function createCoordMapper(artboard: Artboard): SvgCoordMapper {
	// F: svgX = worldX - originX, svgY = originY - worldY
	const originX = artboard.x - artboard.width / 2;
	const originY = artboard.y + artboard.height / 2;

	return {
		point(p) {
			return { x: p.x - originX, y: originY - p.y };
		},
		composeWorld(world) {
			// F · W with F(p) = Fl·p + f, Fl = diag(1, -1), f = (-originX, originY):
			// linear part Fl·M negates the second row, translation is F(t).
			return {
				a: world.m00,
				// Avoid -0 coefficients so numeric consumers see plain zeros.
				b: world.m10 === 0 ? 0 : -world.m10,
				c: world.m01,
				d: world.m11 === 0 ? 0 : -world.m11,
				e: world.tx - originX,
				f: originY - world.ty,
			};
		},
	};
}

/**
 * Uniform scale factor of a transform's linear part, or null when the
 * transform is non-uniform or shears. SVG strokes only support a single
 * width, so a null here means a constant-width stroke cannot be represented.
 */
export function uniformTransformScale(
	transform: ElementTransform,
): number | null {
	const m = transformLinearMatrix(transform);
	const sx = Math.hypot(m.m00, m.m10);
	const sy = Math.hypot(m.m01, m.m11);
	const shear = m.m00 * m.m01 + m.m10 * m.m11;
	const maxScale = Math.max(sx, sy, 1e-12);
	if (
		Math.abs(sx - sy) > maxScale * 1e-3 ||
		Math.abs(shear) > maxScale * maxScale * 1e-3
	) {
		return null;
	}
	return sx;
}

/** Affine mapping bbox-relative unit space (0..1, Y up) onto `bounds`. */
export function boundsUnitAffine(bounds: {
	minX: number;
	minY: number;
	width: number;
	height: number;
}): WorldAffine {
	return {
		m00: bounds.width,
		m01: 0,
		m10: 0,
		m11: bounds.height,
		tx: bounds.minX,
		ty: bounds.minY,
	};
}

/** Compose two affine maps: result(p) = outer(inner(p)). */
export function composeWorldAffine(
	outer: WorldAffine,
	inner: WorldAffine,
): WorldAffine {
	return {
		m00: outer.m00 * inner.m00 + outer.m01 * inner.m10,
		m01: outer.m00 * inner.m01 + outer.m01 * inner.m11,
		m10: outer.m10 * inner.m00 + outer.m11 * inner.m10,
		m11: outer.m10 * inner.m01 + outer.m11 * inner.m11,
		tx: outer.m00 * inner.tx + outer.m01 * inner.ty + outer.tx,
		ty: outer.m10 * inner.tx + outer.m11 * inner.ty + outer.ty,
	};
}

/**
 * Expand an ElementTransform applied around `origin` (the element's local
 * bbox center) into an explicit world-space affine map. Mirrors the point
 * math of `applyTransformToPoint`.
 */
export function elementTransformToWorldAffine(
	transform: ElementTransform,
	origin: { x: number; y: number },
): WorldAffine {
	const m = transformLinearMatrix(transform);
	return {
		m00: m.m00,
		m01: m.m01,
		m10: m.m10,
		m11: m.m11,
		tx: origin.x - (m.m00 * origin.x + m.m01 * origin.y) + transform.x,
		ty: origin.y - (m.m10 * origin.x + m.m11 * origin.y) + transform.y,
	};
}

/**
 * Serialize world-space segments (identity element transform, relative
 * control points) into an SVG path `d` attribute. `isMoved` starts a new
 * subpath (`M`), `isClosed` closes it (`Z`). Straight segments (both control
 * points at zero offset) are emitted as `L`.
 */
export function segmentsToPathData(
	segments: readonly CubicBezierSegment[],
	mapper: SvgCoordMapper,
): string {
	const parts: string[] = [];

	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i];
		const prevEnd = i > 0 ? segments[i - 1].end : undefined;
		const { start, cp1, cp2, end } = resolveSegment(seg, prevEnd);

		if (i === 0 || seg.isMoved) {
			const p = mapper.point(start);
			parts.push(`M ${formatNumber(p.x)} ${formatNumber(p.y)}`);
		}

		const isLine =
			seg.cp1.x === 0 && seg.cp1.y === 0 && seg.cp2.x === 0 && seg.cp2.y === 0;
		const pe = mapper.point(end);
		if (isLine) {
			parts.push(`L ${formatNumber(pe.x)} ${formatNumber(pe.y)}`);
		} else {
			const p1 = mapper.point(cp1);
			const p2 = mapper.point(cp2);
			parts.push(
				`C ${formatNumber(p1.x)} ${formatNumber(p1.y)} ${formatNumber(p2.x)} ${formatNumber(p2.y)} ${formatNumber(pe.x)} ${formatNumber(pe.y)}`,
			);
		}

		if (seg.isClosed) parts.push("Z");
	}

	return parts.join(" ");
}

export function svgMatrixToString(m: SvgMatrix): string {
	return `matrix(${formatNumber(m.a)} ${formatNumber(m.b)} ${formatNumber(m.c)} ${formatNumber(m.d)} ${formatNumber(m.e)} ${formatNumber(m.f)})`;
}

/** Format a coordinate with 3-decimal precision, without `-0` or exponents. */
export function formatNumber(n: number): string {
	const rounded = Math.round(n * 1000) / 1000;
	// Also normalizes -0 (rounding of tiny negatives) to "0".
	if (rounded === 0) return "0";
	return String(rounded);
}
