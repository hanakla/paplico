/**
 * The brush shape documents used before BrushSettingsV2, kept solely so old
 * files can still be opened: `migrate.ts` reads these types and emits v2, and
 * nothing else in the engine may import from here. Every runtime path — tools,
 * renderer, panel, storage — sees v2 only.
 */

import type {
	BrushArtSource,
	BrushColorMode,
	BrushStroking,
	StampRotation,
} from "../schema";

interface BrushSettingsBase {
	/** Base size in world units */
	size: number;
	/** Pressure-to-size sensitivity (0-1). 1.0 = zero pressure yields zero size */
	sizeByPressure: number;
	/** Base opacity (0-1) */
	opacity: number;
	/** Pressure-to-opacity sensitivity (0-1) */
	opacityByPressure: number;
	/** Seed for reproducible randomness (rotation, scatter selection, jitter) */
	randomSeed: number;
	/** Texture color processing mode. "tinting" uses luminance as alpha (default), "color" uses texture RGB directly */
	colorMode?: BrushColorMode;
	/** Entry taper length in world units. 0/undefined = off */
	taperStart?: number;
	/** Exit taper length in world units. 0/undefined = off */
	taperEnd?: number;
}

/** Geometric stroke pen (formerly the SVG brush). */
interface StrokeBrushSettings extends BrushSettingsBase {
	type: "stroke";
	/** Stroke geometry (line cap/join, miter, dash). */
	stroking?: BrushStroking;
}

/**
 * Per-stroke wetness parameters consumed by WetInkPass.
 *
 * All values are deterministic inputs to the simulation. Strokes without
 * `wetInk` (or with `enabled === false`) skip the wet pass and render
 * through the regular pipeline with no extra render target allocation.
 */
export interface WetInkSettings {
	/** Master toggle. `false` (or undefined wetInk) short-circuits all wet-ink work. */
	enabled: boolean;
	/** Bleed radius as a ratio of `size`. 0 = sharp edge, 1 = doubles the radius. */
	bleedWidth: number;
	/** Edge darkening intensity (0..1). Higher values deepen the rim of the wet patch. */
	edgeDarkening: number;
	/** Edge roughness (0..1). Paper-grain noise modulating the bleed boundary. */
	edgeRoughness: number;
	/** Internal paper grain (0..1). Granularity inside the wet patch. */
	paperGrain: number;
	/** Noise frequency in world units (smaller = larger grain). */
	paperScale: number;
	/** Directional bias toward stroke tangent (0..1). 1 = strong forward-pull. */
	directionality: number;
	/** Speed influence (0..1). Fast strokes bleed less (dry brush). */
	speedInfluence: number;
	/** Acceleration influence (0..1). Pauses/turns bleed more. */
	accelInfluence: number;
	/** Master wetness (0..1). Scales the field-write weight. */
	wetness: number;
	/**
	 * Optional bleed softness (0..1). 0 = granular bleed, 1 = soft bleed; the
	 * bleed radius itself does not change. Undefined uses
	 * `DEFAULT_WET_INK_DIFFUSION`. The diffuse pass always runs a fixed 32
	 * dt-normalized iterations, so the total effect is iteration-count
	 * independent.
	 */
	diffusion?: number;
	/** Pigment density to visible premultiplied alpha conversion strength. */
	pigmentLoad: number;
	/** Paper absorption rate. Higher values remove water earlier and leave pigment in paper grain. */
	absorption: number;
	/** Paper-grain pigment separation amount. */
	granulation: number;
	/** When true, the wet stroke picks pigment from the already-rendered layer buffer. */
	pickupUnderlyingColor: boolean;
	/** Strength of render-buffer color pickup into the wet simulation. */
	pickupStrength: number;
	/** Pickup trail distance (-2..2). Positive = forward sampling, negative = backward. Abs scales reach. Default 1.0. */
	pickupDecay?: number;
	/** Pickup color blend style (0..1). 0 = vivid (OkLCH hue arc), 1 = muted (OkLAB linear). Default 0. */
	pickupBlendMode?: number;
}

export const DEFAULT_WET_INK_DIFFUSION = 0.35;
export const DEFAULT_WET_INK_PIGMENT_LOAD = 0.85;
export const DEFAULT_WET_INK_ABSORPTION = 0.35;
export const DEFAULT_WET_INK_GRANULATION = 0.25;
export const DEFAULT_WET_INK_PICKUP_UNDERLYING_COLOR = false;
export const DEFAULT_WET_INK_PICKUP_STRENGTH = 0.35;
export const DEFAULT_WET_INK_PICKUP_DECAY = 1.0;

export interface ScatterBrushSettings extends BrushSettingsBase {
	type: "scatter";
	/** Art source for the stamp texture */
	source: BrushArtSource;
	/** Stamp spacing as ratio of size (0.1 = 10% of size) */
	spacing: number;
	/** Flow/accumulation (0-1). Lower values produce thinner layering */
	flow: number;
	/** Stamp rotation mode */
	stampRotation: StampRotation;
	/** Fixed stamp rotation angle in degrees (-180 to 180). Added on top of stampRotation mode. */
	stampAngle?: number;
	/** Tilt-to-stamp rotation influence (0-1). 0=no effect, 1=full tilt angle applied */
	rotationByTilt: number;
	/** Tilt-to-aspect ratio influence (0-1). 0=circular, 1=max elongation at full tilt */
	aspectRatioByTilt: number;
	/** Speed-to-size influence (0-1). Higher speed yields a thinner line. */
	sizeBySpeed: number;
	/** Ink pooling strength (0-1). Higher values accumulate more ink at low speed */
	pooling: number;
	/** Pooling size/opacity balance (0-1). 0=opacity-heavy, 1=size-heavy */
	poolingSizeRatio: number;
	/** Additional art variants for scatter (randomly selected per stamp) */
	scatterSources?: readonly BrushArtSource[];
	/** Art source for the first stamp of a stroke */
	startSource?: BrushArtSource;
	/** Art source for the last stamp of a stroke */
	endSource?: BrushArtSource;
	/** Perpendicular scatter offset (0-1, ratio of brush size) */
	scatterOffset?: number;
	/** Size jitter range (0-1, random variation ratio of base size) */
	scatterSizeVariation?: number;
	/** Optional wet-ink parameters. Undefined keeps the stroke dry. */
	wetInk?: WetInkSettings;
}

/** Art brush: stretches one art source along the whole stroke length. */
interface ArtBrushSettings extends BrushSettingsBase {
	type: "art";
	source: BrushArtSource;
	/** Flow/accumulation (0-1) */
	flow: number;
	/** Flip art along the stroke direction */
	flip?: boolean;
	/** Flip art across the stroke width */
	flipAcross?: boolean;
}

/** Pattern brush: repeats a tile along the stroke. */
interface PatternBrushSettings extends BrushSettingsBase {
	type: "pattern";
	source: BrushArtSource;
	/** Flow/accumulation (0-1) */
	flow: number;
	/** Tile width factor (1 = preserve texture aspect ratio) */
	tileScale: number;
	/** Gap between tiles as ratio of tile width (0 = no gap) */
	tileSpacing: number;
	/** UV.x offset for alignment */
	uvOffset?: number;
	/** End-fraction handling. v1 supports "none" only. */
	fitMode?: "none";
}

/** Calligraphy brush: elliptical nib, no texture. */
export interface CalligraphyBrushSettings extends BrushSettingsBase {
	type: "calligraphy";
	/** Nib angle in degrees */
	nibAngle: number;
	/** Nib roundness 0..1 (minor/major axis ratio; 1 = circular) */
	roundness: number;
	/** Source of nib orientation */
	angleMode: "fixed" | "tangent" | "tilt";
	/** Stamp spacing as ratio of size (0.1 = 10% of size) */
	spacing?: number;
	/** Flow/accumulation (0-1) */
	flow: number;
	/** Speed-to-size influence (0-1) */
	sizeBySpeed: number;
	/** Ink pooling strength (0-1) */
	pooling: number;
	/** Pooling size/opacity balance (0-1) */
	poolingSizeRatio: number;
	/** Optional wet-ink parameters. Undefined keeps the stroke dry. */
	wetInk?: WetInkSettings;
}

export const DEFAULT_CALLIGRAPHY_SPACING = 0.05;

export type BrushSettings =
	| StrokeBrushSettings
	| ScatterBrushSettings
	| ArtBrushSettings
	| PatternBrushSettings
	| CalligraphyBrushSettings;
