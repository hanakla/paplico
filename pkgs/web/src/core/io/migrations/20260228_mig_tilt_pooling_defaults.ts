import type {
	CubicBezierSegment,
	Document,
	StrokeAppearance,
} from "../../schema";
import type { Migration } from "./index";

// Legacy flat brush-settings defaults backfilled by this migration version.
const BRUSH_DEFAULTS: Record<string, number> = {
	rotationByTilt: 0,
	aspectRatioByTilt: 0,
	sizeBySpeed: 0,
	pooling: 0,
	poolingSizeRatio: 0.5,
};

const SEGMENT_DEFAULTS: Pick<
	CubicBezierSegment,
	| "startTiltX"
	| "startTiltY"
	| "endTiltX"
	| "endTiltY"
	| "startDeltaTime"
	| "endDeltaTime"
> = {
	startTiltX: 0,
	startTiltY: 0,
	endTiltX: 0,
	endTiltY: 0,
	startDeltaTime: 0,
	endDeltaTime: 0,
};

/**
 * Backfill tilt/deltaTime/pooling/speed fields with defaults.
 *
 * Documents created before this migration may lack:
 *   - CubicBezierSegment tilt/deltaTime fields (added in brush-tilt-pooling)
 *   - V1BrushSettings rotationByTilt/aspectRatioByTilt/sizeBySpeed/pooling/poolingSizeRatio
 *
 * This migration fills them with zero-defaults so the fields are always present.
 */
export const migTiltPoolingDefaults: Migration = {
	version: 20260228,
	migrate(doc: Document): void {
		for (const element of Object.values(doc.objects)) {
			// Backfill segment tilt/deltaTime
			const rec = element as unknown as Record<string, unknown>;
			if (Array.isArray(rec.segments)) {
				for (const seg of rec.segments as Record<string, unknown>[]) {
					for (const [key, val] of Object.entries(SEGMENT_DEFAULTS)) {
						seg[key] ??= val;
					}
				}
			}

			// Backfill brush settings in StrokeAppearance filters
			if (element.filters) {
				for (const filter of element.filters) {
					if (filter.processor !== "stroke") continue;
					const stroke = filter as StrokeAppearance;
					const bs = stroke.paramData.params.brushSettings;
					if (bs == null) continue;
					// v2 settings carry no flat fields; backfilling would inject
					// v1 keys into them (papf runs every migration on each load).
					if ((bs as unknown as Record<string, unknown>).version === 2)
						continue;

					for (const [key, val] of Object.entries(BRUSH_DEFAULTS)) {
						(bs as unknown as Record<string, unknown>)[key] ??= val;
					}
				}
			}
		}

		// Backfill brush presets (legacy presets stored flat `defaultSettings`).
		for (const preset of doc.brushPresets) {
			const ds = (preset as unknown as { defaultSettings?: unknown })
				.defaultSettings as Record<string, unknown> | undefined;
			if (ds == null || typeof ds !== "object") continue;
			for (const [key, val] of Object.entries(BRUSH_DEFAULTS)) {
				ds[key] ??= val;
			}
		}
	},
};
