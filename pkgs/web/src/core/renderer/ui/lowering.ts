import {
	type FillPoint,
	flattenBezierContour,
	triangulateFillContour,
} from "./fillTessellation";
import type {
	ArcPrimitive,
	ArrowPrimitive,
	BezierPathPrimitive,
	CirclePrimitive,
	DiamondPrimitive,
	Dim,
	LinePrimitive,
	PolylinePrimitive,
	RectPrimitive,
	UIPrimitive,
} from "./primitives";
import type { RGBA } from "./theme";

/**
 * Lowering: pure functions turning UIPrimitives into ordered fill-triangle and
 * stroke-bezier instance streams.
 *
 * Instance layout (14 floats): p0(2) cp1(2) cp2(2) p1(2) color(4)
 * halfWidth0(1) halfWidth1(1).
 */

export const BEZIER_INSTANCE_FLOATS = 14;
export const FILL_TRIANGLE_INSTANCE_FLOATS = 11;

// Cubic Bezier approximation of a quarter circle: k = 4/3 × (√2 − 1)
const CIRCLE_BEZIER_K = 0.5522847498;

const HALF_PI = Math.PI / 2;
const TWO_PI = Math.PI * 2;

/** An overlay's primitives with its base z-order. */
export interface OverlayGroup {
	z: number;
	prims: readonly UIPrimitive[];
}

export interface LoweredRun {
	kind: "fill" | "stroke";
	firstInstance: number;
	instanceCount: number;
}

/**
 * Persistent grow-only Float32Array scratch for instance data.
 * Grows 1.5x on demand; never shrinks, so steady-state frames allocate nothing.
 */
export class InstanceScratch {
	private buf: Float32Array<ArrayBuffer>;
	private floats = 0;

	public constructor(
		private readonly instanceFloats = BEZIER_INSTANCE_FLOATS,
		initialInstances = 256,
	) {
		this.buf = new Float32Array(initialInstances * instanceFloats);
	}

	public get instanceCount(): number {
		return this.floats / this.instanceFloats;
	}

	/** View of the written portion (valid until the next alloc/reset). */
	public get view(): Float32Array<ArrayBuffer> {
		return this.buf.subarray(0, this.floats);
	}

	public reset(): void {
		this.floats = 0;
	}

	/** Reserve `instances` slots and return the base float offset to write at. */
	public alloc(instances: number): number {
		const need = this.floats + instances * this.instanceFloats;
		if (need > this.buf.length) {
			const next = new Float32Array(
				Math.ceil(Math.max(need, this.buf.length * 1.5)),
			);
			next.set(this.buf.subarray(0, this.floats));
			this.buf = next;
		}
		const offset = this.floats;
		this.floats = need;
		return offset;
	}

	/** Raw backing array (may be larger than the written portion). */
	public get data(): Float32Array<ArrayBuffer> {
		return this.buf;
	}
}

export class LoweringScratch {
	public readonly fills = new InstanceScratch(FILL_TRIANGLE_INSTANCE_FLOATS);
	public readonly strokes = new InstanceScratch(BEZIER_INSTANCE_FLOATS);
	public readonly runs: LoweredRun[] = [];

	public reset(): void {
		this.fills.reset();
		this.strokes.reset();
		this.runs.length = 0;
	}

	public allocFill(instances: number): number {
		return this.alloc("fill", this.fills, instances);
	}

	public allocStroke(instances: number): number {
		return this.alloc("stroke", this.strokes, instances);
	}

	private alloc(
		kind: LoweredRun["kind"],
		scratch: InstanceScratch,
		instances: number,
	): number {
		const firstInstance = scratch.instanceCount;
		const offset = scratch.alloc(instances);
		const lastRun = this.runs.at(-1);
		if (
			lastRun?.kind === kind &&
			lastRun.firstInstance + lastRun.instanceCount === firstInstance
		) {
			lastRun.instanceCount += instances;
		} else {
			this.runs.push({ kind, firstInstance, instanceCount: instances });
		}
		return offset;
	}
}

/**
 * Sort all primitives by (group z + primitive zIndex, insertion order) and
 * lower them into ordered fill/stroke instance runs.
 */
export function lowerScene(
	groups: readonly OverlayGroup[],
	zoom: number,
	scratch: LoweringScratch,
): readonly LoweredRun[] {
	scratch.reset();

	const entries: Array<{ z: number; seq: number; prim: UIPrimitive }> = [];
	let seq = 0;
	for (const group of groups) {
		for (const prim of group.prims) {
			seq++;
			if (prim.hitOnly) continue;
			entries.push({ z: group.z + (prim.zIndex ?? 0), seq, prim });
		}
	}
	entries.sort((a, b) => a.z - b.z || a.seq - b.seq);

	for (const entry of entries) {
		lowerPrimitive(entry.prim, zoom, scratch);
	}
	return scratch.runs;
}

/** Resolve a size Dim to world units. Bare number = world; screen = px / zoom. */
export function resolveSizeDim(dim: Dim, zoom: number): number {
	if (typeof dim === "number") return dim;
	return (dim.world ?? 0) + (dim.screen ?? 0) / zoom;
}

/**
 * Resolve a stroke-width Dim to a world half-width. Both components are exact
 * halves (`px / 2 / zoom`, `w / 2`): the bezier shader's analytic AA places the
 * coverage edge at the true half-width, so no width compensation is needed.
 * Bare number = screen pixels.
 */
export function resolveStrokeHalfWidth(dim: Dim, zoom: number): number {
	if (typeof dim === "number") return dim / 2 / zoom;
	const screen = dim.screen != null ? dim.screen / 2 / zoom : 0;
	const world = dim.world != null ? dim.world / 2 : 0;
	return screen + world;
}

/** Resolve a screen-fixed offset to world units (px / zoom, world Y-up axes). */
export function resolveScreenOffset(
	screenOffset: { x: number; y: number } | undefined,
	zoom: number,
): { x: number; y: number } {
	return {
		x: (screenOffset?.x ?? 0) / zoom,
		y: (screenOffset?.y ?? 0) / zoom,
	};
}

// --- Per-primitive lowering ---

function lowerPrimitive(
	prim: UIPrimitive,
	zoom: number,
	scratch: LoweringScratch,
): void {
	const { x: ox, y: oy } = resolveScreenOffset(prim.screenOffset, zoom);

	switch (prim.kind) {
		case "circle":
			lowerCircle(prim, zoom, ox, oy, scratch);
			break;
		case "rect":
			lowerRect(prim, zoom, ox, oy, scratch);
			break;
		case "diamond":
			lowerDiamond(prim, zoom, ox, oy, scratch);
			break;
		case "line":
			lowerLine(prim, zoom, ox, oy, scratch);
			break;
		case "polyline":
			lowerPolyline(prim, zoom, ox, oy, scratch);
			break;
		case "bezierPath":
			lowerBezierPath(prim, zoom, ox, oy, scratch);
			break;
		case "arc":
			lowerArc(prim, zoom, ox, oy, scratch);
			break;
		case "arrow":
			lowerArrow(prim, zoom, ox, oy, scratch);
			break;
	}
}

function lowerCircle(
	prim: CirclePrimitive,
	zoom: number,
	ox: number,
	oy: number,
	scratch: LoweringScratch,
): void {
	const radius = resolveSizeDim(prim.radius, zoom);
	lowerBezierPath(
		{
			kind: "bezierPath",
			segments: createCircleSegments(prim.cx, prim.cy, radius),
			closed: true,
			fill: prim.fill,
			stroke: prim.stroke,
		},
		zoom,
		ox,
		oy,
		scratch,
	);
}

function lowerRect(
	prim: RectPrimitive,
	zoom: number,
	ox: number,
	oy: number,
	scratch: LoweringScratch,
): void {
	const w = resolveSizeDim(prim.width, zoom);
	const h = resolveSizeDim(prim.height, zoom);
	const r =
		prim.cornerRadius != null ? resolveSizeDim(prim.cornerRadius, zoom) : 0;
	// Rounded corners reuse the bezier fill/stroke path (like lowerCircle), so the
	// rounding is emitted as GPU geometry rather than a separate shader.
	if (r > 0) {
		lowerBezierPath(
			{
				kind: "bezierPath",
				segments: createRoundedRectSegments(
					prim.cx,
					prim.cy,
					w / 2,
					h / 2,
					Math.min(r, w / 2, h / 2),
				),
				closed: true,
				fill: prim.fill,
				stroke: prim.stroke,
			},
			zoom,
			ox,
			oy,
			scratch,
		);
		return;
	}

	const cx = prim.cx + ox;
	const cy = prim.cy + oy;
	const minX = cx - w / 2;
	const maxX = cx + w / 2;
	const minY = cy - h / 2;
	const maxY = cy + h / 2;

	if (prim.fill) {
		writeFillContour(
			scratch,
			[
				{ x: minX, y: minY },
				{ x: maxX, y: minY },
				{ x: maxX, y: maxY },
				{ x: minX, y: maxY },
			],
			prim.fill.color,
		);
	}
	if (prim.stroke) {
		const [r, g, b, a] = prim.stroke.color;
		const hw = resolveStrokeHalfWidth(prim.stroke.width, zoom);
		const edges: Array<[number, number, number, number]> = [
			[minX, maxY, maxX, maxY],
			[maxX, maxY, maxX, minY],
			[maxX, minY, minX, minY],
			[minX, minY, minX, maxY],
		];
		if (prim.stroke.dash) {
			for (const [x1, y1, x2, y2] of edges) {
				writeDashedLineInstances(
					scratch,
					x1,
					y1,
					x2,
					y2,
					r,
					g,
					b,
					a,
					hw,
					prim.stroke.dash.length / zoom,
					prim.stroke.dash.gap / zoom,
				);
			}
			return;
		}
		const off = scratch.allocStroke(4);
		const d = scratch.strokes.data;
		const F = BEZIER_INSTANCE_FLOATS;
		for (let i = 0; i < 4; i++) {
			const [x1, y1, x2, y2] = edges[i];
			writeLineInstance(d, off + i * F, x1, y1, x2, y2, r, g, b, a, hw);
		}
	}
}

/**
 * Emit one stroke instance per dash along the segment. Dash/gap are world
 * units (screen px already divided by zoom); the last dash is clipped to the
 * segment end.
 */
function writeDashedLineInstances(
	scratch: LoweringScratch,
	x1: number,
	y1: number,
	x2: number,
	y2: number,
	r: number,
	g: number,
	b: number,
	a: number,
	hw: number,
	dashLen: number,
	gapLen: number,
): void {
	const len = Math.hypot(x2 - x1, y2 - y1);
	const period = dashLen + gapLen;
	if (len < 1e-9 || period <= 0) {
		const off = scratch.allocStroke(1);
		writeLineInstance(
			scratch.strokes.data,
			off,
			x1,
			y1,
			x2,
			y2,
			r,
			g,
			b,
			a,
			hw,
		);
		return;
	}
	const ux = (x2 - x1) / len;
	const uy = (y2 - y1) / len;
	const count = Math.ceil(len / period);
	const off = scratch.allocStroke(count);
	const d = scratch.strokes.data;
	for (let i = 0; i < count; i++) {
		const s = i * period;
		const e = Math.min(s + dashLen, len);
		writeLineInstance(
			d,
			off + i * BEZIER_INSTANCE_FLOATS,
			x1 + ux * s,
			y1 + uy * s,
			x1 + ux * e,
			y1 + uy * e,
			r,
			g,
			b,
			a,
			hw,
		);
	}
}

function lowerDiamond(
	prim: DiamondPrimitive,
	zoom: number,
	ox: number,
	oy: number,
	scratch: LoweringScratch,
): void {
	const cx = prim.cx + ox;
	const cy = prim.cy + oy;
	const hs = resolveSizeDim(prim.halfSize, zoom);

	if (prim.fill) {
		writeFillContour(
			scratch,
			[
				{ x: cx, y: cy + hs },
				{ x: cx + hs, y: cy },
				{ x: cx, y: cy - hs },
				{ x: cx - hs, y: cy },
			],
			prim.fill.color,
		);
	}
	if (prim.stroke) {
		// 4 edges: top→right, right→bottom, bottom→left, left→top.
		const [r, g, b, a] = prim.stroke.color;
		const hw = resolveStrokeHalfWidth(prim.stroke.width, zoom);
		const off = scratch.allocStroke(4);
		const d = scratch.strokes.data;
		const F = BEZIER_INSTANCE_FLOATS;
		writeLineInstance(d, off, cx, cy + hs, cx + hs, cy, r, g, b, a, hw);
		writeLineInstance(d, off + F, cx + hs, cy, cx, cy - hs, r, g, b, a, hw);
		writeLineInstance(d, off + 2 * F, cx, cy - hs, cx - hs, cy, r, g, b, a, hw);
		writeLineInstance(d, off + 3 * F, cx - hs, cy, cx, cy + hs, r, g, b, a, hw);
	}
}

function lowerLine(
	prim: LinePrimitive,
	zoom: number,
	ox: number,
	oy: number,
	scratch: LoweringScratch,
): void {
	const x1 = prim.x1 + ox;
	const y1 = prim.y1 + oy;
	const x2 = prim.x2 + ox;
	const y2 = prim.y2 + oy;

	if (prim.fill) {
		const [r, g, b, a] = prim.fill.color;
		const hw = resolveSizeDim(prim.fill.width, zoom) / 2;
		const off = scratch.allocStroke(1);
		writeLineInstance(
			scratch.strokes.data,
			off,
			x1,
			y1,
			x2,
			y2,
			r,
			g,
			b,
			a,
			hw,
		);
	}
	if (prim.stroke) {
		const [r, g, b, a] = prim.stroke.color;
		const hw = resolveStrokeHalfWidth(prim.stroke.width, zoom);
		const off = scratch.allocStroke(1);
		writeLineInstance(
			scratch.strokes.data,
			off,
			x1,
			y1,
			x2,
			y2,
			r,
			g,
			b,
			a,
			hw,
		);
	}
}

function lowerPolyline(
	prim: PolylinePrimitive,
	zoom: number,
	ox: number,
	oy: number,
	scratch: LoweringScratch,
): void {
	const points = prim.points;
	if (points.length < 2) return;

	if (prim.fill && points.length >= 3) {
		writeFillContour(
			scratch,
			points.map(({ x, y }) => ({ x: x + ox, y: y + oy })),
			prim.fill.color,
		);
	}
	if (prim.stroke) {
		const [r, g, b, a] = prim.stroke.color;
		const hw = resolveStrokeHalfWidth(prim.stroke.width, zoom);
		const segCount = prim.closed ? points.length : points.length - 1;
		const off = scratch.allocStroke(segCount);
		const d = scratch.strokes.data;
		for (let i = 0; i < points.length - 1; i++) {
			const p0 = points[i];
			const p1 = points[i + 1];
			writeLineInstance(
				d,
				off + i * BEZIER_INSTANCE_FLOATS,
				p0.x + ox,
				p0.y + oy,
				p1.x + ox,
				p1.y + oy,
				r,
				g,
				b,
				a,
				hw,
			);
		}
		if (prim.closed) {
			const first = points[0];
			const last = points.at(-1)!;
			writeLineInstance(
				d,
				off + (segCount - 1) * BEZIER_INSTANCE_FLOATS,
				last.x + ox,
				last.y + oy,
				first.x + ox,
				first.y + oy,
				r,
				g,
				b,
				a,
				hw,
			);
		}
	}
}

function lowerBezierPath(
	prim: BezierPathPrimitive,
	zoom: number,
	ox: number,
	oy: number,
	scratch: LoweringScratch,
): void {
	const segments = prim.segments;
	if (segments.length === 0) return;

	if (prim.fill && prim.closed) {
		writeFillContour(
			scratch,
			flattenBezierContour(segments, ox, oy, 0.25 / zoom),
			prim.fill.color,
		);
	}
	if (!prim.stroke) return;

	const [r, g, b, a] = prim.stroke.color;
	const hw = resolveStrokeHalfWidth(prim.stroke.width, zoom);
	const off = scratch.allocStroke(segments.length);
	const d = scratch.strokes.data;
	let prevEnd: { x: number; y: number } | null = null;

	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i];
		const p0 = seg.start ?? prevEnd ?? seg.end;
		const base = off + i * BEZIER_INSTANCE_FLOATS;
		d[base] = p0.x + ox;
		d[base + 1] = p0.y + oy;
		d[base + 2] = seg.cp1.x + ox;
		d[base + 3] = seg.cp1.y + oy;
		d[base + 4] = seg.cp2.x + ox;
		d[base + 5] = seg.cp2.y + oy;
		d[base + 6] = seg.end.x + ox;
		d[base + 7] = seg.end.y + oy;
		d[base + 8] = r;
		d[base + 9] = g;
		d[base + 10] = b;
		d[base + 11] = a;
		d[base + 12] = hw;
		d[base + 13] = hw;
		prevEnd = seg.end;
	}
}

function lowerArc(
	prim: ArcPrimitive,
	zoom: number,
	ox: number,
	oy: number,
	scratch: LoweringScratch,
): void {
	const cx = prim.cx + ox;
	const cy = prim.cy + oy;
	const rx = resolveSizeDim(prim.radiusX, zoom);
	const ry = prim.radiusY != null ? resolveSizeDim(prim.radiusY, zoom) : rx;
	const rotation = prim.rotation ?? 0;
	const [r, g, b, a] = prim.stroke.color;
	const hw = resolveStrokeHalfWidth(prim.stroke.width, zoom);
	const sweep = prim.endAngle - prim.startAngle;

	if (Math.abs(sweep) >= TWO_PI) {
		const off = scratch.allocStroke(4);
		writeFullEllipseInstances(
			scratch.strokes.data,
			off,
			cx,
			cy,
			rx,
			ry,
			rotation,
			r,
			g,
			b,
			a,
			hw,
		);
		return;
	}
	if (sweep === 0) return;

	// Split into ≤4 cubic segments of at most 90° each.
	const segCount = Math.min(4, Math.ceil(Math.abs(sweep) / HALF_PI));
	const segSweep = sweep / segCount;
	const k = (4 / 3) * Math.tan(segSweep / 4);
	const cosR = Math.cos(rotation);
	const sinR = Math.sin(rotation);
	const off = scratch.allocStroke(segCount);
	const d = scratch.strokes.data;

	for (let i = 0; i < segCount; i++) {
		const a0 = prim.startAngle + segSweep * i;
		const a1 = a0 + segSweep;
		const cos0 = Math.cos(a0);
		const sin0 = Math.sin(a0);
		const cos1 = Math.cos(a1);
		const sin1 = Math.sin(a1);
		// Local (unrotated) endpoints and tangent-scaled control points
		const local = [
			cos0 * rx,
			sin0 * ry,
			cos0 * rx - k * sin0 * rx,
			sin0 * ry + k * cos0 * ry,
			cos1 * rx + k * sin1 * rx,
			sin1 * ry - k * cos1 * ry,
			cos1 * rx,
			sin1 * ry,
		];
		const base = off + i * BEZIER_INSTANCE_FLOATS;
		for (let p = 0; p < 4; p++) {
			const lx = local[p * 2];
			const ly = local[p * 2 + 1];
			d[base + p * 2] = cx + lx * cosR - ly * sinR;
			d[base + p * 2 + 1] = cy + lx * sinR + ly * cosR;
		}
		d[base + 8] = r;
		d[base + 9] = g;
		d[base + 10] = b;
		d[base + 11] = a;
		d[base + 12] = hw;
		d[base + 13] = hw;
	}
}

function lowerArrow(
	prim: ArrowPrimitive,
	zoom: number,
	ox: number,
	oy: number,
	scratch: LoweringScratch,
): void {
	const x1 = prim.x1 + ox;
	const y1 = prim.y1 + oy;
	const x2 = prim.x2 + ox;
	const y2 = prim.y2 + oy;
	const dx = x2 - x1;
	const dy = y2 - y1;
	const len = Math.hypot(dx, dy);
	if (len === 0) return;

	const [r, g, b, a] = prim.color;
	const headLength = resolveSizeDim(prim.headLength, zoom);
	const headHalfWidth = resolveSizeDim(prim.headWidth, zoom) / 2;
	const ux = dx / len;
	const uy = dy / len;
	const baseX = x2 - ux * headLength;
	const baseY = y2 - uy * headLength;

	// Shaft: tail → head base
	const shaftHw = resolveStrokeHalfWidth(prim.width, zoom);
	const off = scratch.allocStroke(1);
	const d = scratch.strokes.data;
	writeLineInstance(d, off, x1, y1, baseX, baseY, r, g, b, a, shaftHw);

	const nx = -uy * headHalfWidth;
	const ny = ux * headHalfWidth;
	writeFillContour(
		scratch,
		[
			{ x: baseX + nx, y: baseY + ny },
			{ x: baseX - nx, y: baseY - ny },
			{ x: x2, y: y2 },
		],
		prim.color,
	);
}

function createCircleSegments(
	cx: number,
	cy: number,
	radius: number,
): BezierPathPrimitive["segments"] {
	const k = CIRCLE_BEZIER_K * radius;
	return [
		{
			start: { x: cx + radius, y: cy },
			cp1: { x: cx + radius, y: cy + k },
			cp2: { x: cx + k, y: cy + radius },
			end: { x: cx, y: cy + radius },
		},
		{
			cp1: { x: cx - k, y: cy + radius },
			cp2: { x: cx - radius, y: cy + k },
			end: { x: cx - radius, y: cy },
		},
		{
			cp1: { x: cx - radius, y: cy - k },
			cp2: { x: cx - k, y: cy - radius },
			end: { x: cx, y: cy - radius },
		},
		{
			cp1: { x: cx + k, y: cy - radius },
			cp2: { x: cx + radius, y: cy - k },
			end: { x: cx + radius, y: cy },
		},
	];
}

/** Rounded-rect outline as cubic-bezier segments (4 straight edges + 4 corner
 *  quarter-arcs), matching createCircleSegments' absolute-control-point format
 *  and CCW winding. `r` must already be clamped to <= min(hw, hh). */
function createRoundedRectSegments(
	cx: number,
	cy: number,
	hw: number,
	hh: number,
	r: number,
): BezierPathPrimitive["segments"] {
	const k = CIRCLE_BEZIER_K * r;
	const L = cx - hw;
	const R = cx + hw;
	const B = cy - hh;
	const T = cy + hh;
	return [
		// Right edge (bottom → top).
		{
			start: { x: R, y: B + r },
			cp1: { x: R, y: B + r },
			cp2: { x: R, y: T - r },
			end: { x: R, y: T - r },
		},
		// Top-right corner (east → north).
		{
			cp1: { x: R, y: T - r + k },
			cp2: { x: R - r + k, y: T },
			end: { x: R - r, y: T },
		},
		// Top edge (right → left).
		{
			cp1: { x: R - r, y: T },
			cp2: { x: L + r, y: T },
			end: { x: L + r, y: T },
		},
		// Top-left corner (north → west).
		{
			cp1: { x: L + r - k, y: T },
			cp2: { x: L, y: T - r + k },
			end: { x: L, y: T - r },
		},
		// Left edge (top → bottom).
		{
			cp1: { x: L, y: T - r },
			cp2: { x: L, y: B + r },
			end: { x: L, y: B + r },
		},
		// Bottom-left corner (west → south).
		{
			cp1: { x: L, y: B + r - k },
			cp2: { x: L + r - k, y: B },
			end: { x: L + r, y: B },
		},
		// Bottom edge (left → right).
		{
			cp1: { x: L + r, y: B },
			cp2: { x: R - r, y: B },
			end: { x: R - r, y: B },
		},
		// Bottom-right corner (south → east).
		{
			cp1: { x: R - r + k, y: B },
			cp2: { x: R, y: B + r - k },
			end: { x: R, y: B + r },
		},
	];
}

function writeFillContour(
	scratch: LoweringScratch,
	points: readonly FillPoint[],
	color: RGBA,
): void {
	const triangles = triangulateFillContour(points);
	if (triangles.length === 0) return;

	const offset = scratch.allocFill(triangles.length);
	const data = scratch.fills.data;
	const [r, g, b, a] = color;
	for (let i = 0; i < triangles.length; i++) {
		const triangle = triangles[i];
		const base = offset + i * FILL_TRIANGLE_INSTANCE_FLOATS;
		data[base] = triangle.p0.x;
		data[base + 1] = triangle.p0.y;
		data[base + 2] = triangle.p1.x;
		data[base + 3] = triangle.p1.y;
		data[base + 4] = triangle.p2.x;
		data[base + 5] = triangle.p2.y;
		data[base + 6] = r;
		data[base + 7] = g;
		data[base + 8] = b;
		data[base + 9] = a;
		data[base + 10] = triangle.boundaryMask;
	}
}

// --- Instance write helpers ---

/** Write a degenerate cubic bezier instance (straight line). */
function writeLineInstance(
	data: Float32Array,
	offset: number,
	x1: number,
	y1: number,
	x2: number,
	y2: number,
	r: number,
	g: number,
	b: number,
	a: number,
	halfWidth: number,
): void {
	data[offset] = x1;
	data[offset + 1] = y1; // p0
	data[offset + 2] = x1;
	data[offset + 3] = y1; // cp1 = p0
	data[offset + 4] = x2;
	data[offset + 5] = y2; // cp2 = p1
	data[offset + 6] = x2;
	data[offset + 7] = y2; // p1
	data[offset + 8] = r;
	data[offset + 9] = g;
	data[offset + 10] = b;
	data[offset + 11] = a;
	data[offset + 12] = halfWidth;
	data[offset + 13] = halfWidth;
}

/** Write 4 cubic bezier instances approximating a full ellipse with rotation. */
function writeFullEllipseInstances(
	data: Float32Array,
	offset: number,
	cx: number,
	cy: number,
	rx: number,
	ry: number,
	rotation: number,
	r: number,
	g: number,
	b: number,
	a: number,
	halfWidth: number,
): void {
	const cosR = Math.cos(rotation);
	const sinR = Math.sin(rotation);
	const krx = CIRCLE_BEZIER_K * rx;
	const kry = CIRCLE_BEZIER_K * ry;
	// Local coordinates (before rotation) for each quarter arc:
	// right→top, top→left, left→bottom, bottom→right
	const localArcs: [
		number,
		number,
		number,
		number,
		number,
		number,
		number,
		number,
	][] = [
		[rx, 0, rx, kry, krx, ry, 0, ry],
		[0, ry, -krx, ry, -rx, kry, -rx, 0],
		[-rx, 0, -rx, -kry, -krx, -ry, 0, -ry],
		[0, -ry, krx, -ry, rx, -kry, rx, 0],
	];

	for (let q = 0; q < 4; q++) {
		const local = localArcs[q];
		const base = offset + q * BEZIER_INSTANCE_FLOATS;
		// Apply rotation and translate to center for each control point
		for (let p = 0; p < 4; p++) {
			const lx = local[p * 2];
			const ly = local[p * 2 + 1];
			data[base + p * 2] = cx + lx * cosR - ly * sinR;
			data[base + p * 2 + 1] = cy + lx * sinR + ly * cosR;
		}
		data[base + 8] = r;
		data[base + 9] = g;
		data[base + 10] = b;
		data[base + 11] = a;
		data[base + 12] = halfWidth;
		data[base + 13] = halfWidth;
	}
}
