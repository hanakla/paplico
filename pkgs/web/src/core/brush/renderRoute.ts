import type { BrushSettingsV2 } from "../schema";
import { normalizeBrushSettingsV2 } from "./migrate";
import { toLegacyBrushSettings } from "./toLegacy";

/**
 * Single routing decision for stroke rendering during the v2 transition
 * (design §13-7): every consumer asks this once per stroke instead of
 * probing settings shapes ad hoc.
 *
 * - "dab-v2": the new dab pipeline consumes BrushSettingsV2 directly.
 * - "dab-legacy": wetV1 is present — the legacy WetInkPass path stays the
 *   authority until the wet switchover, consuming the down-converted view.
 * - "ribbon-legacy" / "geometric": engines that keep their v1 renderers
 *   until their own integration phases.
 */
export type BrushRenderRoute =
	| { kind: "dab-v2"; settings: BrushSettingsV2 }
	| { kind: "dab-legacy"; settings: BrushSettingsV2 }
	| { kind: "ribbon-legacy"; settings: BrushSettingsV2 }
	| { kind: "geometric"; settings: BrushSettingsV2 };

export function resolveBrushRenderRoute(raw: unknown): BrushRenderRoute {
	const settings = normalizeBrushSettingsV2(raw);
	if (settings.engine === "geometric") return { kind: "geometric", settings };
	if (settings.engine === "ribbon") return { kind: "ribbon-legacy", settings };
	if (settings.wetV1?.enabled === true) {
		return { kind: "dab-legacy", settings };
	}
	return { kind: "dab-v2", settings };
}

/** Legacy v1 view for the routes that still render through v1 code. */
export function legacyViewOf(route: BrushRenderRoute) {
	return toLegacyBrushSettings(route.settings);
}
