/**
 * StampGenerator - ブラシストローク用のスタンプ位置を生成
 *
 * ベジェ曲線に沿って等間隔でスタンプ位置を計算し、
 * 筆圧に基づいてサイズと不透明度を決定する
 */

import type {
	BoundingBox,
	CubicBezierSegment,
	ScatterBrushSettings,
	StrokeWidthPoint,
} from "../../../../schema";
import { interpolateStrokeWidths } from "../../../geometry/strokeTessellator";
import {
	type ResolvedTaper,
	resolveTaper,
	taperFactor,
} from "../../../geometry/taper";
import type { GeometryHandle } from "../GeometryStore";
import type { StampHandle } from "../stroke/BoundedStampStore";
import { packStampPathIndex } from "./StampPacking";

/** Resident GPU leases for a cached stroke's stamps, populated lazily by
 *  StrokeBatchContext so pan/zoom frames draw with zero stamp uploads. */
export interface ResidentStamps {
	/** Stamp instances with the meta's absolute store index baked in. */
	stamps: StampHandle;
	meta: GeometryHandle;
	stops: GeometryHandle | null;
	/** CPU copies for change detection — meta/stops rewrite in place when
	 *  color, opacity, or the transform slot drifts. */
	metaSnapshot: Float32Array;
	stopsSnapshot: Float32Array | null;
	/** Frame stamp of the last sync — detects same-submit rewrites that
	 *  would corrupt draws already queued this frame. */
	syncedFrame: number;
	/** CPU bytes retained by this entry while resident, for cache budgeting:
	 *  the ONE shared stamp array (the entry's `data` IS the stamp store's
	 *  regrow mirror) plus the meta/stops snapshots and their GeometryStore
	 *  mirrors. Each physical byte is counted once. */
	byteSize: number;
}

/** GPU送信用のスタンプデータ（Float32Array + 有効スタンプ数） */
export interface StampBuffer {
	/** Stamp instance floats. Once `resident` is attached this is the
	 *  pathIndex-baked run SHARED with the stamp store's regrow mirror —
	 *  never mutate it. */
	data: Float32Array;
	count: number;
	/** Assigned on first batch draw; released with the cache entry. */
	resident?: ResidentStamps;
}

const FLOATS_PER_STAMP = 16;
const MAX_SAMPLES_PER_SEGMENT = 100;

/** Time constants (ms) for the two first-order low-pass velocity trackers.
 *  The fast tracker follows the pen almost immediately; the slow one lags, so
 *  their difference acts as an acceleration signal that thins the stroke while
 *  speeding up (ramp-in) or slowing down (ramp-out). */
const SPEED_TAU_FAST_MS = 25;
const SPEED_TAU_SLOW_MS = 110;
/** Pooling stays disarmed for this long after the stroke (or subpath) starts,
 *  so the low velocity that every stroke begins with never reads as a
 *  deliberate slow-down and blobs the stroke head. */
const POOL_ARM_TIME_MS = 150;
/** Window over which the tracker seed velocity is estimated at a (sub)stroke
 *  head. Real pen input dwells for tens of ms right after touch-down; a
 *  window longer than that dwell lets a fast gesture seed fast even though
 *  its first millimetres are slow. */
const SPEED_SEED_WINDOW_MS = 150;

/** u32値をfloat32のビットパターンとして再解釈する */
const _u32View = new Uint32Array(1);
const _f32View = new Float32Array(_u32View.buffer);
function u32AsFloat(v: number): number {
	_u32View[0] = v;
	return _f32View[0];
}

/**
 * シード付き擬似乱数生成器（mulberry32）
 * 同じシードからは常に同じ乱数列を生成する
 */
function createSeededRng(seed: number): () => number {
	let state = seed | 0;
	return () => {
		state = (state + 0x6d2b_79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 0xffff_ffff;
	};
}

/**
 * セグメントの絶対座標を解決してインライン展開する。
 * resolveSegment/resolveCP1/resolveCP2 のオブジェクト生成を回避して
 * 6つのnumber変数（sx,sy,c1x,c1y,c2x,c2y,ex,ey）に直接格納する。
 */
function resolveSegmentInline(
	segment: CubicBezierSegment,
	prevEndX: number,
	prevEndY: number,
): [
	sx: number,
	sy: number,
	c1x: number,
	c1y: number,
	c2x: number,
	c2y: number,
	ex: number,
	ey: number,
] {
	const sx = segment.start ? segment.start.x : prevEndX;
	const sy = segment.start ? segment.start.y : prevEndY;
	return [
		sx,
		sy,
		sx + segment.cp1.x,
		sy + segment.cp1.y,
		segment.end.x + segment.cp2.x,
		segment.end.y + segment.cp2.y,
		segment.end.x,
		segment.end.y,
	];
}

/**
 * Optional per-stamp nib shape modifier used by procedural-calligraphy mode.
 *
 * `aspectRatio` < 1 squashes the stamp along its local Y axis (after rotation
 * is applied), producing an elliptical nib. `1` keeps the stamp circular.
 */
export interface NibShape {
	/** sizeY = sizeX * aspectRatio (after texture aspect normalization). */
	aspectRatio: number;
}

export const NIB_SHAPE_CIRCLE: NibShape = { aspectRatio: 1 };

/**
 * The stroke hot path: bezier evaluation and segment resolution are kept
 * inline / tuple-based here (rather than calling object-returning helpers) so
 * generating thousands of stamps allocates nothing per segment.
 */
export function generateStampsDirect(
	segments: CubicBezierSegment[],
	settings: ScatterBrushSettings,
	pathIndex: number = 0,
	pathStart: number = 0,
	pathEnd: number = 1,
	strokeWidths?: StrokeWidthPoint[],
	textureAspectRatio: number = 1,
	variantCount: number = 0,
	startLayerIndex: number = -1,
	endLayerIndex: number = -1,
	nibShape: NibShape = NIB_SHAPE_CIRCLE,
): StampBuffer {
	if (segments.length === 0) return { data: EMPTY_F32, count: 0 };

	const baseSpacing = settings.size * settings.spacing;
	const minSpacing = Math.max(baseSpacing, 0.5);
	const brushSize = settings.size;
	const sizeByPressure = settings.sizeByPressure;
	const opacityBase = settings.opacity * settings.flow;
	const opacityByPressure = settings.opacityByPressure;
	const rotationMode = settings.stampRotation ?? "none";
	const useTangent = rotationMode === "tangent";
	const useRandom = rotationMode === "random";
	const stampAngleRad = ((settings.stampAngle ?? 0) * Math.PI) / 180;
	const rng = useRandom ? createSeededRng(settings.randomSeed ?? 0) : null;
	const scatterOffset = settings.scatterOffset ?? 0;
	const scatterSizeVar = settings.scatterSizeVariation ?? 0;
	const hasScatter =
		variantCount > 0 || scatterOffset > 0 || scatterSizeVar > 0;
	// Scatter RNG uses a different seed to avoid disturbing rotation randomness
	const scatterRng = hasScatter
		? createSeededRng((settings.randomSeed ?? 0) ^ 0xa5a5a5a5)
		: null;
	const rotationByTilt = settings.rotationByTilt;
	const aspectRatioByTilt = settings.aspectRatioByTilt;
	const sizeBySpeed = settings.sizeBySpeed;
	const pooling = settings.pooling;
	const poolingSizeRatio = settings.poolingSizeRatio;
	const hasTilt = rotationByTilt > 0 || aspectRatioByTilt > 0;
	const hasPooling = pooling > 0;
	// Full-scale velocity in world px/ms. Hand-drawn strokes move at roughly
	// 0.3–2 px/ms; a weak brush-size proportionality keeps "big brush = big
	// gesture" while the clamp stops large brushes from reading as always-slow.
	const speedRefVelocity = Math.min(Math.max(brushSize * 0.06, 0.5), 2.0);

	const activeStrokeWidths =
		strokeWidths != null && strokeWidths.length > 0 ? strokeWidths : undefined;
	const taperRequested =
		(settings.taperStart ?? 0) > 0 || (settings.taperEnd ?? 0) > 0;
	// Taper needs arc-length-normalized pathT at write time, same as strokeWidths.
	const segLengths =
		activeStrokeWidths != null || taperRequested
			? new Float64Array(segments.length)
			: null;
	let totalPathLength = 0;
	if (segLengths) {
		let peX = 0;
		let peY = 0;
		let hasPrev = false;
		for (let si = 0; si < segments.length; si++) {
			const seg = segments[si];
			const [sx, sy, c1x, c1y, c2x, c2y, ex, ey] = resolveSegmentInline(
				seg,
				peX,
				peY,
			);
			if (!hasPrev && seg.start) {
				hasPrev = true;
			}

			const len = approximateSegmentLength(sx, sy, c1x, c1y, c2x, c2y, ex, ey);
			segLengths[si] = len;
			totalPathLength += len;
			peX = ex;
			peY = ey;
		}
	}

	// Estimate the whole-stroke length from this fragment's share of it so the
	// resolved taper lengths stay consistent across collaboration fragments.
	const taper = taperRequested
		? resolveTaper(
				settings.taperStart,
				settings.taperEnd,
				totalPathLength / Math.max(pathEnd - pathStart, 1e-6),
				pathStart,
				pathEnd,
			)
		: null;

	const maxStamps = segLengths
		? Math.ceil(totalPathLength / minSpacing) + segments.length + 2
		: Math.max(32, segments.length * 4 + 2);
	const stampState: StampWriteState = {
		data: new Float32Array(maxStamps * FLOATS_PER_STAMP),
		count: 0,
		stampIndex: 0,
	};
	const stampConfig: StampWriteConfig = {
		brushSize,
		sizeByPressure,
		opacityBase,
		opacityByPressure,
		hasTilt,
		rotationByTilt,
		aspectRatioByTilt,
		poolingSizeRatio,
		textureAspectRatio,
		nibAspectRatio: nibShape.aspectRatio,
		hasScatter,
		scatterOffset,
		scatterSizeVar,
		scatterRng,
		variantCount,
		startLayerIndex,
		pathIndex,
		strokeWidths: activeStrokeWidths,
		taper,
		fragLength: totalPathLength,
	};

	// 最初のスタンプ
	const firstSeg = segments[0];
	const firstStartX = firstSeg.start?.x ?? firstSeg.end.x;
	const firstStartY = firstSeg.start?.y ?? firstSeg.end.y;
	// When pathStart > 0, this fragment is mid-stroke: use endPressure to
	// suppress the ramp-in that would normally occur at the stroke beginning.
	const firstPressure =
		pathStart > 0
			? (firstSeg.endPressure ?? firstSeg.startPressure ?? 0.5)
			: (firstSeg.startPressure ?? 0.5);

	let firstRotation = stampAngleRad;
	let firstNx = 0;
	let firstNy = 0;
	let firstFlowX = 1;
	let firstFlowY = 0;
	if (useTangent) {
		// 0.01でのtangent近似
		const [sx, sy, c1x, c1y, c2x, c2y, ex, ey] = resolveSegmentInline(
			firstSeg,
			0,
			0,
		);
		const t = 0.01;
		const t1 = 1 - t;
		const t1_2 = t1 * t1;
		const t1_3 = t1_2 * t1;
		const t_2 = t * t;
		const t_3 = t_2 * t;
		const tx = t1_3 * sx + 3 * t1_2 * t * c1x + 3 * t1 * t_2 * c2x + t_3 * ex;
		const ty = t1_3 * sy + 3 * t1_2 * t * c1y + 3 * t1 * t_2 * c2y + t_3 * ey;
		const tdx = tx - firstStartX;
		const tdy = ty - firstStartY;
		if (tdx !== 0 || tdy !== 0) {
			firstRotation += Math.atan2(tdy, tdx) - Math.PI / 2;
			const tLen = Math.sqrt(tdx * tdx + tdy * tdy);
			firstFlowX = tdx / tLen;
			firstFlowY = tdy / tLen;
			firstNx = -firstFlowY;
			firstNy = firstFlowX;
		}
	} else if (useRandom && rng) {
		firstRotation += rng() * Math.PI * 2;
	}

	// Compute initial normal from first segment direction if not yet set
	if (firstNx === 0 && firstNy === 0) {
		const [sx, sy, , , , , ex, ey] = resolveSegmentInline(firstSeg, 0, 0);
		const fdx = ex - sx;
		const fdy = ey - sy;
		const fLen = Math.sqrt(fdx * fdx + fdy * fdy);
		if (fLen > 0) {
			firstFlowX = fdx / fLen;
			firstFlowY = fdy / fLen;
			firstNx = -firstFlowY;
			firstNy = firstFlowX;
		}
	}

	// Seed the velocity trackers from the leading seed window so the head stamp
	// already carries the ramp-in taper. Mid-stroke fragments (pathStart > 0)
	// seed both trackers equally to suppress the taper, same as firstPressure.
	const initialVelocity = estimateSeedVelocity(segments, 0, segLengths, 0, 0);
	const strokeHasTiming = initialVelocity != null;
	let velFast = initialVelocity ?? 0;
	let velSlow = pathStart > 0 ? velFast : 0;
	let strokeStartDT = firstSeg.startDeltaTime;
	let trackedSpeedFactor = strokeHasTiming
		? speedSizeFactor(velFast, velSlow, speedRefVelocity, sizeBySpeed)
		: 1;
	let trackedSpeedNorm = strokeHasTiming
		? Math.min(velFast / speedRefVelocity, 1)
		: 0.5;
	// Head cap: during touch-down dwell the trackers re-learn the dwell's low
	// velocity and would re-fatten the head, so the entry width is additionally
	// capped by a ramp that grows with distance from the stroke start. The
	// ramp starts at the seed-based factor (thin for fast gestures, ~1 for
	// deliberate slow starts) and spans the distance the seed velocity covers
	// within the seed window.
	let headSeedFactor = trackedSpeedFactor;
	let headStartDist = 0;
	let headRampDist = Math.max((initialVelocity ?? 0) * SPEED_SEED_WINDOW_MS, 1);
	let headCapActive = strokeHasTiming && pathStart === 0 && sizeBySpeed > 0;

	const firstTiltX = firstSeg.startTiltX;
	const firstTiltY = firstSeg.startTiltY;
	writeStampDirect(
		stampState,
		stampConfig,
		firstStartX,
		firstStartY,
		firstPressure,
		firstRotation,
		0,
		firstNx,
		firstNy,
		firstTiltX,
		firstTiltY,
		0,
		trackedSpeedFactor,
		firstFlowX,
		firstFlowY,
		trackedSpeedNorm,
		0,
	);

	let accumulatedDistance = 0;
	let globalCumulativeDistance = 0;
	let prevX = firstStartX;
	let prevY = firstStartY;
	let prevPressure = firstPressure;
	let prevEndX = 0;
	let prevEndY = 0;
	let hasPrevEnd = false;
	let prevDeltaTime = firstSeg.startDeltaTime;
	let prevFlowX = firstFlowX;
	let prevFlowY = firstFlowY;

	for (let si = 0; si < segments.length; si++) {
		const segment = segments[si];
		const [sx, sy, c1x, c1y, c2x, c2y, ex, ey] = resolveSegmentInline(
			segment,
			hasPrevEnd ? prevEndX : 0,
			hasPrevEnd ? prevEndY : 0,
		);
		const segLen = segLengths
			? segLengths[si]
			: approximateSegmentLength(sx, sy, c1x, c1y, c2x, c2y, ex, ey);

		// When isMoved is true (start of a new subpath), reset accumulation state
		// to prevent stroke connecting the previous subpath's end to this subpath's start.
		if (segment.isMoved && si > 0) {
			accumulatedDistance = 0;
			prevX = sx;
			prevY = sy;
			prevPressure = segment.startPressure ?? 0.5;
			prevDeltaTime = segment.startDeltaTime;
			const subpathStartRotation =
				stampAngleRad + (useRandom && rng ? rng() * Math.PI * 2 : 0);
			// Normal from segment start→end direction
			const sdx = ex - sx;
			const sdy = ey - sy;
			const sLen = Math.sqrt(sdx * sdx + sdy * sdy);
			const subpathFlowX = sLen > 0 ? sdx / sLen : 1;
			const subpathFlowY = sLen > 0 ? sdy / sLen : 0;
			const snx = -subpathFlowY;
			const sny = subpathFlowX;
			prevFlowX = subpathFlowX;
			prevFlowY = subpathFlowY;
			// Re-seed the velocity trackers: a subpath starts a fresh gesture.
			const subpathVelocity = estimateSeedVelocity(
				segments,
				si,
				segLengths,
				hasPrevEnd ? prevEndX : 0,
				hasPrevEnd ? prevEndY : 0,
			);
			const subpathHasTiming = subpathVelocity != null;
			velFast = subpathVelocity ?? 0;
			velSlow = 0;
			strokeStartDT = segment.startDeltaTime;
			trackedSpeedFactor = subpathHasTiming
				? speedSizeFactor(velFast, velSlow, speedRefVelocity, sizeBySpeed)
				: 1;
			trackedSpeedNorm = subpathHasTiming
				? Math.min(velFast / speedRefVelocity, 1)
				: 0.5;
			headSeedFactor = trackedSpeedFactor;
			headStartDist = globalCumulativeDistance;
			headRampDist = Math.max((subpathVelocity ?? 0) * SPEED_SEED_WINDOW_MS, 1);
			headCapActive = subpathHasTiming && sizeBySpeed > 0;
			writeStampDirect(
				stampState,
				stampConfig,
				sx,
				sy,
				prevPressure,
				subpathStartRotation,
				segLengths
					? globalCumulativeDistance / Math.max(totalPathLength, 1)
					: globalCumulativeDistance,
				snx,
				sny,
				segment.startTiltX,
				segment.startTiltY,
				0,
				trackedSpeedFactor,
				subpathFlowX,
				subpathFlowY,
				trackedSpeedNorm,
				0,
			);
		}

		if (segLen < 0.001) {
			prevEndX = segment.end.x;
			prevEndY = segment.end.y;
			hasPrevEnd = true;
			continue;
		}

		const startPressure = segment.startPressure ?? 0.5;
		// When pathEnd < 1, the last segment is mid-stroke: override endPressure
		// with startPressure to suppress the ramp-out that would normally occur.
		const endPressure =
			pathEnd < 1 && si === segments.length - 1
				? startPressure
				: (segment.endPressure ?? 0.5);

		// Tilt interpolation endpoints for this segment
		const segStartTiltX = segment.startTiltX;
		const segStartTiltY = segment.startTiltY;
		const segEndTiltX = segment.endTiltX;
		const segEndTiltY = segment.endTiltY;
		const segStartDT = segment.startDeltaTime;
		const segEndDT = segment.endDeltaTime;

		const numSamples = Math.min(
			MAX_SAMPLES_PER_SEGMENT,
			Math.max(10, Math.ceil(segLen / Math.max(minSpacing * 0.25, 0.1))),
		);
		const invNumSamples = 1 / numSamples;

		for (let i = 1; i <= numSamples; i++) {
			const t = i * invNumSamples;
			const t1 = 1 - t;
			const t1_2 = t1 * t1;
			const t1_3 = t1_2 * t1;
			const t_2 = t * t;
			const t_3 = t_2 * t;

			const px = t1_3 * sx + 3 * t1_2 * t * c1x + 3 * t1 * t_2 * c2x + t_3 * ex;
			const py = t1_3 * sy + 3 * t1_2 * t * c1y + 3 * t1 * t_2 * c2y + t_3 * ey;
			const currentPressure = startPressure + (endPressure - startPressure) * t;

			// Interpolate tilt and deltaTime
			const currentTiltX = segStartTiltX + (segEndTiltX - segStartTiltX) * t;
			const currentTiltY = segStartTiltY + (segEndTiltY - segStartTiltY) * t;
			const currentDT = segStartDT + (segEndDT - segStartDT) * t;

			const dx = px - prevX;
			const dy = py - prevY;
			const stepDist = Math.sqrt(dx * dx + dy * dy);

			if (stepDist > 0) {
				accumulatedDistance += stepDist;
				globalCumulativeDistance += stepDist;

				// Compute velocity-dependent effects (pooling + speed→size).
				// Steps without usable timing (untimed paths, duplicated or
				// regressive timestamps) leave the trackers untouched, so
				// wholly untimed strokes stay at their neutral seed instead of
				// reading as "fastest = thinnest" like the raw velocity did.
				let effectiveSpacing = minSpacing;
				let currentPoolFactor = 0;
				let currentAccelFactor = 0;
				const rawStepTime = currentDT - prevDeltaTime;
				const flowX = dx / stepDist;
				const flowY = dy / stepDist;
				if (rawStepTime > 0.001) {
					const stepVelocity = stepDist / rawStepTime;
					velFast +=
						(stepVelocity - velFast) *
						(1 - Math.exp(-rawStepTime / SPEED_TAU_FAST_MS));
					velSlow +=
						(stepVelocity - velSlow) *
						(1 - Math.exp(-rawStepTime / SPEED_TAU_SLOW_MS));
					trackedSpeedNorm = Math.min(velFast / speedRefVelocity, 1);
					trackedSpeedFactor = speedSizeFactor(
						velFast,
						velSlow,
						speedRefVelocity,
						sizeBySpeed,
					);
					const turnAmount = Math.min(
						Math.max(0, 1 - (prevFlowX * flowX + prevFlowY * flowY)) * 0.5,
						1,
					);
					currentAccelFactor = Math.min(
						(Math.abs(velFast - velSlow) / speedRefVelocity) * 0.8 + turnAmount,
						1,
					);
				}
				if (hasPooling) {
					const poolGate = Math.min(
						Math.max(currentDT - strokeStartDT, 0) / POOL_ARM_TIME_MS,
						1,
					);
					currentPoolFactor = (1 - trackedSpeedNorm) * pooling * poolGate;
					effectiveSpacing = minSpacing * (1 - currentPoolFactor * 0.6);
				}
				let currentSpeedFactor = trackedSpeedFactor;
				if (headCapActive) {
					const headT = Math.min(
						(globalCumulativeDistance - headStartDist) / headRampDist,
						1,
					);
					if (headT >= 1) {
						headCapActive = false;
					} else {
						const cap = headSeedFactor + (1 - headSeedFactor) * headT;
						if (cap < currentSpeedFactor) currentSpeedFactor = cap;
					}
				}

				while (accumulatedDistance >= effectiveSpacing) {
					const overshoot = accumulatedDistance - effectiveSpacing;
					const ratio = overshoot / stepDist;
					const stampX = px - dx * ratio;
					const stampY = py - dy * ratio;
					const stampPressure =
						currentPressure - (currentPressure - prevPressure) * ratio;

					accumulatedDistance = overshoot;

					let rotation = stampAngleRad;
					if (useTangent) {
						rotation += Math.atan2(dy, dx) - Math.PI / 2;
					} else if (useRandom && rng) {
						rotation += rng() * Math.PI * 2;
					}

					const pathDistance = globalCumulativeDistance - overshoot;
					const pathT = segLengths
						? pathDistance / Math.max(totalPathLength, 1)
						: pathDistance;

					// Normal perpendicular to step direction (rotate 90° CCW)
					const nx = -dy / stepDist;
					const ny = dx / stepDist;

					writeStampDirect(
						stampState,
						stampConfig,
						stampX,
						stampY,
						stampPressure,
						rotation,
						pathT,
						nx,
						ny,
						currentTiltX,
						currentTiltY,
						currentPoolFactor,
						currentSpeedFactor,
						flowX,
						flowY,
						trackedSpeedNorm,
						currentAccelFactor,
					);
				}
				prevFlowX = flowX;
				prevFlowY = flowY;
			}

			prevX = px;
			prevY = py;
			prevPressure = currentPressure;
			prevDeltaTime = currentDT;
		}

		prevEndX = segment.end.x;
		prevEndY = segment.end.y;
		hasPrevEnd = true;
	}

	if (!segLengths && globalCumulativeDistance > 0) {
		normalizeStampPathT(
			stampState.data,
			stampState.count,
			globalCumulativeDistance,
		);
	}

	// Apply endLayerIndex to the last stamp
	if (endLayerIndex >= 0 && stampState.count > 0) {
		const lastOff = (stampState.count - 1) * FLOATS_PER_STAMP;
		// Re-read the current packed value, replace upper 16 bits
		_f32View[0] = stampState.data[lastOff + 6];
		const currentPathIndex = _u32View[0] & 0xffff;
		stampState.data[lastOff + 6] = u32AsFloat(
			(endLayerIndex << 16) | currentPathIndex,
		);
	}

	return { data: stampState.data, count: stampState.count };
}

interface StampWriteState {
	data: Float32Array;
	count: number;
	stampIndex: number;
}

interface StampWriteConfig {
	brushSize: number;
	sizeByPressure: number;
	opacityBase: number;
	opacityByPressure: number;
	hasTilt: boolean;
	rotationByTilt: number;
	aspectRatioByTilt: number;
	poolingSizeRatio: number;
	textureAspectRatio: number;
	nibAspectRatio: number;
	hasScatter: boolean;
	scatterOffset: number;
	scatterSizeVar: number;
	scatterRng: (() => number) | null;
	variantCount: number;
	startLayerIndex: number;
	pathIndex: number;
	strokeWidths: StrokeWidthPoint[] | undefined;
	taper: ResolvedTaper | null;
	/** Arc length of the generated fragment (denominator of pathT). */
	fragLength: number;
}

function approximateSegmentLength(
	sx: number,
	sy: number,
	c1x: number,
	c1y: number,
	c2x: number,
	c2y: number,
	ex: number,
	ey: number,
): number {
	let len = 0;
	let px = sx;
	let py = sy;
	for (let i = 1; i <= 10; i++) {
		const t = i * 0.1;
		const t1 = 1 - t;
		const t1_2 = t1 * t1;
		const t1_3 = t1_2 * t1;
		const t_2 = t * t;
		const t_3 = t_2 * t;
		const nx = t1_3 * sx + 3 * t1_2 * t * c1x + 3 * t1 * t_2 * c2x + t_3 * ex;
		const ny = t1_3 * sy + 3 * t1_2 * t * c1y + 3 * t1 * t_2 * c2y + t_3 * ey;
		const ddx = nx - px;
		const ddy = ny - py;
		len += Math.sqrt(ddx * ddx + ddy * ddy);
		px = nx;
		py = ny;
	}
	return len;
}

/**
 * Speed→size response combining two effects behind one influence value:
 * steady thinning at sustained speed and a taper while accelerating or
 * decelerating (|velFast - velSlow|, the acceleration proxy) so strokes
 * enter thin, reach the speed-appropriate width at constant speed, and exit
 * thin again. Steady reads max(velFast, velSlow): the slow tracker alone is
 * zero at the stroke head (cancelling the entry taper), the fast tracker
 * alone collapses during deceleration (cancelling the exit taper).
 */
function speedSizeFactor(
	velFast: number,
	velSlow: number,
	refVelocity: number,
	sizeBySpeed: number,
): number {
	if (sizeBySpeed <= 0) return 1;
	const steady =
		1 -
		sizeBySpeed * Math.min(Math.max(velFast, velSlow) / refVelocity, 1) * 0.7;
	const ramp =
		1 -
		sizeBySpeed * Math.min(Math.abs(velFast - velSlow) / refVelocity, 1) * 0.85;
	return Math.max(steady * ramp, 0.1);
}

/**
 * Average velocity (world px/ms) over roughly the first SPEED_SEED_WINDOW_MS
 * of the (sub)stroke starting at segIndex, or null when those segments carry
 * no usable timing. Averaging over a window instead of the first segment
 * alone rides over the touch-down dwell that real pen input starts with.
 */
function estimateSeedVelocity(
	segments: CubicBezierSegment[],
	segIndex: number,
	segLengths: Float64Array | null,
	prevEndX: number,
	prevEndY: number,
): number | null {
	let dist = 0;
	let time = 0;
	let peX = prevEndX;
	let peY = prevEndY;
	for (let si = segIndex; si < segments.length; si++) {
		const segment = segments[si];
		if (si > segIndex && segment.isMoved) break;
		const [sx, sy, c1x, c1y, c2x, c2y, ex, ey] = resolveSegmentInline(
			segment,
			peX,
			peY,
		);
		dist += segLengths
			? segLengths[si]
			: approximateSegmentLength(sx, sy, c1x, c1y, c2x, c2y, ex, ey);
		time += Math.max(segment.endDeltaTime - segment.startDeltaTime, 0);
		peX = ex;
		peY = ey;
		if (time >= SPEED_SEED_WINDOW_MS) break;
	}
	return time > 0.001 ? dist / time : null;
}

function writeStampDirect(
	state: StampWriteState,
	config: StampWriteConfig,
	x: number,
	y: number,
	pressure: number,
	rotation: number,
	pathT: number,
	normalX: number,
	normalY: number,
	tiltX: number = 0,
	tiltY: number = 0,
	poolFactor: number = 0,
	speedFactor: number = 1,
	flowX: number = normalY,
	flowY: number = -normalX,
	motionSpeed: number = 0.5,
	motionAccel: number = 0,
): void {
	if (state.count * FLOATS_PER_STAMP >= state.data.length) {
		const newData = new Float32Array(state.data.length * 2);
		newData.set(state.data);
		state.data = newData;
	}
	const data = state.data;
	const off = state.count * FLOATS_PER_STAMP;
	const pf = 1 - config.sizeByPressure + config.sizeByPressure * pressure;
	const opf =
		1 - config.opacityByPressure + config.opacityByPressure * pressure;

	let tiltRotation = 0;
	let tiltAspectRatio = 1;
	if (config.hasTilt) {
		const tiltMag = Math.sqrt(tiltX * tiltX + tiltY * tiltY) / 90;
		if (tiltMag > 0.001) {
			tiltRotation = Math.atan2(tiltY, tiltX) * tiltMag * config.rotationByTilt;
			tiltAspectRatio = 1 - config.aspectRatioByTilt * tiltMag * 0.7;
		}
	}

	const poolSizeFactor = 1 + poolFactor * config.poolingSizeRatio * 0.3;
	const poolOpacityFactor =
		1 + poolFactor * (1 - config.poolingSizeRatio) * 0.5;

	let sizeX =
		config.brushSize *
		pf *
		poolSizeFactor *
		speedFactor *
		Math.max(config.textureAspectRatio, 1);
	if (config.taper) {
		// Size only — opacity is intentionally untouched. sizeY derives from sizeX.
		sizeX *= taperFactor(
			config.taper,
			pathT * config.fragLength,
			config.fragLength,
		);
	}

	let stampX = x;
	let stampY = y;
	const scatterRng = config.scatterRng;
	if (config.hasScatter && scatterRng) {
		if (config.scatterOffset > 0) {
			const jitter =
				(scatterRng() * 2 - 1) * config.scatterOffset * config.brushSize;
			stampX += normalX * jitter;
			stampY += normalY * jitter;
		}
		if (config.scatterSizeVar > 0) {
			sizeX *= 1 + (scatterRng() * 2 - 1) * config.scatterSizeVar;
		}
	}

	data[off] = stampX;
	data[off + 1] = stampY;
	data[off + 2] = sizeX;
	data[off + 3] = Math.min(config.opacityBase * opf * poolOpacityFactor, 1);
	data[off + 4] = rotation + tiltRotation;
	data[off + 5] = pathT;

	let textureLayer = 0;
	if (config.variantCount > 0 && scatterRng) {
		textureLayer = Math.floor(scatterRng() * config.variantCount);
	}
	if (state.stampIndex === 0 && config.startLayerIndex >= 0) {
		textureLayer = config.startLayerIndex;
	}
	data[off + 6] = u32AsFloat(
		packStampPathIndex(config.pathIndex, textureLayer),
	);
	data[off + 7] =
		(sizeX * tiltAspectRatio * config.nibAspectRatio) /
		config.textureAspectRatio;

	if (config.strokeWidths) {
		const { side1, side2 } = interpolateStrokeWidths(
			config.strokeWidths,
			pathT,
		);
		data[off + 8] = side1;
		data[off + 9] = side2;
	} else {
		data[off + 8] = 1;
		data[off + 9] = 1;
	}

	data[off + 10] = normalX;
	data[off + 11] = normalY;
	const flowLen = Math.sqrt(flowX * flowX + flowY * flowY);
	if (flowLen > 0) {
		data[off + 12] = flowX / flowLen;
		data[off + 13] = flowY / flowLen;
	} else {
		data[off + 12] = normalY;
		data[off + 13] = -normalX;
	}
	data[off + 14] = Math.max(0, Math.min(motionSpeed, 1));
	data[off + 15] = Math.max(0, Math.min(motionAccel, 1));
	state.count++;
	state.stampIndex++;
}

function normalizeStampPathT(
	data: Float32Array,
	count: number,
	totalPathLength: number,
): void {
	for (let i = 0; i < count; i++) {
		data[i * FLOATS_PER_STAMP + 5] /= totalPathLength;
	}
}

const EMPTY_F32 = new Float32Array(0);

// ── grow-only cull出力バッファ（フレーム間で再利用） ──
// WebGPUのwriteBufferはresizable ArrayBufferを受け付けないため、
// 通常のFloat32Arrayをgrow-onlyで再利用する。
let cullView = new Float32Array(4096);

function ensureCullBuffer(requiredFloats: number): void {
	if (cullView.length >= requiredFloats) return;
	cullView = new Float32Array(Math.max(requiredFloats, cullView.length * 2));
}

/**
 * ビューポート内のスタンプのみをフィルタリング（Float32Arrayベース）
 * 長いパスのレンダリングパフォーマンス最適化用
 *
 * 返されるStampBuffer.dataは共有バッファを参照するため、
 * 次のcullStampBufferToViewport呼び出しで上書きされる。
 * 呼び出し元は返却後すぐにデータをコピーすること。
 */
export function cullStampBufferToViewport(
	buf: StampBuffer,
	viewportBounds: BoundingBox,
	margin: number,
): StampBuffer {
	const minX = viewportBounds.minX - margin;
	const minY = viewportBounds.minY - margin;
	const maxX = viewportBounds.maxX + margin;
	const maxY = viewportBounds.maxY + margin;

	const { data, count } = buf;
	ensureCullBuffer(count * FLOATS_PER_STAMP);
	const out = cullView;
	let outCount = 0;

	for (let i = 0; i < count; i++) {
		const off = i * FLOATS_PER_STAMP;
		const x = data[off];
		const y = data[off + 1];
		if (x >= minX && x <= maxX && y >= minY && y <= maxY) {
			const outOff = outCount * FLOATS_PER_STAMP;
			out.set(data.subarray(off, off + FLOATS_PER_STAMP), outOff);
			outCount++;
		}
	}

	return { data: out, count: outCount };
}
