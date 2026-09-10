import {
	createDefaultColor,
	createIdentityTransform,
	createStrokeBrushSettings,
} from "../document/factory";
import type { SvgFilterNode } from "../renderer/filters/svg/SvgFilterGraphHandler";
import {
	type AnyArtObject,
	type BlendMode,
	type BoundingBox,
	type ColorStop,
	type DefEntry,
	type EmbeddedFile,
	type FillAppearance,
	type FillColor,
	type Filter,
	type Group,
	generateUid,
	type ImageObject,
	type LinearGradient,
	type LineCap,
	type LineJoin,
	type Path,
	type PathSegment,
	type PatternFill,
	type RadialGradient,
	type RGBColor,
	type SolidColor,
	type StrokeAppearance,
	type StrokeColor,
	type StrokeGradient,
	type StrokePattern,
	type TextElement,
	type TextParagraph,
	type TextRun,
	type TextStyle,
} from "../schema";
import { calculateSegmentListBounds } from "./geometry/bounds";
import { clamp01 } from "./math";
import { parseSvgFilterElement } from "./svgFilterImport";

// SVG presentation attributes that inherit from ancestor elements (per the SVG
// spec). Non-inherited properties (opacity, filter, clip-path, mix-blend-mode,
// display) are intentionally excluded — they apply per element / per group.
const INHERITED_PROPS = [
	"fill",
	"fill-opacity",
	"fill-rule",
	"stroke",
	"stroke-width",
	"stroke-opacity",
	"stroke-linecap",
	"stroke-linejoin",
	"stroke-miterlimit",
	"stroke-dasharray",
	"stroke-dashoffset",
	"font-family",
	"font-size",
	"font-weight",
	"font-style",
	"letter-spacing",
	"text-anchor",
	"writing-mode",
] as const;

const ALLOWED_IMAGE_MIMES = new Set([
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/gif",
	"image/svg+xml",
]);

// --- Public Types ---

export interface SvgImportResult {
	objects: Map<string, AnyArtObject>;
	files: EmbeddedFile[];
	topLevelIds: string[];
	/** Pattern definitions materialized from SVG <pattern> elements. */
	defs: DefEntry[];
}

interface ViewBox {
	x: number;
	y: number;
	width: number;
	height: number;
}

/**
 * Rescales a filter's spatial parameters, the way FilterHandler.onScaleFilter
 * does; the importer applies it with the element's CTM scale, which the path
 * coordinates absorb but the filter parameters do not.
 */
export type ScaleFilter = (filter: Filter, scale: [number, number]) => Filter;

export interface ParseCtx {
	viewBox: ViewBox;
	pasteWorldX: number;
	pasteWorldY: number;
	scaleFilter?: ScaleFilter;
	gradients: Map<string, GradientDef>;
	cssClasses: Map<string, Record<string, string>>;
	clipPaths: Map<string, Element>;
	/**
	 * Resolved SVG <pattern> id -> a ready PatternFill (defId + decomposed
	 * patternTransform). `null` marks a pattern that could not be materialized
	 * (e.g. objectBoundingBox units), cached so fill/stroke resolution treats it
	 * as "no paint" without reprocessing.
	 */
	patternFills: Map<string, PatternFill | null>;
	/** Resolved SVG <filter> id -> its `svg:filter` graph nodes, or null if nothing is supported. */
	filters: Map<string, SvgFilterNode[] | null>;
}

// --- Internal Types ---

// Raw gradient definition. Coordinates are kept as authored: for
// userSpaceOnUse they are SVG user-space coords resolved per-referencing-element
// (needs that element's CTM + world bbox); for objectBoundingBox they are 0..1
// fractions of the filled element's bounding box in SVG orientation (y down).
type GradientDef =
	| {
			kind: "linear";
			userSpace: boolean;
			/** Parsed gradientTransform, applied to gradient coords before the element CTM. */
			transform: DOMMatrix | null;
			x1: number;
			y1: number;
			x2: number;
			y2: number;
			stops: ColorStop[];
	  }
	| {
			kind: "radial";
			userSpace: boolean;
			transform: DOMMatrix | null;
			cx: number;
			cy: number;
			r: number;
			stops: ColorStop[];
	  };

interface ParseState {
	ctx: ParseCtx;
	objects: Map<string, AnyArtObject>;
	files: EmbeddedFile[];
	defs: DefEntry[];
	/** ids of <use> targets currently being expanded, to cut reference cycles. */
	activeUseIds: Set<string>;
}

// --- Entry Point ---

export async function parseSvgToArtObjects(
	svgString: string,
	pasteWorldX: number,
	pasteWorldY: number,
	{ scaleFilter }: { scaleFilter?: ScaleFilter } = {},
): Promise<SvgImportResult> {
	const empty: SvgImportResult = {
		objects: new Map(),
		files: [],
		topLevelIds: [],
		defs: [],
	};
	if (!svgString.trim()) return empty;

	try {
		const parser = new DOMParser();
		const doc = parser.parseFromString(svgString, "image/svg+xml");

		const svgEl = doc.querySelector("svg");
		if (!svgEl) return empty;
		if (doc.querySelector("parsererror")) return empty;

		const viewBox = parseViewBox(svgEl);
		const gradients = collectGradients(doc);
		const cssClasses = collectCssClasses(doc);
		const clipPaths = collectClipPaths(doc);
		const ctx: ParseCtx = {
			viewBox,
			pasteWorldX,
			pasteWorldY,
			gradients,
			cssClasses,
			clipPaths,
			patternFills: new Map(),
			filters: collectSvgFilters(doc),
			scaleFilter,
		};

		const state: ParseState = {
			ctx,
			objects: new Map(),
			files: [],
			defs: [],
			activeUseIds: new Set(),
		};

		// Materialize <pattern> defs before element processing so fill/stroke
		// resolution can look up already-registered defIds synchronously.
		await materializePatternDefs(collectPatternElements(doc), state);

		// The <svg> root itself may carry inheritable presentation attributes.
		const topLevelIds = await processChildren(
			svgEl,
			new DOMMatrix(),
			state,
			overlayInheritedProps(makeStyleGetter(svgEl, ctx, {}), {}),
		);
		return {
			objects: state.objects,
			files: state.files,
			topLevelIds,
			defs: state.defs,
		};
	} catch (err) {
		console.error("[svgImport] parse failed:", err);
		return empty;
	}
}

// --- ViewBox ---

function parseViewBox(el: Element): ViewBox {
	const vb = el.getAttribute("viewBox");
	if (vb) {
		const parts = vb
			.trim()
			.split(/[\s,]+/)
			.map(Number);
		const [x, y, w, h] = parts;
		if (parts.length >= 4 && !parts.some(Number.isNaN) && w > 0 && h > 0) {
			return { x, y, width: w, height: h };
		}
	}
	const w = parseFloat(el.getAttribute("width") ?? "100");
	const h = parseFloat(el.getAttribute("height") ?? "100");
	return {
		x: 0,
		y: 0,
		width: Number.isNaN(w) ? 100 : w,
		height: Number.isNaN(h) ? 100 : h,
	};
}

// --- Coordinate Transform ---

function svgToWorld(
	px: number,
	py: number,
	ctx: ParseCtx,
): { x: number; y: number } {
	const cx = ctx.viewBox.x + ctx.viewBox.width / 2;
	const cy = ctx.viewBox.y + ctx.viewBox.height / 2;
	return {
		x: px - cx + ctx.pasteWorldX,
		y: -(py - cy) + ctx.pasteWorldY,
	};
}

function ctmAndFlip(
	svgX: number,
	svgY: number,
	ctm: DOMMatrix,
	ctx: ParseCtx,
): { x: number; y: number } {
	const pt = ctm.transformPoint({ x: svgX, y: svgY });
	return svgToWorld(pt.x, pt.y, ctx);
}

// --- Gradient Collection ---

function collectGradients(doc: Document): Map<string, GradientDef> {
	const map = new Map<string, GradientDef>();

	for (const el of doc.querySelectorAll("linearGradient")) {
		const id = el.getAttribute("id");
		if (!id) continue;

		const hrefId = (
			el.getAttribute("xlink:href") ?? el.getAttribute("href")
		)?.slice(1);
		// getElementById: ids like "1grad" are invalid CSS selectors and would make
		// querySelector throw, aborting the whole import via the top-level catch.
		const base = hrefId ? doc.getElementById(hrefId) : null;
		const attr = (name: string) =>
			el.getAttribute(name) ?? base?.getAttribute(name) ?? null;

		const stopEls =
			el.querySelectorAll("stop").length > 0
				? el.querySelectorAll("stop")
				: (base?.querySelectorAll("stop") ?? []);

		const gt = attr("gradientTransform");
		map.set(id, {
			kind: "linear",
			userSpace:
				(attr("gradientUnits") ?? "objectBoundingBox") === "userSpaceOnUse",
			transform: gt ? parseTransform(gt) : null,
			x1: parseFloat(attr("x1") ?? "0"),
			y1: parseFloat(attr("y1") ?? "0"),
			x2: parseFloat(attr("x2") ?? "1"),
			y2: parseFloat(attr("y2") ?? "0"),
			stops: parseStops(stopEls),
		});
	}

	for (const el of doc.querySelectorAll("radialGradient")) {
		const id = el.getAttribute("id");
		if (!id) continue;

		const hrefId = (
			el.getAttribute("xlink:href") ?? el.getAttribute("href")
		)?.slice(1);
		const base = hrefId ? doc.getElementById(hrefId) : null;
		const attr = (name: string) =>
			el.getAttribute(name) ?? base?.getAttribute(name) ?? null;

		const stopEls =
			el.querySelectorAll("stop").length > 0
				? el.querySelectorAll("stop")
				: (base?.querySelectorAll("stop") ?? []);

		const gt = attr("gradientTransform");
		map.set(id, {
			kind: "radial",
			userSpace:
				(attr("gradientUnits") ?? "objectBoundingBox") === "userSpaceOnUse",
			transform: gt ? parseTransform(gt) : null,
			cx: parseFloat(attr("cx") ?? "0.5"),
			cy: parseFloat(attr("cy") ?? "0.5"),
			r: parseFloat(attr("r") ?? "0.5"),
			stops: parseStops(stopEls),
		});
	}

	return map;
}

// --- Gradient Resolution ---

/**
 * Convert a gradient definition into a bbox-relative LinearGradient for a
 * specific element. For userSpaceOnUse the raw user-space coords go through
 * gradientTransform, then the same element CTM + world Y-flip as the geometry,
 * then normalize against the element's world bounding box. For objectBoundingBox
 * the coords are already bbox fractions in SVG orientation (y down), so only flip
 * Y to Paplico's y-up (gradientTransform is not applied in that mode).
 */
function resolveLinearGradient(
	def: Extract<GradientDef, { kind: "linear" }>,
	bbox: BoundingBox,
	ctm: DOMMatrix,
	ctx: ParseCtx,
): LinearGradient {
	if (def.userSpace) {
		const m = def.transform ? ctm.multiply(def.transform) : ctm;
		const p1 = bboxRelative(ctmAndFlip(def.x1, def.y1, m, ctx), bbox);
		const p2 = bboxRelative(ctmAndFlip(def.x2, def.y2, m, ctx), bbox);
		return {
			type: "linear",
			x1: p1.x,
			y1: p1.y,
			x2: p2.x,
			y2: p2.y,
			stops: def.stops,
		};
	}
	return {
		type: "linear",
		x1: def.x1,
		y1: 1 - def.y1,
		x2: def.x2,
		y2: 1 - def.y2,
		stops: def.stops,
	};
}

function resolveRadialGradient(
	def: Extract<GradientDef, { kind: "radial" }>,
	bbox: BoundingBox,
	ctm: DOMMatrix,
	ctx: ParseCtx,
): RadialGradient {
	if (def.userSpace) {
		const m = def.transform ? ctm.multiply(def.transform) : ctm;
		const center = ctmAndFlip(def.cx, def.cy, m, ctx);
		const rel = bboxRelative(center, bbox);
		// Radius is a length in user space; map its world extent to bbox-relative
		// on each axis so a circle in user space stays circular after Paplico
		// stretches the ellipse back by the (possibly non-square) bbox.
		const edgeX = ctmAndFlip(def.cx + def.r, def.cy, m, ctx);
		const edgeY = ctmAndFlip(def.cx, def.cy + def.r, m, ctx);
		const rWorldX = Math.hypot(edgeX.x - center.x, edgeX.y - center.y);
		const rWorldY = Math.hypot(edgeY.x - center.x, edgeY.y - center.y);
		return {
			type: "radial",
			cx: rel.x,
			cy: rel.y,
			radiusX: bbox.width > 0 ? rWorldX / bbox.width : rWorldX,
			radiusY: bbox.height > 0 ? rWorldY / bbox.height : rWorldY,
			rotation: 0,
			stops: def.stops,
		};
	}
	return {
		type: "radial",
		cx: def.cx,
		cy: 1 - def.cy,
		radiusX: def.r,
		radiusY: def.r,
		rotation: 0,
		stops: def.stops,
	};
}

function bboxRelative(
	p: { x: number; y: number },
	bbox: BoundingBox,
): { x: number; y: number } {
	return {
		x: bbox.width > 0 ? (p.x - bbox.minX) / bbox.width : 0.5,
		y: bbox.height > 0 ? (p.y - bbox.minY) / bbox.height : 0.5,
	};
}

function collectCssClasses(doc: Document): Map<string, Record<string, string>> {
	const map = new Map<string, Record<string, string>>();
	for (const styleEl of doc.querySelectorAll("style")) {
		const css = styleEl.textContent ?? "";
		// Match selector { declarations } blocks; skip @rules
		const ruleRe = /([^{}@]+)\{([^}]*)\}/g;
		let match = ruleRe.exec(css);
		while (match !== null) {
			const selectors = match[1]
				.split(",")
				.map((s) => s.trim())
				// Accept only simple class selectors like ".cls-1"
				.filter((s) => /^\.[a-zA-Z_-][a-zA-Z0-9_-]*$/.test(s));
			const declarations = parseInlineStyle(match[2]);
			for (const sel of selectors) {
				const cls = sel.slice(1);
				const existing = map.get(cls) ?? {};
				map.set(cls, { ...existing, ...declarations });
			}
			match = ruleRe.exec(css);
		}
	}
	return map;
}

function collectClipPaths(doc: Document): Map<string, Element> {
	const map = new Map<string, Element>();
	for (const el of doc.querySelectorAll("clipPath")) {
		const id = el.getAttribute("id");
		if (id) map.set(id, el);
	}
	return map;
}

// --- Filter Collection ---

function collectSvgFilters(doc: Document): Map<string, SvgFilterNode[] | null> {
	const map = new Map<string, SvgFilterNode[] | null>();
	for (const el of doc.querySelectorAll("filter")) {
		const id = el.getAttribute("id");
		if (id) map.set(id, parseSvgFilterElement(el, parseSvgColor));
	}
	return map;
}

// Build the Paplico filter appearance for an element's `filter` reference:
// one `svg:filter` graph holding the <filter>'s primitives, with its spatial
// parameters scaled by the element's CTM like the geometry already is.
function buildFilterAppearances(
	filterRef: string | null,
	ctx: ParseCtx,
	ctm: DOMMatrix,
): Filter[] {
	const refId = matchUrlRef(filterRef);
	const nodes = refId ? ctx.filters.get(refId) : null;
	if (!nodes) return [];
	const graph: Filter = {
		uid: generateUid("app"),
		processor: "svg:filter",
		opacity: 1,
		blendMode: "normal",
		paramData: {
			version: "1",
			params: {
				nodes: nodes.map((node) => ({ ...node, params: { ...node.params } })),
			},
		},
	};
	const scale: [number, number] = [
		Math.hypot(ctm.a, ctm.b),
		Math.hypot(ctm.c, ctm.d),
	];
	const scaled =
		ctx.scaleFilter && (scale[0] !== 1 || scale[1] !== 1)
			? ctx.scaleFilter(graph, scale)
			: graph;
	return [scaled];
}

// --- Pattern Collection ---

function collectPatternElements(doc: Document): Map<string, Element> {
	const map = new Map<string, Element>();
	for (const el of doc.querySelectorAll("pattern")) {
		const id = el.getAttribute("id");
		if (id) map.set(id, el);
	}
	return map;
}

/**
 * Turn each <pattern> into a DefEntry of kind "pattern" whose tile content lives
 * in document.objects (state.objects). Records the SVG id -> defId mapping on
 * ctx.patternDefIds for fill/stroke resolution.
 *
 * Only patternUnits="userSpaceOnUse" is supported: it maps deterministically at
 * import time. objectBoundingBox depends on the filled element's bounding box
 * (unknown at parse time) and is left as "no paint". patternTransform,
 * patternContentUnits, xlink:href inheritance and the tile x/y phase offset are
 * not applied in this version.
 */
async function materializePatternDefs(
	patternEls: Map<string, Element>,
	state: ParseState,
): Promise<void> {
	for (const [svgId, el] of patternEls) {
		const units = el.getAttribute("patternUnits") ?? "objectBoundingBox";
		if (units !== "userSpaceOnUse") {
			console.warn(
				`[svgImport] Unsupported patternUnits="${units}" on <pattern id="${svgId}">; fill left empty`,
			);
			state.ctx.patternFills.set(svgId, null);
			continue;
		}

		const x = parseFloat(el.getAttribute("x") ?? "0");
		const y = parseFloat(el.getAttribute("y") ?? "0");
		const width = parseFloat(el.getAttribute("width") ?? "0");
		const height = parseFloat(el.getAttribute("height") ?? "0");
		if (
			Number.isNaN(width) ||
			Number.isNaN(height) ||
			width <= 0 ||
			height <= 0
		) {
			state.ctx.patternFills.set(svgId, null);
			continue;
		}

		// Process tile content in a sub-context whose viewBox is the tile rect and
		// whose paste origin is (0,0). svgToWorld then yields def-local coords
		// centered on the tile center with the world Y-flip, matching DefEntry.tile
		// semantics. Objects / files / defs / shared maps are the same instances.
		const subState: ParseState = {
			ctx: {
				...state.ctx,
				viewBox: {
					x: Number.isNaN(x) ? 0 : x,
					y: Number.isNaN(y) ? 0 : y,
					width,
					height,
				},
				pasteWorldX: 0,
				pasteWorldY: 0,
			},
			objects: state.objects,
			files: state.files,
			defs: state.defs,
			activeUseIds: state.activeUseIds,
		};
		const rootElementIds = await processChildren(
			el,
			new DOMMatrix(),
			subState,
			{},
		);
		if (rootElementIds.length === 0) {
			state.ctx.patternFills.set(svgId, null);
			continue;
		}

		const defId = generateUid("def");
		state.defs.push({
			id: defId,
			kind: "pattern",
			name: svgId,
			rootElementIds,
			tile: { width, height },
		});
		const gt = el.getAttribute("patternTransform");
		state.ctx.patternFills.set(
			svgId,
			patternFillFromTransform(defId, gt ? parseTransform(gt) : null),
		);
	}
}

// Decompose a patternTransform matrix into the PatternFill affine. The tile
// content is already Y-flipped into def-local space, so a clockwise SVG rotation
// (Y-down) reads as a counter-clockwise world rotation, and the translate Y
// flips. Best-effort: skew is dropped (PatternFill has no skew term).
function patternFillFromTransform(
	defId: string,
	transform: DOMMatrix | null,
): PatternFill {
	if (!transform) {
		return {
			type: "pattern",
			defId,
			scaleX: 1,
			scaleY: 1,
			rotation: 0,
			offsetX: 0,
			offsetY: 0,
		};
	}
	const { a, b, c, d, e, f } = transform;
	return {
		type: "pattern",
		defId,
		scaleX: Math.hypot(a, b) || 1,
		scaleY: Math.hypot(c, d) || 1,
		rotation: -Math.atan2(b, a),
		offsetX: e,
		offsetY: -f,
	};
}

function parseStops(stopEls: NodeListOf<Element> | Element[]): ColorStop[] {
	const stops: ColorStop[] = [];
	for (const stop of stopEls) {
		const offsetStr = stop.getAttribute("offset") ?? "0";
		const offset = offsetStr.endsWith("%")
			? parseFloat(offsetStr) / 100
			: parseFloat(offsetStr);

		const inlineStyle = parseInlineStyle(stop.getAttribute("style") ?? "");
		const colorStr =
			inlineStyle["stop-color"] ?? stop.getAttribute("stop-color") ?? "black";
		const opacityStr =
			inlineStyle["stop-opacity"] ?? stop.getAttribute("stop-opacity") ?? "1";
		const opacity = parseFloat(opacityStr);

		const color = parseSvgColor(colorStr);
		if (!color) continue;

		stops.push({
			offset: Number.isNaN(offset) ? 0 : Math.max(0, Math.min(1, offset)),
			color: {
				...color,
				a:
					color.a *
					(Number.isNaN(opacity) ? 1 : Math.max(0, Math.min(1, opacity))),
			},
			// SVG <stop> has no midpoint concept; import as linear (no bias).
			midpoint: 0.5,
		});
	}
	return stops;
}

function parseInlineStyle(style: string): Record<string, string> {
	const result: Record<string, string> = {};
	for (const decl of style.split(";")) {
		const colon = decl.indexOf(":");
		if (colon < 0) continue;
		result[decl.slice(0, colon).trim()] = decl.slice(colon + 1).trim();
	}
	return result;
}

// --- Element Processing ---

async function processChildren(
	parent: Element,
	ctm: DOMMatrix,
	state: ParseState,
	inherited: Record<string, string>,
): Promise<string[]> {
	const ids: string[] = [];
	for (const child of parent.children) {
		const id = await processElement(child, ctm, state, inherited);
		if (id) ids.push(id);
	}
	return ids;
}

async function processElement(
	el: Element,
	parentCtm: DOMMatrix,
	state: ParseState,
	inherited: Record<string, string>,
): Promise<string | null> {
	const tag = el.tagName.toLowerCase();
	if (
		tag === "defs" ||
		tag === "style" ||
		tag === "title" ||
		tag === "desc" ||
		tag === "metadata"
	)
		return null;

	const localMatrix = (() => {
		const t = el.getAttribute("transform");
		return t ? parseTransform(t) : new DOMMatrix();
	})();
	const ctm = parentCtm.multiply(localMatrix);

	// Merged style lookup: inline style > CSS class > element attribute > inherited
	const getElProp = makeStyleGetter(el, state.ctx, inherited);

	if (getElProp("display") === "none") return null;

	const opacityStr = getElProp("opacity") ?? "1";
	const opacityVal = parseFloat(opacityStr);
	const opacity = Number.isNaN(opacityVal)
		? 1
		: Math.max(0, Math.min(1, opacityVal));

	let baseId: string | null = null;

	switch (tag) {
		case "path": {
			const d = el.getAttribute("d");
			if (!d) break;
			const segs = parseSvgPathD(d, ctm, state.ctx);
			if (segs.length === 0) break;
			baseId = buildPath(el, segs, opacity, ctm, state, inherited);
			break;
		}
		case "rect": {
			const d = rectToPathD(el);
			if (!d) break;
			const segs = parseSvgPathD(d, ctm, state.ctx);
			if (segs.length === 0) break;
			baseId = buildPath(el, segs, opacity, ctm, state, inherited);
			break;
		}
		case "circle": {
			const segs = circleToSegs(el, ctm, state.ctx);
			if (segs.length === 0) break;
			baseId = buildPath(el, segs, opacity, ctm, state, inherited);
			break;
		}
		case "ellipse": {
			const segs = ellipseToSegs(el, ctm, state.ctx);
			if (segs.length === 0) break;
			baseId = buildPath(el, segs, opacity, ctm, state, inherited);
			break;
		}
		case "polygon":
		case "polyline": {
			const d = polyToPathD(el, tag === "polygon");
			if (!d) break;
			const segs = parseSvgPathD(d, ctm, state.ctx);
			if (segs.length === 0) break;
			baseId = buildPath(el, segs, opacity, ctm, state, inherited);
			break;
		}
		case "line": {
			const d = lineToPathD(el);
			if (!d) break;
			const segs = parseSvgPathD(d, ctm, state.ctx);
			if (segs.length === 0) break;
			baseId = buildPath(el, segs, opacity, ctm, state, inherited);
			break;
		}
		case "g": {
			const childIds = await processChildren(
				el,
				ctm,
				state,
				overlayInheritedProps(getElProp, inherited),
			);
			if (childIds.length === 0) break;
			baseId = wrapChildren(childIds, opacity, getElProp, state, ctm);
			break;
		}
		case "use": {
			baseId = await buildUseReference(
				el,
				ctm,
				opacity,
				getElProp,
				state,
				inherited,
			);
			break;
		}
		case "image": {
			baseId = await buildImageObject(el, ctm, opacity, getElProp, state);
			break;
		}
		case "text": {
			baseId = buildTextElement(el, ctm, opacity, getElProp, state) || null;
			break;
		}
		default: {
			console.warn(`[svgImport] Unsupported element: <${el.tagName}>`);
			break;
		}
	}

	if (!baseId) return null;

	const clipPathAttr = getElProp("clip-path");
	return clipPathAttr
		? applyClipPath(baseId, clipPathAttr, ctm, state)
		: baseId;
}

async function applyClipPath(
	contentId: string,
	clipPathAttr: string,
	ctm: DOMMatrix,
	state: ParseState,
): Promise<string> {
	const refId = matchUrlRef(clipPathAttr);
	if (!refId) return contentId;

	const clipEl = state.ctx.clipPaths.get(refId);
	if (!clipEl) return contentId;

	// clipPathUnits defaults to userSpaceOnUse: clip children use the current CTM
	const cpTransform = clipEl.getAttribute("transform");
	const clipCtm = cpTransform ? ctm.multiply(parseTransform(cpTransform)) : ctm;
	// Clip shapes only contribute geometry, so no inherited paint context.
	const clipIds = await processChildren(clipEl, clipCtm, state, {});
	if (clipIds.length === 0) return contentId;

	// Wrap clip shapes into a single node if multiple
	let clipPathId: string;
	if (clipIds.length === 1) {
		clipPathId = clipIds[0];
	} else {
		const clipGroup: Group = {
			type: "group",
			id: generateUid("obj"),
			childIds: clipIds,
			opacity: 1,
			blendMode: "normal",
			transform: createIdentityTransform(),
			filters: [],
		};
		state.objects.set(clipGroup.id, clipGroup);
		clipPathId = clipGroup.id;
	}

	// Create wrapper group with clip-path relationship preserved as a group
	const allChildIds = [clipPathId, contentId];
	const wrapperGroup: Group = {
		type: "group",
		id: generateUid("obj"),
		childIds: allChildIds,
		opacity: 1,
		blendMode: "normal",
		transform: createIdentityTransform(),
		filters: [],
		clipPathId,
	};
	state.objects.set(wrapperGroup.id, wrapperGroup);
	return wrapperGroup.id;
}

/**
 * Group `childIds` under one Group carrying the element's own opacity, blend
 * mode and effect filters. A single child with opacity 1, normal blend and no
 * filter needs no wrapper; a filter always keeps the group so it applies to
 * the whole subtree.
 */
function wrapChildren(
	childIds: string[],
	opacity: number,
	getElProp: (name: string) => string | null,
	state: ParseState,
	ctm: DOMMatrix,
): string {
	const filters = buildFilterAppearances(getElProp("filter"), state.ctx, ctm);
	const blendMode = resolveBlendMode(getElProp("mix-blend-mode")) ?? "normal";
	if (
		childIds.length === 1 &&
		opacity === 1 &&
		blendMode === "normal" &&
		filters.length === 0
	) {
		return childIds[0];
	}
	const group: Group = {
		type: "group",
		id: generateUid("obj"),
		childIds,
		opacity,
		blendMode,
		transform: createIdentityTransform(),
		filters,
	};
	state.objects.set(group.id, group);
	return group.id;
}

/**
 * Expand a <use> by processing its referenced element under the use's CTM
 * (`parent × transform × translate(x, y)`), inheriting the use's presentation
 * attributes. The use's own opacity / blend / filter wrap the result.
 */
async function buildUseReference(
	el: Element,
	ctm: DOMMatrix,
	opacity: number,
	getElProp: (name: string) => string | null,
	state: ParseState,
	inherited: Record<string, string>,
): Promise<string | null> {
	const href =
		el.getAttributeNS("http://www.w3.org/1999/xlink", "href") ??
		el.getAttribute("href") ??
		"";
	const refId = href.startsWith("#") ? href.slice(1) : null;
	if (!refId || state.activeUseIds.has(refId)) return null;
	const referenced = el.ownerDocument.getElementById(refId);
	if (!referenced) return null;

	const x = parseFloat(el.getAttribute("x") ?? "0") || 0;
	const y = parseFloat(el.getAttribute("y") ?? "0") || 0;

	state.activeUseIds.add(refId);
	try {
		const childId = await processElement(
			referenced,
			ctm.translate(x, y),
			state,
			overlayInheritedProps(getElProp, inherited),
		);
		if (!childId) return null;
		return wrapChildren([childId], opacity, getElProp, state, ctm);
	} finally {
		state.activeUseIds.delete(refId);
	}
}

async function buildImageObject(
	el: Element,
	ctm: DOMMatrix,
	opacity: number,
	getElProp: (name: string) => string | null,
	state: ParseState,
): Promise<string | null> {
	const href =
		el.getAttributeNS("http://www.w3.org/1999/xlink", "href") ??
		el.getAttribute("href") ??
		"";
	if (!href) return null;
	const svgX = parseFloat(el.getAttribute("x") ?? "0");
	const svgY = parseFloat(el.getAttribute("y") ?? "0");
	const svgW = parseFloat(el.getAttribute("width") ?? "0");
	const svgH = parseFloat(el.getAttribute("height") ?? "0");
	if (Number.isNaN(svgW) || Number.isNaN(svgH) || svgW <= 0 || svgH <= 0)
		return null;
	const tl = ctmAndFlip(svgX, svgY, ctm, state.ctx);
	const tr = ctmAndFlip(svgX + svgW, svgY, ctm, state.ctx);
	const bl = ctmAndFlip(svgX, svgY + svgH, ctm, state.ctx);
	const br = ctmAndFlip(svgX + svgW, svgY + svgH, ctm, state.ctx);
	const centerX = (tl.x + tr.x + bl.x + br.x) / 4;
	const centerY = (tl.y + tr.y + bl.y + br.y) / 4;
	const worldWidth = Math.hypot(tr.x - tl.x, tr.y - tl.y);
	const worldHeight = Math.hypot(bl.x - tl.x, bl.y - tl.y);
	// Recover the CTM rotation from the world-space top edge so a rotated
	// <image> keeps its orientation. Element transforms rotate around the local
	// bounds center (computeTransformOrigin), which is exactly (x, y) here, so
	// the computed center stays put. Skew is not representable and is dropped.
	const rotation = Math.atan2(tr.y - tl.y, tr.x - tl.x);
	const mimeMatch = href.match(/^data:([^;,]+)/);
	const mimeType = mimeMatch ? mimeMatch[1] : "image/png";
	if (!ALLOWED_IMAGE_MIMES.has(mimeType)) return null;
	const base64Match = href.match(/^data:[^;]+;base64,(.+)$/);
	if (!base64Match) return null;
	try {
		const b64 = base64Match[1].replace(/\s/g, "");
		const binStr = atob(b64);
		const bin = new Uint8Array(binStr.length);
		for (let i = 0; i < binStr.length; i++) bin[i] = binStr.charCodeAt(i);
		const hashBuf = await crypto.subtle.digest("SHA-256", bin);
		const hash = Array.from(new Uint8Array(hashBuf))
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("");
		// Reuse an already-embedded file when the same image is referenced twice.
		const existingFile = state.files.find((f) => f.hash === hash);
		let fileUid: string;
		if (existingFile) {
			fileUid = existingFile.uid;
		} else {
			const ext = mimeType.split("/")[1] ?? "png";
			fileUid = `file-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
			state.files.push({
				uid: fileUid,
				name: `svg-image-${hash.slice(0, 8)}.${ext}`,
				type: mimeType,
				hash,
				bin,
			});
		}
		const imageObject: ImageObject = {
			type: "image",
			id: generateUid("obj"),
			fileUid,
			x: centerX,
			y: centerY,
			width: worldWidth,
			height: worldHeight,
			opacity,
			blendMode: resolveBlendMode(getElProp("mix-blend-mode")) ?? "normal",
			transform: { ...createIdentityTransform(), rotation },
			filters: [],
		};
		state.objects.set(imageObject.id, imageObject);
		return imageObject.id;
	} catch {
		return null;
	}
}

// --- Shape-to-Path Conversions ---

function rectToPathD(el: Element): string | null {
	const x = parseFloat(el.getAttribute("x") ?? "0");
	const y = parseFloat(el.getAttribute("y") ?? "0");
	const w = parseFloat(el.getAttribute("width") ?? "0");
	const h = parseFloat(el.getAttribute("height") ?? "0");
	if (Number.isNaN(w) || Number.isNaN(h) || w <= 0 || h <= 0) return null;

	const rxAttr = el.getAttribute("rx");
	const ryAttr = el.getAttribute("ry");
	let rx = rxAttr ? parseFloat(rxAttr) : ryAttr ? parseFloat(ryAttr) : 0;
	let ry = ryAttr ? parseFloat(ryAttr) : rx;
	if (Number.isNaN(rx) || rx < 0) rx = 0;
	if (Number.isNaN(ry) || ry < 0) ry = 0;
	rx = Math.min(rx, w / 2);
	ry = Math.min(ry, h / 2);

	if (rx === 0 && ry === 0) {
		return `M ${x} ${y} L ${x + w} ${y} L ${x + w} ${y + h} L ${x} ${y + h} Z`;
	}

	return (
		`M ${x + rx} ${y} ` +
		`L ${x + w - rx} ${y} ` +
		`A ${rx} ${ry} 0 0 1 ${x + w} ${y + ry} ` +
		`L ${x + w} ${y + h - ry} ` +
		`A ${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h} ` +
		`L ${x + rx} ${y + h} ` +
		`A ${rx} ${ry} 0 0 1 ${x} ${y + h - ry} ` +
		`L ${x} ${y + ry} ` +
		`A ${rx} ${ry} 0 0 1 ${x + rx} ${y} Z`
	);
}

const KAPPA = 0.5522_847_498;

function circleToSegs(
	el: Element,
	ctm: DOMMatrix,
	ctx: ParseCtx,
): PathSegment[] {
	const cx = parseFloat(el.getAttribute("cx") ?? "0");
	const cy = parseFloat(el.getAttribute("cy") ?? "0");
	const r = parseFloat(el.getAttribute("r") ?? "0");
	if (Number.isNaN(r) || r <= 0) return [];
	return ellipseArcs(cx, cy, r, r, ctm, ctx);
}

function ellipseToSegs(
	el: Element,
	ctm: DOMMatrix,
	ctx: ParseCtx,
): PathSegment[] {
	const cx = parseFloat(el.getAttribute("cx") ?? "0");
	const cy = parseFloat(el.getAttribute("cy") ?? "0");
	const rx = parseFloat(el.getAttribute("rx") ?? "0");
	const ry = parseFloat(el.getAttribute("ry") ?? "0");
	if (Number.isNaN(rx) || Number.isNaN(ry) || rx <= 0 || ry <= 0) return [];
	return ellipseArcs(cx, cy, rx, ry, ctm, ctx);
}

function ellipseArcs(
	cx: number,
	cy: number,
	rx: number,
	ry: number,
	ctm: DOMMatrix,
	ctx: ParseCtx,
): PathSegment[] {
	const k = KAPPA;
	const anchors = [
		{ x: cx, y: cy - ry }, // top
		{ x: cx + rx, y: cy }, // right
		{ x: cx, y: cy + ry }, // bottom
		{ x: cx - rx, y: cy }, // left
	];
	const cps = [
		{
			cp1: { x: cx + rx * k, y: cy - ry },
			cp2: { x: cx + rx, y: cy - ry * k },
		},
		{
			cp1: { x: cx + rx, y: cy + ry * k },
			cp2: { x: cx + rx * k, y: cy + ry },
		},
		{
			cp1: { x: cx - rx * k, y: cy + ry },
			cp2: { x: cx - rx, y: cy + ry * k },
		},
		{
			cp1: { x: cx - rx, y: cy - ry * k },
			cp2: { x: cx - rx * k, y: cy - ry },
		},
	];

	const segs: PathSegment[] = [];
	for (let i = 0; i < 4; i++) {
		const startW = ctmAndFlip(anchors[i].x, anchors[i].y, ctm, ctx);
		const endW = ctmAndFlip(
			anchors[(i + 1) % 4].x,
			anchors[(i + 1) % 4].y,
			ctm,
			ctx,
		);
		const cp1W = ctmAndFlip(cps[i].cp1.x, cps[i].cp1.y, ctm, ctx);
		const cp2W = ctmAndFlip(cps[i].cp2.x, cps[i].cp2.y, ctm, ctx);

		const seg: PathSegment = {
			end: endW,
			cp1: { x: cp1W.x - startW.x, y: cp1W.y - startW.y },
			cp2: { x: cp2W.x - endW.x, y: cp2W.y - endW.y },
			isMoved: i === 0,
			...(i === 3 ? { isClosed: true } : {}),
			startTiltX: 0,
			startTiltY: 0,
			endTiltX: 0,
			endTiltY: 0,
			startDeltaTime: 0,
			endDeltaTime: 0,
		};
		if (i === 0) seg.start = startW;
		segs.push(seg);
	}
	return segs;
}

function polyToPathD(el: Element, close: boolean): string | null {
	const pts = el.getAttribute("points");
	if (!pts) return null;
	const coords = pts
		.trim()
		.split(/[\s,]+/)
		.map(Number);
	if (coords.some(Number.isNaN) || coords.length < 4) return null;

	const parts: string[] = [];
	for (let i = 0; i + 1 < coords.length; i += 2) {
		parts.push(
			i === 0
				? `M ${coords[i]} ${coords[i + 1]}`
				: `L ${coords[i]} ${coords[i + 1]}`,
		);
	}
	if (close) parts.push("Z");
	return parts.join(" ");
}

function lineToPathD(el: Element): string | null {
	const x1 = el.getAttribute("x1") ?? "0";
	const y1 = el.getAttribute("y1") ?? "0";
	const x2 = el.getAttribute("x2") ?? "0";
	const y2 = el.getAttribute("y2") ?? "0";
	return `M ${x1} ${y1} L ${x2} ${y2}`;
}

// --- Path Builder ---

function buildPath(
	el: Element,
	segments: PathSegment[],
	opacity: number,
	ctm: DOMMatrix,
	state: ParseState,
	inherited: Record<string, string>,
): string {
	const getAttr = makeStyleGetter(el, state.ctx, inherited);

	const fillStr = getAttr("fill") ?? "black";
	const strokeStr = getAttr("stroke") ?? "none";
	const strokeWidthStr = getAttr("stroke-width") ?? "1";
	const strokeWidth = parseFloat(strokeWidthStr);

	// Reference frame for bbox-relative gradient resolution. Mirror
	// calculatePathBounds (which spatialIndex.getWorldBounds — and therefore the
	// native gradient tool — resolves against): tight segment bounds expanded by
	// half the stroke width when a stroke is present. SVG imports never use
	// wet-ink brushes, so the stroke half-width is the only margin. Keeping this in
	// sync makes an imported userSpaceOnUse gradient land where a hand-drawn one would.
	const strokeWidthPx = Number.isNaN(strokeWidth) ? 1 : strokeWidth;
	const hasStroke =
		matchUrlRef(strokeStr) !== null || parseSvgColor(strokeStr) !== null;
	const strokeMargin = hasStroke ? strokeWidthPx / 2 : 0;
	const rawBounds = calculateSegmentListBounds(segments);
	const bbox: BoundingBox = rawBounds
		? {
				minX: rawBounds.minX - strokeMargin,
				minY: rawBounds.minY - strokeMargin,
				maxX: rawBounds.maxX + strokeMargin,
				maxY: rawBounds.maxY + strokeMargin,
				width: rawBounds.width + strokeMargin * 2,
				height: rawBounds.height + strokeMargin * 2,
			}
		: { minX: 0, minY: 0, maxX: 1, maxY: 1, width: 1, height: 1 };

	const filters: Path["filters"] = [];

	const fillColor = resolveFill(fillStr, state.ctx, bbox, ctm);
	if (fillColor) {
		const fa: FillAppearance = {
			uid: generateUid("app"),
			processor: "fill",
			opacity: parsePaintOpacity(getAttr("fill-opacity")),
			blendMode: "normal" as const,
			paramData: { version: "1", params: { fill: fillColor } },
		};
		filters.push(fa);
	}

	const strokeColor = resolveStroke(strokeStr, state.ctx, bbox, ctm);
	if (strokeColor) {
		const lineCap = parseSvgLineCap(getAttr("stroke-linecap"));
		const lineJoin = parseSvgLineJoin(getAttr("stroke-linejoin"));
		const miterLimitRaw = parseFloat(getAttr("stroke-miterlimit") ?? "4");
		const miterLimit = Number.isNaN(miterLimitRaw) ? 4 : miterLimitRaw;

		const dashArrayStr = getAttr("stroke-dasharray");
		const dashArray =
			dashArrayStr && dashArrayStr !== "none"
				? dashArrayStr
						.split(/[\s,]+/)
						.map(Number)
						.filter((n) => !Number.isNaN(n) && n >= 0)
				: undefined;
		const dashOffsetRaw = parseFloat(getAttr("stroke-dashoffset") ?? "0");
		const dashOffset = Number.isNaN(dashOffsetRaw) ? 0 : dashOffsetRaw;

		const sa: StrokeAppearance = {
			uid: generateUid("app"),
			processor: "stroke",
			opacity: parsePaintOpacity(getAttr("stroke-opacity")),
			blendMode: "normal" as const,
			paramData: {
				version: "1",
				params: {
					strokeColor,
					brushSettings: createStrokeBrushSettings(
						Number.isNaN(strokeWidth) ? 1 : strokeWidth,
						{
							lineCap,
							lineJoin,
							miterLimit,
							dashArray,
							dashOffset: dashOffset || undefined,
						},
					),
				},
			},
		};
		filters.push(sa);
	}

	// The element's <filter> graph applies on top of fill/stroke.
	filters.push(...buildFilterAppearances(getAttr("filter"), state.ctx, ctm));

	const path: Path = {
		type: "path",
		id: generateUid("obj"),
		opacity,
		blendMode: resolveBlendMode(getAttr("mix-blend-mode")) ?? "normal",
		transform: createIdentityTransform(),
		segments,
		filters,
	};
	state.objects.set(path.id, path);
	return path.id;
}

// --- Text Builder ---

// Supports single <text> with x/y, element-level dx/dy, font-size,
// font-family/weight/style, fill, text-anchor, writing-mode and <filter>
// graphs. <tspan> children contribute their own runs with per-span style
// overrides. Not handled (v1): per-<tspan> dx/dy positioning, rotate, per-glyph
// positioning, textPath, and gradient/pattern text fill (solid colors only).
function buildTextElement(
	el: Element,
	ctm: DOMMatrix,
	opacity: number,
	getElProp: (name: string) => string | null,
	state: ParseState,
): string {
	const svgX = parseFloat(el.getAttribute("x") ?? "0");
	const svgY = parseFloat(el.getAttribute("y") ?? "0");
	// Element-level dx/dy shift the anchor. Per-<tspan> dx/dy (run-relative
	// positioning) is not represented — runs are concatenated at the anchor.
	const dx = parseFloat(el.getAttribute("dx") ?? "0");
	const dy = parseFloat(el.getAttribute("dy") ?? "0");
	const baseStyle = applyTextStyle(createBaseTextStyle(), getElProp);
	const writingMode = svgWritingMode(getElProp("writing-mode"));
	const vertical = writingMode !== "horizontal-tb";
	// SVG centers a vertical column on x; layoutVertical puts the glyph's left
	// edge on the column x, so shift the anchor half an em to compensate.
	const columnOffset = vertical ? baseStyle.fontSize / 2 : 0;
	const anchor = ctmAndFlip(
		(Number.isNaN(svgX) ? 0 : svgX) +
			(Number.isNaN(dx) ? 0 : dx) -
			columnOffset,
		(Number.isNaN(svgY) ? 0 : svgY) + (Number.isNaN(dy) ? 0 : dy),
		ctm,
		state.ctx,
	);

	const alignment = svgTextAnchorToAlignment(getElProp("text-anchor"));
	const paragraphs = collectTextParagraphs(
		el,
		baseStyle,
		state.ctx,
		vertical,
	).map(
		(runs): TextParagraph => ({
			runs,
			alignment,
			lineHeight: 1.2,
			indent: 0,
			spacing: { before: 0, after: 0 },
		}),
	);
	if (paragraphs.length === 0) return "";

	const textEl: TextElement = {
		type: "text",
		id: generateUid("obj"),
		x: anchor.x,
		y: anchor.y,
		transform: createIdentityTransform(),
		opacity,
		blendMode: resolveBlendMode(getElProp("mix-blend-mode")) ?? "normal",
		content: { paragraphs },
		defaultStyle: baseStyle,
		layout: {
			writingMode,
			boxWidth: "auto",
			boxHeight: "auto",
			overflow: "visible",
			wordWrap: false,
		},
		// Content appearance marker: anchor for per-glyph paint (mirrors TextTool),
		// followed by the element's <filter> graph.
		filters: [
			{
				uid: generateUid("app"),
				processor: "content",
				opacity: 1,
				blendMode: "normal",
				paramData: { version: "1", params: {} },
			},
			...buildFilterAppearances(getElProp("filter"), state.ctx, ctm),
		],
	};
	state.objects.set(textEl.id, textEl);
	return textEl.id;
}

// SVG default text style baseline. fontSource is re-derived from the resolved
// family/weight in applyTextStyle. Mirrors the shape of createDefaultTextStyle
// (kept local to avoid a utils -> tools dependency).
function createBaseTextStyle(): TextStyle {
	return {
		fontFamily: "Inter",
		fontSource: { type: "google", family: "Inter", variants: ["400"] },
		fontSize: 16,
		fontWeight: 400,
		fontStyle: "normal",
		fill: { type: "solid", color: createDefaultColor() },
		underline: false,
		strikethrough: false,
		letterSpacing: 0,
		baselineShift: 0,
	};
}

function applyTextStyle(
	base: TextStyle,
	getProp: (name: string) => string | null,
): TextStyle {
	const style: TextStyle = { ...base };

	const fontSize = parseFloat(getProp("font-size") ?? "");
	if (!Number.isNaN(fontSize) && fontSize > 0) style.fontSize = fontSize;

	const weight = parseSvgFontWeight(getProp("font-weight"));
	if (weight !== null) style.fontWeight = weight;

	const fontStyle = getProp("font-style")?.trim().toLowerCase();
	if (fontStyle === "italic" || fontStyle === "oblique") {
		style.fontStyle = fontStyle;
	} else if (fontStyle === "normal") {
		style.fontStyle = "normal";
	}

	const family = cleanFontFamily(getProp("font-family"));
	if (family) style.fontFamily = family;

	const fillStr = getProp("fill");
	if (fillStr) {
		if (fillStr.trim().toLowerCase() === "none") {
			style.fill = null;
		} else {
			const color = parseSvgColor(fillStr);
			if (color) style.fill = { type: "solid", color };
		}
	}

	// TextStyle has no per-run opacity; bake fill-opacity into the color alpha.
	const fillOpacity = parsePaintOpacity(getProp("fill-opacity"));
	if (fillOpacity < 1 && style.fill?.type === "solid") {
		style.fill = {
			type: "solid",
			color: { ...style.fill.color, a: style.fill.color.a * fillOpacity },
		};
	}

	// SVG letter-spacing is in px; TextStyle.letterSpacing is in em.
	const letterSpacing = parseFloat(getProp("letter-spacing") ?? "");
	if (!Number.isNaN(letterSpacing) && style.fontSize > 0) {
		style.letterSpacing = letterSpacing / style.fontSize;
	}

	// Keep fontSource aligned with the resolved family/weight so the Google
	// loader targets it (unknown families fall back to Noto Sans JP at render).
	style.fontSource = {
		type: "google",
		family: style.fontFamily,
		variants: [String(style.fontWeight)],
	};
	return style;
}

/**
 * Collect the runs of a <text>, grouped into paragraphs. Horizontal text is a
 * single paragraph. In vertical text a <tspan x> starts a new column: each
 * becomes its own paragraph, and the run styles carry a lineHeight derived
 * from the x delta so layoutVertical advances the column by exactly that far.
 */
function collectTextParagraphs(
	el: Element,
	baseStyle: TextStyle,
	ctx: ParseCtx,
	vertical: boolean,
): TextRun[][] {
	const columns: { x: number | null; runs: TextRun[] }[] = [
		{ x: null, runs: [] },
	];
	const visit = (node: Element, inheritedStyle: TextStyle) => {
		for (const child of node.childNodes) {
			if (child.nodeType === Node.TEXT_NODE) {
				const text = collapseWhitespace(child.textContent ?? "");
				if (text) columns.at(-1)!.runs.push({ text, style: inheritedStyle });
				continue;
			}
			if (
				child.nodeType !== Node.ELEMENT_NODE ||
				(child as Element).tagName.toLowerCase() !== "tspan"
			) {
				continue;
			}
			const spanEl = child as Element;
			const spanX = parseFloat(spanEl.getAttribute("x") ?? "");
			if (vertical && !Number.isNaN(spanX)) {
				const current = columns.at(-1)!;
				if (current.runs.length === 0) current.x = spanX;
				else columns.push({ x: spanX, runs: [] });
			}
			// Ancestor style inheritance is already carried by inheritedStyle.
			visit(
				spanEl,
				applyTextStyle(inheritedStyle, makeStyleGetter(spanEl, ctx, {})),
			);
		}
	};
	visit(el, baseStyle);

	return columns
		.filter((column) => column.runs.length > 0)
		.map((column, i, all) => {
			const prev = i > 0 ? all[i - 1] : null;
			if (prev?.x == null || column.x == null || column.x === prev.x) {
				return column.runs;
			}
			const advance = Math.abs(column.x - prev.x);
			return column.runs.map((run) => ({
				...run,
				style: { ...run.style, lineHeight: advance / run.style.fontSize },
			}));
		});
}

function makeStyleGetter(
	el: Element,
	ctx: ParseCtx,
	inherited: Record<string, string>,
): (name: string) => string | null {
	const inlineStyle = parseInlineStyle(el.getAttribute("style") ?? "");
	const classStyle: Record<string, string> = {};
	for (const cls of (el.getAttribute("class") ?? "")
		.split(/\s+/)
		.filter(Boolean)) {
		const rules = ctx.cssClasses.get(cls);
		if (rules) Object.assign(classStyle, rules);
	}
	return (name) =>
		inlineStyle[name] ??
		classStyle[name] ??
		el.getAttribute(name) ??
		inherited[name] ??
		null;
}

// Overlay the element's own values for inherited presentation attributes onto
// the ancestor map, producing the map its children inherit.
function overlayInheritedProps(
	getProp: (name: string) => string | null,
	inherited: Record<string, string>,
): Record<string, string> {
	let result = inherited;
	for (const name of INHERITED_PROPS) {
		const value = getProp(name);
		if (value === null || value === result[name]) continue;
		if (result === inherited) result = { ...inherited };
		result[name] = value;
	}
	return result;
}

function svgWritingMode(
	value: string | null,
): TextElement["layout"]["writingMode"] {
	// Accept both CSS (vertical-rl/-lr) and legacy SVG 1.1 (tb, tb-rl) values.
	const v = value?.trim().toLowerCase();
	if (v === "vertical-rl" || v === "tb-rl" || v === "tb") return "vertical-rl";
	if (v === "vertical-lr") return "vertical-lr";
	return "horizontal-tb";
}

function svgTextAnchorToAlignment(
	value: string | null,
): TextParagraph["alignment"] {
	const v = value?.trim().toLowerCase();
	if (v === "middle") return "center";
	if (v === "end") return "right";
	return "left";
}

function parseSvgFontWeight(value: string | null): number | null {
	if (!value) return null;
	const v = value.trim().toLowerCase();
	if (v === "bold") return 700;
	if (v === "normal") return 400;
	const n = parseInt(v, 10);
	if (Number.isNaN(n)) return null;
	return Math.max(100, Math.min(900, n));
}

function cleanFontFamily(value: string | null): string | null {
	if (!value) return null;
	// Take the first family in the stack and strip surrounding quotes.
	const first = value
		.split(",")[0]
		?.trim()
		.replace(/^['"]|['"]$/g, "");
	return first || null;
}

function collapseWhitespace(text: string): string {
	return text.replace(/\s+/g, " ");
}

const VALID_BLEND_MODES = new Set<string>([
	"normal",
	"multiply",
	"screen",
	"overlay",
	"darken",
	"lighten",
	"color-dodge",
	"color-burn",
	"hard-light",
	"soft-light",
	"difference",
	"exclusion",
]);

function resolveBlendMode(value: string | null): BlendMode | null {
	if (!value) return null;
	const v = value.trim().toLowerCase();
	return VALID_BLEND_MODES.has(v) ? (v as BlendMode) : null;
}

/** Parse a fill-opacity / stroke-opacity value ("0.5" or "50%") into 0..1. */
function parsePaintOpacity(value: string | null): number {
	if (!value) return 1;
	const v = value.trim();
	const n = parseFloat(v);
	if (Number.isNaN(n)) return 1;
	return Math.max(0, Math.min(1, v.endsWith("%") ? n / 100 : n));
}

/** Extract the referenced id from a url(#id) / url('#id') / url("#id") value. */
function matchUrlRef(value: string | null): string | null {
	const m = value?.match(/url\(\s*["']?#([^"')]+)["']?\s*\)/);
	return m ? m[1].trim() : null;
}

function resolveFill(
	fillStr: string,
	ctx: ParseCtx,
	bbox: BoundingBox,
	ctm: DOMMatrix,
): FillColor | null {
	const refId = matchUrlRef(fillStr);
	if (refId) {
		const def = ctx.gradients.get(refId);
		if (def?.kind === "linear")
			return resolveLinearGradient(def, bbox, ctm, ctx);
		if (def?.kind === "radial")
			return resolveRadialGradient(def, bbox, ctm, ctx);
		const patternFill = ctx.patternFills.get(refId);
		if (patternFill) return { ...patternFill };
		return null;
	}
	const color = parseSvgColor(fillStr);
	if (!color) return null;
	const solid: SolidColor = { type: "solid", color };
	return solid;
}

function resolveStroke(
	strokeStr: string,
	ctx: ParseCtx,
	bbox: BoundingBox,
	ctm: DOMMatrix,
): StrokeColor | null {
	const refId = matchUrlRef(strokeStr);
	if (refId) {
		const def = ctx.gradients.get(refId);
		if (def?.kind === "linear") {
			const sg: StrokeGradient = {
				type: "stroke-gradient",
				gradient: resolveLinearGradient(def, bbox, ctm, ctx),
				mode: "within",
			};
			return sg;
		}
		const patternFill = ctx.patternFills.get(refId);
		if (patternFill) {
			const sp: StrokePattern = {
				type: "stroke-pattern",
				pattern: { ...patternFill },
				mode: "within",
			};
			return sp;
		}
		// radialGradient stroke: fallback to solid black
		const solid: SolidColor = {
			type: "solid",
			color: { type: "rgb", r: 0, g: 0, b: 0, a: 1 },
		};
		return solid;
	}
	const color = parseSvgColor(strokeStr);
	if (!color) return null;
	const solid: SolidColor = { type: "solid", color };
	return solid;
}

// --- Transform Parsing ---

function parseTransform(t: string): DOMMatrix {
	let m = new DOMMatrix();
	const re = /(\w+)\s*\(([^)]*)\)/g;
	let match = re.exec(t);
	while (match !== null) {
		const fn = match[1];
		const args = match[2]
			.trim()
			.split(/[\s,]+/)
			.map(Number);
		switch (fn) {
			case "translate":
				m = m.translate(args[0] ?? 0, args[1] ?? 0);
				break;
			case "scale":
				m = m.scale(args[0] ?? 1, args[1] ?? args[0] ?? 1);
				break;
			case "rotate": {
				const deg = args[0] ?? 0;
				const px = args[1] ?? 0;
				const py = args[2] ?? 0;
				if (px !== 0 || py !== 0) {
					m = m.translate(px, py).rotate(deg).translate(-px, -py);
				} else {
					m = m.rotate(deg);
				}
				break;
			}
			case "matrix":
				m = m.multiply(
					new DOMMatrix([args[0], args[1], args[2], args[3], args[4], args[5]]),
				);
				break;
			case "skewX":
				m = m.skewX(args[0] ?? 0);
				break;
			case "skewY":
				m = m.skewY(args[0] ?? 0);
				break;
		}
		match = re.exec(t);
	}
	return m;
}

// --- Color Parsing ---

// Full CSS named color set (CSS Color Level 4).
const CSS_NAMED_COLORS: Record<string, string> = {
	aliceblue: "#f0f8ff",
	antiquewhite: "#faebd7",
	aqua: "#00ffff",
	aquamarine: "#7fffd4",
	azure: "#f0ffff",
	beige: "#f5f5dc",
	bisque: "#ffe4c4",
	black: "#000000",
	blanchedalmond: "#ffebcd",
	blue: "#0000ff",
	blueviolet: "#8a2be2",
	brown: "#a52a2a",
	burlywood: "#deb887",
	cadetblue: "#5f9ea0",
	chartreuse: "#7fff00",
	chocolate: "#d2691e",
	coral: "#ff7f50",
	cornflowerblue: "#6495ed",
	cornsilk: "#fff8dc",
	crimson: "#dc143c",
	cyan: "#00ffff",
	darkblue: "#00008b",
	darkcyan: "#008b8b",
	darkgoldenrod: "#b8860b",
	darkgray: "#a9a9a9",
	darkgreen: "#006400",
	darkgrey: "#a9a9a9",
	darkkhaki: "#bdb76b",
	darkmagenta: "#8b008b",
	darkolivegreen: "#556b2f",
	darkorange: "#ff8c00",
	darkorchid: "#9932cc",
	darkred: "#8b0000",
	darksalmon: "#e9967a",
	darkseagreen: "#8fbc8f",
	darkslateblue: "#483d8b",
	darkslategray: "#2f4f4f",
	darkslategrey: "#2f4f4f",
	darkturquoise: "#00ced1",
	darkviolet: "#9400d3",
	deeppink: "#ff1493",
	deepskyblue: "#00bfff",
	dimgray: "#696969",
	dimgrey: "#696969",
	dodgerblue: "#1e90ff",
	firebrick: "#b22222",
	floralwhite: "#fffaf0",
	forestgreen: "#228b22",
	fuchsia: "#ff00ff",
	gainsboro: "#dcdcdc",
	ghostwhite: "#f8f8ff",
	gold: "#ffd700",
	goldenrod: "#daa520",
	gray: "#808080",
	green: "#008000",
	greenyellow: "#adff2f",
	grey: "#808080",
	honeydew: "#f0fff0",
	hotpink: "#ff69b4",
	indianred: "#cd5c5c",
	indigo: "#4b0082",
	ivory: "#fffff0",
	khaki: "#f0e68c",
	lavender: "#e6e6fa",
	lavenderblush: "#fff0f5",
	lawngreen: "#7cfc00",
	lemonchiffon: "#fffacd",
	lightblue: "#add8e6",
	lightcoral: "#f08080",
	lightcyan: "#e0ffff",
	lightgoldenrodyellow: "#fafad2",
	lightgray: "#d3d3d3",
	lightgreen: "#90ee90",
	lightgrey: "#d3d3d3",
	lightpink: "#ffb6c1",
	lightsalmon: "#ffa07a",
	lightseagreen: "#20b2aa",
	lightskyblue: "#87cefa",
	lightslategray: "#778899",
	lightslategrey: "#778899",
	lightsteelblue: "#b0c4de",
	lightyellow: "#ffffe0",
	lime: "#00ff00",
	limegreen: "#32cd32",
	linen: "#faf0e6",
	magenta: "#ff00ff",
	maroon: "#800000",
	mediumaquamarine: "#66cdaa",
	mediumblue: "#0000cd",
	mediumorchid: "#ba55d3",
	mediumpurple: "#9370db",
	mediumseagreen: "#3cb371",
	mediumslateblue: "#7b68ee",
	mediumspringgreen: "#00fa9a",
	mediumturquoise: "#48d1cc",
	mediumvioletred: "#c71585",
	midnightblue: "#191970",
	mintcream: "#f5fffa",
	mistyrose: "#ffe4e1",
	moccasin: "#ffe4b5",
	navajowhite: "#ffdead",
	navy: "#000080",
	oldlace: "#fdf5e6",
	olive: "#808000",
	olivedrab: "#6b8e23",
	orange: "#ffa500",
	orangered: "#ff4500",
	orchid: "#da70d6",
	palegoldenrod: "#eee8aa",
	palegreen: "#98fb98",
	paleturquoise: "#afeeee",
	palevioletred: "#db7093",
	papayawhip: "#ffefd5",
	peachpuff: "#ffdab9",
	peru: "#cd853f",
	pink: "#ffc0cb",
	plum: "#dda0dd",
	powderblue: "#b0e0e6",
	purple: "#800080",
	rebeccapurple: "#663399",
	red: "#ff0000",
	rosybrown: "#bc8f8f",
	royalblue: "#4169e1",
	saddlebrown: "#8b4513",
	salmon: "#fa8072",
	sandybrown: "#f4a460",
	seagreen: "#2e8b57",
	seashell: "#fff5ee",
	sienna: "#a0522d",
	silver: "#c0c0c0",
	skyblue: "#87ceeb",
	slateblue: "#6a5acd",
	slategray: "#708090",
	slategrey: "#708090",
	snow: "#fffafa",
	springgreen: "#00ff7f",
	steelblue: "#4682b4",
	tan: "#d2b48c",
	teal: "#008080",
	thistle: "#d8bfd8",
	tomato: "#ff6347",
	turquoise: "#40e0d0",
	violet: "#ee82ee",
	wheat: "#f5deb3",
	white: "#ffffff",
	whitesmoke: "#f5f5f5",
	yellow: "#ffff00",
	yellowgreen: "#9acd32",
};

export function parseSvgColor(str: string): RGBColor | null {
	const s = str.trim().toLowerCase();
	if (s === "none" || s === "transparent") return null;

	const named = CSS_NAMED_COLORS[s];
	if (named || s.startsWith("#")) {
		return parseHexColor((named ?? s).slice(1));
	}

	const rgbMatch = s.match(
		/^rgba?\(\s*([\d.]+%?)\s*,\s*([\d.]+%?)\s*,\s*([\d.]+%?)(?:\s*,\s*([\d.]+%?))?\s*\)$/,
	);
	if (rgbMatch) {
		// Channels accept 0-255 or percentages; alpha accepts 0-1 or percentages.
		const channel = (v: string) =>
			clamp01(v.endsWith("%") ? parseFloat(v) / 100 : parseFloat(v) / 255);
		const alpha = (v: string) =>
			clamp01(v.endsWith("%") ? parseFloat(v) / 100 : parseFloat(v));
		return {
			type: "rgb",
			r: channel(rgbMatch[1]),
			g: channel(rgbMatch[2]),
			b: channel(rgbMatch[3]),
			a: rgbMatch[4] !== undefined ? alpha(rgbMatch[4]) : 1,
		};
	}

	return null;
}

/** Parse "rgb", "rgba", "rrggbb" or "rrggbbaa" hex digits (no leading "#"). */
function parseHexColor(hex: string): RGBColor | null {
	if (!/^[0-9a-f]+$/.test(hex)) return null;
	if (hex.length === 3 || hex.length === 4) {
		const [r, g, b, a] = [...hex].map((c) => parseInt(c + c, 16) / 255);
		return { type: "rgb", r, g, b, a: hex.length === 4 ? a : 1 };
	}
	if (hex.length === 6 || hex.length === 8) {
		const r = parseInt(hex.slice(0, 2), 16) / 255;
		const g = parseInt(hex.slice(2, 4), 16) / 255;
		const b = parseInt(hex.slice(4, 6), 16) / 255;
		const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
		return { type: "rgb", r, g, b, a };
	}
	return null;
}

// --- SVG Path D Parser ---

export function parseSvgPathD(
	d: string,
	ctm: DOMMatrix,
	ctx: ParseCtx,
): PathSegment[] {
	const tokens = tokenizeD(d);
	const segs: PathSegment[] = [];

	let curX = 0;
	let curY = 0;
	let subX = 0;
	let subY = 0;
	let pendingMove = false;
	let prevCmd = "";
	let prevAbsCp2X = 0;
	let prevAbsCp2Y = 0;
	let prevAbsQCpX = 0;
	let prevAbsQCpY = 0;
	let subpathStart = 0;

	let i = 0;
	const next = () => parseFloat(tokens[i++]);
	// Arc flags are single characters and may be glued to the following number
	// ("A 5 5 0 011 0" = largeArc=0, sweep=1, x=1). Consume exactly one char and
	// leave the remainder in place for the next read.
	const nextFlag = () => {
		const tok = tokens[i];
		if (tok.length > 1) {
			tokens[i] = tok.slice(1);
			return tok[0] === "1";
		}
		i++;
		return tok === "1";
	};

	const addSeg = (
		endSvgX: number,
		endSvgY: number,
		absCp1X: number,
		absCp1Y: number,
		absCp2X: number,
		absCp2Y: number,
	) => {
		const startW = ctmAndFlip(curX, curY, ctm, ctx);
		const endW = ctmAndFlip(endSvgX, endSvgY, ctm, ctx);
		const cp1W = ctmAndFlip(absCp1X, absCp1Y, ctm, ctx);
		const cp2W = ctmAndFlip(absCp2X, absCp2Y, ctm, ctx);

		const seg: PathSegment = {
			end: endW,
			cp1: { x: cp1W.x - startW.x, y: cp1W.y - startW.y },
			cp2: { x: cp2W.x - endW.x, y: cp2W.y - endW.y },
			isMoved: pendingMove,
			startTiltX: 0,
			startTiltY: 0,
			endTiltX: 0,
			endTiltY: 0,
			startDeltaTime: 0,
			endDeltaTime: 0,
		};
		if (pendingMove) {
			seg.start = startW;
			pendingMove = false;
		}
		segs.push(seg);
		prevAbsCp2X = absCp2X;
		prevAbsCp2Y = absCp2Y;
		curX = endSvgX;
		curY = endSvgY;
	};

	while (i < tokens.length) {
		const cmd = tokens[i];
		if (!/[a-zA-Z]/.test(cmd)) break;
		i++;

		const rel = cmd !== cmd.toUpperCase() && cmd !== "z";

		switch (cmd.toUpperCase()) {
			case "M": {
				const ox = rel ? curX : 0;
				const oy = rel ? curY : 0;
				const x = next() + ox;
				const y = next() + oy;
				subX = x;
				subY = y;
				curX = x;
				curY = y;
				subpathStart = segs.length;
				pendingMove = true;
				prevCmd = cmd;
				// Subsequent pairs after M are implicit L
				while (i < tokens.length && !/[a-zA-Z]/.test(tokens[i])) {
					const lox = rel ? curX : 0;
					const loy = rel ? curY : 0;
					const lx = next() + lox;
					const ly = next() + loy;
					addSeg(lx, ly, curX, curY, lx, ly);
					prevCmd = rel ? "l" : "L";
				}
				continue;
			}

			case "Z": {
				if (pendingMove) {
					// M immediately followed by Z: degenerate closed point
					const pt = ctmAndFlip(subX, subY, ctm, ctx);
					segs.push({
						start: pt,
						end: pt,
						cp1: { x: 0, y: 0 },
						cp2: { x: 0, y: 0 },
						isMoved: true,
						isClosed: true,
						startTiltX: 0,
						startTiltY: 0,
						endTiltX: 0,
						endTiltY: 0,
						startDeltaTime: 0,
						endDeltaTime: 0,
					});
					pendingMove = false;
				} else if (segs.length > subpathStart) {
					// Return to the subpath start explicitly, like native shapes
					// (ShapeTool's createClosedPolygonSegments ends its last segment at
					// the start). Without this, the closing edge exists only as the
					// isClosed flag and segment-based consumers (path outline / edit
					// overlays / boolean ops) omit it. Skip if already at the start.
					if (Math.abs(curX - subX) > 1e-6 || Math.abs(curY - subY) > 1e-6) {
						addSeg(subX, subY, curX, curY, subX, subY);
					}
					segs[segs.length - 1].isClosed = true;
				}
				curX = subX;
				curY = subY;
				subpathStart = segs.length;
				pendingMove = true;
				prevCmd = cmd;
				continue;
			}

			case "L": {
				while (i < tokens.length && !/[a-zA-Z]/.test(tokens[i])) {
					const ox = rel ? curX : 0;
					const oy = rel ? curY : 0;
					const x = next() + ox;
					const y = next() + oy;
					addSeg(x, y, curX, curY, x, y);
					prevCmd = cmd;
				}
				break;
			}

			case "H": {
				while (i < tokens.length && !/[a-zA-Z]/.test(tokens[i])) {
					const ox = rel ? curX : 0;
					const x = next() + ox;
					addSeg(x, curY, curX, curY, x, curY);
					prevCmd = cmd;
				}
				break;
			}

			case "V": {
				while (i < tokens.length && !/[a-zA-Z]/.test(tokens[i])) {
					const oy = rel ? curY : 0;
					const y = next() + oy;
					addSeg(curX, y, curX, curY, curX, y);
					prevCmd = cmd;
				}
				break;
			}

			case "C": {
				while (i < tokens.length && !/[a-zA-Z]/.test(tokens[i])) {
					const ox = rel ? curX : 0;
					const oy = rel ? curY : 0;
					const cp1x = next() + ox;
					const cp1y = next() + oy;
					const cp2x = next() + ox;
					const cp2y = next() + oy;
					const x = next() + ox;
					const y = next() + oy;
					addSeg(x, y, cp1x, cp1y, cp2x, cp2y);
					prevCmd = cmd;
				}
				break;
			}

			case "S": {
				while (i < tokens.length && !/[a-zA-Z]/.test(tokens[i])) {
					const ox = rel ? curX : 0;
					const oy = rel ? curY : 0;
					const reflX = "CScs".includes(prevCmd)
						? 2 * curX - prevAbsCp2X
						: curX;
					const reflY = "CScs".includes(prevCmd)
						? 2 * curY - prevAbsCp2Y
						: curY;
					const cp2x = next() + ox;
					const cp2y = next() + oy;
					const x = next() + ox;
					const y = next() + oy;
					addSeg(x, y, reflX, reflY, cp2x, cp2y);
					prevCmd = cmd;
				}
				break;
			}

			case "Q": {
				while (i < tokens.length && !/[a-zA-Z]/.test(tokens[i])) {
					const ox = rel ? curX : 0;
					const oy = rel ? curY : 0;
					const qcpX = next() + ox;
					const qcpY = next() + oy;
					const x = next() + ox;
					const y = next() + oy;
					// Quadratic to cubic conversion
					const cp1x = curX + (2 / 3) * (qcpX - curX);
					const cp1y = curY + (2 / 3) * (qcpY - curY);
					const cp2x = x + (2 / 3) * (qcpX - x);
					const cp2y = y + (2 / 3) * (qcpY - y);
					prevAbsQCpX = qcpX;
					prevAbsQCpY = qcpY;
					addSeg(x, y, cp1x, cp1y, cp2x, cp2y);
					prevCmd = cmd;
				}
				break;
			}

			case "T": {
				while (i < tokens.length && !/[a-zA-Z]/.test(tokens[i])) {
					const ox = rel ? curX : 0;
					const oy = rel ? curY : 0;
					const qcpX = "QqTt".includes(prevCmd) ? 2 * curX - prevAbsQCpX : curX;
					const qcpY = "QqTt".includes(prevCmd) ? 2 * curY - prevAbsQCpY : curY;
					const x = next() + ox;
					const y = next() + oy;
					const cp1x = curX + (2 / 3) * (qcpX - curX);
					const cp1y = curY + (2 / 3) * (qcpY - curY);
					const cp2x = x + (2 / 3) * (qcpX - x);
					const cp2y = y + (2 / 3) * (qcpY - y);
					prevAbsQCpX = qcpX;
					prevAbsQCpY = qcpY;
					addSeg(x, y, cp1x, cp1y, cp2x, cp2y);
					prevCmd = cmd;
				}
				break;
			}

			case "A": {
				while (i < tokens.length && !/[a-zA-Z]/.test(tokens[i])) {
					const ox = rel ? curX : 0;
					const oy = rel ? curY : 0;
					const rx = next();
					const ry = next();
					const rotation = next();
					const largeArc = nextFlag();
					const sweep = nextFlag();
					const x = next() + ox;
					const y = next() + oy;
					const beziers = arcToBeziers(
						curX,
						curY,
						rx,
						ry,
						rotation,
						largeArc,
						sweep,
						x,
						y,
					);
					for (const bez of beziers) {
						addSeg(bez.x, bez.y, bez.cp1x, bez.cp1y, bez.cp2x, bez.cp2y);
					}
					prevCmd = cmd;
				}
				break;
			}
		}
	}

	return segs;
}

// --- Arc to Bezier Conversion ---

function arcToBeziers(
	x1: number,
	y1: number,
	rx: number,
	ry: number,
	rotation: number,
	largeArc: boolean,
	sweep: boolean,
	x2: number,
	y2: number,
): Array<{
	cp1x: number;
	cp1y: number;
	cp2x: number;
	cp2y: number;
	x: number;
	y: number;
}> {
	if (rx === 0 || ry === 0) {
		return [
			{
				cp1x: x1 + (x2 - x1) / 3,
				cp1y: y1 + (y2 - y1) / 3,
				cp2x: x1 + (2 * (x2 - x1)) / 3,
				cp2y: y1 + (2 * (y2 - y1)) / 3,
				x: x2,
				y: y2,
			},
		];
	}
	if (x1 === x2 && y1 === y2) return [];

	const phi = (rotation * Math.PI) / 180;
	const cosPhi = Math.cos(phi);
	const sinPhi = Math.sin(phi);

	rx = Math.abs(rx);
	ry = Math.abs(ry);

	const dx2 = (x1 - x2) / 2;
	const dy2 = (y1 - y2) / 2;
	const x1p = cosPhi * dx2 + sinPhi * dy2;
	const y1p = -sinPhi * dx2 + cosPhi * dy2;

	const x1pSq = x1p * x1p;
	const y1pSq = y1p * y1p;

	const lambda = Math.sqrt(x1pSq / (rx * rx) + y1pSq / (ry * ry));
	if (lambda > 1) {
		rx *= lambda;
		ry *= lambda;
	}

	const rxSq = rx * rx;
	const rySq = ry * ry;
	const num = Math.max(0, rxSq * rySq - rxSq * y1pSq - rySq * x1pSq);
	const den = rxSq * y1pSq + rySq * x1pSq;
	const sq =
		(den === 0 ? 0 : Math.sqrt(num / den)) * (largeArc === sweep ? -1 : 1);

	const cxp = (sq * rx * y1p) / ry;
	const cyp = (-sq * ry * x1p) / rx;
	const cx = cosPhi * cxp - sinPhi * cyp + (x1 + x2) / 2;
	const cy = sinPhi * cxp + cosPhi * cyp + (y1 + y2) / 2;

	const theta1 = vecAngle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
	let dTheta = vecAngle(
		(x1p - cxp) / rx,
		(y1p - cyp) / ry,
		(-x1p - cxp) / rx,
		(-y1p - cyp) / ry,
	);
	if (!sweep && dTheta > 0) dTheta -= 2 * Math.PI;
	if (sweep && dTheta < 0) dTheta += 2 * Math.PI;

	const n = Math.max(1, Math.ceil(Math.abs(dTheta) / (Math.PI / 2)));
	const dt = dTheta / n;
	const t =
		Math.abs(dt) < 1e-10
			? 0
			: ((8 / 3) * Math.sin(dt / 4) ** 2) / Math.sin(dt / 2);

	const result: Array<{
		cp1x: number;
		cp1y: number;
		cp2x: number;
		cp2y: number;
		x: number;
		y: number;
	}> = [];

	let theta = theta1;
	let prevX = x1;
	let prevY = y1;

	for (let j = 0; j < n; j++) {
		const nextTheta = theta + dt;
		const cos1 = Math.cos(theta);
		const sin1 = Math.sin(theta);
		const cos2 = Math.cos(nextTheta);
		const sin2 = Math.sin(nextTheta);

		const ex2 = cosPhi * rx * cos2 - sinPhi * ry * sin2 + cx;
		const ey2 = sinPhi * rx * cos2 + cosPhi * ry * sin2 + cy;
		const finalX = j === n - 1 ? x2 : ex2;
		const finalY = j === n - 1 ? y2 : ey2;

		const cp1x = prevX + t * (-cosPhi * rx * sin1 - sinPhi * ry * cos1);
		const cp1y = prevY + t * (-sinPhi * rx * sin1 + cosPhi * ry * cos1);
		const cp2x = finalX + t * (cosPhi * rx * sin2 + sinPhi * ry * cos2);
		const cp2y = finalY + t * (sinPhi * rx * sin2 - cosPhi * ry * cos2);

		result.push({ cp1x, cp1y, cp2x, cp2y, x: finalX, y: finalY });

		prevX = ex2;
		prevY = ey2;
		theta = nextTheta;
	}

	return result;
}

function vecAngle(ux: number, uy: number, vx: number, vy: number): number {
	const n = Math.sqrt(ux * ux + uy * uy) * Math.sqrt(vx * vx + vy * vy);
	if (n === 0) return 0;
	const a = Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy) / n)));
	return ux * vy - uy * vx < 0 ? -a : a;
}

// --- Path D Tokenizer ---

const SVG_LINE_CAPS: Record<string, LineCap> = {
	butt: "butt",
	round: "round",
	square: "square",
};

function parseSvgLineCap(value: string | null): LineCap {
	if (!value) return "butt";
	return SVG_LINE_CAPS[value.trim().toLowerCase()] ?? "butt";
}

const SVG_LINE_JOINS: Record<string, LineJoin> = {
	miter: "miter",
	round: "round",
	bevel: "bevel",
};

function parseSvgLineJoin(value: string | null): LineJoin {
	if (!value) return "miter";
	return SVG_LINE_JOINS[value.trim().toLowerCase()] ?? "miter";
}

function tokenizeD(d: string): string[] {
	const tokens: string[] = [];
	// Match command letters or numbers (including scientific notation and negative sign)
	const re = /[a-zA-Z]|[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g;
	let m = re.exec(d);
	while (m !== null) {
		tokens.push(m[0]);
		m = re.exec(d);
	}
	return tokens;
}
