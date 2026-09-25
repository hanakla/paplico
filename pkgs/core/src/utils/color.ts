import {
	type AnyArtObject,
	type Color,
	type FillAppearance,
	type FillColor,
	type Filter,
	hsvToRgb,
	isAppearancePresetRef,
	type RGBColor,
	type StrokeAppearance,
	type StrokeColor,
} from "../schema";

export function lerpOptionalScalar(
	a: number | undefined,
	b: number | undefined,
	t: number,
	fallback: number,
): number {
	const va = a ?? fallback;
	const vb = b ?? fallback;
	return va + (vb - va) * t;
}

export function lerpOptionalRGBColor(
	a: RGBColor | undefined,
	b: RGBColor | undefined,
	t: number,
): RGBColor | undefined {
	if (a == null && b == null) return undefined;
	const da: RGBColor = a ?? { type: "rgb", r: 0, g: 0, b: 0, a: 1 };
	const db: RGBColor = b ?? { type: "rgb", r: 0, g: 0, b: 0, a: 1 };
	return {
		type: "rgb",
		r: da.r + (db.r - da.r) * t,
		g: da.g + (db.g - da.g) * t,
		b: da.b + (db.b - da.b) * t,
		a: da.a + (db.a - da.a) * t,
	};
}

// PQ constants (SMPTE ST 2084)
const PQ_M1 = 0.1593017578125;
const PQ_M2 = 78.84375;
const PQ_C1 = 0.8359375;
const PQ_C2 = 18.8515625;
const PQ_C3 = 18.6875;

/** sRGB EOTF: sRGB gamma [0,∞) → linear light [0,∞) */
export function srgbEotf(v: number): number {
	return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/** sRGB OETF: linear light [0,∞) → sRGB gamma [0,∞) */
export function srgbOetf(v: number): number {
	return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
}

/** PQ OETF (SMPTE ST 2084): absolute luminance [0, 10000] cd/m² → PQ signal [0,1] */
export function pqOetf(nits: number): number {
	const y = Math.max(nits, 0) / 10000;
	const yPow = y ** PQ_M1;
	return ((PQ_C1 + PQ_C2 * yPow) / (1 + PQ_C3 * yPow)) ** PQ_M2;
}

/** PQ EOTF (SMPTE ST 2084): PQ signal [0,1] → absolute luminance [0, 10000] cd/m² */
export function pqEotf(pq: number): number {
	const pqPow = Math.max(pq, 0) ** (1 / PQ_M2);
	const num = Math.max(pqPow - PQ_C1, 0);
	const den = PQ_C2 - PQ_C3 * pqPow;
	return 10000 * (num / den) ** (1 / PQ_M1);
}
// ============================================================
// Types
// ============================================================

export interface CollectedColor {
	/** Unique sequential index across the entire session (0-based). Stable for the session lifetime. */
	index: number;
	/** Original color value (RGBColor or HSVColor). All channels are 0.0-1.0 normalized. */
	color: Color;
	/**
	 * Dot-path identifying where this color lives in the element.
	 *
	 * Values:
	 * - `"stroke.solid"` — strokeColor of type SolidColor
	 * - `"stroke.gradient.stop[N]"` — Nth stop of strokeColor gradient
	 * - `"fill.solid"` — fill of type SolidColor
	 * - `"fill.linear.stop[N]"` — Nth stop of LinearGradient fill
	 * - `"fill.radial.stop[N]"` — Nth stop of RadialGradient fill
	 * - `"fill.free.stop[N]"` — Nth stop of FreeGradient fill
	 * - `"filter[N].color[M]"` — Mth color of filter at filter index N
	 */
	source: string;
	/** Element ID this color belongs to */
	elementId: string;
}

export type FilterHandlerLookup = (processor: string) =>
	| {
			onAdjustColor?(
				params: unknown,
				adjustColor: (color: Color) => Color,
			): unknown;
	  }
	| undefined;

// ============================================================
// Color collection
// ============================================================

export function collectElementColors(
	elementId: string,
	element: AnyArtObject,
	getHandler?: FilterHandlerLookup,
): CollectedColor[] {
	const result: CollectedColor[] = [];

	if (element.filters) {
		for (let i = 0; i < element.filters.length; i++) {
			const filter = element.filters[i];
			if (isAppearancePresetRef(filter)) continue;
			if (filter.processor === "stroke") {
				const strokeApp = filter as StrokeAppearance;
				collectStrokeColors(
					elementId,
					strokeApp.paramData.params.strokeColor,
					result,
				);
			} else if (filter.processor === "fill") {
				const fillApp = filter as FillAppearance;
				collectFillColors(elementId, fillApp.paramData.params.fill, result);
			} else {
				collectFilterColors(elementId, filter, i, result, getHandler);
			}
		}
	}

	return result;
}

function collectStrokeColors(
	elementId: string,
	stroke: StrokeColor,
	out: CollectedColor[],
): void {
	switch (stroke.type) {
		case "solid":
			out.push({
				index: 0,
				color: stroke.color,
				source: "stroke.solid",
				elementId,
			});
			break;
		case "stroke-gradient":
			for (let i = 0; i < stroke.gradient.stops.length; i++) {
				out.push({
					index: 0,
					color: stroke.gradient.stops[i].color,
					source: `stroke.gradient.stop[${i}]`,
					elementId,
				});
			}
			break;
		case "stroke-pattern":
			// Pattern strokes reference def members; their colors live on the def
			// elements themselves and are collected through document.objects walk.
			break;
	}
}

function collectFillColors(
	elementId: string,
	fill: FillColor,
	out: CollectedColor[],
): void {
	switch (fill.type) {
		case "solid":
			out.push({
				index: 0,
				color: fill.color,
				source: "fill.solid",
				elementId,
			});
			break;
		case "linear":
		case "radial":
			for (let i = 0; i < fill.stops.length; i++) {
				out.push({
					index: 0,
					color: fill.stops[i].color,
					source: `fill.${fill.type}.stop[${i}]`,
					elementId,
				});
			}
			break;
		case "free":
			for (let i = 0; i < fill.stops.length; i++) {
				out.push({
					index: 0,
					color: fill.stops[i].color,
					source: `fill.free.stop[${i}]`,
					elementId,
				});
			}
			break;
		case "mesh":
			for (let i = 0; i < fill.vertices.length; i++) {
				out.push({
					index: 0,
					color: fill.vertices[i].color,
					source: `fill.mesh.vertex[${i}]`,
					elementId,
				});
			}
			break;
		case "pattern":
			// Pattern fills reference def members; their colors live on the def
			// elements themselves and are collected through document.objects walk.
			break;
	}
}

function collectFilterColors(
	elementId: string,
	filter: Filter,
	index: number,
	out: CollectedColor[],
	getHandler?: FilterHandlerLookup,
): void {
	const handler = getHandler?.(filter.processor);
	if (!handler?.onAdjustColor) return;

	let colorIdx = 0;
	handler.onAdjustColor(filter.paramData.params, (color) => {
		out.push({
			index: 0,
			color,
			source: `filter[${index}].color[${colorIdx++}]`,
			elementId,
		});
		return color;
	});
}

// ============================================================
// Filter color adjustment
// ============================================================

function adjustFilterColors(
	filter: Filter,
	adjuster: (color: Color) => Color,
	getHandler?: FilterHandlerLookup,
): Filter {
	switch (filter.processor) {
		case "fill": {
			const fillFilter = filter as FillAppearance;
			const adjustedFill = adjustFillColor(
				fillFilter.paramData.params.fill,
				adjuster,
			);
			return {
				...fillFilter,
				paramData: {
					...fillFilter.paramData,
					params: { fill: adjustedFill },
				},
			} satisfies FillAppearance;
		}
		case "stroke": {
			const strokeFilter = filter as StrokeAppearance;
			const params = strokeFilter.paramData.params;
			const adjustedStroke = adjustStrokeColor(params.strokeColor, adjuster);
			return {
				...strokeFilter,
				paramData: {
					...strokeFilter.paramData,
					params: { ...params, strokeColor: adjustedStroke },
				},
			} satisfies StrokeAppearance;
		}
		default: {
			const handler = getHandler?.(filter.processor);
			if (!handler?.onAdjustColor) return filter;
			const adjustedParams = handler.onAdjustColor(
				filter.paramData.params,
				adjuster,
			);
			return {
				...filter,
				paramData: { ...filter.paramData, params: adjustedParams },
			} as Filter;
		}
	}
}

// ============================================================
// Element color update builder
// ============================================================

export function buildElementColorUpdates(
	element: AnyArtObject,
	adjuster: (color: Color) => Color,
	getHandler?: FilterHandlerLookup,
): Partial<AnyArtObject> {
	const updates: Record<string, unknown> = {};

	if (element.filters) {
		updates.filters = element.filters.map((f) =>
			isAppearancePresetRef(f)
				? f
				: adjustFilterColors(f, adjuster, getHandler),
		);
	}

	return updates as Partial<AnyArtObject>;
}

function adjustStrokeColor(
	stroke: StrokeColor,
	adjuster: (color: Color) => Color,
): StrokeColor {
	switch (stroke.type) {
		case "solid":
			return { ...stroke, color: adjuster(stroke.color) };
		case "stroke-gradient":
			return {
				...stroke,
				gradient: {
					...stroke.gradient,
					stops: stroke.gradient.stops.map((s) => ({
						...s,
						color: adjuster(s.color),
					})),
				},
			};
		case "stroke-pattern":
			// Pattern strokes carry no inline color — the underlying def elements
			// are walked separately by buildElementColorUpdates over document.objects.
			return stroke;
	}
}

function adjustFillColor(
	fill: FillColor,
	adjuster: (color: Color) => Color,
): FillColor {
	switch (fill.type) {
		case "solid":
			return { ...fill, color: adjuster(fill.color) };
		case "linear":
		case "radial":
			return {
				...fill,
				stops: fill.stops.map((s) => ({ ...s, color: adjuster(s.color) })),
			};
		case "free":
			return {
				...fill,
				stops: fill.stops.map((s) => ({ ...s, color: adjuster(s.color) })),
			};
		case "mesh":
			return {
				...fill,
				vertices: fill.vertices.map((v) => ({
					...v,
					color: adjuster(v.color),
				})),
			};
		case "pattern":
			// Pattern fills carry no inline color — the underlying def elements
			// are walked separately by buildElementColorUpdates over document.objects.
			return fill;
	}
}

// ============================================================
// Oklch color conversion (perceptually uniform)
// Pipeline: sRGB → linear RGB → XYZ (D65) → Oklab → Oklch
// ============================================================

function srgbToLinear(c: number): number {
	return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(c: number): number {
	return c <= 0.003_130_8 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
}

function rgbToOklch(
	r: number,
	g: number,
	b: number,
): [L: number, C: number, h: number] {
	const lr = srgbToLinear(r);
	const lg = srgbToLinear(g);
	const lb = srgbToLinear(b);

	// Linear RGB → LMS (via Oklab M1 matrix)
	const l_ = 0.412_221_5 * lr + 0.536_332_7 * lg + 0.051_445_8 * lb;
	const m_ = 0.211_903_5 * lr + 0.680_699_5 * lg + 0.107_397 * lb;
	const s_ = 0.088_302_5 * lr + 0.281_718_8 * lg + 0.629_978_7 * lb;

	const l1 = Math.cbrt(l_);
	const m1 = Math.cbrt(m_);
	const s1 = Math.cbrt(s_);

	// LMS → Oklab
	const L = 0.210_454_26 * l1 + 0.793_617_8 * m1 - 0.004_072_047 * s1;
	const a = 1.977_998_5 * l1 - 2.428_592_2 * m1 + 0.450_593_7 * s1;
	const bb = 0.025_904_037 * l1 + 0.782_771_77 * m1 - 0.808_675_77 * s1;

	// Oklab → Oklch
	const C = Math.sqrt(a * a + bb * bb);
	const h = C < 1e-8 ? 0 : (((Math.atan2(bb, a) / (2 * Math.PI)) % 1) + 1) % 1;

	return [L, C, h];
}

function oklchToRgb(
	L: number,
	C: number,
	h: number,
): [r: number, g: number, b: number] {
	// Oklch → Oklab
	const hRad = h * 2 * Math.PI;
	const a = C * Math.cos(hRad);
	const bb = C * Math.sin(hRad);

	// Oklab → LMS
	const l1 = L + 0.396_337_78 * a + 0.215_803_76 * bb;
	const m1 = L - 0.105_561_346 * a - 0.063_854_17 * bb;
	const s1 = L - 0.089_484_18 * a - 1.291_485_5 * bb;

	const l_ = l1 * l1 * l1;
	const m_ = m1 * m1 * m1;
	const s_ = s1 * s1 * s1;

	// LMS → linear RGB
	const lr = 4.076_741_7 * l_ - 3.307_711_6 * m_ + 0.230_969_94 * s_;
	const lg = -1.268_438 * l_ + 2.609_757_4 * m_ - 0.341_319_38 * s_;
	const lb = -0.004_196_086_3 * l_ - 0.703_418_6 * m_ + 1.707_614_7 * s_;

	return [
		Math.max(0, Math.min(1, linearToSrgb(lr))),
		Math.max(0, Math.min(1, linearToSrgb(lg))),
		Math.max(0, Math.min(1, linearToSrgb(lb))),
	];
}

function colorToOklch(
	color: Color,
): [L: number, C: number, h: number, a: number] {
	let r: number;
	let g: number;
	let b: number;

	if (color.type === "rgb") {
		r = color.r;
		g = color.g;
		b = color.b;
	} else {
		[r, g, b] = hsvToRgb(color.h, color.s, color.v);
	}

	const [L, C, h] = rgbToOklch(r, g, b);
	return [L, C, h, color.a];
}

// ============================================================
// Color adjust strategies
// ============================================================

/**
 * Build a unique key for a color value, used for per-color override matching.
 * Matches colors by their original value with epsilon tolerance.
 */
export function colorKey(c: CollectedColor): string {
	return `${c.elementId}:${c.source}`;
}

export const ColorAdjustStrategies = {
	/**
	 * Perceptually uniform color adjuster using Oklch color space.
	 * @param hue -180..+180 (degrees shift, mapped to Oklch hue)
	 * @param chroma -100..+100 (percentage shift, mapped to Oklch chroma)
	 * @param lightness -100..+100 (percentage shift, mapped to Oklch L)
	 * @param perColorHueOverrides Per-color hue overrides keyed by
	 *   `colorKey(collectedColor)`. Each value is an additional hue offset
	 *   (degrees, -180..+180) applied on top of the global hue shift.
	 *   The adjuster matches input colors against the original CollectedColor
	 *   values by value comparison to find the corresponding override.
	 * @param originalColors Original CollectedColor array from the session,
	 *   required when per-color overrides are provided, used to build
	 *   value→key lookup for matching.
	 * @param perColorAbsoluteOverrides Per-color absolute color overrides
	 *   keyed by `colorKey(collectedColor)`. When matched, the color is
	 *   replaced entirely (bypassing HSV shift). Takes priority over
	 *   perColorHueOverrides.
	 */
	hsvAdjuster(
		hue: number,
		chroma: number,
		lightness: number,
		perColorHueOverrides?: ReadonlyMap<string, number>,
		originalColors?: readonly CollectedColor[],
		perColorAbsoluteOverrides?: ReadonlyMap<string, Color>,
	): (color: Color) => Color {
		const hShift = hue / 360;
		const cShift = (chroma / 100) * 0.4; // Oklch C range ~0-0.4
		const lShift = lightness / 100;

		// Build value→extraHue lookup for per-color hue overrides
		let hueLookup: Map<string, number> | null = null;
		if (perColorHueOverrides?.size && originalColors) {
			hueLookup = new Map();
			for (const cc of originalColors) {
				const extra = perColorHueOverrides.get(colorKey(cc));
				if (extra != null) {
					hueLookup.set(colorValueSig(cc.color), extra / 360);
				}
			}
		}

		// Build value→Color lookup for per-color absolute overrides
		let absoluteLookup: Map<string, Color> | null = null;
		if (perColorAbsoluteOverrides?.size && originalColors) {
			absoluteLookup = new Map();
			for (const cc of originalColors) {
				const abs = perColorAbsoluteOverrides.get(colorKey(cc));
				if (abs) {
					absoluteLookup.set(colorValueSig(cc.color), abs);
				}
			}
		}

		return (color: Color): Color => {
			// Absolute override takes priority — bypass all adjustment
			if (absoluteLookup) {
				const abs = absoluteLookup.get(colorValueSig(color));
				if (abs) return abs;
			}

			const [L, C, h, a] = colorToOklch(color);

			let extraH = 0;
			if (hueLookup) {
				extraH = hueLookup.get(colorValueSig(color)) ?? 0;
			}

			const newH = (((h + hShift + extraH) % 1) + 1) % 1;
			const newC = Math.max(0, Math.min(0.4, C + cShift));
			const newL = Math.max(0, Math.min(1, L + lShift));

			const [r, g, b] = oklchToRgb(newL, newC, newH);

			return { type: "rgb", r, g, b, a };
		};
	},
};

/** Stable signature string for a Color value (truncated to avoid FP noise). */
function colorValueSig(c: Color): string {
	if (c.type === "rgb") {
		return `rgb:${c.r.toFixed(6)}:${c.g.toFixed(6)}:${c.b.toFixed(6)}:${c.a.toFixed(6)}`;
	}
	return `hsv:${c.h.toFixed(6)}:${c.s.toFixed(6)}:${c.v.toFixed(6)}:${c.a.toFixed(6)}`;
}
