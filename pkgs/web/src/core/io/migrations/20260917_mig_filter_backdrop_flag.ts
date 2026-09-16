import {
	type Document,
	type Filter,
	isAppearancePresetRef,
} from "../../schema";
import type { Migration } from "./index";

/** Processors that once carried their own `params.applyToBackdrop`. */
const LEGACY_BACKDROP_PROCESSORS = new Set(["pixelate", "hk:pixel-sort"]);

/**
 * Move the per-filter `params.applyToBackdrop` of pixelate / pixel sort onto
 * the common Appearance.applyToBackdrop flag, so documents that sorted or
 * pixelated the backdrop keep rendering the same.
 */
export const migFilterBackdropFlag: Migration = {
	version: 20260917,
	migrate(doc: Document): void {
		for (const element of Object.values(doc.objects)) {
			for (const entry of element.filters ?? []) {
				if (isAppearancePresetRef(entry)) continue;
				moveBackdropFlag(entry);
			}
		}
		for (const preset of doc.appearancePresets ?? []) {
			for (const filter of preset.filters) moveBackdropFlag(filter);
		}
	},
};

function moveBackdropFlag(filter: Filter): void {
	for (const sub of filter.subFilters ?? []) moveBackdropFlag(sub);
	if (!LEGACY_BACKDROP_PROCESSORS.has(filter.processor)) return;

	const params = filter.paramData.params as { applyToBackdrop?: boolean };
	if (params.applyToBackdrop) filter.applyToBackdrop = true;
	delete params.applyToBackdrop;
}
