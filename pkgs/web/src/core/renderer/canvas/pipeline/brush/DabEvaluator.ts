import { neutralizeSizeCurves } from "../../../../brush/access";
import {
	bakeBrushProperties,
	evalBrushProperty,
} from "../../../../brush/evaluateProperties";
import { BRUSH_PROPERTY_REGISTRY } from "../../../../brush/properties";
import type {
	BrushInputId,
	BrushSettingsV2,
	CubicBezierSegment,
	StrokeWidthPoint,
} from "../../../../schema";
import { interpolateStrokeWidths } from "../../../geometry/strokeTessellator";
import { resolveTaper, taperFactor } from "../../../geometry/taper";
import { DAB_FIELD_OFFSETS, DAB_INSTANCE_FLOATS } from "./DabInstanceLayout";
import { packStampPathIndex } from "./StampPacking";
import { hardnessToLutIndex } from "./TipMaskBuilder";

/**
 * DabEvaluator — curve-matrix dab generation (design §7).
 *
 * Replaces StampGenerator for the dab engine: walks the stroke segments,
 * samples the inputs (pressure/speed EMAs/accel/tilt/twist/strokeT/...),
 * evaluates the property curve matrix per dab and writes 24-float instances
 * (DabInstanceLayout). Spacing integrates distance and timed intervals and
 * takes the earlier one (Krita's min-of-factors rule); both accumulators
 * reset on every emitted dab.
 */

export interface DabEvaluateOptions {
	pathIndex?: number;
	pathStart?: number;
	pathEnd?: number;
	strokeWidths?: StrokeWidthPoint[];
	/**
	 * Path.strokeWidthsBaked: strokeWidths carries the size-curve evaluation
	 * baked at commit. Size curves are skipped, and the profile scales the
	 * stamp size (with its asymmetry as a normal offset) instead of clipping
	 * alpha — a clipped full-size stamp keeps its along-stroke extent and
	 * pokes past corners.
	 */
	strokeWidthsBaked?: boolean;
	textureAspectRatio?: number;
	/** Number of texture-array variants for random tip selection. */
	variantCount?: number;
	startLayerIndex?: number;
	endLayerIndex?: number;
	/**
	 * Continue from a previous chunk's end state. The chunked result is
	 * bit-identical to a full evaluation as long as every chunk receives the
	 * same `totalLength` (see the incremental-resume tests).
	 */
	resume?: DabEvalState;
	/**
	 * Full-stroke arc length when `segments` is only a fragment of the
	 * stroke. strokeT/fade normalization and taper use this instead of the
	 * fragment's own length.
	 */
	totalLength?: number;
}

/**
 * Everything the segment walk carries between dabs. Opaque to callers:
 * capture it from one chunk's DabBuffer and feed it to the next.
 */
export interface DabEvalState {
	velFast: number;
	velSlow: number;
	speedFine: number;
	speedGross: number;
	accel: number;
	accDist: number;
	accTime: number;
	spacingWorld: number;
	timedInterval: number;
	globalDistance: number;
	prevX: number;
	prevY: number;
	prevPressure: number;
	prevDeltaTime: number;
	prevDirX: number;
	prevDirY: number;
	prevEndX: number;
	prevEndY: number;
	hasPrevEnd: boolean;
	/** Dabs emitted across all prior chunks. */
	dabCount: number;
	/** mulberry32 internal state of the per-dab rng. */
	rngState: number;
}

export interface DabBuffer {
	data: Float32Array;
	count: number;
	/** Per-dab {colorRate, alphaRate, smudgeLength, 0} vec4s for the mix
	 *  pass; empty unless settings.mixing.enabled (explicit gate, §H-3). */
	mixParams: Float32Array;
	/** End state for incremental continuation (evaluateDabs `resume`). */
	state: DabEvalState;
	/** Arc length the walk normalized against (options.totalLength wins). */
	totalLength: number;
}

/** Speed EMA defaults (carried over from the v1 stamp generator). */
export const DEFAULT_SPEED_FINE_TAU_MS = 25;
export const DEFAULT_SPEED_GROSS_TAU_MS = 110;
/** opaque_linearize strength (MyPaint default). */
export const OPAQUE_LINEARIZE = 0.9;
/** fade input saturates after this many brush sizes of travel. */
const FADE_SATURATION_SIZES = 32;
/** distance input saturates after this world distance. */
const DISTANCE_SATURATION_PX = 1024;
const MAX_SAMPLES_PER_SEGMENT = 100;
const MIN_SPACING_WORLD = 0.5;
const EMPTY_F32 = new Float32Array(0);

export function evaluateDabs(
	segments: CubicBezierSegment[],
	settings: BrushSettingsV2,
	options: DabEvaluateOptions = {},
): DabBuffer {
	const resume = options.resume;
	if (settings.engine !== "dab" || segments.length === 0) {
		return {
			data: EMPTY_F32,
			count: 0,
			mixParams: EMPTY_F32,
			state: resume ?? initialEvalState(settings),
			totalLength: options.totalLength ?? 0,
		};
	}

	const pathStart = options.pathStart ?? 0;
	const pathEnd = options.pathEnd ?? 1;
	const textureAspectRatio = Math.max(options.textureAspectRatio ?? 1, 1e-6);
	const strokeWidths =
		options.strokeWidths != null && options.strokeWidths.length > 0
			? options.strokeWidths
			: undefined;
	const widthsBaked =
		options.strokeWidthsBaked === true && strokeWidths != null;

	const baked = bakeBrushProperties(
		widthsBaked ? neutralizeSizeCurves(settings) : settings,
	);
	const sizeBase =
		settings.properties.size?.base ?? BRUSH_PROPERTY_REGISTRY.size.base;
	const wetEnabled = settings.wet?.enabled === true;
	const tangentAngle = settings.tip?.angleMode === "tangent";

	// Seeded rngs keep the output a pure function of (segments, settings).
	// Resumed chunks continue the same random sequence.
	let dabRngState = (resume?.rngState ?? settings.randomSeed) >>> 0;
	const dabRng = (): number => {
		dabRngState = (dabRngState + 0x6d2b79f5) >>> 0;
		let t = dabRngState;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	const strokeRng = mulberry32((settings.randomSeed ^ 0x9e3779b9) >>> 0);
	const randomPerStroke = strokeRng();

	// --- arc lengths -------------------------------------------------------
	const segLengths = new Float64Array(segments.length);
	let fragmentLength = 0;
	{
		let prevEndX = resume?.hasPrevEnd ? resume.prevEndX : 0;
		let prevEndY = resume?.hasPrevEnd ? resume.prevEndY : 0;
		for (let si = 0; si < segments.length; si++) {
			const [sx, sy, c1x, c1y, c2x, c2y, ex, ey] = resolveSegment(
				segments[si],
				prevEndX,
				prevEndY,
			);
			const len = approximateCubicLength(sx, sy, c1x, c1y, c2x, c2y, ex, ey);
			segLengths[si] = len;
			fragmentLength += len;
			prevEndX = ex;
			prevEndY = ey;
		}
	}
	const totalLength = options.totalLength ?? fragmentLength;
	// A held airbrush has no length at all but still sprays, so only bail out
	// when nothing can produce a dab.
	const heldOnly =
		totalLength <= 0 &&
		segments.some((seg) => seg.endDeltaTime - seg.startDeltaTime > 0);
	if (totalLength <= 0 && !heldOnly) {
		return {
			data: EMPTY_F32,
			count: 0,
			mixParams: EMPTY_F32,
			state: resume ?? initialEvalState(settings),
			totalLength: 0,
		};
	}

	const taper =
		(settings.taperStart ?? 0) > 0 || (settings.taperEnd ?? 0) > 0
			? resolveTaper(
					settings.taperStart,
					settings.taperEnd,
					totalLength / Math.max(pathEnd - pathStart, 1e-6),
					pathStart,
					pathEnd,
				)
			: null;

	const speedRef =
		settings.inputDynamics?.speedRef ??
		Math.min(Math.max(sizeBase * 0.06, 0.5), 2.0);
	const fineTau =
		settings.inputDynamics?.speedFineTau ?? DEFAULT_SPEED_FINE_TAU_MS;
	const grossTau =
		settings.inputDynamics?.speedGrossTau ?? DEFAULT_SPEED_GROSS_TAU_MS;

	// --- output state ------------------------------------------------------
	const estimatedDabs =
		Math.ceil(fragmentLength / Math.max(sizeBase * 0.05, MIN_SPACING_WORLD)) +
		segments.length +
		2;
	const priorDabs = resume?.dabCount ?? 0;
	let data = new Float32Array(estimatedDabs * DAB_INSTANCE_FLOATS);
	const mixingEnabled = settings.mixing?.enabled === true;
	let mixParams = mixingEnabled
		? new Float32Array(estimatedDabs * 4)
		: EMPTY_F32;
	let count = 0;

	const inputs: Record<BrushInputId, number> = {
		pressure: 0,
		speedFine: 0,
		speedGross: 0,
		accel: 0,
		tiltMagnitude: 0,
		tiltAzimuth: 0.5,
		twist: 0,
		direction: 0.5,
		strokeT: pathStart,
		fade: 0,
		distance: 0,
		randomPerDab: 0,
		randomPerStroke,
	};

	// Color dynamics ride along as offsets, not as a resolved color: the
	// gradient switch and the mix pass both resolve color in the shader, so a
	// baked color here would have to duplicate them (design §5).
	const colorDynamic =
		settings.properties.hueShift != null ||
		settings.properties.satShift != null ||
		settings.properties.valShift != null;
	const pathIndex = options.pathIndex ?? 0;
	const variantCount = options.variantCount ?? 0;

	const emit = (
		x: number,
		y: number,
		pressure: number,
		tiltX: number,
		tiltY: number,
		twistDeg: number,
		flowX: number,
		flowY: number,
		fragDistance: number,
	): void => {
		if ((count + 1) * DAB_INSTANCE_FLOATS > data.length) {
			const grown = new Float32Array(data.length * 2);
			grown.set(data);
			data = grown;
			if (mixingEnabled) {
				const grownMix = new Float32Array(mixParams.length * 2);
				grownMix.set(mixParams);
				mixParams = grownMix;
			}
		}

		const fragT = totalLength > 0 ? fragDistance / totalLength : 0;
		inputs.pressure = clamp01(pressure);
		inputs.tiltMagnitude = clamp01(Math.hypot(tiltX, tiltY) / 90);
		inputs.tiltAzimuth =
			inputs.tiltMagnitude > 1e-3
				? (Math.atan2(tiltY, tiltX) + Math.PI) / (2 * Math.PI)
				: 0.5;
		inputs.twist = clamp01((((twistDeg % 360) + 360) % 360) / 360);
		inputs.direction = (Math.atan2(flowY, flowX) + Math.PI) / (2 * Math.PI);
		inputs.strokeT = pathStart + (pathEnd - pathStart) * fragT;
		inputs.fade = clamp01(fragDistance / (sizeBase * FADE_SATURATION_SIZES));
		inputs.distance = clamp01(fragDistance / DISTANCE_SATURATION_PX);
		inputs.randomPerDab = dabRng();

		const sizeVal = evalBrushProperty(baked, "size", inputs);
		const ratioVal = evalBrushProperty(baked, "ratio", inputs);
		const angleVal = evalBrushProperty(baked, "angle", inputs);
		const flowVal = evalBrushProperty(baked, "flow", inputs);
		const spacingVal = evalBrushProperty(baked, "spacing", inputs);
		const scatterOffsetVal = evalBrushProperty(baked, "scatterOffset", inputs);
		const scatterAlongVal = evalBrushProperty(baked, "scatterAlong", inputs);
		const hardnessVal = evalBrushProperty(baked, "hardness", inputs);
		const grainVal = evalBrushProperty(baked, "grainStrength", inputs);

		const taperF = taper ? taperFactor(taper, fragDistance, totalLength) : 1;
		let sizeX = sizeVal * taperF * Math.max(textureAspectRatio, 1);
		let sizeY = (sizeX * ratioVal) / textureAspectRatio;

		let side1 = 1;
		let side2 = 1;
		let bakedNormalOffset = 0;
		if (strokeWidths) {
			const widths = interpolateStrokeWidths(strokeWidths, fragT);
			if (widthsBaked) {
				// Baked profile IS the width: scale the stamp instead of clipping
				// its alpha, so the mark stays a round stamp (clipped full-size
				// stamps keep their along-stroke extent and poke past corners).
				const halfRatio = (widths.side1 + widths.side2) * 0.5;
				if (halfRatio <= 0) return;
				sizeX *= halfRatio;
				sizeY *= halfRatio;
				bakedNormalOffset =
					(widths.side1 - widths.side2) * 0.25 * sizeVal * taperF;
			} else {
				side1 = widths.side1;
				side2 = widths.side2;
			}
		}

		// Scatter offsets displace along the normal / tangent as size ratios.
		const normalX = -flowY;
		const normalY = flowX;
		let dabX = x;
		let dabY = y;
		if (bakedNormalOffset !== 0) {
			dabX += normalX * bakedNormalOffset;
			dabY += normalY * bakedNormalOffset;
		}
		if (scatterOffsetVal !== 0) {
			const jitter = (inputs.randomPerDab * 2 - 1) * scatterOffsetVal * sizeVal;
			dabX += normalX * jitter;
			dabY += normalY * jitter;
		}
		if (scatterAlongVal !== 0) {
			const jitter = (dabRng() * 2 - 1) * scatterAlongVal * sizeVal;
			dabX += flowX * jitter;
			dabY += flowY * jitter;
		}

		let alpha: number;
		if (settings.paintMode === "wash") {
			// strokeOpacity applies exactly once at composite time.
			alpha = flowVal;
		} else {
			// Overlap counts the dab's actual stamped diameter, not the
			// configured base size: a size or taper modulation that shrinks a
			// dab thins its overlap in equal measure, and assuming 1/spacing
			// here left pressure-shrunk strokes far lighter than their flow.
			// sizeX / max(aspect, 1) recovers that diameter including the baked
			// width ratio.
			const spacingWorld = Math.max(sizeBase * spacingVal, MIN_SPACING_WORLD);
			const overlap = sizeX / Math.max(textureAspectRatio, 1) / spacingWorld;
			const dabsPerPixel = Math.max(1 + OPAQUE_LINEARIZE * (overlap - 1), 1);
			alpha =
				1 -
				(1 - clamp01(flowVal * settings.strokeOpacity)) ** (1 / dabsPerPixel);
		}

		let rotation = angleVal;
		if (tangentAngle && (flowX !== 0 || flowY !== 0)) {
			rotation += Math.atan2(flowY, flowX) - Math.PI / 2;
		}

		let textureLayer = 0;
		if (variantCount > 0) {
			textureLayer = Math.floor(dabRng() * variantCount);
		}
		if (priorDabs + count === 0 && (options.startLayerIndex ?? -1) >= 0) {
			textureLayer = options.startLayerIndex ?? 0;
		}

		const off = count * DAB_INSTANCE_FLOATS;
		data[off + DAB_FIELD_OFFSETS.positionX] = dabX;
		data[off + DAB_FIELD_OFFSETS.positionY] = dabY;
		data[off + DAB_FIELD_OFFSETS.sizeX] = sizeX;
		data[off + DAB_FIELD_OFFSETS.alpha] = Math.min(alpha, 1);
		data[off + DAB_FIELD_OFFSETS.rotation] = rotation;
		data[off + DAB_FIELD_OFFSETS.pathT] = fragT;
		data[off + DAB_FIELD_OFFSETS.packedMeta] = u32AsFloat(
			packStampPathIndex(pathIndex, textureLayer),
		);
		data[off + DAB_FIELD_OFFSETS.sizeY] = sizeY;
		data[off + DAB_FIELD_OFFSETS.side1Width] = side1;
		data[off + DAB_FIELD_OFFSETS.side2Width] = side2;
		data[off + DAB_FIELD_OFFSETS.normalX] = normalX;
		data[off + DAB_FIELD_OFFSETS.normalY] = normalY;
		data[off + DAB_FIELD_OFFSETS.strokeDirX] = flowX;
		data[off + DAB_FIELD_OFFSETS.strokeDirY] = flowY;
		data[off + DAB_FIELD_OFFSETS.motionSpeed] = inputs.speedFine;
		data[off + DAB_FIELD_OFFSETS.motionAccel] = inputs.accel;
		if (colorDynamic) {
			data[off + DAB_FIELD_OFFSETS.packedColorShift0] = u32AsFloat(
				pack2x16snorm(
					evalBrushProperty(baked, "hueShift", inputs),
					evalBrushProperty(baked, "satShift", inputs),
				),
			);
			data[off + DAB_FIELD_OFFSETS.packedColorShift1] = u32AsFloat(
				pack2x16snorm(evalBrushProperty(baked, "valShift", inputs), 0),
			);
		}
		data[off + DAB_FIELD_OFFSETS.hardnessLutIndex] =
			hardnessToLutIndex(hardnessVal);
		data[off + DAB_FIELD_OFFSETS.grainStrength] = grainVal;
		if (wetEnabled) {
			data[off + DAB_FIELD_OFFSETS.wetness] = evalBrushProperty(
				baked,
				"wetness",
				inputs,
			);
			data[off + DAB_FIELD_OFFSETS.directionality] = evalBrushProperty(
				baked,
				"directionality",
				inputs,
			);
			data[off + DAB_FIELD_OFFSETS.grainAmount] = evalBrushProperty(
				baked,
				"grainAmount",
				inputs,
			);
		} else {
			data[off + DAB_FIELD_OFFSETS.wetness] = 0;
			data[off + DAB_FIELD_OFFSETS.directionality] = 0;
			data[off + DAB_FIELD_OFFSETS.grainAmount] = 0;
		}
		data[off + DAB_FIELD_OFFSETS.packedWetCoefficients] = wetEnabled
			? u32AsFloat(
					pack5x6unorm(
						evalBrushProperty(baked, "absorption", inputs),
						evalBrushProperty(baked, "granulation", inputs),
						evalBrushProperty(baked, "bleedSoftness", inputs),
						evalBrushProperty(baked, "edgeDarkening", inputs),
						evalBrushProperty(baked, "edgeRoughness", inputs),
					),
				)
			: 0;
		if (mixingEnabled) {
			const mixOff = count * 4;
			mixParams[mixOff] = evalBrushProperty(baked, "colorRate", inputs);
			mixParams[mixOff + 1] = evalBrushProperty(baked, "alphaRate", inputs);
			mixParams[mixOff + 2] = evalBrushProperty(baked, "smudgeLength", inputs);
		}
		count++;
	};

	// Spacing thresholds re-evaluated after every emitted dab.
	const currentSpacingWorld = (): number =>
		Math.max(
			sizeBase * evalBrushProperty(baked, "spacing", inputs),
			MIN_SPACING_WORLD,
		);
	const currentTimedInterval = (): number => {
		const dps = evalBrushProperty(baked, "dabsPerSecond", inputs);
		return dps > 0 ? 1000 / dps : Number.POSITIVE_INFINITY;
	};

	// --- walk --------------------------------------------------------------
	let velFast: number;
	let velSlow: number;
	let accDist: number;
	let accTime: number;
	let spacingWorld: number;
	let timedInterval: number;
	let globalDistance: number;
	let prevX: number;
	let prevY: number;
	let prevPressure: number;
	let prevDeltaTime: number;
	let prevDirX: number;
	let prevDirY: number;
	let prevEndX: number;
	let prevEndY: number;
	let hasPrevEnd: boolean;

	if (resume) {
		velFast = resume.velFast;
		velSlow = resume.velSlow;
		inputs.speedFine = resume.speedFine;
		inputs.speedGross = resume.speedGross;
		inputs.accel = resume.accel;
		accDist = resume.accDist;
		accTime = resume.accTime;
		spacingWorld = resume.spacingWorld;
		timedInterval = resume.timedInterval;
		globalDistance = resume.globalDistance;
		prevX = resume.prevX;
		prevY = resume.prevY;
		prevPressure = resume.prevPressure;
		prevDeltaTime = resume.prevDeltaTime;
		prevDirX = resume.prevDirX;
		prevDirY = resume.prevDirY;
		prevEndX = resume.prevEndX;
		prevEndY = resume.prevEndY;
		hasPrevEnd = resume.hasPrevEnd;
	} else {
		const firstSeg = segments[0];
		velFast = 0;
		velSlow = 0;
		{
			// Seed velocity from the first segment's timing so speed curves do
			// not ramp from zero on every stroke. Mid-stroke fragments seed both
			// EMAs equally (ramp-in suppression).
			const duration = firstSeg.endDeltaTime - firstSeg.startDeltaTime;
			if (duration > 0 && segLengths[0] > 0) {
				velFast = segLengths[0] / duration;
				velSlow = pathStart > 0 ? velFast : 0;
			}
		}

		const [fsx, fsy, , , , , fex, fey] = resolveSegment(firstSeg, 0, 0);
		const firstPressure =
			pathStart > 0
				? (firstSeg.endPressure ?? firstSeg.startPressure ?? 0.5)
				: (firstSeg.startPressure ?? 0.5);
		let firstDirX = 1;
		let firstDirY = 0;
		{
			const dx = fex - fsx;
			const dy = fey - fsy;
			const len = Math.hypot(dx, dy);
			if (len > 0) {
				firstDirX = dx / len;
				firstDirY = dy / len;
			}
		}

		inputs.speedFine = Math.min(velFast / speedRef, 1);
		inputs.speedGross = Math.min(velSlow / speedRef, 1);
		inputs.accel = 0;

		emit(
			fsx,
			fsy,
			firstPressure,
			firstSeg.startTiltX,
			firstSeg.startTiltY,
			firstSeg.startTwist ?? 0,
			firstDirX,
			firstDirY,
			0,
		);

		accDist = 0;
		accTime = 0;
		spacingWorld = currentSpacingWorld();
		timedInterval = currentTimedInterval();
		globalDistance = 0;
		prevX = fsx;
		prevY = fsy;
		prevPressure = firstPressure;
		prevDeltaTime = firstSeg.startDeltaTime;
		prevDirX = firstDirX;
		prevDirY = firstDirY;
		prevEndX = 0;
		prevEndY = 0;
		hasPrevEnd = false;
	}

	for (let si = 0; si < segments.length; si++) {
		const segment = segments[si];
		const [sx, sy, c1x, c1y, c2x, c2y, ex, ey] = resolveSegment(
			segment,
			hasPrevEnd ? prevEndX : 0,
			hasPrevEnd ? prevEndY : 0,
		);
		const segLen = segLengths[si];

		if (segment.isMoved && (si > 0 || resume != null)) {
			// New subpath: restart accumulation and emit its head dab.
			accDist = 0;
			accTime = 0;
			prevX = sx;
			prevY = sy;
			prevPressure = segment.startPressure ?? 0.5;
			prevDeltaTime = segment.startDeltaTime;
			const dx = ex - sx;
			const dy = ey - sy;
			const len = Math.hypot(dx, dy);
			prevDirX = len > 0 ? dx / len : 1;
			prevDirY = len > 0 ? dy / len : 0;
			emit(
				sx,
				sy,
				prevPressure,
				segment.startTiltX,
				segment.startTiltY,
				segment.startTwist ?? 0,
				prevDirX,
				prevDirY,
				globalDistance,
			);
			spacingWorld = currentSpacingWorld();
			timedInterval = currentTimedInterval();
		}

		if (segLen < 0.001) {
			// Airbrush hold: no distance accrues, but time does. Without this
			// a stylus held in place stops laying down paint entirely, since
			// the sample walk below is driven by arc length.
			const heldTime = segment.endDeltaTime - segment.startDeltaTime;
			if (heldTime > 0) {
				const decay = 1 - Math.exp(-heldTime / fineTau);
				velFast += (0 - velFast) * decay;
				velSlow += (0 - velSlow) * (1 - Math.exp(-heldTime / grossTau));
				inputs.speedFine = Math.min(velFast / speedRef, 1);
				inputs.speedGross = Math.min(velSlow / speedRef, 1);
				inputs.accel = 0;
				accTime += heldTime;
				while (Number.isFinite(timedInterval) && accTime >= timedInterval) {
					accTime -= timedInterval;
					emit(
						ex,
						ey,
						segment.endPressure ?? prevPressure,
						segment.endTiltX,
						segment.endTiltY,
						segment.endTwist ?? 0,
						prevDirX,
						prevDirY,
						globalDistance,
					);
					spacingWorld = currentSpacingWorld();
					timedInterval = currentTimedInterval();
				}
				prevDeltaTime = segment.endDeltaTime;
			}
			prevEndX = segment.end.x;
			prevEndY = segment.end.y;
			hasPrevEnd = true;
			continue;
		}

		const startPressure = segment.startPressure ?? 0.5;
		const endPressure =
			pathEnd < 1 && si === segments.length - 1
				? startPressure
				: (segment.endPressure ?? 0.5);

		const numSamples = Math.min(
			MAX_SAMPLES_PER_SEGMENT,
			Math.max(10, Math.ceil(segLen / Math.max(spacingWorld * 0.25, 0.1))),
		);

		for (let i = 1; i <= numSamples; i++) {
			const t = i / numSamples;
			const omt = 1 - t;
			const px =
				omt * omt * omt * sx +
				3 * omt * omt * t * c1x +
				3 * omt * t * t * c2x +
				t * t * t * ex;
			const py =
				omt * omt * omt * sy +
				3 * omt * omt * t * c1y +
				3 * omt * t * t * c2y +
				t * t * t * ey;
			const samplePressure = startPressure + (endPressure - startPressure) * t;
			const tiltX =
				segment.startTiltX + (segment.endTiltX - segment.startTiltX) * t;
			const tiltY =
				segment.startTiltY + (segment.endTiltY - segment.startTiltY) * t;
			const twist =
				(segment.startTwist ?? 0) +
				((segment.endTwist ?? 0) - (segment.startTwist ?? 0)) * t;
			const deltaTime =
				segment.startDeltaTime +
				(segment.endDeltaTime - segment.startDeltaTime) * t;

			const dx = px - prevX;
			const dy = py - prevY;
			const stepDist = Math.hypot(dx, dy);
			if (stepDist <= 0) {
				prevDeltaTime = deltaTime;
				continue;
			}
			const stepTime = Math.max(deltaTime - prevDeltaTime, 0);
			const dirX = dx / stepDist;
			const dirY = dy / stepDist;

			// Speed EMAs + accel, updated per sample (world-based, zoom-free).
			if (stepTime > 0.001) {
				const stepVelocity = stepDist / stepTime;
				velFast +=
					(stepVelocity - velFast) * (1 - Math.exp(-stepTime / fineTau));
				velSlow +=
					(stepVelocity - velSlow) * (1 - Math.exp(-stepTime / grossTau));
				const turnAmount = Math.min(
					Math.max(0, 1 - (prevDirX * dirX + prevDirY * dirY)) * 0.5,
					1,
				);
				inputs.speedFine = Math.min(velFast / speedRef, 1);
				inputs.speedGross = Math.min(velSlow / speedRef, 1);
				inputs.accel = Math.min(
					(Math.abs(velFast - velSlow) / speedRef) * 0.8 + turnAmount,
					1,
				);
			}

			// Emit every dab this step covers; the earlier of the distance and
			// timed thresholds fires, and both accumulators reset per dab.
			let consumed = 0;
			while (consumed < 1) {
				const remainDist = (1 - consumed) * stepDist;
				const remainTime = (1 - consumed) * stepTime;
				const needDist = spacingWorld - accDist;
				const needTime = timedInterval - accTime;
				const fDist = needDist / stepDist;
				const fTime =
					stepTime > 0 && Number.isFinite(timedInterval)
						? needTime / stepTime
						: Number.POSITIVE_INFINITY;
				const f = Math.min(fDist, fTime);

				if (f > 1 - consumed) {
					accDist += remainDist;
					accTime += remainTime;
					break;
				}
				consumed += f;
				accDist = 0;
				accTime = 0;
				const emitX = prevX + dx * consumed;
				const emitY = prevY + dy * consumed;
				const emitPressure =
					prevPressure + (samplePressure - prevPressure) * consumed;
				emit(
					emitX,
					emitY,
					emitPressure,
					tiltX,
					tiltY,
					twist,
					dirX,
					dirY,
					globalDistance + stepDist * consumed,
				);
				spacingWorld = currentSpacingWorld();
				timedInterval = currentTimedInterval();
			}

			globalDistance += stepDist;
			prevX = px;
			prevY = py;
			prevPressure = samplePressure;
			prevDeltaTime = deltaTime;
			prevDirX = dirX;
			prevDirY = dirY;
		}

		prevEndX = segment.end.x;
		prevEndY = segment.end.y;
		hasPrevEnd = true;
	}

	// Apply the end layer to the last dab (matches the v1 behavior).
	if ((options.endLayerIndex ?? -1) >= 0 && count > 0) {
		const off = (count - 1) * DAB_INSTANCE_FLOATS;
		data[off + DAB_FIELD_OFFSETS.packedMeta] = u32AsFloat(
			packStampPathIndex(pathIndex, options.endLayerIndex ?? 0),
		);
	}

	const state: DabEvalState = {
		velFast,
		velSlow,
		speedFine: inputs.speedFine,
		speedGross: inputs.speedGross,
		accel: inputs.accel,
		accDist,
		accTime,
		spacingWorld,
		timedInterval,
		globalDistance,
		prevX,
		prevY,
		prevPressure,
		prevDeltaTime,
		prevDirX,
		prevDirY,
		prevEndX,
		prevEndY,
		hasPrevEnd,
		dabCount: priorDabs + count,
		rngState: dabRngState,
	};
	return { data, count, mixParams, state, totalLength };
}

/**
 * Arc length of a segment run using the walk's own approximation, continuing
 * relative-cp resolution from a resume state when given. Chunked callers use
 * this to assemble the totalLength option without re-walking committed work.
 */
export function measureSegmentsLength(
	segments: CubicBezierSegment[],
	resume?: Pick<DabEvalState, "prevEndX" | "prevEndY" | "hasPrevEnd">,
): number {
	let prevEndX = resume?.hasPrevEnd ? resume.prevEndX : 0;
	let prevEndY = resume?.hasPrevEnd ? resume.prevEndY : 0;
	let total = 0;
	for (const segment of segments) {
		const [sx, sy, c1x, c1y, c2x, c2y, ex, ey] = resolveSegment(
			segment,
			prevEndX,
			prevEndY,
		);
		total += approximateCubicLength(sx, sy, c1x, c1y, c2x, c2y, ex, ey);
		prevEndX = ex;
		prevEndY = ey;
	}
	return total;
}

/** Neutral state for a stroke that has not emitted anything yet. */
function initialEvalState(settings: BrushSettingsV2): DabEvalState {
	return {
		velFast: 0,
		velSlow: 0,
		speedFine: 0,
		speedGross: 0,
		accel: 0,
		accDist: 0,
		accTime: 0,
		spacingWorld: MIN_SPACING_WORLD,
		timedInterval: Number.POSITIVE_INFINITY,
		globalDistance: 0,
		prevX: 0,
		prevY: 0,
		prevPressure: 0.5,
		prevDeltaTime: 0,
		prevDirX: 1,
		prevDirY: 0,
		prevEndX: 0,
		prevEndY: 0,
		hasPrevEnd: false,
		dabCount: 0,
		rngState: settings.randomSeed >>> 0,
	};
}

// --- helpers --------------------------------------------------------------

function resolveSegment(
	segment: CubicBezierSegment,
	prevEndX: number,
	prevEndY: number,
): [number, number, number, number, number, number, number, number] {
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

function approximateCubicLength(
	sx: number,
	sy: number,
	c1x: number,
	c1y: number,
	c2x: number,
	c2y: number,
	ex: number,
	ey: number,
): number {
	const STEPS = 10;
	let length = 0;
	let px = sx;
	let py = sy;
	for (let i = 1; i <= STEPS; i++) {
		const t = i / STEPS;
		const omt = 1 - t;
		const x =
			omt * omt * omt * sx +
			3 * omt * omt * t * c1x +
			3 * omt * t * t * c2x +
			t * t * t * ex;
		const y =
			omt * omt * omt * sy +
			3 * omt * omt * t * c1y +
			3 * omt * t * t * c2y +
			t * t * t * ey;
		length += Math.hypot(x - px, y - py);
		px = x;
		py = y;
	}
	return length;
}

function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const _bitView = new DataView(new ArrayBuffer(4));

function u32AsFloat(value: number): number {
	_bitView.setUint32(0, value >>> 0, true);
	return _bitView.getFloat32(0, true);
}

/** Five 0..1 coefficients into 30 bits, lowest first (see
 *  DAB_FIELD_OFFSETS.packedWetCoefficients). */
function pack5x6unorm(
	a: number,
	b: number,
	c: number,
	d: number,
	e: number,
): number {
	const enc = (value: number) =>
		Math.round(Math.min(Math.max(value, 0), 1) * 63) & 0x3f;
	return (
		(enc(a) |
			(enc(b) << 6) |
			(enc(c) << 12) |
			(enc(d) << 18) |
			(enc(e) << 24)) >>>
		0
	);
}

/** WGSL pack2x16snorm: zero bits decode to zero, so an unwritten dab
 *  carries no shift at all. */
function pack2x16snorm(a: number, b: number): number {
	const enc = (value: number) =>
		Math.round(Math.min(Math.max(value, -1), 1) * 32767) & 0xffff;
	return ((enc(b) << 16) | enc(a)) >>> 0;
}

function clamp01(value: number): number {
	return Math.min(Math.max(value, 0), 1);
}
