import { localAppearances } from "../../document/appearancePresets";
import {
	type ColorStop,
	type Document,
	type FillAppearance,
	isLinearGradient,
	isRadialGradient,
	type StrokeAppearance,
} from "../../schema";
import type { Migration } from "./index";

/** Pre-midpoint persisted shape of ColorStop. */
type LegacyColorStop = Omit<ColorStop, "midpoint"> & { midpoint?: number };

function setMidpoints(stops: LegacyColorStop[]): void {
	for (const stop of stops) stop.midpoint ??= 0.5;
}

export const migGradientStopMidpoint: Migration = {
	version: 20260722,
	migrate(doc: Document): void {
		for (const element of Object.values(doc.objects)) {
			if (!element.filters) continue;

			for (const filter of localAppearances(element.filters)) {
				if (filter.processor === "fill") {
					const fill = (filter as FillAppearance).paramData.params.fill;
					if (isLinearGradient(fill) || isRadialGradient(fill)) {
						setMidpoints(fill.stops);
					}
				} else if (filter.processor === "stroke") {
					const strokeColor = (filter as StrokeAppearance).paramData.params
						.strokeColor;
					if (strokeColor.type === "stroke-gradient") {
						setMidpoints(strokeColor.gradient.stops);
					}
				}
			}
		}
	},
};
