/**
 * Blend interpolation: generate intermediate Path objects between source paths
 * in a chain (A→B→C→...).
 *
 * Pure geometry (no renderer/GPU deps) so both the render path (BlendCache) and
 * hit-testing (SpatialIndex) can reuse it.
 *
 * Coordinate model (mirrors CompoundPathCache): every source is first baked to
 * WORLD space via toWorldPath (its own transform folded into segment coords,
 * transform reset to identity). All interpolation happens in world space and
 * every produced intermediate has identity transform with world-space segments.
 * The renderer draws these under the blend element's transform index, so a path
 * with world coords + the blend's (usually identity) matrix lands at the correct
 * absolute position. Intermediates are synthetic (not in document.objects) and
 * cannot own a transform-index slot, so positioning — including spine rotation —
 * must be baked into the segment coordinates here.
 */

import { localAppearances } from "../../document/appearancePresets";
import { createIdentityTransform } from "../../document/factory";
import type { BrushSettings } from "../../schema";
import {
	type AnyArtObject,
	type BezierPoint,
	type BlendObject,
	type BlendSpacing,
	type Color,
	type ColorStop,
	type ElementTransform,
	type FillAppearance,
	type FillColor,
	type Filter,
	getTransform,
	isCompoundPath,
	isPath,
	type LinearGradient,
	type Path,
	type PathSegment,
	type RadialGradient,
	type RGBColor,
	type SolidColor,
	type StrokeAppearance,
	type StrokeColor,
	type StrokeGradient,
} from "../../schema";
import { srgbEotf, srgbOetf } from "../color";
import { lerp } from "./bezierBool";
import { calculatePathBounds } from "./bounds";
import { composeTransforms, type WorldBezierSegment } from "./geometry";
import { computeBooleanOperation, splitBezierAtT } from "./pathOps";
import { buildArcLengthTable, samplePathAtArcLength } from "./pathSampling";
import {
	resolveSegment,
	toRelativeCP1,
	toRelativeCP2,
	toWorldPath,
	transformSegmentsToWorld,
} from "./segmentOps";

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Compute intermediate Path objects for a blend, grouped per adjacent pair.
 * `result[i]` holds the intermediates between objects[i] and objects[i+1].
 * Returned paths are world-space with identity transform.
 *
 * Returning a 2D array (rather than a flat list) lets the renderer recover pair
 * boundaries even when each pair has a different intermediate count
 * (distance/smooth spacing) — a flat list cannot be sliced back correctly.
 */
/**
 * Interpolate a non-fill/stroke filter pair at fraction `t` (e.g. an
 * extrude3d appearance's depth/rotation between two blend keys). Optional —
 * callers with no renderer context (hit-testing) omit it and each
 * intermediate keeps the source key's filter unchanged.
 */
export type FilterInterpolator = (a: Filter, b: Filter, t: number) => Filter;

export function computeBlendIntermediates(
	blend: BlendObject,
	objects: Path[],
	spineSource?: Path | null,
	interpolateOtherFilter?: FilterInterpolator,
): Path[][] {
	if (objects.length < 2) return [];

	// Bake each source into world space so interpolation is transform-agnostic.
	const world = objects.map((o) => toWorldPath(o));

	// The spine is a live source path (resolved from blend.spineSourceId), baked
	// the same way so editing it through the normal path tools flows into the
	// intermediate placement.
	const spineSegments = spineSource ? toWorldPath(spineSource).segments : null;
	const spineTable = spineSegments ? buildArcLengthTable(spineSegments) : null;
	const spineTotal = spineTable
		? (spineTable.at(-1)?.cumulativeLength ?? 0)
		: 0;
	const pairCount = world.length - 1;

	// Arc-length of each key ON the spine, so each pair's intermediates run
	// between the ACTUAL key positions — not an even split of the spine. With
	// keys at uneven spots the even split would start intermediates away from the
	// keys. First/last keys pin to the spine ends; the sequence is kept
	// non-decreasing so every pair range is valid.
	let keyArcLengths: number[] | null = null;
	if (spineSegments && spineTable && spineTotal > 0) {
		keyArcLengths = world.map((w) =>
			arcLengthOfNearestSpinePoint(
				segmentsBBoxCenter(w.segments),
				spineSegments,
				spineTable,
				spineTotal,
			),
		);
		keyArcLengths[0] = 0;
		for (let i = 1; i < keyArcLengths.length - 1; i++) {
			keyArcLengths[i] = Math.min(
				Math.max(keyArcLengths[i], keyArcLengths[i - 1]),
				spineTotal,
			);
		}
		keyArcLengths[keyArcLengths.length - 1] = spineTotal;
	}

	const result: Path[][] = [];
	for (let i = 0; i < pairCount; i++) {
		const source = world[i];
		const target = world[i + 1];
		const spineRange = keyArcLengths
			? { start: keyArcLengths[i], end: keyArcLengths[i + 1] }
			: null;
		const sliceLength = spineRange ? spineRange.end - spineRange.start : 0;
		const steps = resolveStepCount(blend.spacing, source, target, sliceLength);
		result.push(
			computePairIntermediates(
				blend.id,
				i,
				source,
				target,
				steps,
				spineSegments ?? undefined,
				spineTable,
				spineTotal,
				spineRange,
				blend.tiltToSpine ?? false,
				interpolateOtherFilter,
			),
		);
	}
	return result;
}

/**
 * World-space point for each blend key when the spine is edited: key j glides to
 * equal arc-length j/(N-1) along the spine — first/last at the ends. Keys glide
 * smoothly along the curve, NOT snapped to anchor vertices, so adding a curve
 * anchor does not yank a key onto it. Returns null with no spine or fewer than
 * two keys.
 *
 * This is the spine-edit → keys direction only. A KEY MOVE must NOT route through
 * here: `rebuildBlendSpineIfKey` only reshapes the spine and leaves the moved key
 * at its dragged position (re-placing it by arc-length here would pull it off the
 * spot the user dropped it).
 *
 * Used to lay the keys out along the spine, baking the position into their own
 * transforms (stored == drawn, so they stay editable in place). Position only —
 * keys keep their authored orientation.
 */
export function computeSpineKeyPlacements(
	spineSource: Path | null,
	keyCount: number,
): Array<{ x: number; y: number }> | null {
	if (!spineSource || keyCount < 2) return null;
	const spineSegments = toWorldPath(spineSource).segments;
	const spineTable = buildArcLengthTable(spineSegments);
	const spineTotal = spineTable.at(-1)?.cumulativeLength ?? 0;
	if (spineTotal <= 0) return null;

	const placements: Array<{ x: number; y: number }> = [];
	for (let i = 0; i < keyCount; i++) {
		const arcLen = (spineTotal / (keyCount - 1)) * i;
		const sample = samplePathAtArcLength(
			spineSegments,
			spineTable,
			arcLen,
			spineTotal,
		);
		if (!sample) return null;
		placements.push({ x: sample.x, y: sample.y });
	}
	return placements;
}

/**
 * Reshape the spine so it passes through the (moved) key centers: move each
 * key's anchor onto its key center, keeping the relative cp1/cp2 handles so
 * anchors between keys preserve the spine's curve. key j ↔ anchor
 * `keyAnchorIndex(...)`. When the spine has fewer anchors than keys it is
 * subdivided (shape-preserving) so every key gets one.
 *
 * This is the key-move → spine direction: it edits the SPINE only and never
 * moves the keys, so a dragged key stays exactly where it was dropped. Returns
 * null only when there is nothing to place (fewer than two keys or an empty
 * spine).
 */
export function relocateSpineAnchorsToKeys(
	segments: PathSegment[],
	centers: Array<{ x: number; y: number }>,
): PathSegment[] | null {
	const keyCount = centers.length;
	if (keyCount < 2 || segments.length === 0) return null;
	const out = subdivideToCount(segments, keyCount - 1).map((seg) => ({
		...seg,
	}));
	const anchorCount = out.length + 1; // open polyline: N anchors, N-1 segments
	for (let j = 0; j < keyCount; j++) {
		const idx = keyAnchorIndex(anchorCount, keyCount, j);
		const c = centers[j];
		if (idx === 0) {
			const first = out[0];
			if (first.start) first.start = { ...first.start, x: c.x, y: c.y };
		} else {
			const seg = out[idx - 1];
			seg.end = { ...seg.end, x: c.x, y: c.y };
		}
	}
	return out;
}

/**
 * Map blend key index j → spine anchor index, distributing the N keys evenly
 * across the M spine anchors (requires M >= N). For M === N this is the identity
 * (key j ↔ anchor j); extra anchors (M > N) are curve detail between keys. Both
 * reflow directions share this mapping so they stay in sync.
 */
function keyAnchorIndex(
	anchorCount: number,
	keyCount: number,
	keyIndex: number,
): number {
	return Math.round(((anchorCount - 1) * keyIndex) / (keyCount - 1));
}

/**
 * Arc-length on the spine of the point nearest to `center`. Keys lie on the
 * spine, so this gives each key's position along it — letting each pair's
 * intermediates be bounded by the ACTUAL (possibly uneven) key positions
 * instead of an even split.
 */
export function arcLengthOfNearestSpinePoint(
	center: { x: number; y: number },
	spineSegments: PathSegment[],
	spineTable: ReturnType<typeof buildArcLengthTable>,
	spineTotal: number,
): number {
	const SAMPLES = 200;
	let bestArc = 0;
	let bestDist = Number.POSITIVE_INFINITY;
	for (let i = 0; i <= SAMPLES; i++) {
		const arc = (spineTotal / SAMPLES) * i;
		const p = samplePathAtArcLength(spineSegments, spineTable, arc, spineTotal);
		if (!p) continue;
		const d = (p.x - center.x) ** 2 + (p.y - center.y) ** 2;
		if (d < bestDist) {
			bestDist = d;
			bestArc = arc;
		}
	}
	return bestArc;
}

/**
 * Resolve a blend source element to a plain Path suitable for interpolation:
 * a Path is returned as-is; a CompoundPath is flattened to its boolean-resolved
 * outline (a single multi-subpath Path in the compound's local space, carrying
 * the compound's transform and appearance). `resolveChild` looks up the
 * compound's source paths by id. Returns null for unsupported / unresolvable
 * sources.
 */
export function resolveBlendSourcePath(
	source: AnyArtObject,
	resolveChild: (id: string) => AnyArtObject | undefined,
): Path | null {
	if (isPath(source)) return source;
	if (isCompoundPath(source)) {
		const pathMap = new Map<string, Path>();
		for (const s of source.sources) {
			const child = resolveChild(s.id);
			if (child && isPath(child)) pathMap.set(s.id, child);
		}
		if (pathMap.size === 0) return null;
		const segments = computeBooleanOperation(source.sources, pathMap, {
			curveTolerance: 0.25,
		});
		if (segments.length === 0) return null;
		return {
			type: "path",
			id: source.id,
			segments,
			opacity: source.opacity,
			blendMode: source.blendMode,
			transform: source.transform,
			filters: source.filters,
		};
	}
	return null;
}

/**
 * Resolve a blend's spine to a plain Path (from blend.spineSourceId), or null
 * when the blend has no spine. The spine source lives in document.objects (like
 * a clip path), so editing it through the normal path tools updates the blend.
 */
export function resolveBlendSpinePath(
	blend: BlendObject,
	getObject: (id: string) => AnyArtObject | undefined,
): Path | null {
	if (!blend.spineSourceId) return null;
	const el = getObject(blend.spineSourceId);
	if (!el) return null;
	return resolveBlendSourcePath(el, getObject);
}

/**
 * World-space outline segments of a blend's key objects (its source paths /
 * compound-paths), grouped per key, for selection-overlay display.
 *
 * Mirrors renderBlend exactly: each key is resolved to a plain outline
 * (compounds flattened) and world-baked (its own transform folded into the
 * segments), then the whole blend's transform — composed with the blend's own
 * ancestors — is applied around the blend's local bbox center. Using the blend's
 * center (not each source's own center) is what keeps the outlines aligned with
 * the drawn shapes when the blend is rotated or scaled.
 */
export function blendKeyOutlines(
	blend: BlendObject,
	getObject: (id: string) => AnyArtObject | undefined,
	getAncestorTransform: (id: string) => ElementTransform | null,
): WorldBezierSegment[][] {
	const bakedSources: Path[] = [];
	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;

	for (const keyId of blend.objectIds) {
		const key = getObject(keyId);
		if (!key) continue;
		const path = resolveBlendSourcePath(key, getObject);
		if (!path || path.segments.length === 0) continue;
		// Keys are baked onto the spine in their own stored transforms, so the
		// world-baked source already sits where it is drawn.
		const baked = toWorldPath(path);
		bakedSources.push(baked);
		const b = calculatePathBounds(baked);
		if (b.minX < minX) minX = b.minX;
		if (b.minY < minY) minY = b.minY;
		if (b.maxX > maxX) maxX = b.maxX;
		if (b.maxY > maxY) maxY = b.maxY;
	}
	if (bakedSources.length === 0) return [];

	const blendAncestorT = getAncestorTransform(blend.id);
	const blendT = getTransform(blend);
	const worldT = blendAncestorT
		? composeTransforms(blendAncestorT, blendT)
		: blendT;
	const origin = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };

	const outlines = bakedSources.map((baked) =>
		transformSegmentsToWorld(baked.segments, worldT, origin),
	);

	// Outline the spine too (excluded from the bbox union above, matching the
	// blend's own bounds) so it is visible and locatable while selected.
	const spineSource = resolveBlendSpinePath(blend, getObject);
	if (spineSource && spineSource.segments.length > 0) {
		outlines.push(
			transformSegmentsToWorld(
				toWorldPath(spineSource).segments,
				worldT,
				origin,
			),
		);
	}

	return outlines;
}

// ── Spacing resolution ────────────────────────────────────────────────────

function resolveStepCount(
	spacing: BlendSpacing,
	source: Path,
	target: Path,
	spineSliceLength: number,
): number {
	if (spacing.type === "steps") {
		return Math.max(0, Math.floor(spacing.count));
	}

	if (spacing.type === "distance") {
		if (spacing.spacing <= 0) return 0;
		const dist =
			spineSliceLength > 0
				? spineSliceLength
				: distanceBetweenCenters(source, target);
		if (dist <= 0) return 0;
		return Math.max(0, Math.floor(dist / spacing.spacing) - 1);
	}

	// smooth: add steps until consecutive OKLab ΔE < 1 (cap 100)
	const sourceColor = extractFillRgb(source);
	const targetColor = extractFillRgb(target);
	if (!sourceColor || !targetColor) return 5;
	const deltaE = oklabDistance(
		rgbToOklab(sourceColor),
		rgbToOklab(targetColor),
	);
	return Math.max(0, Math.min(100, Math.ceil(deltaE) - 1));
}

/** Distance between two world-space paths' geometric centers. */
function distanceBetweenCenters(a: Path, b: Path): number {
	const ca = segmentsBBoxCenter(a.segments);
	const cb = segmentsBBoxCenter(b.segments);
	return Math.hypot(cb.x - ca.x, cb.y - ca.y);
}

// ── Pair-wise interpolation ───────────────────────────────────────────────

function computePairIntermediates(
	blendId: string,
	pairIndex: number,
	source: Path,
	target: Path,
	steps: number,
	spinePath: PathSegment[] | undefined,
	spineTable: ReturnType<typeof buildArcLengthTable> | null,
	spineTotal: number,
	spineRange: { start: number; end: number } | null,
	tilt: boolean,
	interpolateOtherFilter?: FilterInterpolator,
): Path[] {
	if (steps <= 0) return [];

	// Match sub-paths so compound/holey shapes blend per sub-path; each matched
	// pair is normalized + anchor-aligned once here. A single-subpath path falls
	// through as one pair, identical to the non-compound case.
	const subPathPairs = matchSubPaths(
		splitSubPaths(source.segments),
		splitSubPaths(target.segments),
	);
	const result: Path[] = [];

	for (let i = 1; i <= steps; i++) {
		const t = i / (steps + 1);
		let segments = interpolateSubPaths(subPathPairs, t);
		const filters = interpolateFilters(
			localAppearances(source.filters),
			localAppearances(target.filters),
			t,
			interpolateOtherFilter,
		);
		const opacity = lerp(source.opacity, target.opacity, t);

		if (spinePath && spineTable && spineRange && spineTotal > 0) {
			const arcLen = spineRange.start + (spineRange.end - spineRange.start) * t;
			const sample = samplePathAtArcLength(
				spinePath,
				spineTable,
				arcLen,
				spineTotal,
			);
			if (sample) {
				// Move the shape's center onto the spine point, baked into world coords
				// because an intermediate has no transform-index slot. When tilt is on,
				// also rotate it to the spine tangent (normal = tangent rotated +90°);
				// otherwise keep it upright (angle 0 = translation only).
				const center = segmentsBBoxCenter(segments);
				const angle = tilt ? Math.atan2(-sample.normalX, sample.normalY) : 0;
				segments = bakeSpinePlacement(
					segments,
					center,
					{ x: sample.x, y: sample.y },
					angle,
				);
			}
		}

		result.push({
			// Deterministic id derived from the (live) blend id so per-id render
			// caches (outline, strips) are stable across frames and not
			// destroyed mid-flight by stale-entry pruning. "::" separates the
			// live base id used by RenderCacheManager.onDocumentChange.
			id: `${blendId}::s${pairIndex}_${i}`,
			type: "path",
			opacity,
			blendMode: source.blendMode,
			transform: createIdentityTransform(),
			filters,
			segments,
			visible: true,
			locked: true,
		});
	}

	return result;
}

/**
 * Bake a rotate-around-center + translate-to-target placement into world-space
 * segments. Anchors (start/end) are rotated about `center` then offset to
 * `target`; control points (relative offsets) are rotated only.
 */
function bakeSpinePlacement(
	segments: PathSegment[],
	center: { x: number; y: number },
	target: { x: number; y: number },
	angle: number,
): PathSegment[] {
	const cos = Math.cos(angle);
	const sin = Math.sin(angle);
	const anchor = (p: BezierPoint): BezierPoint => {
		const dx = p.x - center.x;
		const dy = p.y - center.y;
		return {
			...p,
			x: target.x + cos * dx - sin * dy,
			y: target.y + sin * dx + cos * dy,
		};
	};
	const offset = (v: BezierPoint): BezierPoint => ({
		...v,
		x: cos * v.x - sin * v.y,
		y: sin * v.x + cos * v.y,
	});
	return segments.map((s) => ({
		...s,
		start: s.start ? anchor(s.start) : undefined,
		cp1: offset(s.cp1),
		cp2: offset(s.cp2),
		end: anchor(s.end),
	}));
}

function segmentsBBoxCenter(segments: PathSegment[]): { x: number; y: number } {
	const bounds = calculatePathBounds({
		id: "__blend_tmp__",
		type: "path",
		segments,
		opacity: 1,
		blendMode: "normal",
		transform: createIdentityTransform(),
	});
	return {
		x: (bounds.minX + bounds.maxX) / 2,
		y: (bounds.minY + bounds.maxY) / 2,
	};
}

// ── Segment normalization ─────────────────────────────────────────────────

/**
 * Normalize two segment arrays to the same length by subdividing the shorter
 * one (longest-chord-first) until both reach max(a.length, b.length).
 */
function normalizeSegmentCount(
	a: PathSegment[],
	b: PathSegment[],
): [PathSegment[], PathSegment[]] {
	const target = Math.max(a.length, b.length);
	return [subdivideToCount(a, target), subdivideToCount(b, target)];
}

function subdivideToCount(
	segments: PathSegment[],
	target: number,
): PathSegment[] {
	if (segments.length === 0 || segments.length >= target) return segments;
	let result = segments;
	while (result.length < target) {
		result = splitSegmentInPlace(result, findLongestSegmentIndex(result), 0.5);
	}
	return result;
}

function findLongestSegmentIndex(segments: PathSegment[]): number {
	let maxLen = -1;
	let maxIdx = 0;
	for (let i = 0; i < segments.length; i++) {
		const prevEnd = i > 0 ? segments[i - 1].end : undefined;
		const r = resolveSegment(segments[i], prevEnd);
		const len = (r.end.x - r.start.x) ** 2 + (r.end.y - r.start.y) ** 2;
		if (len > maxLen) {
			maxLen = len;
			maxIdx = i;
		}
	}
	return maxIdx;
}

function splitSegmentInPlace(
	segments: PathSegment[],
	index: number,
	t: number,
): PathSegment[] {
	const seg = segments[index];
	const prevEnd = index > 0 ? segments[index - 1].end : undefined;
	const { start, cp1, cp2, end } = resolveSegment(seg, prevEnd);
	const [left, right] = splitBezierAtT(start, cp1, cp2, end, t);
	const mid = left.p3;

	const leftSeg: PathSegment = {
		start: index === 0 ? seg.start : undefined,
		cp1: toRelativeCP1(left.p1, left.p0),
		cp2: toRelativeCP2(left.p2, mid),
		end: mid,
		isMoved: seg.isMoved,
		startTiltX: seg.startTiltX,
		startTiltY: seg.startTiltY,
		endTiltX: 0,
		endTiltY: 0,
		startDeltaTime: seg.startDeltaTime,
		endDeltaTime: 0,
	};
	const rightSeg: PathSegment = {
		cp1: toRelativeCP1(right.p1, mid),
		cp2: toRelativeCP2(right.p2, end),
		end: { ...end },
		isMoved: false,
		isClosed: seg.isClosed,
		startTiltX: 0,
		startTiltY: 0,
		endTiltX: seg.endTiltX,
		endTiltY: seg.endTiltY,
		startDeltaTime: 0,
		endDeltaTime: seg.endDeltaTime,
	};

	const result = [...segments];
	result.splice(index, 1, leftSeg, rightSeg);
	return result;
}

// ── Anchor correspondence ─────────────────────────────────────────────────

type AbsSegment = {
	start: BezierPoint;
	cp1: BezierPoint;
	cp2: BezierPoint;
	end: BezierPoint;
};

/**
 * Reorder `tgt` (same length as `src`) so its anchors best correspond to `src`'s:
 * pick the cyclic rotation and winding direction that minimize total squared
 * anchor distance. Both must be closed paths with ≥3 segments; otherwise `tgt`
 * is returned unchanged (open paths have fixed endpoints, nothing to rotate).
 */
function alignSegmentsToReference(
	src: PathSegment[],
	tgt: PathSegment[],
): PathSegment[] {
	const n = tgt.length;
	if (n < 3 || src.length !== n || !isClosedPath(src) || !isClosedPath(tgt)) {
		return tgt;
	}

	const srcAnchors = toAbsoluteSegments(src).map((s) => s.start);
	const tgtAbs = toAbsoluteSegments(tgt);
	const candidates = [tgtAbs, reverseAbsoluteSegments(tgtAbs)];

	let best = tgtAbs;
	let bestCost = Number.POSITIVE_INFINITY;
	for (const cand of candidates) {
		for (let k = 0; k < n; k++) {
			let cost = 0;
			for (let i = 0; i < n; i++) {
				const a = srcAnchors[i];
				const b = cand[(i + k) % n].start;
				cost += (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
			}
			if (cost < bestCost) {
				bestCost = cost;
				best = k === 0 ? cand : [...cand.slice(k), ...cand.slice(0, k)];
			}
		}
	}
	return fromAbsoluteSegments(best);
}

function isClosedPath(segments: PathSegment[]): boolean {
	return segments.at(-1)?.isClosed === true;
}

/** Resolve relative control points + chained anchors into absolute coordinates. */
function toAbsoluteSegments(segments: PathSegment[]): AbsSegment[] {
	const result: AbsSegment[] = [];
	let prevEnd: BezierPoint | undefined;
	for (const seg of segments) {
		const r = resolveSegment(seg, prevEnd);
		result.push({ start: r.start, cp1: r.cp1, cp2: r.cp2, end: r.end });
		prevEnd = r.end;
	}
	return result;
}

/** Reverse a closed loop's traversal direction (swap each segment end-for-end). */
function reverseAbsoluteSegments(abs: AbsSegment[]): AbsSegment[] {
	const n = abs.length;
	return abs.map((_, j) => {
		const s = abs[n - 1 - j];
		return { start: s.end, cp1: s.cp2, cp2: s.cp1, end: s.start };
	});
}

function fromAbsoluteSegments(abs: AbsSegment[]): PathSegment[] {
	return abs.map((s, i) => ({
		start: i === 0 ? { ...s.start } : undefined,
		cp1: toRelativeCP1(s.cp1, s.start),
		cp2: toRelativeCP2(s.cp2, s.end),
		end: { ...s.end },
		isMoved: i === 0,
		isClosed: i === abs.length - 1 ? true : undefined,
		startTiltX: 0,
		startTiltY: 0,
		endTiltX: 0,
		endTiltY: 0,
		startDeltaTime: 0,
		endDeltaTime: 0,
	}));
}

// ── Sub-path matching (compound / holey shapes) ───────────────────────────

type SubPathPair =
	| { kind: "both"; src: PathSegment[]; tgt: PathSegment[] }
	| { kind: "srcOnly"; src: PathSegment[] }
	| { kind: "tgtOnly"; tgt: PathSegment[] };

/** Split a segment list into sub-paths at `isMoved` boundaries. */
function splitSubPaths(segments: PathSegment[]): PathSegment[][] {
	if (segments.length === 0) return [];
	const subs: PathSegment[][] = [];
	let cur: PathSegment[] = [];
	for (const seg of segments) {
		if (seg.isMoved && cur.length > 0) {
			subs.push(cur);
			cur = [];
		}
		cur.push(seg);
	}
	if (cur.length > 0) subs.push(cur);
	return subs;
}

/**
 * Pair source/target sub-paths by nearest center + closest area, normalizing and
 * anchor-aligning each matched pair once. Unmatched sub-paths (count mismatch)
 * are kept alone and faded by collapsing toward their center during interpolation.
 */
function matchSubPaths(
	srcSubs: PathSegment[][],
	tgtSubs: PathSegment[][],
): SubPathPair[] {
	const usedTgt = new Set<number>();
	const pairs: SubPathPair[] = [];
	for (const src of srcSubs) {
		const cs = segmentsBBoxCenter(src);
		const as = Math.sqrt(subPathArea(src));
		let best = -1;
		let bestCost = Number.POSITIVE_INFINITY;
		for (let j = 0; j < tgtSubs.length; j++) {
			if (usedTgt.has(j)) continue;
			const ct = segmentsBBoxCenter(tgtSubs[j]);
			const cost =
				Math.hypot(ct.x - cs.x, ct.y - cs.y) +
				Math.abs(Math.sqrt(subPathArea(tgtSubs[j])) - as);
			if (cost < bestCost) {
				bestCost = cost;
				best = j;
			}
		}
		if (best === -1) {
			pairs.push({ kind: "srcOnly", src });
			continue;
		}
		usedTgt.add(best);
		const [ns, nt0] = normalizeSegmentCount(src, tgtSubs[best]);
		pairs.push({
			kind: "both",
			src: ns,
			tgt: alignSegmentsToReference(ns, nt0),
		});
	}
	for (let j = 0; j < tgtSubs.length; j++) {
		if (!usedTgt.has(j)) pairs.push({ kind: "tgtOnly", tgt: tgtSubs[j] });
	}
	return pairs;
}

function interpolateSubPaths(pairs: SubPathPair[], t: number): PathSegment[] {
	const out: PathSegment[] = [];
	for (const p of pairs) {
		if (p.kind === "both") {
			out.push(...interpolateSegments(p.src, p.tgt, t));
		} else if (p.kind === "srcOnly") {
			out.push(...collapseSubPath(p.src, t)); // present at t=0, gone at t=1
		} else {
			out.push(...collapseSubPath(p.tgt, 1 - t)); // gone at t=0, present at t=1
		}
	}
	return out;
}

/** Scale a sub-path toward its center: amount 0 = unchanged, 1 = collapsed to a point. */
function collapseSubPath(sub: PathSegment[], amount: number): PathSegment[] {
	const c = segmentsBBoxCenter(sub);
	const s = 1 - amount;
	const scale = (p: BezierPoint): BezierPoint => ({
		...p,
		x: c.x + (p.x - c.x) * s,
		y: c.y + (p.y - c.y) * s,
	});
	return sub.map((seg) => ({
		...seg,
		start: seg.start ? scale(seg.start) : undefined,
		end: scale(seg.end),
		cp1: { ...seg.cp1, x: seg.cp1.x * s, y: seg.cp1.y * s },
		cp2: { ...seg.cp2, x: seg.cp2.x * s, y: seg.cp2.y * s },
	}));
}

/** Shoelace area of a sub-path using its resolved anchor points. */
function subPathArea(sub: PathSegment[]): number {
	const abs = toAbsoluteSegments(sub);
	let area = 0;
	for (let i = 0; i < abs.length; i++) {
		const a = abs[i].end;
		const b = abs[(i + 1) % abs.length].end;
		area += a.x * b.y - b.x * a.y;
	}
	return Math.abs(area) / 2;
}

// ── Segment interpolation ─────────────────────────────────────────────────

function interpolateSegments(
	a: PathSegment[],
	b: PathSegment[],
	t: number,
): PathSegment[] {
	const len = Math.min(a.length, b.length);
	const result: PathSegment[] = [];
	for (let i = 0; i < len; i++) result.push(interpolateSegment(a[i], b[i], t));
	return result;
}

function interpolateSegment(
	a: PathSegment,
	b: PathSegment,
	t: number,
): PathSegment {
	return {
		start: a.start && b.start ? lerpBezierPoint(a.start, b.start, t) : a.start,
		cp1: lerpBezierPoint(a.cp1, b.cp1, t),
		cp2: lerpBezierPoint(a.cp2, b.cp2, t),
		end: lerpBezierPoint(a.end, b.end, t),
		isMoved: a.isMoved,
		isClosed: a.isClosed ?? b.isClosed,
		startPressure: lerpOptional(a.startPressure, b.startPressure, t),
		endPressure: lerpOptional(a.endPressure, b.endPressure, t),
		startTiltX: lerp(a.startTiltX ?? 0, b.startTiltX ?? 0, t),
		startTiltY: lerp(a.startTiltY ?? 0, b.startTiltY ?? 0, t),
		endTiltX: lerp(a.endTiltX ?? 0, b.endTiltX ?? 0, t),
		endTiltY: lerp(a.endTiltY ?? 0, b.endTiltY ?? 0, t),
		startDeltaTime: lerp(a.startDeltaTime ?? 0, b.startDeltaTime ?? 0, t),
		endDeltaTime: lerp(a.endDeltaTime ?? 0, b.endDeltaTime ?? 0, t),
		cornerRadius: lerpOptional(a.cornerRadius, b.cornerRadius, t),
		cornerSuperellipseN: lerpOptional(
			a.cornerSuperellipseN,
			b.cornerSuperellipseN,
			t,
		),
	};
}

function lerpBezierPoint(
	a: BezierPoint,
	b: BezierPoint,
	t: number,
): BezierPoint {
	return {
		x: lerp(a.x, b.x, t),
		y: lerp(a.y, b.y, t),
		pressure: lerpOptional(a.pressure, b.pressure, t),
	};
}

function lerpOptional(
	a: number | undefined,
	b: number | undefined,
	t: number,
): number | undefined {
	if (a != null && b != null) return lerp(a, b, t);
	return a ?? b;
}

// ── Appearance (filter) interpolation ─────────────────────────────────────

/** Pair appearances by processor type (fill↔fill, stroke↔stroke). */
function interpolateFilters(
	a: Filter[],
	b: Filter[],
	t: number,
	interpolateOtherFilter?: FilterInterpolator,
): Filter[] {
	const result: Filter[] = [];
	result.push(...pairByProcessor(a, b, "fill", t));
	result.push(...pairByProcessor(a, b, "stroke", t));
	// Non fill/stroke effects: interpolate against the target's same-processor
	// filter when a caller-supplied interpolator is available (e.g. an
	// extrude3d appearance's depth/rotation); otherwise keep source's as-is.
	for (const f of a) {
		if (f.processor === "fill" || f.processor === "stroke") continue;
		const match = interpolateOtherFilter
			? b.find((g) => g.processor === f.processor)
			: undefined;
		result.push(match ? interpolateOtherFilter!(f, match, t) : f);
	}
	return result;
}

function pairByProcessor(
	a: Filter[],
	b: Filter[],
	processor: "fill" | "stroke",
	t: number,
): Filter[] {
	const af = a.filter((f) => f.processor === processor);
	const bf = b.filter((f) => f.processor === processor);
	const len = Math.max(af.length, bf.length);
	const out: Filter[] = [];
	for (let i = 0; i < len; i++) {
		const x = af[i];
		const y = bf[i];
		if (x && y) out.push(interpolateAppearance(x, y, t));
		else if (x)
			out.push({ ...x, opacity: x.opacity * (1 - t) }); // fade out
		else if (y) out.push({ ...y, opacity: y.opacity * t }); // fade in
	}
	return out;
}

function interpolateAppearance(a: Filter, b: Filter, t: number): Filter {
	if (a.processor === "fill" && b.processor === "fill") {
		const fa = a as FillAppearance;
		const fb = b as FillAppearance;
		return {
			...fa,
			opacity: lerp(fa.opacity, fb.opacity, t),
			paramData: {
				version: fa.paramData.version,
				params: {
					fill: interpolateFillColor(
						fa.paramData.params.fill,
						fb.paramData.params.fill,
						t,
					),
				},
			},
		};
	}
	if (a.processor === "stroke" && b.processor === "stroke") {
		const sa = a as StrokeAppearance;
		const sb = b as StrokeAppearance;
		return {
			...sa,
			opacity: lerp(sa.opacity, sb.opacity, t),
			paramData: {
				version: sa.paramData.version,
				params: {
					strokeColor: interpolateStrokeColor(
						sa.paramData.params.strokeColor,
						sb.paramData.params.strokeColor,
						t,
					),
					brushSettings: interpolateBrushSettings(
						sa.paramData.params.brushSettings,
						sb.paramData.params.brushSettings,
						t,
					),
				},
			},
		};
	}
	return { ...a, opacity: lerp(a.opacity, b.opacity, t) };
}

function interpolateFillColor(
	a: FillColor,
	b: FillColor,
	t: number,
): FillColor {
	if (isGradLike(a) && isGradLike(b)) {
		const r = interpolateGradLike(a, b, t);
		if (r) return r;
	}
	// free / mesh fills (or linear↔radial type mismatch) switch at the midpoint.
	return t < 0.5 ? a : b;
}

function interpolateStrokeColor(
	a: StrokeColor,
	b: StrokeColor,
	t: number,
): StrokeColor {
	// Pattern strokes do not interpolate between samples: switch at the midpoint.
	if (a.type === "stroke-pattern" || b.type === "stroke-pattern") {
		return t < 0.5 ? a : b;
	}
	// Stroke gradients are always linear; unwrap, interpolate, re-wrap.
	const ga: GradLike = a.type === "stroke-gradient" ? a.gradient : a;
	const gb: GradLike = b.type === "stroke-gradient" ? b.gradient : b;
	const r = interpolateGradLike(ga, gb, t);
	if (r?.type === "solid") return r;
	if (r?.type === "linear") {
		const mode =
			a.type === "stroke-gradient"
				? a.mode
				: b.type === "stroke-gradient"
					? b.mode
					: "within";
		return {
			type: "stroke-gradient",
			gradient: r,
			mode,
		} satisfies StrokeGradient;
	}
	return t < 0.5 ? a : b;
}

// ── Gradient color interpolation ──────────────────────────────────────────
// solid↔gradient and same-type gradient↔gradient (linear↔linear, radial↔radial)
// interpolate continuously: stop counts are normalized to the larger side (the
// shorter list gets midpoint stops inserted into its widest offset gaps), then
// each stop's offset and color (OKLab) interpolate by index. A solid is treated
// as a uniform gradient sharing the other side's stop offsets. Type mismatches
// (linear↔radial) and free/mesh return null so the caller switches at midpoint.

type GradLike = SolidColor | LinearGradient | RadialGradient;

function isGradLike(c: FillColor): c is GradLike {
	return c.type === "solid" || c.type === "linear" || c.type === "radial";
}

function interpolateGradLike(
	a: GradLike,
	b: GradLike,
	t: number,
): GradLike | null {
	if (a.type === "solid" && b.type === "solid") {
		return { type: "solid", color: interpolateColor(a.color, b.color, t) };
	}

	const kind = resolveGradKind(a, b);
	if (!kind) return null;

	const aStops =
		a.type === "solid"
			? uniformStops((b as LinearGradient | RadialGradient).stops, a.color)
			: a.stops;
	const bStops =
		b.type === "solid"
			? uniformStops((a as LinearGradient | RadialGradient).stops, b.color)
			: b.stops;
	const [na, nb] = normalizeStops(aStops, bStops);
	const stops: ColorStop[] = na
		.map((s, i) => ({
			offset: lerp(s.offset, nb[i].offset, t),
			color: lerpStopColor(s.color, nb[i].color, t),
			midpoint: lerp(s.midpoint, nb[i].midpoint, t),
		}))
		.sort((x, y) => x.offset - y.offset);

	if (kind === "linear") {
		const la = a.type === "linear" ? a : null;
		const lb = b.type === "linear" ? b : null;
		const g = la && lb ? null : (la ?? lb)!;
		return {
			type: "linear",
			x1: g ? g.x1 : lerp(la!.x1, lb!.x1, t),
			y1: g ? g.y1 : lerp(la!.y1, lb!.y1, t),
			x2: g ? g.x2 : lerp(la!.x2, lb!.x2, t),
			y2: g ? g.y2 : lerp(la!.y2, lb!.y2, t),
			stops,
		};
	}

	const ra = a.type === "radial" ? a : null;
	const rb = b.type === "radial" ? b : null;
	const g = ra && rb ? null : (ra ?? rb)!;
	return {
		type: "radial",
		cx: g ? g.cx : lerp(ra!.cx, rb!.cx, t),
		cy: g ? g.cy : lerp(ra!.cy, rb!.cy, t),
		radiusX: g ? g.radiusX : lerp(ra!.radiusX, rb!.radiusX, t),
		radiusY: g ? g.radiusY : lerp(ra!.radiusY, rb!.radiusY, t),
		rotation: g ? g.rotation : lerp(ra!.rotation, rb!.rotation, t),
		stops,
	};
}

/** Target gradient kind, or null for type mismatch (linear↔radial). */
function resolveGradKind(a: GradLike, b: GradLike): "linear" | "radial" | null {
	const isLin = (c: GradLike) => c.type === "linear";
	const isRad = (c: GradLike) => c.type === "radial";
	const isSol = (c: GradLike) => c.type === "solid";
	if (
		(isLin(a) && isLin(b)) ||
		(isLin(a) && isSol(b)) ||
		(isSol(a) && isLin(b))
	)
		return "linear";
	if (
		(isRad(a) && isRad(b)) ||
		(isRad(a) && isSol(b)) ||
		(isSol(a) && isRad(b))
	)
		return "radial";
	return null;
}

/** A solid color as a gradient: the reference offsets, all the same color. */
function uniformStops(reference: ColorStop[], color: Color): ColorStop[] {
	if (reference.length === 0) {
		return [
			{ offset: 0, color, midpoint: 0.5 },
			{ offset: 1, color, midpoint: 0.5 },
		];
	}
	return reference.map((s) => ({
		offset: s.offset,
		color,
		midpoint: s.midpoint,
	}));
}

/** Bring both stop lists to max(count) by inserting midpoint stops. */
function normalizeStops(
	a: ColorStop[],
	b: ColorStop[],
): [ColorStop[], ColorStop[]] {
	const target = Math.max(a.length, b.length, 2);
	return [subdivideStopsToCount(a, target), subdivideStopsToCount(b, target)];
}

function subdivideStopsToCount(
	stops: ColorStop[],
	target: number,
): ColorStop[] {
	const result =
		stops.length >= 2
			? [...stops]
			: stops.length === 1
				? [
						{ offset: 0, color: stops[0].color, midpoint: 0.5 },
						{ offset: 1, color: stops[0].color, midpoint: 0.5 },
					]
				: [
						{
							offset: 0,
							color: { type: "rgb", r: 0, g: 0, b: 0, a: 1 },
							midpoint: 0.5,
						} as ColorStop,
						{
							offset: 1,
							color: { type: "rgb", r: 0, g: 0, b: 0, a: 1 },
							midpoint: 0.5,
						} as ColorStop,
					];
	while (result.length < target) {
		// Split the widest offset gap with a stop whose color is sampled there.
		let gapIndex = 0;
		let maxGap = -1;
		for (let i = 0; i < result.length - 1; i++) {
			const gap = result[i + 1].offset - result[i].offset;
			if (gap > maxGap) {
				maxGap = gap;
				gapIndex = i;
			}
		}
		const offset = (result[gapIndex].offset + result[gapIndex + 1].offset) / 2;
		result.splice(gapIndex + 1, 0, {
			offset,
			color: lerpStopColor(
				result[gapIndex].color,
				result[gapIndex + 1].color,
				0.5,
			),
			midpoint: 0.5,
		});
	}
	return result;
}

function lerpStopColor(a: Color, b: Color, t: number): Color {
	return lerpOklab(colorToRgb(a), colorToRgb(b), t);
}

/** Blend steps only interpolate the brush width; everything else is taken
 *  from the first key's brush. */
function interpolateBrushSettings(
	a: BrushSettings | undefined,
	b: BrushSettings | undefined,
	t: number,
): BrushSettings | undefined {
	if (!a) return b;
	if (!b) return a;
	const sizeA = a.properties.size?.base;
	const sizeB = b.properties.size?.base;
	if (sizeA == null || sizeB == null) return a;
	return {
		...a,
		properties: {
			...a.properties,
			size: { ...a.properties.size, base: lerp(sizeA, sizeB, t) },
		},
	};
}

function interpolateColor(
	a: SolidColor["color"],
	b: SolidColor["color"],
	t: number,
): RGBColor {
	return lerpOklab(colorToRgb(a), colorToRgb(b), t);
}

export function colorToRgb(c: SolidColor["color"]): RGBColor {
	if (c.type === "rgb") return c;
	const i = Math.floor(c.h * 6);
	const f = c.h * 6 - i;
	const p = c.v * (1 - c.s);
	const q = c.v * (1 - f * c.s);
	const tt = c.v * (1 - (1 - f) * c.s);
	let r: number;
	let g: number;
	let bl: number;
	switch (i % 6) {
		case 0:
			[r, g, bl] = [c.v, tt, p];
			break;
		case 1:
			[r, g, bl] = [q, c.v, p];
			break;
		case 2:
			[r, g, bl] = [p, c.v, tt];
			break;
		case 3:
			[r, g, bl] = [p, q, c.v];
			break;
		case 4:
			[r, g, bl] = [tt, p, c.v];
			break;
		default:
			[r, g, bl] = [c.v, p, q];
	}
	return { type: "rgb", r, g, b: bl, a: c.a };
}

// ── OKLab color space ─────────────────────────────────────────────────────
// Matrix constants match renderer/filters/hanakla-kit/wgsl-includes.ts.

export interface OklabColor {
	L: number;
	a: number;
	b: number;
	alpha: number;
}

export function rgbToOklab(c: RGBColor): OklabColor {
	const lr = srgbEotf(c.r);
	const lg = srgbEotf(c.g);
	const lb = srgbEotf(c.b);

	const l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
	const m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
	const s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;

	const lp = Math.cbrt(l);
	const mp = Math.cbrt(m);
	const sp = Math.cbrt(s);

	return {
		L: 0.2104542553 * lp + 0.793617785 * mp - 0.0040720468 * sp,
		a: 1.9779984951 * lp - 2.428592205 * mp + 0.4505937099 * sp,
		b: 0.0259040371 * lp + 0.7827717662 * mp - 0.808675766 * sp,
		alpha: c.a,
	};
}

export function oklabToRgb(c: OklabColor): RGBColor {
	const lp = c.L + 0.3963377774 * c.a + 0.2158037573 * c.b;
	const mp = c.L - 0.1055613458 * c.a - 0.0638541728 * c.b;
	const sp = c.L - 0.0894841775 * c.a - 1.291485548 * c.b;

	const l = lp * lp * lp;
	const m = mp * mp * mp;
	const s = sp * sp * sp;

	const lr = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
	const lg = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
	const lb = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;

	return {
		type: "rgb",
		r: clamp01(srgbOetf(Math.max(0, lr))),
		g: clamp01(srgbOetf(Math.max(0, lg))),
		b: clamp01(srgbOetf(Math.max(0, lb))),
		a: c.alpha,
	};
}

export function lerpOklab(a: RGBColor, b: RGBColor, t: number): RGBColor {
	const la = rgbToOklab(a);
	const lb = rgbToOklab(b);
	return oklabToRgb({
		L: lerp(la.L, lb.L, t),
		a: lerp(la.a, lb.a, t),
		b: lerp(la.b, lb.b, t),
		alpha: lerp(la.alpha, lb.alpha, t),
	});
}

function oklabDistance(a: OklabColor, b: OklabColor): number {
	return Math.hypot(b.L - a.L, b.a - a.a, b.b - a.b);
}

// ── Helpers ───────────────────────────────────────────────────────────────

function clamp01(v: number): number {
	return v < 0 ? 0 : v > 1 ? 1 : v;
}

function extractFillRgb(path: Path): RGBColor | null {
	const fill = localAppearances(path.filters).find(
		(f) => f.processor === "fill",
	) as FillAppearance | undefined;
	if (!fill) return null;
	const fillColor = fill.paramData.params.fill;
	if (fillColor.type !== "solid") return null;
	return colorToRgb(fillColor.color);
}
