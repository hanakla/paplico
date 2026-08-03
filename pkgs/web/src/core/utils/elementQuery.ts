import { readStoredBrushSize } from "../brush/access";
import type {
	AnyArtObject,
	BlendMode,
	FillAppearance,
	Filter,
	Layer,
	SolidColor,
	StrokeAppearance,
	TextStyle,
} from "../schema";

/** Get the first StrokeAppearance from a filters array, or undefined */
export function getFirstStroke(
	filters: Filter[] | undefined,
): StrokeAppearance | undefined {
	return filters?.find((f) => f.processor === "stroke") as
		| StrokeAppearance
		| undefined;
}

/** Get the first FillAppearance from a filters array, or undefined */
export function getFirstFill(
	filters: Filter[] | undefined,
): FillAppearance | undefined {
	return filters?.find((f) => f.processor === "fill") as
		| FillAppearance
		| undefined;
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
	const allFilters = (element.filters ?? []).filter(
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
	filters: Filter[] | undefined,
	fallback = 1,
): number {
	const stroke = filters?.find(
		(f) => f.processor === "stroke" && f.enabled !== false,
	) as StrokeAppearance | undefined;
	return (
		readStoredBrushSize(stroke?.paramData.params.brushSettings) ?? fallback
	);
}

/** Get the taper-in distance from the first enabled StrokeAppearance's brushSettings.taperStart */
export function getStrokeTaperStart(
	filters: Filter[] | undefined,
	fallback = 0,
): number {
	const stroke = filters?.find(
		(f) => f.processor === "stroke" && f.enabled !== false,
	) as StrokeAppearance | undefined;
	return stroke?.paramData.params.brushSettings?.taperStart ?? fallback;
}

/** Get the taper-out distance from the first enabled StrokeAppearance's brushSettings.taperEnd */
export function getStrokeTaperEnd(
	filters: Filter[] | undefined,
	fallback = 0,
): number {
	const stroke = filters?.find(
		(f) => f.processor === "stroke" && f.enabled !== false,
	) as StrokeAppearance | undefined;
	return stroke?.paramData.params.brushSettings?.taperEnd ?? fallback;
}

/**
 * Check if an element is effectively locked by checking:
 * 1. The element's own `locked` property
 * 2. Any ancestor group's `locked` property (walking up parentGroupMap)
 * 3. The containing layer's `locked` property
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
