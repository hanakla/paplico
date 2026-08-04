import {
	type BrushArtSource,
	type BrushCurve,
	type BrushEngineKind,
	type BrushInputId,
	type BrushPropertyConfig,
	type BrushPropertyId,
	type BrushSettings,
	type BrushSettingsV2,
	type BrushTipConfig,
	DEFAULT_CALLIGRAPHY_SPACING,
	DEFAULT_WET_INK_DIFFUSION,
	type GrainConfig,
	type InputDynamicsConfig,
	type MixingConfig,
	type RibbonConfig,
	type WetConfig,
	type WetEdgeConfig,
	type WetInkSettings,
} from "../schema";
import { isBrushInputId } from "./inputs";
import { normalizeBrushSettings } from "./normalize";
import { BRUSH_PROPERTY_IDS, BRUSH_PROPERTY_REGISTRY } from "./properties";

/** Max control points per curve (design §3-3). */
export const MAX_CURVE_POINTS = 16;

/**
 * Single v2 gate: accepts v1 unions, the legacy flat shape and v2 values and
 * returns a sanitized BrushSettingsV2. Idempotent — see migrate.test.ts.
 * Wet ink settings are NOT converted here: they are preserved verbatim in
 * `wetV1` until the wet switchover migration (design §13-7).
 */
export function normalizeBrushSettingsV2(raw: unknown): BrushSettingsV2 {
	const r = (raw ?? {}) as Record<string, unknown>;
	if (r.version === 2) return sanitizeV2(r);
	return sanitizeV2(convertV1(normalizeBrushSettings(raw)));
}

/**
 * Normalize persisted brush settings while preserving their stored format:
 * v2 stays v2 (sanitized), everything else stays a v1 union value. Storage
 * boundaries (papb, IndexedDB) use this so stored v2 data never collapses to
 * the lossy legacy view on a read/save cycle.
 */
export function normalizeStoredBrushSettings(
	raw: unknown,
): BrushSettings | BrushSettingsV2 {
	const r = (raw ?? {}) as Record<string, unknown>;
	if (r.version === 2) return sanitizeV2(r);
	return normalizeBrushSettings(raw);
}

/**
 * Curve pairs the flat slider layer owns. Must match exactly what convertV1
 * emits: a pair listed here is rebuilt from sliders on every flat patch, so
 * `next` wins for it; every other pair is curve-editor territory and is
 * preserved from the previously stored v2 value.
 */
const FLAT_MANAGED_CURVE_PAIRS: ReadonlySet<string> = new Set([
	"size:pressure",
	"flow:pressure",
	"size:speedFine",
	"spacing:speedFine",
	"flow:speedFine",
	"size:randomPerDab",
	"angle:randomPerDab",
	"angle:tiltAzimuth",
	"ratio:tiltMagnitude",
]);

/**
 * Merge a flat-layer rebuild (`next`, produced from the legacy view plus a
 * slider patch) onto the previously stored v2 value. Flat-managed curve pairs
 * and property bases come from `next` so slider edits (including removals)
 * win; unmanaged curves and v2-only config sections the flat layer cannot
 * express (grain, wet, mixing, inputDynamics, strokeOpacity, paintMode) are
 * preserved from `previous`.
 */
export function mergeBrushSettingsV2PreservingCurves(
	previous: BrushSettingsV2 | undefined,
	next: BrushSettingsV2,
): BrushSettingsV2 {
	if (!previous) return next;

	const properties: MutableProps = {};
	const ids = new Set([
		...Object.keys(next.properties),
		...Object.keys(previous.properties),
	]) as Set<BrushPropertyId>;
	for (const id of ids) {
		const nextCfg = next.properties[id];
		const prevCfg = previous.properties[id];
		const preserved = (prevCfg?.curves ?? []).filter(
			(c) =>
				!FLAT_MANAGED_CURVE_PAIRS.has(`${id}:${c.input}`) &&
				!nextCfg?.curves?.some((n) => n.input === c.input),
		);
		if (nextCfg) {
			const curves = [...(nextCfg.curves ?? []), ...preserved];
			properties[id] =
				curves.length > 0 ? { base: nextCfg.base, curves } : { ...nextCfg };
		} else if (prevCfg && preserved.length > 0) {
			properties[id] = { base: prevCfg.base, curves: preserved };
		}
	}

	const merged: Record<string, unknown> = {
		...next,
		properties,
		strokeOpacity: previous.strokeOpacity,
		paintMode: previous.paintMode,
		grain: next.grain ?? previous.grain,
		wetEdge: next.wetEdge ?? previous.wetEdge,
		mixing: next.mixing ?? previous.mixing,
		wet: next.wet ?? previous.wet,
		inputDynamics: next.inputDynamics ?? previous.inputDynamics,
		wetV1: next.wetV1 ?? previous.wetV1,
	};
	if (
		next.tip?.kind === "procedural" &&
		previous.tip?.kind === "procedural" &&
		next.tip.softnessCurve == null &&
		previous.tip.softnessCurve != null
	) {
		merged.tip = { ...next.tip, softnessCurve: previous.tip.softnessCurve };
	}
	return sanitizeV2(merged);
}

// --- v1 -> v2 conversion -------------------------------------------------

type MutableProps = Partial<Record<BrushPropertyId, BrushPropertyConfig>>;

function convertV1(v1: BrushSettings): Record<string, unknown> {
	const props: MutableProps = {};

	setBase(props, "size", v1.size);
	if (v1.sizeByPressure > 0) {
		addCurve(props, "size", "pressure", [
			[0, -v1.sizeByPressure],
			[1, 0],
		]);
	}

	const v1Flow = "flow" in v1 ? v1.flow : 1;
	setBase(props, "flow", v1.opacity * v1Flow);
	if (v1.opacityByPressure > 0) {
		addCurve(props, "flow", "pressure", [
			[0, -v1.opacityByPressure],
			[1, 0],
		]);
	}

	const common = {
		version: 2,
		strokeOpacity: 1,
		paintMode: "buildup",
		randomSeed: v1.randomSeed,
		taperStart: v1.taperStart,
		taperEnd: v1.taperEnd,
		colorMode: v1.colorMode,
	};

	switch (v1.type) {
		case "stroke":
			return {
				...common,
				engine: "geometric" satisfies BrushEngineKind,
				properties: props,
				stroking: v1.stroking,
			};

		case "scatter": {
			setBase(props, "spacing", v1.spacing);
			convertDabDynamics(props, v1);
			if ((v1.stampAngle ?? 0) !== 0) {
				setBase(props, "angle", ((v1.stampAngle ?? 0) * Math.PI) / 180);
			}
			if (v1.stampRotation === "random") {
				addCurve(props, "angle", "randomPerDab", [
					[0, -Math.PI],
					[1, Math.PI],
				]);
			}
			if (v1.rotationByTilt > 0) {
				addCurve(props, "angle", "tiltAzimuth", [
					[0, -Math.PI * v1.rotationByTilt],
					[1, Math.PI * v1.rotationByTilt],
				]);
			}
			if (v1.aspectRatioByTilt > 0) {
				addCurve(props, "ratio", "tiltMagnitude", [
					[0, 0],
					[1, -0.7 * v1.aspectRatioByTilt],
				]);
			}
			if ((v1.scatterOffset ?? 0) !== 0) {
				setBase(props, "scatterOffset", v1.scatterOffset ?? 0);
			}
			if ((v1.scatterSizeVariation ?? 0) > 0) {
				const v = v1.scatterSizeVariation ?? 0;
				addCurve(props, "size", "randomPerDab", [
					[0, -v],
					[1, v],
				]);
			}

			const tip: BrushTipConfig = {
				kind: "image",
				sources: [v1.source, ...(v1.scatterSources ?? [])],
				selection: "random",
				startSource: v1.startSource,
				endSource: v1.endSource,
				angleMode: v1.stampRotation === "tangent" ? "tangent" : "fixed",
			};
			return {
				...common,
				engine: "dab" satisfies BrushEngineKind,
				properties: props,
				tip,
				wetV1: v1.wetInk,
			};
		}

		case "calligraphy": {
			setBase(props, "spacing", v1.spacing ?? DEFAULT_CALLIGRAPHY_SPACING);
			convertDabDynamics(props, v1);
			setBase(props, "ratio", v1.roundness);
			if (v1.nibAngle !== 0) {
				setBase(props, "angle", (v1.nibAngle * Math.PI) / 180);
			}
			if (v1.angleMode === "tilt") {
				addCurve(props, "angle", "tiltAzimuth", [
					[0, -Math.PI],
					[1, Math.PI],
				]);
			}
			const tip: BrushTipConfig = {
				kind: "procedural",
				hardness: 1,
				angleMode: v1.angleMode === "tangent" ? "tangent" : "fixed",
			};
			return {
				...common,
				engine: "dab" satisfies BrushEngineKind,
				properties: props,
				tip,
				wetV1: v1.wetInk,
			};
		}

		case "art":
			return {
				...common,
				engine: "ribbon" satisfies BrushEngineKind,
				properties: props,
				ribbon: {
					source: v1.source,
					uvMode: "stretch",
					tileScale: 1,
					tileSpacing: 0,
					flipU: v1.flip ?? false,
					flipV: v1.flipAcross ?? false,
				} satisfies RibbonConfig,
			};

		case "pattern":
			return {
				...common,
				engine: "ribbon" satisfies BrushEngineKind,
				properties: props,
				ribbon: {
					source: v1.source,
					uvMode: "repeat",
					tileScale: v1.tileScale,
					tileSpacing: v1.tileSpacing,
					uvOffset: v1.uvOffset,
				} satisfies RibbonConfig,
			};
	}
}

/** Speed/pooling dynamics shared by scatter and calligraphy conversions. */
function convertDabDynamics(
	props: MutableProps,
	v1: Extract<BrushSettings, { type: "scatter" | "calligraphy" }>,
): void {
	if (v1.sizeBySpeed > 0) {
		addCurve(props, "size", "speedFine", [
			[0, 0],
			[1, -v1.sizeBySpeed],
		]);
	}
	if (v1.pooling > 0) {
		const p = v1.pooling;
		const r = v1.poolingSizeRatio;
		addCurve(props, "spacing", "speedFine", [
			[0, -0.6 * p],
			[1, 0],
		]);
		addCurve(props, "size", "speedFine", [
			[0, 0.3 * p * r],
			[1, 0],
		]);
		addCurve(props, "flow", "speedFine", [
			[0, 0.5 * p * (1 - r)],
			[1, 0],
		]);
	}
}

function setBase(props: MutableProps, id: BrushPropertyId, base: number): void {
	const existing = props[id];
	props[id] = { ...existing, base };
}

function addCurve(
	props: MutableProps,
	id: BrushPropertyId,
	input: BrushInputId,
	points: [number, number][],
): void {
	const existing = props[id] ?? { base: BRUSH_PROPERTY_REGISTRY[id].base };
	props[id] = {
		...existing,
		curves: [...(existing.curves ?? []), { input, points }],
	};
}

// --- v2 sanitize ---------------------------------------------------------

function sanitizeV2(r: Record<string, unknown>): BrushSettingsV2 {
	const engine = isEngineKind(r.engine) ? r.engine : "dab";
	const wet = sanitizeWet(r.wet);

	const result: BrushSettingsV2 = {
		version: 2,
		engine,
		strokeOpacity: clamp(num(r.strokeOpacity, 1), 0, 1),
		paintMode:
			wet?.enabled === true
				? "wash"
				: r.paintMode === "wash"
					? "wash"
					: "buildup",
		properties: sanitizeProperties(r.properties),
		randomSeed: num(r.randomSeed, 0),
	};

	const tip = sanitizeTip(r.tip);
	if (tip) result.tip = tip;
	const ribbon = sanitizeRibbon(r.ribbon);
	if (ribbon) result.ribbon = ribbon;
	const stroking = sanitizeStroking(r.stroking);
	if (stroking) result.stroking = stroking;
	const grain = sanitizeGrain(r.grain);
	if (grain) result.grain = grain;
	const wetEdge = sanitizeWetEdge(r.wetEdge);
	if (wetEdge) result.wetEdge = wetEdge;
	const mixing = sanitizeMixing(r.mixing);
	if (mixing) result.mixing = mixing;
	if (wet) result.wet = wet;
	if (isRecord(r.wetV1)) {
		// Boundary cast: wetV1 is the migration-period original and must stay
		// verbatim — reshaping or clamping it here would break the v1 authority
		// rule (design §13-7).
		result.wetV1 = r.wetV1 as unknown as WetInkSettings;
	}
	const inputDynamics = sanitizeInputDynamics(r.inputDynamics);
	if (inputDynamics) result.inputDynamics = inputDynamics;

	const taperStart = numOpt(r.taperStart);
	if (taperStart !== undefined) result.taperStart = Math.max(taperStart, 0);
	const taperEnd = numOpt(r.taperEnd);
	if (taperEnd !== undefined) result.taperEnd = Math.max(taperEnd, 0);
	if (r.colorMode === "tinting" || r.colorMode === "color") {
		result.colorMode = r.colorMode;
	}
	return result;
}

function sanitizeProperties(
	raw: unknown,
): Partial<Record<BrushPropertyId, BrushPropertyConfig>> {
	const out: MutableProps = {};
	if (!isRecord(raw)) return out;
	for (const id of BRUSH_PROPERTY_IDS) {
		const entry = raw[id];
		if (!isRecord(entry)) continue;
		const spec = BRUSH_PROPERTY_REGISTRY[id];
		const config: BrushPropertyConfig = {
			base: clamp(num(entry.base, spec.base), spec.min, spec.max),
		};
		const curves = sanitizeCurves(entry.curves);
		if (curves.length > 0) config.curves = curves;
		out[id] = config;
	}
	return out;
}

function sanitizeCurves(raw: unknown): BrushCurve[] {
	if (!Array.isArray(raw)) return [];
	const out: BrushCurve[] = [];
	for (const entry of raw) {
		if (!isRecord(entry) || !isBrushInputId(entry.input)) continue;
		if (!Array.isArray(entry.points)) continue;
		const points: [number, number][] = [];
		for (const pt of entry.points.slice(0, MAX_CURVE_POINTS)) {
			if (!Array.isArray(pt)) continue;
			const x = Number(pt[0]);
			const y = Number(pt[1]);
			if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
			points.push([clamp(x, 0, 1), y]);
		}
		if (points.length === 0) continue;
		out.push({ input: entry.input, points });
	}
	return out;
}

function sanitizeTip(raw: unknown): BrushTipConfig | undefined {
	if (!isRecord(raw)) return undefined;
	const angleMode = raw.angleMode === "tangent" ? "tangent" : "fixed";
	if (raw.kind === "procedural") {
		const tip: BrushTipConfig = {
			kind: "procedural",
			hardness: clamp(num(raw.hardness, 1), 0, 1),
			angleMode,
		};
		if (Array.isArray(raw.softnessCurve)) {
			const points = sanitizeCurves([
				{ input: "pressure", points: raw.softnessCurve },
			])[0]?.points;
			if (points) tip.softnessCurve = points;
		}
		return tip;
	}
	if (raw.kind === "image") {
		const sources = Array.isArray(raw.sources)
			? raw.sources.filter(isArtSource)
			: [];
		if (sources.length === 0) return undefined;
		const tip: BrushTipConfig = {
			kind: "image",
			sources,
			selection: raw.selection === "sequence" ? "sequence" : "random",
			angleMode,
		};
		if (isArtSource(raw.startSource)) tip.startSource = raw.startSource;
		if (isArtSource(raw.endSource)) tip.endSource = raw.endSource;
		return tip;
	}
	return undefined;
}

function sanitizeRibbon(raw: unknown): RibbonConfig | undefined {
	if (!isRecord(raw) || !isArtSource(raw.source)) return undefined;
	const ribbon: RibbonConfig = {
		source: raw.source,
		uvMode: raw.uvMode === "stretch" ? "stretch" : "repeat",
		tileScale: Math.max(num(raw.tileScale, 1), 0.1),
		tileSpacing: Math.max(num(raw.tileSpacing, 0), 0),
	};
	const uvOffset = numOpt(raw.uvOffset);
	if (uvOffset !== undefined) ribbon.uvOffset = uvOffset;
	if (raw.flipU !== undefined) ribbon.flipU = raw.flipU === true;
	if (raw.flipV !== undefined) ribbon.flipV = raw.flipV === true;
	return ribbon;
}

function sanitizeStroking(raw: unknown): BrushSettingsV2["stroking"] {
	if (!isRecord(raw)) return undefined;
	const stroking: NonNullable<BrushSettingsV2["stroking"]> = {
		lineCap:
			raw.lineCap === "butt" || raw.lineCap === "square"
				? raw.lineCap
				: "round",
		lineJoin:
			raw.lineJoin === "miter" || raw.lineJoin === "bevel"
				? raw.lineJoin
				: "round",
		miterLimit: num(raw.miterLimit, 4),
	};
	if (Array.isArray(raw.dashArray)) {
		const dashArray = raw.dashArray.map(Number).filter(Number.isFinite);
		if (dashArray.length > 0) stroking.dashArray = dashArray;
	}
	const dashOffset = numOpt(raw.dashOffset);
	if (dashOffset !== undefined) stroking.dashOffset = dashOffset;
	return stroking;
}

function sanitizeGrain(raw: unknown): GrainConfig | undefined {
	if (!isRecord(raw) || !isArtSource(raw.source)) return undefined;
	return {
		source: raw.source,
		scale: clamp(num(raw.scale, 1), 0.05, 1000),
		mode: raw.mode === "subtract" ? "subtract" : "multiply",
		randomOffsetPerStroke: raw.randomOffsetPerStroke === true,
	};
}

function sanitizeWetEdge(raw: unknown): WetEdgeConfig | undefined {
	if (!isRecord(raw)) return undefined;
	return {
		width: Math.max(num(raw.width, 0), 0),
		intensity: clamp(num(raw.intensity, 0.5), 0, 1),
		darkening: clamp(num(raw.darkening, 0.5), 0, 1),
		blur: Math.max(num(raw.blur, 0), 0),
	};
}

function sanitizeMixing(raw: unknown): MixingConfig | undefined {
	if (!isRecord(raw)) return undefined;
	return {
		enabled: raw.enabled === true,
		mode: "dulling",
		sampleRadius: clamp(num(raw.sampleRadius, 1), 0, 4),
		sampleTrail: clamp(num(raw.sampleTrail, 1), -2, 2),
		blendStyle: clamp(num(raw.blendStyle, 0), 0, 1),
	};
}

function sanitizeWet(raw: unknown): WetConfig | undefined {
	if (!isRecord(raw)) return undefined;
	return {
		enabled: raw.enabled === true,
		bleedRadius: clamp(num(raw.bleedRadius, 0.5), 0, 1),
		pigmentLoad: clamp(num(raw.pigmentLoad, 0.85), 0, 1),
		grainScale: clamp(num(raw.grainScale, 1), 0.05, 1000),
	};
}

function sanitizeInputDynamics(raw: unknown): InputDynamicsConfig | undefined {
	if (!isRecord(raw)) return undefined;
	const out: InputDynamicsConfig = {};
	const speedRef = numOpt(raw.speedRef);
	if (speedRef !== undefined && speedRef > 0) out.speedRef = speedRef;
	const fineTau = numOpt(raw.speedFineTau);
	if (fineTau !== undefined && fineTau > 0) out.speedFineTau = fineTau;
	const grossTau = numOpt(raw.speedGrossTau);
	if (grossTau !== undefined && grossTau > 0) out.speedGrossTau = grossTau;
	const directionFilter = numOpt(raw.directionFilter);
	if (directionFilter !== undefined && directionFilter >= 0) {
		out.directionFilter = directionFilter;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

// --- small helpers -------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isEngineKind(value: unknown): value is BrushEngineKind {
	return value === "dab" || value === "ribbon" || value === "geometric";
}

function isArtSource(value: unknown): value is BrushArtSource {
	if (!isRecord(value)) return false;
	if (value.kind === "file") return typeof value.fileUid === "string";
	if (value.kind === "def") return typeof value.defId === "string";
	return false;
}

function num(value: unknown, fallback: number): number {
	const n = Number(value);
	return Number.isFinite(n) ? n : fallback;
}

function numOpt(value: unknown): number | undefined {
	if (value === undefined || value === null) return undefined;
	const n = Number(value);
	return Number.isFinite(n) ? n : undefined;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}
