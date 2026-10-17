import type { Point } from "../../../schema";
import { type Color, colorToRawRGBA, toRGBColor } from "../../../schema";
import type { MeshVertexLike } from "../measure/meshTopology";

export interface MeshColorVertexLike extends MeshVertexLike {
	color: Color;
	colorSource?:
		| { kind: "quad"; faceVerts: number[]; u: number; v: number }
		| { kind: "edge"; edgeVerts: number[]; t: number };
}

// -----------------------------------------------------------------------------
// sRGB ↔ OKLab (Björn Ottosson) — for perceptual color interpolation.
// -----------------------------------------------------------------------------

function srgbChannelToLinear(v: number): number {
	return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function linearToSrgbChannel(v: number): number {
	return v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
}

function srgbToOklab(
	r: number,
	g: number,
	b: number,
): [number, number, number] {
	const lr = srgbChannelToLinear(r);
	const lg = srgbChannelToLinear(g);
	const lb = srgbChannelToLinear(b);
	const l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
	const m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
	const s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;
	const l_ = Math.cbrt(l);
	const m_ = Math.cbrt(m);
	const s_ = Math.cbrt(s);
	return [
		0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
		1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
		0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
	];
}

function oklabToSrgb(
	L: number,
	A: number,
	B: number,
): [number, number, number] {
	const l_ = L + 0.3963377774 * A + 0.2158037573 * B;
	const m_ = L - 0.1055613458 * A - 0.0638541728 * B;
	const s_ = L - 0.0894841775 * A - 1.291485548 * B;
	const l = l_ * l_ * l_;
	const m = m_ * m_ * m_;
	const s = s_ * s_ * s_;
	const lr = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
	const lg = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
	const lb = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
	return [
		Math.max(0, Math.min(1, linearToSrgbChannel(lr))),
		Math.max(0, Math.min(1, linearToSrgbChannel(lg))),
		Math.max(0, Math.min(1, linearToSrgbChannel(lb))),
	];
}

function colorToRGB(c: Color): { r: number; g: number; b: number; a: number } {
	return colorToRawRGBA(c);
}

/** Perceptual bilinear interpolation of four corner colors in OKLab. */
function bilinearColorOklab(
	c00: Color,
	c10: Color,
	c11: Color,
	c01: Color,
	u: number,
	v: number,
): Color {
	const r00 = colorToRGB(c00);
	const r10 = colorToRGB(c10);
	const r11 = colorToRGB(c11);
	const r01 = colorToRGB(c01);
	const lab00 = srgbToOklab(r00.r, r00.g, r00.b);
	const lab10 = srgbToOklab(r10.r, r10.g, r10.b);
	const lab11 = srgbToOklab(r11.r, r11.g, r11.b);
	const lab01 = srgbToOklab(r01.r, r01.g, r01.b);
	const mu = 1 - u;
	const mv = 1 - v;
	const L =
		mu * mv * lab00[0] +
		u * mv * lab10[0] +
		u * v * lab11[0] +
		mu * v * lab01[0];
	const A =
		mu * mv * lab00[1] +
		u * mv * lab10[1] +
		u * v * lab11[1] +
		mu * v * lab01[1];
	const B =
		mu * mv * lab00[2] +
		u * mv * lab10[2] +
		u * v * lab11[2] +
		mu * v * lab01[2];
	const [r, g, b] = oklabToSrgb(L, A, B);
	const a = mu * mv * r00.a + u * mv * r10.a + u * v * r11.a + mu * v * r01.a;
	return toRGBColor({ r, g, b, a });
}

/** Perceptual 1D interpolation of two endpoint colors in OKLab at parameter t. */
function lerpColorOklab(a: Color, b: Color, t: number): Color {
	const ra = colorToRGB(a);
	const rb = colorToRGB(b);
	const la = srgbToOklab(ra.r, ra.g, ra.b);
	const lb = srgbToOklab(rb.r, rb.g, rb.b);
	const mt = 1 - t;
	const [r, g, b2] = oklabToSrgb(
		mt * la[0] + t * lb[0],
		mt * la[1] + t * lb[1],
		mt * la[2] + t * lb[2],
	);
	return toRGBColor({ r, g, b: b2, a: mt * ra.a + t * rb.a });
}

/** Coons-patch corner color at (u, v) for a quad. */
export function colorFromFaceCorners(
	vertices: readonly MeshColorVertexLike[],
	faceVerts: readonly number[],
	u: number,
	v: number,
): Color {
	const [i00, i10, i11, i01] = faceVerts;
	return bilinearColorOklab(
		vertices[i00].color,
		vertices[i10].color,
		vertices[i11].color,
		vertices[i01].color,
		u,
		v,
	);
}

/** Edge color at parameter t. */
export function colorFromEdge(
	vertices: readonly MeshColorVertexLike[],
	edgeVerts: readonly number[],
	t: number,
): Color {
	return lerpColorOklab(
		vertices[edgeVerts[0]].color,
		vertices[edgeVerts[1]].color,
		t,
	);
}

// -----------------------------------------------------------------------------
// Derived vertex factories
// -----------------------------------------------------------------------------

/** Creates a position-only derived vertex on the interior of a quad face. */
export function createQuadDerivedGeometryVertex<V extends MeshVertexLike>(
	position: Point,
	factory: (fields: {
		x: number;
		y: number;
		handles: Record<number, Point>;
	}) => V,
): V {
	return factory({ x: position.x, y: position.y, handles: {} });
}

/** Creates a position-only derived vertex on an edge, with positionSource recorded. */
export function createEdgeDerivedGeometryVertex<V extends MeshVertexLike>(
	position: Point,
	edgeVerts: readonly number[],
	t: number,
	factory: (fields: {
		x: number;
		y: number;
		handles: Record<number, Point>;
		positionSource: { edgeVerts: number[]; t: number };
		meshSource: { edgeVerts: number[]; t: number };
	}) => V,
): V {
	return factory({
		x: position.x,
		y: position.y,
		handles: {},
		positionSource: { edgeVerts: [...edgeVerts], t },
		meshSource: { edgeVerts: [...edgeVerts], t },
	});
}

/** Creates a color+position derived vertex on the interior of a quad. */
export function createQuadDerivedColorVertex<V extends MeshColorVertexLike>(
	vertices: readonly MeshColorVertexLike[],
	position: Point,
	faceVerts: readonly number[],
	u: number,
	v: number,
	factory: (fields: {
		x: number;
		y: number;
		color: Color;
		colorMode: "derived";
		colorSource: { kind: "quad"; faceVerts: number[]; u: number; v: number };
		handles: Record<number, Point>;
	}) => V,
): V {
	return factory({
		x: position.x,
		y: position.y,
		color: colorFromFaceCorners(vertices, faceVerts, u, v),
		colorMode: "derived",
		colorSource: { kind: "quad", faceVerts: [...faceVerts], u, v },
		handles: {},
	});
}

/** Creates a color+position derived vertex on an edge. */
export function createEdgeDerivedColorVertex<V extends MeshColorVertexLike>(
	vertices: readonly MeshColorVertexLike[],
	position: Point,
	edgeVerts: readonly number[],
	t: number,
	factory: (fields: {
		x: number;
		y: number;
		color: Color;
		colorMode: "derived";
		colorSource: { kind: "edge"; edgeVerts: number[]; t: number };
		positionSource: { edgeVerts: number[]; t: number };
		meshSource: { edgeVerts: number[]; t: number };
		handles: Record<number, Point>;
	}) => V,
): V {
	return factory({
		x: position.x,
		y: position.y,
		color: colorFromEdge(vertices, edgeVerts, t),
		colorMode: "derived",
		colorSource: { kind: "edge", edgeVerts: [...edgeVerts], t },
		positionSource: { edgeVerts: [...edgeVerts], t },
		meshSource: { edgeVerts: [...edgeVerts], t },
		handles: {},
	});
}
