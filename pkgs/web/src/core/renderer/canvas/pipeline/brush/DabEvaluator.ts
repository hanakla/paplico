import { sampleCurveLut, buildCurveLut } from "../../../../brush/curves";
import {
	BRUSH_PROPERTY_REGISTRY,
	MAX_SCALE_FACTOR,
	type BrushPropertySpec,
} from "../../../../brush/properties";
import type {
	BrushInputId,
	BrushPropertyId,
	BrushSettingsV2,
	CubicBezierSegment,
	StrokeWidthPoint,
} from "../../../../schema";
import { resolveTaper, taperFactor } from "../../../geometry/taper";
import { interpolateStrokeWidths } from "../../../geometry/strokeTessellator";
import {
	DAB_FIELD_OFFSETS,
	DAB_INSTANCE_FLOATS,
} from "./DabInstanceLayout";
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
	textureAspectRatio?: number;
	/** Number of texture-array variants for random tip selection. */
	variantCount?: number;
	startLayerIndex?: number;
	endLayerIndex?: number;
	/** Resolved stroke color packed into every dab (straight, 0..1). */
	color?: { r: number; g: number; b: number; a: number };
}

export interface DabBuffer {
	data: Float32Array;
	count: number;
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
	if (settings.engine !== "dab" || segments.length === 0) {
		return { data: EMPTY_F32, count: 0 };
	}

	const pathStart = options.pathStart ?? 0;
	const pathEnd = options.pathEnd ?? 1;
	const textureAspectRatio = Math.max(options.textureAspectRatio ?? 1, 1e-6);
	const strokeWidths =
		options.strokeWidths != null && options.strokeWidths.length > 0
			? options.strokeWidths
			: undefined;

	const baked = bakeProperties(settings);
	const sizeBase = settings.properties.size?.base ?? BRUSH_PROPERTY_REGISTRY.size.base;
	const wetEnabled = settings.wet?.enabled === true;
	const tangentAngle = settings.tip?.angleMode === "tangent";

	// Seeded rngs keep the output a pure function of (segments, settings).
	const dabRng = mulberry32(settings.randomSeed >>> 0);
	const strokeRng = mulberry32((settings.randomSeed ^ 0x9e3779b9) >>> 0);
	const randomPerStroke = strokeRng();

	// --- arc lengths -------------------------------------------------------
	const segLengths = new Float64Array(segments.length);
	let totalLength = 0;
	{
		let prevEndX = 0;
		let prevEndY = 0;
		for (let si = 0; si < segments.length; si++) {
			const [sx, sy, c1x, c1y, c2x, c2y, ex, ey] = resolveSegment(
				segments[si],
				prevEndX,
				prevEndY,
			);
			const len = approximateCubicLength(sx, sy, c1x, c1y, c2x, c2y, ex, ey);
			segLengths[si] = len;
			totalLength += len;
			prevEndX = ex;
			prevEndY = ey;
		}
	}
	if (totalLength <= 0) return { data: EMPTY_F32, count: 0 };

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
	const fineTau = settings.inputDynamics?.speedFineTau ?? DEFAULT_SPEED_FINE_TAU_MS;
	const grossTau =
		settings.inputDynamics?.speedGrossTau ?? DEFAULT_SPEED_GROSS_TAU_MS;

	// --- output state ------------------------------------------------------
	const estimatedDabs =
		Math.ceil(totalLength / Math.max(sizeBase * 0.05, MIN_SPACING_WORLD)) +
		segments.length +
		2;
	let data = new Float32Array(estimatedDabs * DAB_INSTANCE_FLOATS);
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

	const color = options.color ?? { r: 0, g: 0, b: 0, a: 1 };
	const packedColor0 = u32AsFloat(pack2x16unorm(color.r, color.g));
	const packedColor1 = u32AsFloat(pack2x16unorm(color.b, color.a));
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
		}

		const fragT = fragDistance / totalLength;
		inputs.pressure = clamp01(pressure);
		inputs.tiltMagnitude = clamp01(Math.hypot(tiltX, tiltY) / 90);
		inputs.tiltAzimuth =
			inputs.tiltMagnitude > 1e-3
				? (Math.atan2(tiltY, tiltX) + Math.PI) / (2 * Math.PI)
				: 0.5;
		inputs.twist = clamp01(((twistDeg % 360) + 360) % 360 / 360);
		inputs.direction = (Math.atan2(flowY, flowX) + Math.PI) / (2 * Math.PI);
		inputs.strokeT = pathStart + (pathEnd - pathStart) * fragT;
		inputs.fade = clamp01(fragDistance / (sizeBase * FADE_SATURATION_SIZES));
		inputs.distance = clamp01(fragDistance / DISTANCE_SATURATION_PX);
		inputs.randomPerDab = dabRng();

		const sizeVal = evalProp(baked, "size", inputs);
		const ratioVal = evalProp(baked, "ratio", inputs);
		const angleVal = evalProp(baked, "angle", inputs);
		const flowVal = evalProp(baked, "flow", inputs);
		const spacingVal = evalProp(baked, "spacing", inputs);
		const scatterOffsetVal = evalProp(baked, "scatterOffset", inputs);
		const scatterAlongVal = evalProp(baked, "scatterAlong", inputs);
		const hardnessVal = evalProp(baked, "hardness", inputs);
		const grainVal = evalProp(baked, "grainStrength", inputs);

		let sizeX = sizeVal * Math.max(textureAspectRatio, 1);
		if (taper) {
			sizeX *= taperFactor(taper, fragDistance, totalLength);
		}
		const sizeY = (sizeX * ratioVal) / textureAspectRatio;

		// Scatter offsets displace along the normal / tangent as size ratios.
		const normalX = -flowY;
		const normalY = flowX;
		let dabX = x;
		let dabY = y;
		if (scatterOffsetVal !== 0) {
			const jitter =
				(inputs.randomPerDab * 2 - 1) * scatterOffsetVal * sizeVal;
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
			const dabsPerPixel = Math.max(
				1 + OPAQUE_LINEARIZE * (1 / Math.min(Math.max(spacingVal, 1e-3), 1) - 1),
				1,
			);
			alpha = 1 - (1 - clamp01(flowVal * settings.strokeOpacity)) ** (1 / dabsPerPixel);
		}

		let rotation = angleVal;
		if (tangentAngle && (flowX !== 0 || flowY !== 0)) {
			rotation += Math.atan2(flowY, flowX) - Math.PI / 2;
		}

		let textureLayer = 0;
		if (variantCount > 0) {
			textureLayer = Math.floor(dabRng() * variantCount);
		}
		if (count === 0 && (options.startLayerIndex ?? -1) >= 0) {
			textureLayer = options.startLayerIndex ?? 0;
		}

		let side1 = 1;
		let side2 = 1;
		if (strokeWidths) {
			const widths = interpolateStrokeWidths(strokeWidths, fragT);
			side1 = widths.side1;
			side2 = widths.side2;
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
		data[off + DAB_FIELD_OFFSETS.packedColor0] = packedColor0;
		data[off + DAB_FIELD_OFFSETS.packedColor1] = packedColor1;
		data[off + DAB_FIELD_OFFSETS.hardnessLutIndex] =
			hardnessToLutIndex(hardnessVal);
		data[off + DAB_FIELD_OFFSETS.grainStrength] = grainVal;
		if (wetEnabled) {
			data[off + DAB_FIELD_OFFSETS.wetness] = evalProp(baked, "wetness", inputs);
			data[off + DAB_FIELD_OFFSETS.directionality] = evalProp(
				baked,
				"directionality",
				inputs,
			);
			data[off + DAB_FIELD_OFFSETS.grainAmount] = evalProp(
				baked,
				"grainAmount",
				inputs,
			);
		} else {
			data[off + DAB_FIELD_OFFSETS.wetness] = 0;
			data[off + DAB_FIELD_OFFSETS.directionality] = 0;
			data[off + DAB_FIELD_OFFSETS.grainAmount] = 0;
		}
		data[off + DAB_FIELD_OFFSETS.reserved] = 0;
		count++;
	};

	// Spacing thresholds re-evaluated after every emitted dab.
	const currentSpacingWorld = (): number =>
		Math.max(sizeBase * evalProp(baked, "spacing", inputs), MIN_SPACING_WORLD);
	const currentTimedInterval = (): number => {
		const dps = evalProp(baked, "dabsPerSecond", inputs);
		return dps > 0 ? 1000 / dps : Number.POSITIVE_INFINITY;
	};

	// --- walk --------------------------------------------------------------
	let velFast = 0;
	let velSlow = 0;
	const firstSeg = segments[0];
	{
		// Seed velocity from the first segment's timing so speed curves do not
		// ramp from zero on every stroke. Mid-stroke fragments seed both EMAs
		// equally (ramp-in suppression).
		const duration = firstSeg.endDeltaTime - firstSeg.startDeltaTime;
		if (duration > 0 && segLengths[0] > 0) {
			velFast = segLengths[0] / duration;
			velSlow = pathStart > 0 ? velFast : 0;
		}
	}

	const [fsx, fsy, fc1x, fc1y, fc2x, fc2y, fex, fey] = resolveSegment(
		firstSeg,
		0,
		0,
	);
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

	let accDist = 0;
	let accTime = 0;
	let spacingWorld = currentSpacingWorld();
	let timedInterval = currentTimedInterval();
	let globalDistance = 0;
	let prevX = fsx;
	let prevY = fsy;
	let prevPressure = firstPressure;
	let prevDeltaTime = firstSeg.startDeltaTime;
	let prevDirX = firstDirX;
	let prevDirY = firstDirY;
	let prevEndX = 0;
	let prevEndY = 0;
	let hasPrevEnd = false;

	for (let si = 0; si < segments.length; si++) {
		const segment = segments[si];
		const [sx, sy, c1x, c1y, c2x, c2y, ex, ey] = resolveSegment(
			segment,
			hasPrevEnd ? prevEndX : 0,
			hasPrevEnd ? prevEndY : 0,
		);
		const segLen = segLengths[si];

		if (segment.isMoved && si > 0) {
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
			const tiltX = segment.startTiltX + (segment.endTiltX - segment.startTiltX) * t;
			const tiltY = segment.startTiltY + (segment.endTiltY - segment.startTiltY) * t;
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
				velFast += (stepVelocity - velFast) * (1 - Math.exp(-stepTime / fineTau));
				velSlow += (stepVelocity - velSlow) * (1 - Math.exp(-stepTime / grossTau));
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

	return { data, count };
}

// --- property baking ------------------------------------------------------

interface BakedProperty {
	spec: BrushPropertySpec;
	base: number;
	curves: { input: BrushInputId; lut: Float32Array }[];
}

type BakedProperties = Partial<Record<BrushPropertyId, BakedProperty>>;

function bakeProperties(settings: BrushSettingsV2): BakedProperties {
	const out: BakedProperties = {};
	for (const [id, config] of Object.entries(settings.properties)) {
		const spec = BRUSH_PROPERTY_REGISTRY[id as BrushPropertyId];
		if (!spec || !config) continue;
		out[id as BrushPropertyId] = {
			spec,
			base: config.base,
			curves: (config.curves ?? []).map((curve) => ({
				input: curve.input,
				lut: buildCurveLut(curve.points),
			})),
		};
	}
	return out;
}

function evalProp(
	baked: BakedProperties,
	id: BrushPropertyId,
	inputs: Record<BrushInputId, number>,
): number {
	const entry = baked[id];
	const spec = entry?.spec ?? BRUSH_PROPERTY_REGISTRY[id];
	const base = entry?.base ?? spec.base;
	let sum = 0;
	if (entry) {
		for (const curve of entry.curves) {
			sum += sampleCurveLut(curve.lut, inputs[curve.input]);
		}
	}
	if (spec.domain === "scale") {
		const factor = Math.min(Math.max(1 + sum, 0), MAX_SCALE_FACTOR);
		return Math.min(Math.max(base * factor, spec.min), spec.max);
	}
	return Math.min(Math.max(base + sum, spec.min), spec.max);
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

function pack2x16unorm(a: number, b: number): number {
	const lo = Math.round(clamp01(a) * 65535);
	const hi = Math.round(clamp01(b) * 65535);
	return ((hi << 16) | lo) >>> 0;
}

function clamp01(value: number): number {
	return Math.min(Math.max(value, 0), 1);
}
