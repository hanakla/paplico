import { localAppearances } from "../../document/appearancePresets";
import type { BrushSettings, Document, StrokeAppearance } from "../../schema";
import type { Migration } from "./index";

/**
 * Frozen default brush settings as of schema version 20260224. Emits the pre-v2
 * shape on purpose: this migration runs before the brush-v2 one, which is what
 * converts the whole document to BrushSettings.
 */
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
 * Migrate legacy width field and backfill missing brushSettings.
 *
 * PR #139 unified brush sizing into brushSettings.size, removing the
 * standalone width field from ToolSettings. Documents may still carry:
 *   - A legacy element.width property not cleaned up by the 20260221 migration
 *     (elements without strokeColor were skipped by that migration)
 *   - StrokeAppearance entries without brushSettings (written when brushEnabled
 *     was false and updateSelectedElementsBrushSettings passed undefined)
 *
 * For each element:
 *   1. If element.width exists, set StrokeAppearance brushSettings.size from it,
 *      then delete the width field.
 *   2. If StrokeAppearance.brushSettings is missing, populate with a 1px line
 *      brush (or element.width if present).
 */
export const migBrushSettings: Migration = {
	version: 20260224,
	migrate(doc: Document): void {
		for (const element of Object.values(doc.objects)) {
			const rec = element as unknown as Record<string, unknown>;
			const legacyWidth =
				"width" in rec && typeof rec.width === "number"
					? (rec.width as number)
					: undefined;

			let widthApplied = false;

			if (element.filters) {
				for (const filter of localAppearances(element.filters)) {
					if (filter.processor !== "stroke") continue;
					const stroke = filter as StrokeAppearance;

					if (stroke.paramData.params.brushSettings == null) {
						stroke.paramData.params.brushSettings = createDefaultLineBrush(
							legacyWidth ?? 1,
						);
					}
					widthApplied = true;
				}
			}

			// Only delete width once it has been absorbed into a StrokeAppearance.
			// If no StrokeAppearance exists (e.g. fill-only element), keep it so
			// a future migration or manual fix can still reference the value.
			if (legacyWidth !== undefined && widthApplied) {
				delete rec.width;
			}
		}
	},
};
