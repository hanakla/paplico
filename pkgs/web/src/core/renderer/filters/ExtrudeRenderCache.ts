import {
	type AnyArtObject,
	type BlendObject,
	type FillAppearance,
	type Filter,
	type Group,
	hasGroupAppearances,
	isFilterEnabled,
	type Solid3DBaseParams,
	type StrokeAppearance,
	type TextElement,
} from "../../schema";

/**
 * Callback bundle a render-cache fingerprint needs to fold in descendant
 * content that FilterGeometryContext's other fields don't already cover:
 * pattern-def revisions, glyph-outline/image async-load readiness, and
 * whether a group's own filter has a preProcess handler (path-union,
 * path-offset, …). The last one mirrors collectGroupExtrudeOutline's
 * shouldUseCombinedGroupShape predicate exactly (same filterRenderer lookup)
 * so the hash's "combined vs plain" branch never diverges from what the
 * outline/albedo actually render.
 */
export interface PaintHashContext {
	resolvePatternTexture: (defId: string) => { revision: number } | null;
	resolveTextOutline: (element: TextElement) => unknown | null;
	isImageReady: (fileUid: string) => boolean;
	hasPreProcessHandler: (processor: string) => boolean;
}

/**
 * rotation/perspective/material/pattern-revision/zoom — no recursion, cheap.
 * Deliberately excludes the mesh-shaping params (depth/bevel, angle/offset —
 * already covered by the mesh hash) and the element's own 2D ElementTransform
 * (moving/scaling an element must never invalidate its bake, same reasoning
 * the mesh hash documents for excluding rotation/transform from ITS key).
 */
export function hashRenderParams(
	params: Solid3DBaseParams,
	zoom: number,
	patternRevision: number | null,
): string {
	return [
		params.rotationDeg.join(","),
		params.perspective,
		zoom,
		JSON.stringify(params.material),
		patternRevision ?? "",
	].join("|");
}

/**
 * Non-recursive paint-content hash for a single element's own fill/stroke
 * appearances — the exact "flatApps" selection ExtrudeMeshBaker.bakeAppearance
 * already uses for its path/text/compound-path albedo branches (fill/stroke
 * filters with enabled !== false). Used directly for path/text/compound-path/
 * image leaves, and for a "compound object" group's own combined appearances.
 */
export function hashLeafPaintContent(
	filters: readonly Filter[] | undefined,
	resolvePatternTexture: PaintHashContext["resolvePatternTexture"],
): string {
	const parts: string[] = [];
	for (const f of filters ?? []) {
		if (
			(f.processor !== "fill" && f.processor !== "stroke") ||
			!isFilterEnabled(f)
		) {
			continue;
		}
		parts.push(
			f.processor,
			String(f.opacity),
			f.blendMode,
			JSON.stringify(f.paramData.params),
		);
		const defId = patternDefIdOfFilter(f);
		if (defId) parts.push(String(resolvePatternTexture(defId)?.revision ?? 0));
		if (f.subFilters?.length) parts.push(JSON.stringify(f.subFilters));
	}
	return parts.join("|");
}

/** blend: each key hashed recursively (a key can itself be any element type,
 *  including a nested group). */
export function hashBlendPaintContent(
	blend: BlendObject,
	elementsMap: Map<string, AnyArtObject>,
	ctx: PaintHashContext,
): string {
	const parts: string[] = [];
	for (const id of blend.objectIds) {
		const key = elementsMap.get(id);
		parts.push(key ? computePaintHash(key, elementsMap, ctx) : "missing");
	}
	return parts.join(";");
}

/**
 * Recursive paint-content hash for a group. Mirrors
 * collectGroupExtrudeOutline's shouldUseCombinedGroupShape branch
 * (ExtrudeAppearanceRenderer.ts) exactly:
 *  - a group with its own enabled fill/stroke (hasGroupAppearances) or a
 *    pre-filter with a real preProcess handler (path-union/offset, …) paints
 *    a COMBINED shape from its OWN appearances — children's individual paint
 *    doesn't matter, so only the group's own filters are hashed;
 *  - a plain group paints each child's own flat look, so childIds are
 *    walked and each child recursively hashed by type (path/compound-path/
 *    image → hashLeafPaintContent; text/image additionally fold async
 *    readiness; blend/nested-group recurse).
 *  - group.clipPathId is folded in as a bare id string.
 *    Known limitation: this catches a clip *assignment* change but not an
 *    edit to the referenced clip element's own geometry under the same id —
 *    accepted (low probability, low blast radius: some other change to the
 *    scene typically invalidates the cache regardless).
 */
export function hashGroupPaintContent(
	group: Group,
	elementsMap: Map<string, AnyArtObject>,
	ctx: PaintHashContext,
): string {
	const ownFilters = group.filters ?? [];
	const hasPreFilter = ownFilters.some(
		(f) => f.enabled !== false && ctx.hasPreProcessHandler(f.processor),
	);
	if (hasGroupAppearances(group) || hasPreFilter) {
		return `combined:${hashLeafPaintContent(ownFilters, ctx.resolvePatternTexture)}:${group.clipPathId ?? ""}`;
	}
	const parts: string[] = [group.clipPathId ?? ""];
	for (const id of group.childIds) {
		if (id === group.clipPathId) continue;
		const child = elementsMap.get(id);
		parts.push(child ? computePaintHash(child, elementsMap, ctx) : "missing");
	}
	return `plain:${parts.join(";")}`;
}

/**
 * Dispatches on element type to the right paint-content hash. Every branch
 * returns a real string — there is no element type for which caching must
 * be disabled, since blend/group both recurse into this same function for
 * their children/keys.
 */
export function computePaintHash(
	element: AnyArtObject,
	elementsMap: Map<string, AnyArtObject>,
	ctx: PaintHashContext,
): string {
	switch (element.type) {
		case "group":
			return hashGroupPaintContent(element, elementsMap, ctx);
		case "blend":
			return hashBlendPaintContent(element, elementsMap, ctx);
		case "text":
			return `${hashLeafPaintContent(element.filters, ctx.resolvePatternTexture)}:${ctx.resolveTextOutline(element) !== null}`;
		case "image":
			return `${element.fileUid}:${ctx.isImageReady(element.fileUid)}`;
		case "repeat":
			// Repeat is not extruded in v1 and contributes no paint of its own to
			// an extruded ancestor, so its hash never needs to vary.
			return "repeat";
		default:
			// path / compound-path / mesh / reference3d: own fill/stroke filters only.
			return hashLeafPaintContent(element.filters, ctx.resolvePatternTexture);
	}
}

function patternDefIdOfFilter(filter: Filter): string | null {
	if (filter.processor === "fill") {
		const fill = (filter as FillAppearance).paramData.params.fill;
		return fill?.type === "pattern" && fill.defId ? fill.defId : null;
	}
	if (filter.processor === "stroke") {
		const strokeColor = (filter as StrokeAppearance).paramData.params
			.strokeColor;
		return strokeColor?.type === "stroke-pattern" && strokeColor.pattern.defId
			? strokeColor.pattern.defId
			: null;
	}
	return null;
}
