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

/**
 * Route memoization keyed on the stored settings object. Document updates
 * are immutable (a changed brush is a new object), so identity implies
 * content — without this, every stroke re-normalizes on every frame and the
 * routed settings never stay referentially stable for downstream caches.
 */
const routeCache = new WeakMap<object, BrushRenderRoute>();

export function resolveBrushRenderRoute(raw: unknown): BrushRenderRoute {
	const cacheable = typeof raw === "object" && raw !== null;
	if (cacheable) {
		const hit = routeCache.get(raw);
		if (hit) return hit;
	}
	const settings = normalizeBrushSettingsV2(raw);
	let route: BrushRenderRoute;
	if (settings.engine === "geometric") {
		route = { kind: "geometric", settings };
	} else if (settings.engine === "ribbon") {
		route = { kind: "ribbon-legacy", settings };
	} else if (settings.wetV1?.enabled === true) {
		route = { kind: "dab-legacy", settings };
	} else {
		route = { kind: "dab-v2", settings };
	}
	if (cacheable) routeCache.set(raw as object, route);
	return route;
}

/** Legacy v1 view for the routes that still render through v1 code. */
export function legacyViewOf(route: BrushRenderRoute) {
	return toLegacyBrushSettings(route.settings);
}
