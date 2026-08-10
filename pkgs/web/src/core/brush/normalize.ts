import {
	type BrushArtSource,
	type BrushColorMode,
	type BrushPreset,
	type BrushStroking,
	BUILTIN_BRUSH_IDS,
	type StampRotation,
} from "../schema";
import { normalizeBrushSettingsV2 } from "./migrate";
import {
	type BrushSettings,
	type CalligraphyBrushSettings,
	DEFAULT_CALLIGRAPHY_SPACING,
	DEFAULT_WET_INK_ABSORPTION,
	DEFAULT_WET_INK_DIFFUSION,
	DEFAULT_WET_INK_GRANULATION,
	DEFAULT_WET_INK_PICKUP_DECAY,
	DEFAULT_WET_INK_PICKUP_STRENGTH,
	DEFAULT_WET_INK_PICKUP_UNDERLYING_COLOR,
	DEFAULT_WET_INK_PIGMENT_LOAD,
	type ScatterBrushSettings,
	type WetInkSettings,
} from "./v1";

/**
 * Read pre-v2 brush data (legacy flat shape or v1 union) into a v1 union
 * value. This is the first half of the migration to v2 and has no other
 * callers; reading is lenient so old documents keep opening:
 * - svg texture -> stroke
 * - renderMode "ribbon" -> pattern
 * - everything else -> scatter
 * The removed `vectorBrushSourceId` is ignored.
 */
export function normalizeBrushSettings(raw: unknown): BrushSettings {
	const r = (raw ?? {}) as Record<string, unknown>;
	const base: BrushSettingsCommon = {
		size: num(r.size, 10),
		sizeByPressure: num(r.sizeByPressure, 0.5),
		opacity: num(r.opacity, 1),
		opacityByPressure: num(r.opacityByPressure, 0.3),
		randomSeed: num(r.randomSeed, 0),
		colorMode: asColorMode(r.colorMode),
		taperStart: asNumberOpt(r.taperStart),
		taperEnd: asNumberOpt(r.taperEnd),
	};

	switch (r.type) {
		case "stroke":
			return { ...base, type: "stroke", stroking: asStroking(r.stroking) };
		case "scatter":
			return buildScatter(r, base, normalizeSource(r.source, r));
		case "art":
			return {
				...base,
				type: "art",
				source: normalizeSource(r.source, r),
				flow: num(r.flow, 1),
				flip: asBool(r.flip),
				flipAcross: asBool(r.flipAcross),
			};
		case "pattern":
			return {
				...base,
				type: "pattern",
				source: normalizeSource(r.source, r),
				flow: num(r.flow, 1),
				tileScale: num(r.tileScale, 1),
				tileSpacing: num(r.tileSpacing, 0),
				uvOffset: asNumberOpt(r.uvOffset),
				fitMode: "none",
			};
		case "calligraphy":
			return buildCalligraphy(r, base);
	}

	// Legacy flat shape (no `type` field).
	const textureFileUid =
		typeof r.textureFileUid === "string"
			? r.textureFileUid
			: BUILTIN_BRUSH_IDS.softCircle;
	if (textureFileUid === BUILTIN_BRUSH_IDS.svg) {
		return { ...base, type: "stroke", stroking: asStroking(r.stroking) };
	}
	if (r.renderMode === "ribbon") {
		return {
			...base,
			type: "pattern",
			source: { kind: "file", fileUid: textureFileUid },
			flow: num(r.flow, 1),
			tileScale: 1 + num(r.ribbonStretch, 0),
			tileSpacing: 0,
			uvOffset: asNumberOpt(r.ribbonOffset),
			fitMode: "none",
		};
	}
	return buildScatter(r, base, { kind: "file", fileUid: textureFileUid });
}

/**
 * Normalize a persisted brush preset into v2. Presets predating v2 stored the
 * brush as `textureFileUid` + `defaultSettings`, or as a v1 union under
 * `settings`; both are folded back into a flat record and migrated here, so
 * everything downstream of this point is v2.
 */
export function normalizeBrushPreset(raw: unknown): BrushPreset {
	const r = (raw ?? {}) as Record<string, unknown>;
	const stored =
		r.settings != null
			? r.settings
			: {
					...((r.defaultSettings as Record<string, unknown>) ?? {}),
					textureFileUid: r.textureFileUid,
				};
	return {
		uid: String(r.uid),
		name: String(r.name),
		settings: normalizeBrushSettingsV2(stored),
	};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type BrushSettingsCommon = {
	size: number;
	sizeByPressure: number;
	opacity: number;
	opacityByPressure: number;
	randomSeed: number;
	colorMode?: BrushColorMode;
	taperStart?: number;
	taperEnd?: number;
};

function buildScatter(
	r: Record<string, unknown>,
	base: BrushSettingsCommon,
	source: BrushArtSource,
): ScatterBrushSettings {
	return {
		...base,
		type: "scatter",
		source,
		spacing: num(r.spacing, 0.1),
		flow: num(r.flow, 1),
		stampRotation: asStampRotation(r.stampRotation),
		stampAngle: asNumberOpt(r.stampAngle),
		rotationByTilt: num(r.rotationByTilt, 0),
		aspectRatioByTilt: num(r.aspectRatioByTilt, 0),
		sizeBySpeed: num(r.sizeBySpeed, 0),
		pooling: num(r.pooling, 0),
		poolingSizeRatio: num(r.poolingSizeRatio, 0.5),
		scatterSources: normalizeScatterSources(r),
		startSource: normalizeNamedSource(r.startSource, r.startTextureUid),
		endSource: normalizeNamedSource(r.endSource, r.endTextureUid),
		scatterOffset: asNumberOpt(r.scatterOffset),
		scatterSizeVariation: asNumberOpt(r.scatterSizeVariation),
		wetInk: asWetInk(r.wetInk),
	};
}

function buildCalligraphy(
	r: Record<string, unknown>,
	base: BrushSettingsCommon,
): CalligraphyBrushSettings {
	return {
		...base,
		type: "calligraphy",
		nibAngle: num(r.nibAngle, 0),
		roundness: num(r.roundness, 1),
		angleMode:
			r.angleMode === "tangent" || r.angleMode === "tilt"
				? r.angleMode
				: "fixed",
		spacing: num(r.spacing, DEFAULT_CALLIGRAPHY_SPACING),
		flow: num(r.flow, 1),
		sizeBySpeed: num(r.sizeBySpeed, 0),
		pooling: num(r.pooling, 0),
		poolingSizeRatio: num(r.poolingSizeRatio, 0.5),
		wetInk: asWetInk(r.wetInk),
	};
}

/** Resolve a source from a new `source` field, falling back to legacy `textureFileUid`. */
function normalizeSource(
	v: unknown,
	fallback: Record<string, unknown>,
): BrushArtSource {
	const source = asSource(v);
	if (source) return source;
	const tex = fallback.textureFileUid;
	return {
		kind: "file",
		fileUid: typeof tex === "string" ? tex : BUILTIN_BRUSH_IDS.softCircle,
	};
}

/** Combine a new `scatterSources` array and legacy `scatterTextureUids` into sources. */
function normalizeScatterSources(
	r: Record<string, unknown>,
): readonly BrushArtSource[] | undefined {
	if (Array.isArray(r.scatterSources)) {
		const out = r.scatterSources
			.map(asSource)
			.filter((s): s is BrushArtSource => s != null);
		return out.length > 0 ? out : undefined;
	}
	if (Array.isArray(r.scatterTextureUids)) {
		const out = r.scatterTextureUids
			.filter((uid): uid is string => typeof uid === "string")
			.map((fileUid): BrushArtSource => ({ kind: "file", fileUid }));
		return out.length > 0 ? out : undefined;
	}
	return undefined;
}

/** Resolve a named source slot from a new source field or a legacy texture UID. */
function normalizeNamedSource(
	source: unknown,
	legacyUid: unknown,
): BrushArtSource | undefined {
	const s = asSource(source);
	if (s) return s;
	if (typeof legacyUid === "string")
		return { kind: "file", fileUid: legacyUid };
	return undefined;
}

function asSource(v: unknown): BrushArtSource | undefined {
	if (v && typeof v === "object" && "kind" in v) {
		const s = v as { kind?: unknown; fileUid?: unknown; defId?: unknown };
		if (s.kind === "file" && typeof s.fileUid === "string") {
			return { kind: "file", fileUid: s.fileUid };
		}
		if (s.kind === "def" && typeof s.defId === "string") {
			return { kind: "def", defId: s.defId };
		}
	}
	return undefined;
}

function num(v: unknown, fallback: number): number {
	return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function asNumberOpt(v: unknown): number | undefined {
	return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function asBool(v: unknown): boolean | undefined {
	return typeof v === "boolean" ? v : undefined;
}

function asColorMode(v: unknown): BrushColorMode | undefined {
	return v === "tinting" || v === "color" ? v : undefined;
}

function asWetInk(v: unknown): WetInkSettings | undefined {
	if (!v || typeof v !== "object") return undefined;
	const w = v as Record<string, unknown>;
	const enabled = asBool(w.enabled);
	if (enabled == null) return undefined;
	return {
		enabled,
		bleedWidth: num(w.bleedWidth, 0.5),
		edgeDarkening: num(w.edgeDarkening, 0.4),
		edgeRoughness: num(w.edgeRoughness, 0.3),
		paperGrain: num(w.paperGrain, 0.2),
		paperScale: num(w.paperScale, 1),
		directionality: num(w.directionality, 0.4),
		speedInfluence: num(w.speedInfluence, 0.5),
		accelInfluence: num(w.accelInfluence, 0.3),
		wetness: num(w.wetness, 0.7),
		diffusion: num(w.diffusion, DEFAULT_WET_INK_DIFFUSION),
		pigmentLoad: num(w.pigmentLoad, DEFAULT_WET_INK_PIGMENT_LOAD),
		absorption: num(w.absorption, DEFAULT_WET_INK_ABSORPTION),
		granulation: num(w.granulation, DEFAULT_WET_INK_GRANULATION),
		pickupUnderlyingColor:
			asBool(w.pickupUnderlyingColor) ??
			DEFAULT_WET_INK_PICKUP_UNDERLYING_COLOR,
		pickupStrength: num(w.pickupStrength, DEFAULT_WET_INK_PICKUP_STRENGTH),
		pickupDecay: num(w.pickupDecay, DEFAULT_WET_INK_PICKUP_DECAY),
		pickupBlendMode: num(w.pickupBlendMode, 0),
	};
}

function asStampRotation(v: unknown): StampRotation {
	return v === "tangent" || v === "random" ? v : "none";
}

function asStroking(v: unknown): BrushStroking | undefined {
	if (!v || typeof v !== "object") return undefined;
	const s = v as Record<string, unknown>;
	return {
		lineCap:
			s.lineCap === "butt" || s.lineCap === "square" ? s.lineCap : "round",
		lineJoin:
			s.lineJoin === "miter" || s.lineJoin === "bevel" ? s.lineJoin : "round",
		miterLimit: num(s.miterLimit, 4),
		...(Array.isArray(s.dashArray) &&
		s.dashArray.every((n) => typeof n === "number")
			? { dashArray: s.dashArray as number[] }
			: {}),
		...(typeof s.dashOffset === "number" ? { dashOffset: s.dashOffset } : {}),
	};
}
