/**
 * The single place that turns a Path's `filters` array into the geometry each
 * appearance actually draws.
 *
 * Every drawing path (the inline element loop, the stamp-brush batching fast
 * path, wet-ink interleaving, per-appearance offscreen plans, group
 * appearances) reads this from one place, so a rule — per-appearance
 * sub-filter deformation, occlusion dropping — cannot apply to one path and
 * silently miss the others. `DrawableSegments` is the contract that keeps them together:
 * only this module produces it, and the GPU primitives only accept it.
 */

import { localAppearances } from "../../../document/appearancePresets";
import {
	type CubicBezierSegment,
	colorToRawRGBA,
	type FillAppearance,
	type FillColor,
	type Filter,
	isFilterEnabled,
	type Path,
	type StrokeAppearance,
} from "../../../schema";
import type { Brand } from "../../../utils/lang";
import {
	type FilterRenderer,
	isElementRenderReplaced,
	isGeometryFilter,
} from "../pipeline/FilterRenderer";
import {
	applyPreFilters,
	resolveElementGeometry,
} from "../pipeline/PreFilterRenderer";

declare const DrawableSegmentsBrand: unique symbol;

/**
 * Segments in their final drawing shape: corner radius resolved, element-level
 * pre-filters applied, and the owning appearance's own preProcess sub-filters
 * applied on top.
 */
export type DrawableSegments = CubicBezierSegment[] &
	Brand<typeof DrawableSegmentsBrand>;

/** One appearance and the geometry it draws. */
export interface ResolvedAppearancePass {
	appearance: FillAppearance | StrokeAppearance;
	segments: DrawableSegments;
	/** Geometry/stencil cache key, distinct per deformation variant. */
	cacheKey: string;
}

type DrawableAppearance = FillAppearance | StrokeAppearance;

/**
 * The appearances this path actually draws, in paint order. Use for routing
 * decisions that only inspect the appearance set (e.g. "are all strokes
 * batchable?"); anything that draws must go through `resolveAppearancePasses`
 * so it gets the deformed geometry too.
 */
export function collectDrawableAppearances(
	path: Path,
	filterRenderer: Pick<FilterRenderer, "getHandler">,
): DrawableAppearance[] {
	// A render-replacing appearance (e.g. extrude3d) draws the element itself
	// through the filter system, so the flat geometry pass draws nothing.
	if (isElementRenderReplaced(path, filterRenderer)) return [];

	return dropOccludedFills(
		localAppearances(path.filters).filter(
			(f) =>
				(f.processor === "fill" || f.processor === "stroke") &&
				isFilterEnabled(f),
		),
		filterRenderer,
	) as DrawableAppearance[];
}

/**
 * Resolve every drawable appearance of `path` to the geometry it draws.
 * Returns an empty array when the element renders nothing flat.
 */
export function resolveAppearancePasses(
	path: Path,
	filterRenderer: Pick<FilterRenderer, "getHandler">,
): ResolvedAppearancePass[] {
	if (path.segments.length === 0) return [];

	const appearances = collectDrawableAppearances(path, filterRenderer);
	if (appearances.length === 0) return [];

	const baseSegments = resolveElementGeometry(
		path.segments,
		localAppearances(path.filters),
		filterRenderer,
	);

	// The base cache key carries the active pre-filter uids: the same element
	// is also drawn as virtual elements (per-appearance offscreen plans, group
	// appearances) whose pre-filter set differs, and those variants must not
	// collide in the geometry cache.
	const preFilterUids = localAppearances(path.filters)
		.filter(
			(f) =>
				f.processor !== "fill" &&
				f.processor !== "stroke" &&
				isFilterEnabled(f) &&
				!filterRenderer.getHandler(f.processor)?.replacesElementRender?.(f),
		)
		.map((f) => f.uid);
	const baseCacheKey =
		preFilterUids.length > 0
			? `${path.id}:${preFilterUids.join(",")}`
			: path.id;

	return appearances.map((appearance) => {
		const preSubFilters = collectPreSubFilters(appearance, filterRenderer);
		if (preSubFilters.length === 0) {
			return {
				appearance,
				segments: baseSegments as DrawableSegments,
				cacheKey: baseCacheKey,
			};
		}
		return {
			appearance,
			segments: applyPreFilters(
				baseSegments,
				preSubFilters,
				filterRenderer,
			) as DrawableSegments,
			cacheKey: `${baseCacheKey}:${appearance.uid}:${preSubFilters
				.map((sf) => sf.uid)
				.join(",")}`,
		};
	});
}

// --- Helpers ---

/** An appearance's enabled geometry-deforming sub-filters, in order. */
function collectPreSubFilters(
	appearance: Filter,
	filterRenderer: Pick<FilterRenderer, "getHandler">,
): Filter[] {
	return (appearance.subFilters ?? []).filter((sf) =>
		isGeometryFilter(sf, filterRenderer),
	);
}

/**
 * Coverage blending is not occlusion: painting the same geometry twice leaks
 * the lower fill's color at AA-fringe pixels (the α(1−α) term), which
 * dominates when zoomed out. A later fully-opaque solid fill (appearance
 * opacity 1, normal blend, alpha-1 color) hides every earlier fill entirely,
 * so drop them instead of painting-then-overpainting. Strokes straddle the
 * outline and are kept.
 */
function dropOccludedFills(
	apps: Filter[],
	filterRenderer: Pick<FilterRenderer, "getHandler">,
): Filter[] {
	// A fill with an enabled preProcess sub-filter draws deformed geometry, so
	// it neither covers the flat outline nor is covered by it — exempt it on
	// both sides. Post-process-only sub-filters (blur, drop-shadow) leave the
	// fill's own coverage intact, so those still occlude normally.
	const isDeformed = (app: Filter) =>
		collectPreSubFilters(app, filterRenderer).length > 0;

	let lastOpaqueFill = -1;
	for (const [i, app] of apps.entries()) {
		if (app.processor !== "fill") continue;
		if (app.opacity !== 1 || app.blendMode !== "normal") continue;
		if (isDeformed(app)) continue;
		const fill: FillColor | undefined = (app as FillAppearance).paramData.params
			.fill;
		if (fill?.type !== "solid") continue;
		if (colorToRawRGBA(fill.color).a !== 1) continue;
		lastOpaqueFill = i;
	}
	if (lastOpaqueFill <= 0) return apps;
	return apps.filter(
		(app, i) =>
			app.processor !== "fill" || i >= lastOpaqueFill || isDeformed(app),
	);
}
