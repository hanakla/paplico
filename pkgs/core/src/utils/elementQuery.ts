import { readStoredBrushSize, readStoredBrushStroking } from "../brush/access";
import { localAppearances } from "../document/appearancePresets";
import {
	type AnyArtObject,
	type BlendMode,
	type FillAppearance,
	type FillColor,
	type Filter,
	type FilterEntry,
	isAppearancePresetRef,
	type Layer,
	type SolidColor,
	type StrokeAlign,
	type StrokeAppearance,
	type TextStyle,
} from "../schema";

/**
 * Get the first StrokeAppearance from a filters array, or undefined.
 * Preset refs are ignored; callers resolve them beforehand when needed.
 */
export function getFirstStroke(
	filters: readonly FilterEntry[] | undefined,
): StrokeAppearance | undefined {
	return localAppearances(filters).find((f) => f.processor === "stroke") as
		| StrokeAppearance
		| undefined;
}

/** Get the first FillAppearance from a filters array, or undefined */
export function getFirstFill(
	filters: readonly FilterEntry[] | undefined,
): FillAppearance | undefined {
	return localAppearances(filters).find((f) => f.processor === "fill") as
		| FillAppearance
		| undefined;
}

/** Fill appearances of a filters array that paint a gradient, in stack order. */
export function getGradientFills(
	filters: readonly FilterEntry[] | undefined,
): FillAppearance[] {
	return localAppearances(filters)
		.filter((f): f is FillAppearance => f.processor === "fill")
		.filter(
			({ paramData }) =>
				paramData.params.fill.type !== "solid" &&
				paramData.params.fill.type !== "pattern",
		);
}

/**
 * The fill appearance the gradient tool edits: the gradient fill carrying
 * `targetUid`, or the first gradient fill when none carries it.
 */
export function getGradientTargetFill(
	filters: readonly FilterEntry[] | undefined,
	targetUid: string | null,
): FillAppearance | undefined {
	const fills = getGradientFills(filters);
	return fills.find((f) => f.uid === targetUid) ?? fills[0];
}

/** A copy of a filters array with the fill of the appearance `uid` replaced. */
export function replaceFillOf(
	filters: readonly FilterEntry[] | undefined,
	uid: string,
	fill: FillColor,
): FilterEntry[] {
	return (filters ?? []).map((f) =>
		!isAppearancePresetRef(f) && f.processor === "fill" && f.uid === uid
			? { ...f, paramData: { ...f.paramData, params: { fill } } }
			: f,
	);
}

export interface ExtractedAppearance {
	strokeAppearance: StrokeAppearance | null;
	fillAppearance: FillAppearance | null;
	/** All filters except "content" processor (includes stroke, fill, effects) */
	allFilters: Filter[];
	opacity: number;
	blendMode: BlendMode;
	textStyle: TextStyle | null;
	/** Solid color picked from empty area (artboard bg or black) */
	pickedColor?: SolidColor;
	/** Whether this pick was triggered by PenTool long-press */
	isLongPress?: boolean;
}

/** Extract appearance properties from an element for eyedropper copying */
export function extractAppearance(element: AnyArtObject): ExtractedAppearance {
	const strokeAppearance = getFirstStroke(element.filters) ?? null;
	const fillAppearance = getFirstFill(element.filters) ?? null;
	const allFilters = localAppearances(element.filters).filter(
		(f) => f.processor !== "content",
	);
	return {
		strokeAppearance,
		fillAppearance,
		allFilters,
		opacity: element.opacity,
		blendMode: element.blendMode,
		textStyle: element.type === "text" ? element.defaultStyle : null,
	};
}

/** Get the stroke width from the first enabled StrokeAppearance's brushSettings.size */
export function getStrokeWidth(
	filters: readonly FilterEntry[] | undefined,
	fallback = 1,
): number {
	const stroke = localAppearances(filters).find(
		(f) => f.processor === "stroke" && f.enabled !== false,
	) as StrokeAppearance | undefined;
	return (
		readStoredBrushSize(stroke?.paramData.params.brushSettings) ?? fallback
	);
}

/** Get the stroke placement from the first enabled StrokeAppearance's brushSettings.stroking */
export function getStrokeAlign(
	filters: readonly FilterEntry[] | undefined,
	fallback: StrokeAlign = "center",
): StrokeAlign {
	const stroke = localAppearances(filters).find(
		(f) => f.processor === "stroke" && f.enabled !== false,
	) as StrokeAppearance | undefined;
	return (
		readStoredBrushStroking(stroke?.paramData.params.brushSettings)?.align ??
		fallback
	);
}

/**
 * How far a stroke reaches from the path on its widest side. An outside-aligned
 * stroke puts the whole width on one side; inside keeps the half-width budget
 * because open subpaths in the same element still render centered.
 */
export function strokeOuterReach(width: number, align: StrokeAlign): number {
	return align === "outside" ? width : width / 2;
}

/**
 * Check if an element is effectively locked by checking:
 * 1. The element's own `locked` property
 * 2. Any ancestor group's `locked` property (walking up parentGroupMap)
 * 3. The containing layer's `locked` property
 *
 * This answers whether the element may be the target of an operation. Ask it
 * once, about the target; a write the operation makes to the target's content
 * is not asked again, so a locked child follows what is done to its parent.
 */
export function isEffectivelyLocked(
	elementId: string,
	objects: Record<string, AnyArtObject>,
	layers: Layer[],
	parentGroupMap: Map<string, string>,
): boolean {
	const element = objects[elementId];
	if (!element) return false;
	if (element.locked) return true;

	// Walk up ancestor groups
	let parentId = parentGroupMap.get(elementId);
	while (parentId != null) {
		if (objects[parentId]?.locked) return true;
		parentId = parentGroupMap.get(parentId);
	}

	// Check the containing layer
	const layer = findLayerForElement(elementId, layers, parentGroupMap);
	return layer?.locked === true;
}

/**
 * Find the layer that contains the given element.
 * First walks up the parentGroupMap to find the top-level ancestor,
 * then finds which layer contains that ancestor in its elementIds.
 */
export function findLayerForElement(
	elementId: string,
	layers: Layer[],
	parentGroupMap: Map<string, string>,
): Layer | null {
	let current = elementId;
	let parentId = parentGroupMap.get(current);

	while (parentId != null) {
		current = parentId;
		parentId = parentGroupMap.get(current);
	}

	// current is now the top-level ancestor (or the element itself)
	return layers.find((l) => l.elementIds.includes(current)) ?? null;
}
