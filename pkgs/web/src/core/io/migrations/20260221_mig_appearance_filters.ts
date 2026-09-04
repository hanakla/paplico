import { nanoid } from "nanoid";
import {
	type ArtObject,
	type BrushSettings,
	type Document,
	type FillAppearance,
	type FillColor,
	type Filter,
	generateUid,
	type StrokeAppearance,
	type StrokeColor,
} from "../../schema";
import type { Migration } from "./index";

/**
 * Frozen default brush settings as of schema version 20260221.
 * Returns the legacy flat persisted shape; later migrations / normalizeBrushSettings
 * convert it into the current V1BrushSettings union.
 */
// Emits the pre-v2 shape on purpose: this migration runs before the brush-v2
// one, which is what converts the whole document to BrushSettings.
function createDefaultLineBrush(size: number): BrushSettings {
	return {
		textureFileUid: "builtin-brush-line",
		size,
		sizeByPressure: 0,
		opacity: 1,
		opacityByPressure: 0,
		spacing: 0.02,
		flow: 1,
		stampRotation: "none",
		randomSeed: 0,
		rotationByTilt: 0,
		aspectRatioByTilt: 0,
		sizeBySpeed: 0,
		pooling: 0,
		poolingSizeRatio: 0,
	} as unknown as BrushSettings;
}

/**
 * Legacy element shape that may still carry flat fill/strokeColor/brushSettings
 * properties from documents saved before the appearance-filter unification.
 */
interface LegacyElement extends ArtObject {
	fill?: FillColor;
	strokeColor?: StrokeColor;
	brushSettings?: BrushSettings;
}

/**
 * Migrate a single element's flat fill/strokeColor/brushSettings into
 * FillAppearance / StrokeAppearance entries inside `filters[]`.
 *
 * If the element already has appearance filters (processor === "fill"/"stroke"),
 * the flat properties are ignored (the document was partially migrated or
 * created with the new schema).
 */
function migrateElement(element: LegacyElement): void {
	const hasLegacyFill = "fill" in element && element.fill !== undefined;
	const hasLegacyStroke =
		"strokeColor" in element && element.strokeColor !== undefined;

	if (!hasLegacyFill && !hasLegacyStroke) return;

	const filters: Filter[] = element.filters ? [...element.filters] : [];

	// Skip if already has appearance filters
	const hasFillFilter = filters.some((f) => f.processor === "fill");
	const hasStrokeFilter = filters.some((f) => f.processor === "stroke");

	if (hasLegacyFill && !hasFillFilter) {
		const fillApp: FillAppearance = {
			uid: nanoid(),
			processor: "fill",
			opacity: 1,
			blendMode: "normal",
			paramData: { version: "1", params: { fill: element.fill! } },
		};
		// Insert fill at the beginning (renders first = behind stroke)
		filters.unshift(fillApp);
	}

	if (hasLegacyStroke && !hasStrokeFilter) {
		const strokeApp: StrokeAppearance = {
			uid: generateUid("app"),
			processor: "stroke",
			opacity: 1,
			blendMode: "normal",
			paramData: {
				version: "1",
				params: {
					strokeColor: element.strokeColor!,
					brushSettings: element.brushSettings
						? element.brushSettings
						: createDefaultLineBrush(
								"width" in element ? (element as { width: number }).width : 1,
							),
				},
			},
		};
		// Insert stroke after fill (renders on top)
		filters.push(strokeApp);
	}

	element.filters = filters;

	// Clean up legacy properties
	delete element.fill;
	delete element.strokeColor;
	delete element.brushSettings;
	if ("width" in element) {
		delete (element as Record<string, unknown>).width;
	}
}

export const migAppearanceFilters: Migration = {
	version: 20260221,
	migrate(doc: Document): void {
		for (const element of Object.values(doc.objects)) {
			migrateElement(element as LegacyElement);
		}
	},
};
