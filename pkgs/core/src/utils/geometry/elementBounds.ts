import { createIdentityTransform } from "../../document/factory";
import {
	type AnyArtObject,
	type BlendObject,
	type BoundingBox,
	type CompoundPath,
	type ElementTransform,
	type Group,
	getTransform,
	type ImageObject,
	type MeshArtObject,
	type Reference3DElement,
	type RepeatObject,
	type TextElement,
} from "../../schema";
import { bakeCompoundPathSegments } from "./generate/compoundBake";
import {
	computeRepeatInstances,
	repeatGridRegion,
} from "./generate/repeatInstances";
import {
	calculateMeshCoordinateBounds,
	calculatePathBounds,
} from "./measure/pathBounds";
import {
	brandWorldBBox,
	type LocalBBox,
	type WorldBBox,
} from "./primitives/box";
import { createMeshWarpSampler } from "./reshape/meshWarp";
import {
	applyAffineToPoint,
	composeAffine,
	elementTransformToAffine,
	IDENTITY_AFFINE,
} from "./space/affine";
import { transformBounds } from "./space/coordinates";
import { toWorldPath } from "./space/worldSegments";

export type LocalBoundsCache = Map<string, LocalBBox>;
export type WorldBoundsCache = Map<string, WorldBBox>;

/**
 * Calculate bounding box for a group element. Children are referenced by id,
 * so elementsMap is required to resolve them. A clip group only shows what
 * lies inside its clip path, so its bounds are the clip path's bounds rather
 * than the union of every child.
 */
function calculateGroupBounds(
	group: Group,
	elementsMap?: ReadonlyMap<string, AnyArtObject>,
	localBoundsCache?: LocalBoundsCache,
): BoundingBox {
	// If no elementsMap provided or no children, return empty bounds
	if (!elementsMap || group.childIds.length === 0) {
		return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
	}

	const clipPath = group.clipPathId
		? elementsMap.get(group.clipPathId)
		: undefined;
	if (clipPath) {
		return calculateElementBounds(clipPath, elementsMap, localBoundsCache);
	}

	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;

	for (const childId of group.childIds) {
		const child = elementsMap.get(childId);
		if (!child) continue;

		const childBounds = calculateElementBounds(
			child,
			elementsMap,
			localBoundsCache,
		);
		minX = Math.min(minX, childBounds.minX);
		minY = Math.min(minY, childBounds.minY);
		maxX = Math.max(maxX, childBounds.maxX);
		maxY = Math.max(maxY, childBounds.maxY);
	}

	// Return empty bounds if no valid children found
	if (minX === Number.POSITIVE_INFINITY) {
		return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
	}

	return {
		minX,
		minY,
		maxX,
		maxY,
		width: maxX - minX,
		height: maxY - minY,
	};
}

/**
 * Calculate bounding box for an image element
 */
function calculateImageBounds(
	image: ImageObject | Reference3DElement,
): BoundingBox {
	// Free-transformed image: bounds enclose the warped corner vertices.
	if (image.type === "image" && image.corners) {
		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		for (const [x, y] of image.corners) {
			minX = Math.min(minX, x);
			minY = Math.min(minY, y);
			maxX = Math.max(maxX, x);
			maxY = Math.max(maxY, y);
		}
		return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
	}

	// x, y は中心座標
	const halfWidth = image.width / 2;
	const halfHeight = image.height / 2;

	return {
		minX: image.x - halfWidth,
		minY: image.y - halfHeight,
		maxX: image.x + halfWidth,
		maxY: image.y + halfHeight,
		width: image.width,
		height: image.height,
	};
}

/**
 * Local bounding box of a mesh warp container: the AABB of its cage vertices
 * and handles (every effective edge curve stays inside the convex hull of its
 * control points, so this covers the whole cage boundary), unioned with the
 * warped image of every child's bounds perimeter — the warp extrapolates past
 * the cage, so a child hanging outside it still draws there and must not be
 * culled or framed short.
 */
function calculateMeshBounds(
	mesh: MeshArtObject,
	elementsMap?: ReadonlyMap<string, AnyArtObject>,
	localBoundsCache?: LocalBoundsCache,
): BoundingBox {
	const cage = calculateMeshCoordinateBounds(mesh.vertices);
	if (!elementsMap || mesh.childIds.length === 0) return cage;

	let { minX, minY, maxX, maxY } = cage;
	let warp: ReturnType<typeof createMeshWarpSampler> | null = null;
	for (const childId of mesh.childIds) {
		const child = elementsMap.get(childId);
		if (!child) continue;
		const childBounds = calculateElementBounds(
			child,
			elementsMap,
			localBoundsCache,
		);
		warp ??= createMeshWarpSampler(mesh.vertices, mesh.faces);
		// Corners + edge midpoints: enough of the perimeter to follow the
		// warp's curvature without walking the child's real geometry.
		const xs = [
			childBounds.minX,
			(childBounds.minX + childBounds.maxX) / 2,
			childBounds.maxX,
		];
		const ys = [
			childBounds.minY,
			(childBounds.minY + childBounds.maxY) / 2,
			childBounds.maxY,
		];
		for (const x of xs) {
			for (const y of ys) {
				if (x === xs[1] && y === ys[1]) continue;
				const w = warp({ x, y });
				minX = Math.min(minX, w.x);
				minY = Math.min(minY, w.y);
				maxX = Math.max(maxX, w.x);
				maxY = Math.max(maxY, w.y);
			}
		}
	}
	return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

/**
 * Calculate bounding box for a text element
 */
function calculateTextBounds(
	text: TextElement,
	elementsMap?: ReadonlyMap<string, AnyArtObject>,
	localBoundsCache?: LocalBoundsCache,
): BoundingBox {
	// Path-bound texts render around the axis path, not at the anchor.
	const boundEstimate = calculateBoundTextEstimate(
		text,
		elementsMap,
		localBoundsCache,
	);
	if (boundEstimate) return boundEstimate;

	// TextLayoutEngine.calculateBoundsで正確な値が計算されてSpatialIndexに上書きされる。
	// ここではレイアウト計算前の初期推定値を返す。
	const fontSize = text.defaultStyle.fontSize ?? 16;
	const lineHeightMultiplier =
		text.defaultStyle.lineHeight ??
		text.content.paragraphs[0]?.lineHeight ??
		1.5;
	const paragraphCharCounts = text.content.paragraphs.map((paragraph) =>
		paragraph.runs.reduce((sum, run) => sum + run.text.length, 0),
	);
	const paragraphCount = Math.max(text.content.paragraphs.length, 1);
	const maxCharsInParagraph = Math.max(1, ...paragraphCharCounts);
	const isVertical =
		text.layout.writingMode === "vertical-rl" ||
		text.layout.writingMode === "vertical-lr";

	const estimatedWidth =
		text.layout.boxWidth === "auto"
			? isVertical
				? fontSize * lineHeightMultiplier * paragraphCount
				: fontSize * maxCharsInParagraph
			: text.layout.boxWidth;
	const estimatedHeight =
		text.layout.boxHeight === "auto"
			? isVertical
				? fontSize * maxCharsInParagraph
				: fontSize * lineHeightMultiplier * paragraphCount
			: text.layout.boxHeight;

	// text.y is the first-line baseline position (Y-up).  Text ascends above
	// the baseline by roughly fontSize and descends below.  Use generous
	// padding so that the culling box covers the actual rendered area until
	// TextLayoutEngine replaces this with precise bounds.
	const ascentPad = fontSize;
	const maxY = text.y + ascentPad;
	const minY = text.y - estimatedHeight;

	const totalHeight = estimatedHeight + ascentPad;

	if (text.layout.writingMode === "vertical-rl") {
		// Fixed-width boxes place columns from the box's right edge back toward
		// the anchor at its left edge ([x, x+width]); unconstrained columns
		// start at the anchor and advance left. Cover both directions — this is
		// a transient culling estimate, so over-coverage only means less culling.
		return {
			minX: text.x - estimatedWidth,
			minY,
			maxX: text.x + estimatedWidth,
			maxY,
			width: estimatedWidth * 2,
			height: totalHeight,
		};
	}

	// Adjust X range based on paragraph alignment.
	// text.x is the anchor: left edge for left-align, center for center, right edge for right.
	const alignment = text.content.paragraphs[0]?.alignment ?? "left";
	let minX: number;
	let maxX: number;
	if (alignment === "center") {
		minX = text.x - estimatedWidth / 2;
		maxX = text.x + estimatedWidth / 2;
	} else if (alignment === "right") {
		minX = text.x - estimatedWidth;
		maxX = text.x;
	} else {
		minX = text.x;
		maxX = text.x + estimatedWidth;
	}

	return {
		minX,
		minY,
		maxX,
		maxY,
		width: estimatedWidth,
		height: totalHeight,
	};
}

/**
 * Estimate for a path-bound text (area text / text on path): glyphs are laid
 * out around the axis path, not at the element anchor, so the anchor-based
 * estimate misses them entirely — worst in vertical writing, where the
 * estimate extends left of the anchor while region glyphs sit to its right.
 * Use the axis path's bounds grown by glyph overhang (on-path glyphs straddle
 * the path; ascenders/descenders extend past region edges). Layout builds the
 * text's pre-transform frame by inverse-transforming the path, so the path's
 * own bounds approximate that frame (exact for identity text transforms).
 * Returns null when the text has no binding or the path can't be resolved.
 */
function calculateBoundTextEstimate(
	text: TextElement,
	elementsMap?: ReadonlyMap<string, AnyArtObject>,
	localBoundsCache?: LocalBoundsCache,
): BoundingBox | null {
	const pathId = text.axisBinding?.pathObjectId;
	if (!pathId || !elementsMap) return null;
	const axisPath = elementsMap.get(pathId);
	if (!axisPath) return null;

	const pathBounds = calculateElementBounds(
		axisPath,
		elementsMap,
		localBoundsCache,
	);
	const pad = (text.defaultStyle.fontSize ?? 16) * 2;
	return {
		minX: pathBounds.minX - pad,
		minY: pathBounds.minY - pad,
		maxX: pathBounds.maxX + pad,
		maxY: pathBounds.maxY + pad,
		width: pathBounds.width + pad * 2,
		height: pathBounds.height + pad * 2,
	};
}

/**
 * Bounding box of a compound path: the extent of its boolean result with the
 * compound's own stroke. A result with no face falls back to the union of
 * the sources' bounds, so the element still has somewhere to be.
 */
function calculateCompoundPathBounds(
	compoundPath: CompoundPath,
	elementsMap?: ReadonlyMap<string, AnyArtObject>,
	localBoundsCache?: LocalBoundsCache,
): BoundingBox {
	if (elementsMap) {
		const segments = bakeCompoundPathSegments(
			compoundPath,
			(id) => elementsMap.get(id),
			toWorldPath,
		);
		if (segments.length > 0) {
			return calculatePathBounds({
				type: "path",
				id: compoundPath.id,
				segments,
				filters: compoundPath.filters,
				opacity: compoundPath.opacity,
				blendMode: compoundPath.blendMode,
				transform: createIdentityTransform(),
			});
		}
	}

	if (elementsMap && compoundPath.sources.length > 0) {
		let minX = Number.POSITIVE_INFINITY;
		let minY = Number.POSITIVE_INFINITY;
		let maxX = Number.NEGATIVE_INFINITY;
		let maxY = Number.NEGATIVE_INFINITY;

		for (const { id } of compoundPath.sources) {
			const source = elementsMap.get(id);
			if (source) {
				const b = calculateElementBounds(source, elementsMap, localBoundsCache);
				minX = Math.min(minX, b.minX);
				minY = Math.min(minY, b.minY);
				maxX = Math.max(maxX, b.maxX);
				maxY = Math.max(maxY, b.maxY);
			}
		}

		if (minX !== Number.POSITIVE_INFINITY) {
			return {
				minX,
				minY,
				maxX,
				maxY,
				width: maxX - minX,
				height: maxY - minY,
			};
		}
	}

	return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
}

/**
 * Calculate bounding box for any element
 * @param element - The element to calculate bounds for
 * @param elementsMap - Optional map of all elements (required for Group bounds calculation)
 */
/**
 * Compute bounds in local (untransformed) space.
 * Use this when you need the local geometry bounds without any SRT transform.
 */
export function calculateLocalElementBounds(
	element: AnyArtObject,
	elementsMap?: ReadonlyMap<string, AnyArtObject>,
	localBoundsCache?: LocalBoundsCache,
): LocalBBox {
	// Read-only lookup: cache writes stay in calculateElementBounds, which
	// guards against caching placeholder bounds computed without elementsMap.
	// Text entries carry precise layout bounds that the synchronous
	// calculateTextBounds estimate cannot reproduce.
	const cached = localBoundsCache?.get(element.id);
	if (cached) return cached;

	let result: BoundingBox;
	switch (element.type) {
		case "path":
			result = calculatePathBounds(element);
			break;
		case "group":
			result = calculateGroupBounds(element, elementsMap, localBoundsCache);
			break;
		case "image":
			result = calculateImageBounds(element);
			break;
		case "reference3d":
			// Same center-rect placement model as ImageObject.
			result = calculateImageBounds(element);
			break;
		case "compound-path":
			result = calculateCompoundPathBounds(
				element,
				elementsMap,
				localBoundsCache,
			);
			break;
		case "text":
			result = calculateTextBounds(element, elementsMap, localBoundsCache);
			break;
		case "mesh":
			result = calculateMeshBounds(element, elementsMap, localBoundsCache);
			break;
		case "blend":
			result = calculateBlendBounds(element, elementsMap, localBoundsCache);
			break;
		case "repeat":
			// Local (pre-own-transform) extent: the raw instance placement. The
			// repeat's own transform is applied by calculateElementBounds around the
			// source union center (see calculateRepeatBounds).
			result = calculateRepeatBounds(element, elementsMap, localBoundsCache);
			break;
		default:
			result = { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
	}
	// Brand boundary: sub-functions return plain BoundingBox
	return result as LocalBBox;
}

/**
 * Bounding box for a blend. Without a spine it is the union of the source
 * objects' bounds. With a spine the keys and intermediates are reflowed onto the
 * spine, so it is the spine's extent grown by the largest source's reach — which
 * encloses every spine-placed shape (and avoids importing the spine-placement
 * code here, which would create a cycle with blendInterpolation).
 */
function calculateBlendBounds(
	blend: BlendObject,
	elementsMap?: ReadonlyMap<string, AnyArtObject>,
	localBoundsCache?: LocalBoundsCache,
): BoundingBox {
	const empty = { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
	if (!elementsMap || blend.objectIds.length === 0) return empty;

	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	let maxHalfReach = 0;

	for (const id of blend.objectIds) {
		const source = elementsMap.get(id);
		if (!source) continue;
		const b = calculateElementBounds(source, elementsMap, localBoundsCache);
		minX = Math.min(minX, b.minX);
		minY = Math.min(minY, b.minY);
		maxX = Math.max(maxX, b.maxX);
		maxY = Math.max(maxY, b.maxY);
		maxHalfReach = Math.max(maxHalfReach, Math.hypot(b.width, b.height) / 2);
	}

	if (minX === Number.POSITIVE_INFINITY) return empty;

	const spineSource = blend.spineSourceId
		? elementsMap.get(blend.spineSourceId)
		: undefined;
	if (spineSource) {
		const s = calculateElementBounds(
			spineSource,
			elementsMap,
			localBoundsCache,
		);
		const x0 = s.minX - maxHalfReach;
		const y0 = s.minY - maxHalfReach;
		const x1 = s.maxX + maxHalfReach;
		const y1 = s.maxY + maxHalfReach;
		return {
			minX: x0,
			minY: y0,
			maxX: x1,
			maxY: y1,
			width: x1 - x0,
			height: y1 - y0,
		};
	}

	return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

/**
 * Union of a repeat's source elements' world bounds — the box every instance
 * clones. Returns null when no source resolves (no elementsMap, or dangling ids).
 */
export function calculateRepeatSourceUnion(
	repeat: RepeatObject,
	elementsMap?: ReadonlyMap<string, AnyArtObject>,
	localBoundsCache?: LocalBoundsCache,
): BoundingBox | null {
	if (!elementsMap) return null;

	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (const id of repeat.sourceIds) {
		const source = elementsMap.get(id);
		if (!source) continue;
		const b = calculateElementBounds(source, elementsMap, localBoundsCache);
		minX = Math.min(minX, b.minX);
		minY = Math.min(minY, b.minY);
		maxX = Math.max(maxX, b.maxX);
		maxY = Math.max(maxY, b.maxY);
	}

	if (minX === Number.POSITIVE_INFINITY) return null;
	return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

/**
 * Bounding box of a repeat: the union of every instance's placement of the
 * source union. `placement` — the repeat's own transform, composed with any
 * group ancestors' — is baked into each instance; omitted, the raw instance
 * placement is returned (local, pre-own-transform bounds).
 */
function calculateRepeatBounds(
	repeat: RepeatObject,
	elementsMap?: ReadonlyMap<string, AnyArtObject>,
	localBoundsCache?: LocalBoundsCache,
	placement?: ElementTransform,
): BoundingBox {
	const empty = { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
	const sourceUnion = calculateRepeatSourceUnion(
		repeat,
		elementsMap,
		localBoundsCache,
	);
	if (!sourceUnion) return empty;

	const center = {
		x: (sourceUnion.minX + sourceUnion.maxX) / 2,
		y: (sourceUnion.minY + sourceUnion.maxY) / 2,
	};
	const outer = placement
		? elementTransformToAffine(placement)
		: IDENTITY_AFFINE;
	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	const accumulate = (p: { x: number; y: number }) => {
		minX = Math.min(minX, p.x);
		minY = Math.min(minY, p.y);
		maxX = Math.max(maxX, p.x);
		maxY = Math.max(maxY, p.y);
	};

	if (repeat.mode === "grid") {
		// Grid copies are clipped to the fill region, so the visible extent is the
		// region rectangle (not the union of every placed tile).
		const region = repeatGridRegion(repeat, sourceUnion);
		for (const corner of [
			{ x: region.minX, y: region.minY },
			{ x: region.maxX, y: region.minY },
			{ x: region.maxX, y: region.maxY },
			{ x: region.minX, y: region.maxY },
		]) {
			accumulate(applyAffineToPoint(outer, corner));
		}
		return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
	}

	const corners = [
		{ x: sourceUnion.minX, y: sourceUnion.minY },
		{ x: sourceUnion.maxX, y: sourceUnion.minY },
		{ x: sourceUnion.maxX, y: sourceUnion.maxY },
		{ x: sourceUnion.minX, y: sourceUnion.maxY },
	];
	for (const instance of computeRepeatInstances(repeat, center)) {
		const full = composeAffine(outer, instance);
		for (const corner of corners) {
			accumulate(applyAffineToPoint(full, corner));
		}
	}
	return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

export function calculateElementBounds(
	element: AnyArtObject,
	elementsMap?: ReadonlyMap<string, AnyArtObject>,
	localBoundsCache?: LocalBoundsCache,
): WorldBBox {
	return calculatePlacedBounds(
		element,
		getTransform(element),
		elementsMap,
		localBoundsCache,
	);
}

/**
 * Bounds of an element drawn with `placement`: its own transform composed
 * with its ancestor groups' transforms, in the space the outermost of them
 * maps into.
 */
export function calculatePlacedBounds(
	element: AnyArtObject,
	placement: ElementTransform,
	elementsMap?: ReadonlyMap<string, AnyArtObject>,
	localBoundsCache?: LocalBoundsCache,
): WorldBBox {
	// A repeat bakes its own transform into every instance, so the world
	// bounds cannot be reproduced from its local box — compute directly.
	if (element.type === "repeat") {
		return brandWorldBBox(
			calculateRepeatBounds(element, elementsMap, localBoundsCache, placement),
		);
	}

	let localBounds = localBoundsCache?.get(element.id);
	if (!localBounds) {
		localBounds = calculateLocalElementBounds(
			element,
			elementsMap,
			localBoundsCache,
		);
		// Don't cache placeholder bounds for group/compound-path when elementsMap
		// is absent — child elements can't be resolved, so the result is an empty
		// box that would poison the cache for later calls with a real elementsMap.
		const canCache =
			elementsMap != null ||
			(element.type !== "group" &&
				element.type !== "compound-path" &&
				element.type !== "blend");
		if (canCache) {
			localBoundsCache?.set(element.id, localBounds);
		}
	}

	return brandWorldBBox(transformBounds(localBounds, placement));
}
