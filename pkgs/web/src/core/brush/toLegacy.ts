import type {
	BrushCurve,
	BrushInputId,
	BrushPropertyId,
	BrushSettings,
	BrushSettingsV2,
	CalligraphyBrushSettings,
	ScatterBrushSettings,
	WetInkSettings,
} from "../schema";
import { evaluatePiecewiseLinear } from "./curves";
import { BRUSH_PROPERTY_REGISTRY } from "./properties";

/**
 * v2 -> v1 down-converter for the transition period (design §13-7 / plan
 * phase 1). The legacy render paths (ribbon/geometric/legacy wet) and the
 * flat brush UI adapter still speak the v1 union; this view reconstructs it
 * from the machine-generated 2-point curves that migration and the flat UI
 * produce. `normalizeBrushSettingsV2(toLegacyBrushSettings(v2))` is a fixed
 * point for such settings (see toLegacy.test.ts).
 *
 * Arbitrary user curves (curve editor, phase 8+) are NOT representable in
 * the v1 union; by the time they can exist, the legacy consumers are gone.
 */
export function toLegacyBrushSettings(
	settings: BrushSettingsV2,
): BrushSettings {
	const sizeBase = base(settings, "size", 10);
	const flowBase = base(settings, "flow", 1);
	const common = {
		size: sizeBase,
		sizeByPressure: pressureCoefficient(settings, "size"),
		opacity: 1,
		opacityByPressure: pressureCoefficient(settings, "flow"),
		randomSeed: settings.randomSeed,
		colorMode: settings.colorMode,
		taperStart: settings.taperStart,
		taperEnd: settings.taperEnd,
	};

	if (settings.engine === "geometric") {
		return {
			...common,
			type: "stroke",
			opacity: flowBase,
			stroking: settings.stroking,
		};
	}

	if (settings.engine === "ribbon") {
		const ribbon = settings.ribbon;
		const source = ribbon?.source ?? { kind: "file" as const, fileUid: "" };
		if (ribbon?.uvMode === "stretch") {
			return {
				...common,
				type: "art",
				source,
				flow: flowBase,
				flip: ribbon.flipU ?? false,
				flipAcross: ribbon.flipV ?? false,
			};
		}
		return {
			...common,
			type: "pattern",
			source,
			flow: flowBase,
			tileScale: ribbon?.tileScale ?? 1,
			tileSpacing: ribbon?.tileSpacing ?? 0,
			uvOffset: ribbon?.uvOffset,
			fitMode: "none",
		};
	}

	// --- dab engine: scatter or calligraphy --------------------------------
	const dynamics = extractDabDynamics(settings);
	const wetInk = settings.wetV1;

	if (settings.tip?.kind === "procedural") {
		const tiltCurve = findCurve(settings, "angle", "tiltAzimuth");
		const angleMode: CalligraphyBrushSettings["angleMode"] =
			settings.tip.angleMode === "tangent"
				? "tangent"
				: tiltCurve
					? "tilt"
					: "fixed";
		return {
			...common,
			type: "calligraphy",
			nibAngle: (base(settings, "angle", 0) * 180) / Math.PI,
			roundness: base(settings, "ratio", 1),
			angleMode,
			spacing: base(settings, "spacing", 0.1),
			flow: flowBase,
			...dynamics,
			wetInk,
		};
	}

	const tip = settings.tip?.kind === "image" ? settings.tip : undefined;
	const randomCurve = findCurve(settings, "angle", "randomPerDab");
	const tiltCurve = findCurve(settings, "angle", "tiltAzimuth");
	const stampRotation: ScatterBrushSettings["stampRotation"] =
		tip?.angleMode === "tangent" ? "tangent" : randomCurve ? "random" : "none";
	const stampAngleDeg = (base(settings, "angle", 0) * 180) / Math.PI;
	const ratioCurve = findCurve(settings, "ratio", "tiltMagnitude");
	const sizeVariationCurve = findCurve(
		settings,
		"size",
		"randomPerDab",
		(curve) => evaluatePiecewiseLinear(curve.points, 1) > 0,
	);
	const scatterOffsetBase = base(settings, "scatterOffset", 0);

	const scatter: ScatterBrushSettings = {
		...common,
		type: "scatter",
		source: tip?.sources[0] ?? { kind: "file", fileUid: "" },
		spacing: base(settings, "spacing", 0.1),
		flow: flowBase,
		stampRotation,
		rotationByTilt: tiltCurve
			? evaluatePiecewiseLinear(tiltCurve.points, 1) / Math.PI
			: 0,
		aspectRatioByTilt: ratioCurve
			? -evaluatePiecewiseLinear(ratioCurve.points, 1) / 0.7
			: 0,
		...dynamics,
		wetInk,
	};
	if (stampAngleDeg !== 0) scatter.stampAngle = stampAngleDeg;
	if (scatterOffsetBase !== 0) scatter.scatterOffset = scatterOffsetBase;
	if (sizeVariationCurve) {
		scatter.scatterSizeVariation = evaluatePiecewiseLinear(
			sizeVariationCurve.points,
			1,
		);
	}
	if (tip && tip.sources.length > 1) {
		scatter.scatterSources = tip.sources.slice(1);
	}
	if (tip?.startSource) scatter.startSource = tip.startSource;
	if (tip?.endSource) scatter.endSource = tip.endSource;
	return scatter;
}

/** sizeBySpeed / pooling / poolingSizeRatio shared by scatter+calligraphy. */
function extractDabDynamics(settings: BrushSettingsV2): {
	sizeBySpeed: number;
	pooling: number;
	poolingSizeRatio: number;
} {
	// pooling writes a spacing/speedFine curve with y(0) = -0.6p, y(1) = 0.
	const poolSpacingCurve = findCurve(settings, "spacing", "speedFine");
	const pooling = poolSpacingCurve
		? -evaluatePiecewiseLinear(poolSpacingCurve.points, 0) / 0.6
		: 0;

	// The pooling size curve has y(1) = 0 and y(0) = 0.3*p*r; sizeBySpeed has
	// y(0) = 0 and y(1) = -k. Both live on (size, speedFine) — disambiguate by
	// which endpoint is zero.
	let poolingSizeRatio = 0.5;
	let sizeBySpeed = 0;
	for (const curve of curvesOf(settings, "size", "speedFine")) {
		const atStart = evaluatePiecewiseLinear(curve.points, 0);
		const atEnd = evaluatePiecewiseLinear(curve.points, 1);
		if (atStart === 0 && atEnd < 0) {
			sizeBySpeed = -atEnd;
		} else if (atEnd === 0 && atStart > 0 && pooling > 0) {
			poolingSizeRatio = atStart / (0.3 * pooling);
		}
	}
	return { sizeBySpeed, pooling, poolingSizeRatio };
}

function base(
	settings: BrushSettingsV2,
	id: BrushPropertyId,
	fallback: number,
): number {
	return settings.properties[id]?.base ?? fallback;
}

/** -k of a migration-generated pressure curve [[0,-k],[1,0]]. */
function pressureCoefficient(
	settings: BrushSettingsV2,
	id: BrushPropertyId,
): number {
	const curve = findCurve(settings, id, "pressure");
	if (!curve) return 0;
	return -evaluatePiecewiseLinear(curve.points, 0);
}

function findCurve(
	settings: BrushSettingsV2,
	id: BrushPropertyId,
	input: BrushInputId,
	predicate?: (curve: BrushCurve) => boolean,
): BrushCurve | undefined {
	return curvesOf(settings, id, input).find(
		(curve) => predicate?.(curve) ?? true,
	);
}

function curvesOf(
	settings: BrushSettingsV2,
	id: BrushPropertyId,
	input: BrushInputId,
): BrushCurve[] {
	return (settings.properties[id]?.curves ?? []).filter(
		(curve) => curve.input === input,
	);
}
