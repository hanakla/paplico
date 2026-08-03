/**
 * Built-in brush EmbeddedFiles and BrushPresets.
 *
 * Extracts the pixel generation logic from BrushTextureManager into
 * standalone functions so it can be reused (e.g. for document
 * initialization without a GPU device).
 */

import { airBrush, pencil } from "../assets";
import {
	type BrushPreset,
	type BrushPresetCategory,
	type BrushSettings,
	BUILTIN_BRUSH_IDS,
	type BuiltinBrushId,
	type CalligraphyBrushSettings,
	DEFAULT_CALLIGRAPHY_SPACING,
	DEFAULT_WET_INK_ABSORPTION,
	DEFAULT_WET_INK_GRANULATION,
	DEFAULT_WET_INK_PICKUP_DECAY,
	DEFAULT_WET_INK_PICKUP_STRENGTH,
	DEFAULT_WET_INK_PICKUP_UNDERLYING_COLOR,
	DEFAULT_WET_INK_PIGMENT_LOAD,
	type EmbeddedFile,
	type ScatterBrushSettings,
} from "../schema";

// Texture size used for programmatically generated brushes
const TEXTURE_SIZE = 128;

/** Shared scatter defaults for the stamp-based built-in brushes. */
const SCATTER_DEFAULTS = {
	size: 10,
	sizeByPressure: 0.5,
	opacity: 1.0,
	opacityByPressure: 0.3,
	randomSeed: 0,
	spacing: 0.15,
	flow: 1.0,
	stampRotation: "none",
	rotationByTilt: 0,
	aspectRatioByTilt: 0,
	sizeBySpeed: 0.5,
	pooling: 0,
	poolingSizeRatio: 0.5,
} as const satisfies Omit<ScatterBrushSettings, "type" | "source">;

/** Build a scatter brush preset for a built-in texture, with per-brush overrides. */
function scatterPreset(
	fileUid: BuiltinBrushId,
	overrides: Partial<ScatterBrushSettings>,
): ScatterBrushSettings {
	return {
		...SCATTER_DEFAULTS,
		type: "scatter",
		source: { kind: "file", fileUid },
		...overrides,
	};
}

/** Build a calligraphy preset (no texture source; rendered procedurally). */
function calligraphyPreset(
	overrides: Partial<CalligraphyBrushSettings>,
): CalligraphyBrushSettings {
	return {
		size: 10,
		sizeByPressure: 0.3,
		opacity: 1.0,
		opacityByPressure: 0,
		randomSeed: 0,
		type: "calligraphy",
		nibAngle: 0,
		roundness: 1,
		angleMode: "fixed",
		spacing: DEFAULT_CALLIGRAPHY_SPACING,
		flow: 1.0,
		sizeBySpeed: 0.5,
		pooling: 0,
		poolingSizeRatio: 0.5,
		...overrides,
	};
}

/**
 * Built-in brush presets keyed by texture file UID.
 *
 * Note: Hard Round (BUILTIN_BRUSH_IDS.hardCircle) and Calligraphy
 * (BUILTIN_BRUSH_IDS.calligraphy) both use the procedural calligraphy engine
 * (elliptical nib, no texture). The hardCircle EmbeddedFile is retained for
 * documents authored before the brush-system rework — those references resolve
 * via the BrushTextureManager fallback chain.
 */
export const BRUSH_PRESETS: Record<BuiltinBrushId, BrushSettings> = {
	[BUILTIN_BRUSH_IDS.svg]: {
		type: "stroke",
		size: 10,
		sizeByPressure: 0,
		opacity: 1.0,
		opacityByPressure: 0,
		randomSeed: 0,
	},
	[BUILTIN_BRUSH_IDS.hardCircle]: calligraphyPreset({
		nibAngle: 0,
		roundness: 1,
		angleMode: "fixed",
	}),
	[BUILTIN_BRUSH_IDS.calligraphy]: calligraphyPreset({
		nibAngle: 45,
		roundness: 0.25,
		angleMode: "fixed",
	}),
	[BUILTIN_BRUSH_IDS.softCircle]: scatterPreset(BUILTIN_BRUSH_IDS.softCircle, {
		spacing: 0.1,
		sizeByPressure: 0.5,
		opacityByPressure: 0.2,
	}),
	[BUILTIN_BRUSH_IDS.pencil]: scatterPreset(BUILTIN_BRUSH_IDS.pencil, {
		spacing: 0.08,
		sizeByPressure: 0.3,
		opacityByPressure: 0.5,
		flow: 0.8,
	}),
	[BUILTIN_BRUSH_IDS.airbrush]: scatterPreset(BUILTIN_BRUSH_IDS.airbrush, {
		spacing: 0.05,
		sizeByPressure: 0.2,
		opacityByPressure: 0.6,
		flow: 0.4,
	}),
};

// -- Public API --------------------------------------------------------------

/** Create EmbeddedFile entries for all four built-in brush textures. */
export async function createBuiltinBrushFiles(): Promise<EmbeddedFile[]> {
	// Generate pixel data for programmatic brushes
	const hardPixels = generateHardCirclePixels(TEXTURE_SIZE);
	const softPixels = generateSoftCirclePixels(TEXTURE_SIZE);

	// Encode to PNG blobs
	const [hardBlob, softBlob] = await Promise.all([
		pixelsToBlob(hardPixels, TEXTURE_SIZE),
		pixelsToBlob(softPixels, TEXTURE_SIZE),
	]);

	// Convert blobs to Uint8Array
	const [hardBin, softBin] = await Promise.all([
		hardBlob.arrayBuffer().then((buf) => new Uint8Array(buf)),
		softBlob.arrayBuffer().then((buf) => new Uint8Array(buf)),
	]);

	// Decode base64 asset brushes
	const pencilBin = base64ToUint8Array(pencil);
	const airbrushBin = base64ToUint8Array(airBrush);

	// Compute hashes in parallel
	const [hardHash, softHash, pencilHash, airbrushHash] = await Promise.all([
		computeHash(hardBin),
		computeHash(softBin),
		computeHash(pencilBin),
		computeHash(airbrushBin),
	]);

	return [
		{
			uid: BUILTIN_BRUSH_IDS.hardCircle,
			name: "Hard Circle Brush",
			type: "image/png",
			hash: hardHash,
			bin: hardBin,
		},
		{
			uid: BUILTIN_BRUSH_IDS.softCircle,
			name: "Soft Brush",
			type: "image/png",
			hash: softHash,
			bin: softBin,
		},
		{
			uid: BUILTIN_BRUSH_IDS.pencil,
			name: "Pencil Brush",
			type: "image/png",
			hash: pencilHash,
			bin: pencilBin,
		},
		{
			uid: BUILTIN_BRUSH_IDS.airbrush,
			name: "Airbrush",
			type: "image/png",
			hash: airbrushHash,
			bin: airbrushBin,
		},
	];
}

/** Create BrushPreset entries for all built-in brushes. */
export function createBuiltinBrushPresets(): BrushPreset[] {
	const presets: Array<{
		builtinId: BuiltinBrushId;
		name: string;
		category: BrushPresetCategory;
	}> = [
		{ builtinId: BUILTIN_BRUSH_IDS.svg, name: "Pen", category: "pen" },
		{
			builtinId: BUILTIN_BRUSH_IDS.hardCircle,
			name: "Hard Round",
			category: "pen",
		},
		{
			builtinId: BUILTIN_BRUSH_IDS.calligraphy,
			name: "Calligraphy",
			category: "calligraphy",
		},
		{
			builtinId: BUILTIN_BRUSH_IDS.softCircle,
			name: "Soft Circle",
			category: "airbrush",
		},
		{ builtinId: BUILTIN_BRUSH_IDS.pencil, name: "Pencil", category: "pen" },
		{
			builtinId: BUILTIN_BRUSH_IDS.airbrush,
			name: "Airbrush",
			category: "airbrush",
		},
	];

	const builtins: BrushPreset[] = presets.map(
		({ builtinId, name, category }) => ({
			uid: builtinId,
			name,
			category,
			settings: BRUSH_PRESETS[builtinId],
		}),
	);

	// Demonstrates wetInk on top of an existing soft-circle stamp; reuses the
	// soft circle texture so no new builtin texture is required.
	const watercolour: BrushPreset = {
		uid: "builtin-brush-watercolor",
		name: "Watercolor",
		category: "watercolor",
		settings: scatterPreset(BUILTIN_BRUSH_IDS.softCircle, {
			spacing: 0.06,
			sizeByPressure: 0.4,
			opacityByPressure: 0.4,
			flow: 0.65,
			wetInk: {
				enabled: true,
				bleedWidth: 0.5,
				edgeDarkening: 0.45,
				edgeRoughness: 0.35,
				paperGrain: 0.25,
				paperScale: 1.2,
				directionality: 0.3,
				speedInfluence: 0.5,
				accelInfluence: 0.5,
				wetness: 0.8,
				diffusion: 0.55,
				pigmentLoad: DEFAULT_WET_INK_PIGMENT_LOAD,
				absorption: DEFAULT_WET_INK_ABSORPTION,
				granulation: DEFAULT_WET_INK_GRANULATION,
				pickupUnderlyingColor: DEFAULT_WET_INK_PICKUP_UNDERLYING_COLOR,
				pickupStrength: DEFAULT_WET_INK_PICKUP_STRENGTH,
				pickupDecay: DEFAULT_WET_INK_PICKUP_DECAY,
				pickupBlendMode: 0,
			},
		}),
	};

	// Fast, high-absorption strokes over the grainy pencil stamp; bleeds only a
	// little so the texture reads as dragged-out pigment.
	const dryBrush: BrushPreset = {
		uid: "builtin-brush-dry-brush",
		name: "Dry Brush",
		category: "watercolor",
		settings: scatterPreset(BUILTIN_BRUSH_IDS.pencil, {
			spacing: 0.08,
			sizeByPressure: 0.35,
			opacityByPressure: 0.4,
			flow: 0.7,
			wetInk: {
				enabled: true,
				bleedWidth: 0.15,
				edgeDarkening: 0.2,
				edgeRoughness: 0.55,
				paperGrain: 0.6,
				paperScale: 1.6,
				directionality: 0.15,
				speedInfluence: 0.9,
				accelInfluence: 0.2,
				wetness: 0.3,
				diffusion: 0.2,
				pigmentLoad: 1.0,
				absorption: 0.7,
				granulation: 0.65,
				pickupUnderlyingColor: false,
				pickupStrength: DEFAULT_WET_INK_PICKUP_STRENGTH,
				pickupDecay: DEFAULT_WET_INK_PICKUP_DECAY,
				pickupBlendMode: 0,
			},
		}),
	};

	// Very wet strokes that spread far and mix with the colors already on the
	// layer via underlying-color pickup.
	const bleedWatercolor: BrushPreset = {
		uid: "builtin-brush-bleed-watercolor",
		name: "Bleed Watercolor",
		category: "watercolor",
		settings: scatterPreset(BUILTIN_BRUSH_IDS.softCircle, {
			spacing: 0.06,
			sizeByPressure: 0.4,
			opacityByPressure: 0.35,
			flow: 0.5,
			wetInk: {
				enabled: true,
				bleedWidth: 0.85,
				edgeDarkening: 0.55,
				edgeRoughness: 0.4,
				paperGrain: 0.3,
				paperScale: 1.2,
				directionality: 0.4,
				speedInfluence: 0.25,
				accelInfluence: 0.6,
				wetness: 0.95,
				diffusion: 0.75,
				pigmentLoad: 0.7,
				absorption: 0.2,
				granulation: 0.3,
				pickupUnderlyingColor: true,
				pickupStrength: 0.55,
				pickupDecay: 1.0,
				pickupBlendMode: 0,
			},
		}),
	};

	const gPen: BrushPreset = {
		uid: "builtin-brush-g-pen",
		name: "G-Pen",
		category: "pen",
		settings: calligraphyPreset({
			nibAngle: 0,
			roundness: 1,
			angleMode: "fixed",
			sizeByPressure: 0.85,
			opacityByPressure: 0,
		}),
	};

	const marker: BrushPreset = {
		uid: "builtin-brush-marker",
		name: "Marker",
		category: "pen",
		settings: scatterPreset(BUILTIN_BRUSH_IDS.hardCircle, {
			spacing: 0.05,
			sizeByPressure: 0,
			opacityByPressure: 0,
			opacity: 0.85,
			flow: 0.9,
		}),
	};

	const ink: BrushPreset = {
		uid: "builtin-brush-ink",
		name: "Ink",
		category: "pen",
		settings: calligraphyPreset({
			roundness: 1,
			sizeByPressure: 0.7,
			pooling: 0.6,
			poolingSizeRatio: 0.4,
		}),
	};

	const softAirbrush: BrushPreset = {
		uid: "builtin-brush-soft-airbrush",
		name: "Soft Airbrush",
		category: "airbrush",
		settings: scatterPreset(BUILTIN_BRUSH_IDS.softCircle, {
			size: 30,
			spacing: 0.04,
			sizeByPressure: 0.1,
			opacityByPressure: 0.7,
			flow: 0.15,
		}),
	};

	return [
		...builtins,
		watercolour,
		dryBrush,
		bleedWatercolor,
		gPen,
		marker,
		ink,
		softAirbrush,
	];
}

// -- Pixel generation helpers ------------------------------------------------

/** Generate RGBA pixels for a hard-edge circle (no gradient). */
function generateHardCirclePixels(size: number): Uint8Array {
	const data = new Uint8Array(size * size * 4);
	const center = size / 2;
	const radius = size / 2 - 1;

	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			const dx = x - center + 0.5;
			const dy = y - center + 0.5;
			const dist = Math.sqrt(dx * dx + dy * dy);

			// Hard edge: fully opaque inside the radius
			const alpha = dist <= radius ? 255 : 0;

			const idx = (y * size + x) * 4;
			// Luminance-based alpha for shader: R=G=B=alpha, A=255
			data[idx] = alpha;
			data[idx + 1] = alpha;
			data[idx + 2] = alpha;
			data[idx + 3] = 255;
		}
	}

	return data;
}

/** Generate RGBA pixels for a soft circle with Gaussian falloff. */
function generateSoftCirclePixels(size: number): Uint8Array {
	const data = new Uint8Array(size * size * 4);
	const center = size / 2;

	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			const dx = (x - center + 0.5) / center;
			const dy = (y - center + 0.5) / center;
			const dist = Math.sqrt(dx * dx + dy * dy);

			// Gaussian falloff (sigma=0.4): alpha=1 at center, ~0 at edge
			const sigma = 0.4;
			const alpha =
				dist < 1 ? Math.exp((-dist * dist) / (2 * sigma * sigma)) : 0;
			const alphaU8 = Math.round(alpha * 255);

			const idx = (y * size + x) * 4;
			// Luminance-based alpha for shader: R=G=B=alpha, A=255
			data[idx] = alphaU8;
			data[idx + 1] = alphaU8;
			data[idx + 2] = alphaU8;
			data[idx + 3] = 255;
		}
	}

	return data;
}

// -- Encoding / hashing helpers ----------------------------------------------

/** Convert RGBA pixel data to a PNG blob via OffscreenCanvas. */
async function pixelsToBlob(pixels: Uint8Array, size: number): Promise<Blob> {
	const canvas = new OffscreenCanvas(size, size);
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("Failed to get 2d context from OffscreenCanvas");
	const imageData = new ImageData(new Uint8ClampedArray(pixels), size, size);
	ctx.putImageData(imageData, 0, 0);
	return canvas.convertToBlob({ type: "image/png" });
}

/** Decode a base64-encoded string to binary. */
function base64ToUint8Array(base64: string): Uint8Array {
	const binaryString = atob(base64);
	const bytes = new Uint8Array(binaryString.length);
	for (let i = 0; i < binaryString.length; i++) {
		bytes[i] = binaryString.charCodeAt(i);
	}
	return bytes;
}

/** Compute SHA-256 hash of binary data, returned as a hex string. */
async function computeHash(bin: Uint8Array): Promise<string> {
	const hashBuffer = await crypto.subtle.digest("SHA-256", new Uint8Array(bin));
	const hashArray = new Uint8Array(hashBuffer);
	return Array.from(hashArray, (b) => b.toString(16).padStart(2, "0")).join("");
}
