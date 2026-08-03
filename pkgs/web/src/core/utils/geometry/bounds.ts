import { readStoredBrushSize, readStoredWetInk } from "../../brush/access";
import {
	type AnyArtObject,
	type BezierPoint,
	type BlendObject,
	type BoundingBox,
	type CompoundPath,
	type CubicBezierSegment,
	type Group,
	getTransform,
	type ImageObject,
	isIdentityTransform,
	type MeshArtObject,
	type MeshGeometryVertex,
	type Path,
	type Reference3DElement,
	type RepeatObject,
	type StrokeAppearance,
	type TextElement,
} from "../../schema";
import { getStrokeWidth } from "../elementQuery";
import type { Brand } from "../lang";
import { applyTransformToBounds } from "./geometry";
// Cycle note: meshWarp.ts imports helpers from this module too. Both sides
// only call across at function-call time (no module-evaluation use), which
// ESM resolves fine.
import { createMeshWarpSampler } from "./meshWarp";
import {
	applyAffineToPoint,
	composeAffine,
	computeRepeatInstances,
	elementTransformToAffine,
	IDENTITY_AFFINE,
	repeatGridRegion,
} from "./repeatInterpolation";
import { resolveSegment } from "./segmentOps";

declare const LocalBBoxBrand: unique symbol;
/** Bounding box in local (untransformed) space — element's own SRT not applied. */
export type LocalBBox = BoundingBox & Brand<typeof LocalBBoxBrand>;
export type LocalBoundsCache = Map<string, LocalBBox>;

declare const WorldBBoxBrand: unique symbol;
/** Bounding box in world space — element's own SRT transform applied. */
export type WorldBBox = BoundingBox & Brand<typeof WorldBBoxBrand>;
export type WorldBoundsCache = Map<string, WorldBBox>;
export function brandLocalBBox(bounds: BoundingBox): LocalBBox {
	return bounds as LocalBBox;
}

/** Brand boundary: mark a BoundingBox as world-space. Only call when the bounds are known to be in world space. */
export function brandWorldBBox(bounds: BoundingBox): WorldBBox {
	return bounds as WorldBBox;
}

/**
 * Anchor/control-point bounding box of a raw segment list (no stroke margin).
 * Returns null for an empty list.
 */
export function calculateSegmentListBounds(
	segments: CubicBezierSegment[],
): BoundingBox | null {
	if (segments.length === 0) return null;

	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;

	let prevEnd: BezierPoint | undefined;
	for (const segment of segments) {
		const start = segment.start ?? prevEnd!;
		const cp1x = start.x + segment.cp1.x;
		const cp1y = start.y + segment.cp1.y;
		const cp2x = segment.end.x + segment.cp2.x;
		const cp2y = segment.end.y + segment.cp2.y;
		const endX = segment.end.x;
		const endY = segment.end.y;

		// Individual comparisons instead of variadic Math.min/max
		if (start.x < minX) minX = start.x;
		if (cp1x < minX) minX = cp1x;
		if (cp2x < minX) minX = cp2x;
		if (endX < minX) minX = endX;

		if (start.y < minY) minY = start.y;
		if (cp1y < minY) minY = cp1y;
		if (cp2y < minY) minY = cp2y;
		if (endY < minY) minY = endY;

		if (start.x > maxX) maxX = start.x;
		if (cp1x > maxX) maxX = cp1x;
		if (cp2x > maxX) maxX = cp2x;
		if (endX > maxX) maxX = endX;

		if (start.y > maxY) maxY = start.y;
		if (cp1y > maxY) maxY = cp1y;
		if (cp2y > maxY) maxY = cp2y;
		if (endY > maxY) maxY = endY;

		prevEnd = segment.end;
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
 * Calculate bounding box for a path element
 */
export function calculatePathBounds(path: Path): LocalBBox {
	const base = calculateSegmentListBounds(path.segments);
	if (!base) {
		return brandLocalBBox({
			minX: 0,
			minY: 0,
			maxX: 0,
			maxY: 0,
			width: 0,
			height: 0,
		});
	}
	let { minX, minY, maxX, maxY } = base;

	// Inline getStrokeWidth to avoid closure allocation in hot path.
	// Wet-ink extends the bound by `bleedWidth × size` so the wet-edge
	// halo and diffusion region are not culled by the viewport / cache.
	let halfWidth = 0;
	let wetExtra = 0;
	if (path.filters) {
		for (const f of path.filters) {
			if (f.processor === "stroke" && f.enabled !== false) {
				const brush = (f as StrokeAppearance).paramData.params.brushSettings;
				const size = readStoredBrushSize(brush) ?? 0;
				halfWidth = size / 2;
				const wet = readStoredWetInk(brush);
				if (wet?.enabled) {
					wetExtra = size * wet.bleedWidth;
				}
				break;
			}
		}
	}
	const margin = halfWidth + wetExtra;
	minX -= margin;
	minY -= margin;
	maxX += margin;
	maxY += margin;

	return brandLocalBBox({
		minX,
		minY,
		maxX,
		maxY,
		width: maxX - minX,
		height: maxY - minY,
	});
}

/**
 * Calculate bounding box for a group element
 * Note: フラット構造では子要素はchildIdsで参照されるため、
 * elementsMapを渡して子のboundsを計算する必要がある
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

/** AABB over mesh vertices + their bezier handles. */
export function calculateMeshCoordinateBounds(
	vertices: readonly MeshGeometryVertex[],
): BoundingBox {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	const include = (point: { x: number; y: number }) => {
		minX = Math.min(minX, point.x);
		minY = Math.min(minY, point.y);
		maxX = Math.max(maxX, point.x);
		maxY = Math.max(maxY, point.y);
	};

	for (const vertex of vertices) {
		include(vertex);
		for (const handle of Object.values(vertex.handles)) include(handle);
	}

	if (!Number.isFinite(minX)) {
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
 * Calculate bounding box for a compound path element
 */
function calculateCompoundPathBounds(
	compoundPath: CompoundPath,
	elementsMap?: ReadonlyMap<string, AnyArtObject>,
	localBoundsCache?: LocalBoundsCache,
): BoundingBox {
	// ソースパスのboundsを合成
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

	// フォールバック: 空bounds
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
 * source union. With `includeOwnTransform` the repeat's own transform — pivoted
 * around the source union center to match the render/hit-test — is baked into
 * each instance (world bounds); without it the raw instance placement is
 * returned (local, pre-own-transform bounds).
 */
function calculateRepeatBounds(
	repeat: RepeatObject,
	elementsMap?: ReadonlyMap<string, AnyArtObject>,
	localBoundsCache?: LocalBoundsCache,
	includeOwnTransform = false,
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
	const outer = includeOwnTransform
		? elementTransformToAffine(getTransform(repeat), center.x, center.y)
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
	// A repeat bakes its own transform (pivoted at the source union center) into
	// every instance, so the world bounds cannot be reproduced by the generic
	// own-transform application around the local-bounds center — compute directly.
	if (element.type === "repeat") {
		return brandWorldBBox(
			calculateRepeatBounds(element, elementsMap, localBoundsCache, true),
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

	const t = getTransform(element);
	if (isIdentityTransform(t)) return brandWorldBBox(localBounds);
	return brandWorldBBox(applyTransformToBounds(localBounds, t));
}

/**
 * Expand a bounding box by a margin.
 * Preserves branded types (WorldBBox in → WorldBBox out).
 */
export function expandBounds(bounds: WorldBBox, margin: number): WorldBBox;
export function expandBounds(bounds: BoundingBox, margin: number): BoundingBox;
export function expandBounds(bounds: BoundingBox, margin: number): BoundingBox {
	return {
		minX: bounds.minX - margin,
		minY: bounds.minY - margin,
		maxX: bounds.maxX + margin,
		maxY: bounds.maxY + margin,
		width: bounds.width + margin * 2,
		height: bounds.height + margin * 2,
	};
}

/**
 * Translate a bounding box by a delta offset.
 * Preserves branded types (WorldBBox in -> WorldBBox out).
 */
export function translateBounds(
	bounds: WorldBBox,
	deltaX: number,
	deltaY: number,
): WorldBBox;
export function translateBounds(
	bounds: BoundingBox,
	deltaX: number,
	deltaY: number,
): BoundingBox;
export function translateBounds(
	bounds: BoundingBox,
	deltaX: number,
	deltaY: number,
): BoundingBox {
	return {
		minX: bounds.minX + deltaX,
		minY: bounds.minY + deltaY,
		maxX: bounds.maxX + deltaX,
		maxY: bounds.maxY + deltaY,
		width: bounds.width,
		height: bounds.height,
	};
}

/**
 * Check if a point is inside a bounding box
 */
export function pointInBounds(
	x: number,
	y: number,
	bounds: BoundingBox,
): boolean {
	return (
		x >= bounds.minX && x <= bounds.maxX && y >= bounds.minY && y <= bounds.maxY
	);
}

/**
 * Check if two bounding boxes intersect
 */
export function boundsIntersect(a: BoundingBox, b: BoundingBox): boolean {
	return !(
		a.maxX < b.minX ||
		a.minX > b.maxX ||
		a.maxY < b.minY ||
		a.minY > b.maxY
	);
}

// --- Path Hit Testing ---

/**
 * Evaluate a cubic bezier curve at parameter t
 * @param p0 Start point
 * @param p1 Control point 1
 * @param p2 Control point 2
 * @param p3 End point
 * @param t Parameter [0, 1]
 * @returns Point on the curve at t
 */
function evaluateCubicBezier(
	p0: { x: number; y: number },
	p1: { x: number; y: number },
	p2: { x: number; y: number },
	p3: { x: number; y: number },
	t: number,
): { x: number; y: number } {
	const mt = 1 - t;
	const mt2 = mt * mt;
	const mt3 = mt2 * mt;
	const t2 = t * t;
	const t3 = t2 * t;

	return {
		x: mt3 * p0.x + 3 * mt2 * t * p1.x + 3 * mt * t2 * p2.x + t3 * p3.x,
		y: mt3 * p0.y + 3 * mt2 * t * p1.y + 3 * mt * t2 * p2.y + t3 * p3.y,
	};
}

/**
 * Calculate squared distance from a point to a point
 */
function distanceSquared(
	x1: number,
	y1: number,
	x2: number,
	y2: number,
): number {
	const dx = x2 - x1;
	const dy = y2 - y1;
	return dx * dx + dy * dy;
}

/**
 * Calculate the minimum distance from a point to a cubic bezier segment
 * Uses adaptive subdivision for accuracy
 * @param px Point X coordinate
 * @param py Point Y coordinate
 * @param segment The bezier segment
 * @param prevEnd Previous segment end point (used as start if segment.start is undefined)
 * @returns Minimum distance to the curve
 */
export function distanceToSegment(
	px: number,
	py: number,
	segment: CubicBezierSegment,
	prevEnd: BezierPoint | null,
): { distance: number; t: number } {
	const rawStart = segment.start ?? prevEnd;
	if (!rawStart) {
		return { distance: Number.POSITIVE_INFINITY, t: 0 };
	}

	const {
		start: p0,
		cp1: p1,
		cp2: p2,
		end: p3,
	} = resolveSegment(segment, prevEnd ?? undefined);

	// Sample the curve and find the minimum distance
	const numSamples = 20;
	let minDistSq = Number.POSITIVE_INFINITY;
	let bestT = 0;

	for (let i = 0; i <= numSamples; i++) {
		const t = i / numSamples;
		const pt = evaluateCubicBezier(p0, p1, p2, p3, t);
		const dSq = distanceSquared(px, py, pt.x, pt.y);
		if (dSq < minDistSq) {
			minDistSq = dSq;
			bestT = t;
		}
	}

	// Refine around bestT with binary search
	let tMin = Math.max(0, bestT - 1 / numSamples);
	let tMax = Math.min(1, bestT + 1 / numSamples);
	const refinementSteps = 5;

	for (let step = 0; step < refinementSteps; step++) {
		const tMid = (tMin + tMax) / 2;
		const tLow = (tMin + tMid) / 2;
		const tHigh = (tMid + tMax) / 2;

		const ptLow = evaluateCubicBezier(p0, p1, p2, p3, tLow);
		const ptHigh = evaluateCubicBezier(p0, p1, p2, p3, tHigh);

		const distLow = distanceSquared(px, py, ptLow.x, ptLow.y);
		const distHigh = distanceSquared(px, py, ptHigh.x, ptHigh.y);

		if (distLow < distHigh) {
			tMax = tMid;
			if (distLow < minDistSq) {
				minDistSq = distLow;
				bestT = tLow;
			}
		} else {
			tMin = tMid;
			if (distHigh < minDistSq) {
				minDistSq = distHigh;
				bestT = tHigh;
			}
		}
	}

	return { distance: Math.sqrt(minDistSq), t: bestT };
}

/**
 * Check if a point is on a path (within stroke width tolerance)
 * @param px Point X coordinate (world space)
 * @param py Point Y coordinate (world space)
 * @param path The path to test against
 * @param extraTolerance Additional tolerance in world units (for click forgiveness)
 * @returns true if the point is on the path stroke
 */
export function isPointOnPath(
	px: number,
	py: number,
	path: Path,
	extraTolerance = 0,
): boolean {
	if (path.segments.length === 0) return false;

	// First, quick bounds check (already includes stroke width)
	const bounds = calculatePathBounds(path);
	const expandedBounds = expandBounds(bounds, extraTolerance);
	if (!pointInBounds(px, py, expandedBounds)) {
		return false;
	}

	// If path has fill, check if point is inside the filled area
	const hasFill = path.filters?.some((f) => f.processor === "fill");
	if (hasFill) {
		if (isPointInPath(px, py, path)) {
			return true;
		}
	}

	// Calculate hit tolerance: half stroke width + extra tolerance
	const hitTolerance = getStrokeWidth(path.filters, 0) / 2 + extraTolerance;

	// Check distance to each segment
	let prevEnd: BezierPoint | null = null;

	for (const segment of path.segments) {
		const { distance: dist } = distanceToSegment(px, py, segment, prevEnd);
		if (dist <= hitTolerance) {
			return true;
		}
		prevEnd = segment.end;
	}

	return false;
}

/**
 * Check if a path's actual geometry (stroke + fill) intersects with a rectangle.
 * Used for marquee selection to avoid false positives from AABB-only checks.
 */
export function doesPathIntersectRect(
	path: Path,
	rectMinX: number,
	rectMinY: number,
	rectMaxX: number,
	rectMaxY: number,
): boolean {
	if (path.segments.length === 0) return false;

	const halfStroke = getStrokeWidth(path.filters, 0) / 2;
	const hasFill = path.filters?.some((f) => f.processor === "fill");

	// Check if any sampled point on the stroke is inside the rect
	let prevEnd: BezierPoint | null = null;
	for (const segment of path.segments) {
		const { start, cp1, cp2, end } = resolveSegment(
			segment,
			prevEnd ?? undefined,
		);

		const numSamples = 16;
		for (let i = 0; i <= numSamples; i++) {
			const pt = evaluateCubicBezier(start, cp1, cp2, end, i / numSamples);
			if (
				pt.x + halfStroke >= rectMinX &&
				pt.x - halfStroke <= rectMaxX &&
				pt.y + halfStroke >= rectMinY &&
				pt.y - halfStroke <= rectMaxY
			) {
				return true;
			}
		}

		prevEnd = segment.end;
	}

	// If filled, check if any corner of the rect is inside the path
	if (hasFill) {
		for (const [cx, cy] of [
			[rectMinX, rectMinY],
			[rectMaxX, rectMinY],
			[rectMinX, rectMaxY],
			[rectMaxX, rectMaxY],
		] as const) {
			if (isPointInPath(cx, cy, path)) return true;
		}
	}

	return false;
}

/**
 * Check if a point is inside a closed path using winding number algorithm
 * @param px Point X coordinate (world space)
 * @param py Point Y coordinate (world space)
 * @param path The path to test against
 * @returns true if the point is inside the filled area
 */
export function isPointInPath(px: number, py: number, path: Path): boolean {
	if (path.segments.length === 0) return false;

	let windingNumber = 0;
	let prevEnd: BezierPoint | null = null;

	for (const segment of path.segments) {
		const rawStart = segment.start ?? prevEnd;
		if (!rawStart) continue;

		const { start, cp1, cp2, end } = resolveSegment(
			segment,
			prevEnd ?? undefined,
		);

		// Flatten bezier curve into line segments for winding number calculation
		const points = flattenBezierSegment(start, cp1, cp2, end);

		for (let i = 0; i < points.length - 1; i++) {
			const p1 = points[i];
			const p2 = points[i + 1];

			// Check if ray from point to +infinity crosses this edge
			if (p1.y <= py) {
				if (p2.y > py) {
					// Upward crossing
					if (isLeft(p1, p2, px, py) > 0) {
						windingNumber++;
					}
				}
			} else {
				if (p2.y <= py) {
					// Downward crossing
					if (isLeft(p1, p2, px, py) < 0) {
						windingNumber--;
					}
				}
			}
		}

		prevEnd = segment.end;
	}

	// Add closing edge (last end → first start) for winding number calculation.
	// For closed paths this is a zero-length edge (no-op).
	// For open paths this implicitly closes the shape with a straight line.
	const firstStart = path.segments[0].start;
	if (prevEnd && firstStart) {
		const p1 = prevEnd;
		const p2 = firstStart;
		if (p1.y <= py) {
			if (p2.y > py) {
				if (isLeft(p1, p2, px, py) > 0) windingNumber++;
			}
		} else {
			if (p2.y <= py) {
				if (isLeft(p1, p2, px, py) < 0) windingNumber--;
			}
		}
	}

	return windingNumber !== 0;
}

/**
 * Flatten a cubic bezier segment into line segments for polygon testing
 */
function flattenBezierSegment(
	p0: BezierPoint,
	p1: BezierPoint,
	p2: BezierPoint,
	p3: BezierPoint,
	tolerance = 0.5,
): BezierPoint[] {
	const points: BezierPoint[] = [p0];

	function subdivide(
		t0: number,
		t1: number,
		q0: BezierPoint,
		q3: BezierPoint,
		depth: number,
	): void {
		if (depth > 12) {
			points.push(q3);
			return;
		}

		// Calculate midpoint at t = 0.5
		const tMid = (t0 + t1) / 2;
		const t = tMid;
		const mt = 1 - t;
		const qMid = {
			x:
				mt * mt * mt * p0.x +
				3 * mt * mt * t * p1.x +
				3 * mt * t * t * p2.x +
				t * t * t * p3.x,
			y:
				mt * mt * mt * p0.y +
				3 * mt * mt * t * p1.y +
				3 * mt * t * t * p2.y +
				t * t * t * p3.y,
		};

		// Check if line q0-q3 is close enough to curve
		const dx = q3.x - q0.x;
		const dy = q3.y - q0.y;
		const d = Math.sqrt(dx * dx + dy * dy);

		if (d < tolerance) {
			points.push(q3);
			return;
		}

		const midX = (q0.x + q3.x) / 2;
		const midY = (q0.y + q3.y) / 2;
		const distFromLine = Math.abs(
			(qMid.x - midX) * (qMid.x - midX) + (qMid.y - midY) * (qMid.y - midY),
		);

		if (distFromLine < tolerance * tolerance) {
			points.push(q3);
			return;
		}

		// Subdivide recursively
		subdivide(t0, tMid, q0, qMid, depth + 1);
		subdivide(tMid, t1, qMid, q3, depth + 1);
	}

	subdivide(0, 1, p0, p3, 0);
	return points;
}

/**
 * Test if point is left/on/right of an infinite line
 * @returns >0 for point left of line, =0 for on line, <0 for right of line
 */
function isLeft(
	p1: BezierPoint,
	p2: BezierPoint,
	px: number,
	py: number,
): number {
	return (p2.x - p1.x) * (py - p1.y) - (px - p1.x) * (p2.y - p1.y);
}

/**
 * Calculate the intersection area of two bounding boxes.
 * Returns 0 if boxes do not overlap.
 */
export function boundsIntersectionArea(a: BoundingBox, b: BoundingBox): number {
	const overlapMinX = Math.max(a.minX, b.minX);
	const overlapMaxX = Math.min(a.maxX, b.maxX);
	const overlapMinY = Math.max(a.minY, b.minY);
	const overlapMaxY = Math.min(a.maxY, b.maxY);
	if (overlapMinX >= overlapMaxX || overlapMinY >= overlapMaxY) return 0;
	return (overlapMaxX - overlapMinX) * (overlapMaxY - overlapMinY);
}

/**
 * Calculate the area of a bounding box.
 */
export function boundsArea(b: BoundingBox): number {
	return b.width * b.height;
}

/**
 * Calculate the intersection bounding box of two bounding boxes.
 * Returns null if no intersection.
 */
export function boundsIntersectionBox(
	a: BoundingBox,
	b: BoundingBox,
): BoundingBox | null {
	const minX = Math.max(a.minX, b.minX);
	const maxX = Math.min(a.maxX, b.maxX);
	const minY = Math.max(a.minY, b.minY);
	const maxY = Math.min(a.maxY, b.maxY);
	if (minX >= maxX || minY >= maxY) return null;
	return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

/** Ray-casting point-in-polygon test. */
export function pointInPolygon(
	px: number,
	py: number,
	polygon: ReadonlyArray<{ x: number; y: number }>,
): boolean {
	if (polygon.length < 3) return false;

	let inside = false;
	for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
		const xi = polygon[i].x;
		const yi = polygon[i].y;
		const xj = polygon[j].x;
		const yj = polygon[j].y;

		if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
			inside = !inside;
		}
	}
	return inside;
}
