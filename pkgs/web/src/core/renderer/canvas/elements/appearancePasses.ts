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
import { calculateSegmentListBounds } from "../../../utils/geometry/bounds";
import type { Affine2D } from "../../../utils/geometry/repeatInterpolation";
import type { Brand } from "../../../utils/lang";
import {
	appearancePaintsPattern,
	type FilterRenderer,
	isElementRenderReplaced,
	isGeometryFilter,
} from "../pipeline/FilterRenderer";
import {
	applyPreFiltersToGeometry,
	resolveAppearanceGeometries,
} from "../pipeline/PreFilterRenderer";

declare const DrawableSegmentsBrand: unique symbol;

/**
 * Segments in their final drawing shape: corner radius resolved, element-level
 * pre-filters applied, and the owning appearance's own preProcess sub-filters
 * applied on top.
 */
export type DrawableSegments = CubicBezierSegment[] &
	Brand<typeof DrawableSegmentsBrand>;

/** Where a pattern paint's tile grid sits on the geometry it fills. */
export interface PatternPlacement {
	/** Tile-grid origin: the flat outline's top-left, in local coordinates. */
	anchor: [number, number];
	/** Sampling affine of a copy placed by a geometry filter (the inverse of
	 *  its placement), so the pattern follows the copy. */
	transform?: Affine2D;
}

/** One appearance and the geometry it draws. */
export interface ResolvedAppearancePass {
	appearance: FillAppearance | StrokeAppearance;
	segments: DrawableSegments;
	/** Outline/strip cache key, distinct per deformation variant. */
	cacheKey: string;
	/** Set when the appearance paints a pattern. */
	pattern?: PatternPlacement;
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

	// Pattern paints anchor their tile grid to the flat outline.
	const patternAnchor = appearances.some(appearancePaintsPattern)
		? flatOutlineAnchor(path.segments)
		: null;
	const geometries = resolveAppearanceGeometries(
		appearances,
		path.segments,
		localAppearances(path.filters),
		filterRenderer,
	);

	return appearances.flatMap((appearance, i): ResolvedAppearancePass[] => {
		const preSubFilters = collectPreSubFilters(appearance, filterRenderer);
		const subKey =
			preSubFilters.length === 0
				? ""
				: `:${appearance.uid}:${preSubFilters.map((sf) => sf.uid).join(",")}`;
		// The appearance's own sub-filters run on each of its geometries with
		// the appearance attached, so they can split or rewrite it as well.
		const own = geometries[i].flatMap((geometry) =>
			applyPreFiltersToGeometry(
				{ ...geometry, appearance: geometry.appearance ?? appearance },
				preSubFilters,
				filterRenderer,
			),
		);
		return own.map((geometry, k) => ({
			appearance: geometry.appearance!,
			segments: geometry.segments as DrawableSegments,
			cacheKey: `${baseCacheKey}${subKey}${own.length > 1 ? `:copy${k}` : ""}`,
			...(patternAnchor && appearancePaintsPattern(appearance)
				? {
						pattern: {
							anchor: patternAnchor,
							...(geometry.patternTransform
								? { transform: geometry.patternTransform }
								: {}),
						},
					}
				: {}),
		}));
	});
}

// --- Helpers ---

/** Top-left of the flat outline, the tile-grid origin every pass shares. */
function flatOutlineAnchor(segments: CubicBezierSegment[]): [number, number] {
	const bounds = calculateSegmentListBounds(segments);
	return bounds ? [bounds.minX, bounds.maxY] : [0, 0];
}

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
 * the lower fill's color at partially covered edge pixels (the α(1−α) term),
 * which dominates when zoomed out. A later fully-opaque solid fill (appearance
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
