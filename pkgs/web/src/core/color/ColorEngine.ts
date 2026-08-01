import type { JsColorEngineModule, JscProfile } from "jscolorengine";
import { buildLutGridRgb, packRgbToRgba } from "./softProofLut";
import type { RenderingIntent, SoftProofLutResult } from "./types";

export interface BuildSoftProofLutOptions {
	displaySpace: "srgb" | "display-p3";
	proofProfileBytes: Uint8Array;
	intent: RenderingIntent;
	/** Grid points per LUT axis. Default 33. */
	gridSize?: number;
	/** Raw bytes for the display profile (injected from infra; core does not fetch). */
	displayProfileBytes: Uint8Array;
}

export interface ConvertImageToCmykOptions {
	srcSpace: "srgb" | "display-p3";
	profileBytes: Uint8Array;
	intent: RenderingIntent;
	/** Raw bytes for the source display profile (injected from infra; core does not fetch). */
	srcProfileBytes: Uint8Array;
}

export interface ConvertImageRgbToRgbOptions {
	srcProfileBytes: Uint8Array;
	dstProfileBytes: Uint8Array;
	intent: RenderingIntent;
}

const DEFAULT_SOFT_PROOF_GRID_SIZE = 33;

const softProofLutCache = new Map<string, Promise<SoftProofLutResult>>();

/** Bakes an RGB->CMYK->RGB roundtrip into a size^3 RGBA LUT for GPU soft proofing. */
export async function buildSoftProofLut(
	opts: BuildSoftProofLutOptions,
): Promise<SoftProofLutResult> {
	const gridSize = opts.gridSize ?? DEFAULT_SOFT_PROOF_GRID_SIZE;
	const cacheKey = [
		opts.displaySpace,
		opts.intent,
		gridSize,
		fnv1aHash(opts.proofProfileBytes),
		fnv1aHash(opts.displayProfileBytes),
	].join(":");

	const cached = softProofLutCache.get(cacheKey);
	if (cached) return cached;

	const promise = bakeSoftProofLut(opts, gridSize);
	softProofLutCache.set(cacheKey, promise);
	promise.catch(() => softProofLutCache.delete(cacheKey));
	return promise;
}

/** Converts straight (non-premultiplied) 8bit RGBA pixels to 8bit CMYK using the given CMYK profile. */
export async function convertImageToCmyk(
	rgba: Uint8ClampedArray,
	opts: ConvertImageToCmykOptions,
): Promise<Uint8Array> {
	if (rgba.length % 4 !== 0) {
		throw new Error(
			`RGBA data length must be a multiple of 4, got ${rgba.length}`,
		);
	}

	const jsce = await loadJsColorEngine();
	const srcProfile = loadProfile(jsce, opts.srcProfileBytes, "source display");
	const cmykProfile = loadProfile(jsce, opts.profileBytes, "destination");
	const intent = resolvePcsToDeviceIntent(jsce, cmykProfile, opts.intent);

	// Image fast path: prebuilt LUT + int8 flat arrays.
	const transform = new jsce.Transform({ buildLut: true, dataFormat: "int8" });
	createTransform(() => transform.create(srcProfile, cmykProfile, intent));

	const cmyk = transform.transformArray(rgba, true, false, false);
	return new Uint8Array(cmyk.buffer, cmyk.byteOffset, cmyk.length);
}

/** Converts straight (non-premultiplied) 8bit RGBA pixels from one RGB ICC profile to another. */
export async function convertImageRgbToRgb(
	rgba: Uint8ClampedArray,
	opts: ConvertImageRgbToRgbOptions,
): Promise<Uint8Array> {
	if (rgba.length % 4 !== 0) {
		throw new Error(
			`RGBA data length must be a multiple of 4, got ${rgba.length}`,
		);
	}

	const jsce = await loadJsColorEngine();
	const srcProfile = loadProfile(jsce, opts.srcProfileBytes, "source display");
	const dstProfile = loadProfile(
		jsce,
		opts.dstProfileBytes,
		"destination display",
	);
	const intent = resolvePcsToDeviceIntent(jsce, dstProfile, opts.intent);

	const transform = new jsce.Transform({ buildLut: true, dataFormat: "int8" });
	createTransform(() => transform.create(srcProfile, dstProfile, intent));

	const out = transform.transformArray(rgba, true, false, false);
	return new Uint8Array(out.buffer, out.byteOffset, out.length);
}

/**
 * Reads the human-readable name from an ICC profile's 'desc' tag.
 * Returns null when the bytes cannot be parsed (caller falls back to file name).
 */
export async function readIccProfileDescription(
	bytes: Uint8Array,
): Promise<string | null> {
	try {
		const jsce = await loadJsColorEngine();
		const profile = new jsce.Profile();
		profile.loadBinary(bytes);
		if (!profile.loaded) return null;
		const name = profile.name?.trim();
		return name ? name : null;
	} catch {
		return null;
	}
}

async function bakeSoftProofLut(
	opts: BuildSoftProofLutOptions,
	gridSize: number,
): Promise<SoftProofLutResult> {
	const jsce = await loadJsColorEngine();
	const displayProfile = loadProfile(jsce, opts.displayProfileBytes, "display");
	const proofProfile = loadProfile(jsce, opts.proofProfileBytes, "proof");

	const toProofIntent = resolvePcsToDeviceIntent(
		jsce,
		proofProfile,
		opts.intent,
	);
	// The proof -> display leg conventionally uses relative colorimetric so
	// the simulated print is shown as-is on the display.
	const toDisplayIntent = resolveDeviceToPcsIntent(
		jsce,
		proofProfile,
		"relative-colorimetric",
	);

	// Accuracy path (no prebuilt engine LUT): the grid points themselves are
	// the LUT samples, so each one runs the full f64 pipeline.
	const transform = new jsce.Transform({ dataFormat: "int8" });
	createTransform(() =>
		transform.createMultiStage([
			displayProfile,
			toProofIntent,
			proofProfile,
			toDisplayIntent,
			displayProfile,
		]),
	);

	const grid = buildLutGridRgb(gridSize);
	const proofed = transform.transformArray(
		grid,
		false,
		false,
		false,
		gridSize ** 3,
		"int8",
	);
	return { size: gridSize, data: packRgbToRgba(proofed) };
}

let jsColorEnginePromise: Promise<JsColorEngineModule> | null = null;

/** Lazily imports jscolorengine so it stays out of the initial bundle. */
function loadJsColorEngine(): Promise<JsColorEngineModule> {
	jsColorEnginePromise ??= import("jscolorengine").then((mod) => mod.default);
	return jsColorEnginePromise;
}

function loadProfile(
	jsce: JsColorEngineModule,
	bytes: Uint8Array,
	label: string,
): JscProfile {
	const profile = new jsce.Profile();
	profile.loadBinary(bytes);
	if (!profile.loaded) {
		throw new Error(
			`Failed to load ${label} ICC profile: ${profile.lastError?.text ?? "unknown error"}`,
		);
	}
	return profile;
}

/** jscolorengine throws plain strings; normalize them to Errors. */
function createTransform(create: () => void): void {
	try {
		create();
	} catch (error) {
		throw error instanceof Error
			? error
			: new Error(`Failed to create color transform: ${String(error)}`);
	}
}

function resolvePcsToDeviceIntent(
	jsce: JsColorEngineModule,
	profile: JscProfile,
	intent: RenderingIntent,
): number {
	return resolveLutIntent(
		jsce,
		profile,
		profile.B2A,
		intent,
		"PCS-to-device (B2A)",
	);
}

function resolveDeviceToPcsIntent(
	jsce: JsColorEngineModule,
	profile: JscProfile,
	intent: RenderingIntent,
): number {
	return resolveLutIntent(
		jsce,
		profile,
		profile.A2B,
		intent,
		"device-to-PCS (A2B)",
	);
}

/**
 * Maps a rendering intent to the engine's eIntent value, falling back to an
 * intent whose lookup table actually exists in the profile (mirroring how
 * CMMs degrade when a profile ships only a subset of its tables). Throws
 * when the profile is LUT-based and has no table at all for the direction.
 */
function resolveLutIntent(
	jsce: JsColorEngineModule,
	profile: JscProfile,
	lutSlots: (object | null)[],
	intent: RenderingIntent,
	direction: string,
): number {
	const requested = toEngineIntent(jsce, intent);
	const isLutBased =
		profile.type === jsce.eProfileType.CMYK ||
		profile.type === jsce.eProfileType.RGBLut;
	if (!isLutBased) return requested;

	// Mirrors Transform.intent2LUTIndex: absolute reuses the relative table.
	const INTENT_TO_LUT_INDEX = [0, 1, 2, 1] as const;
	const candidates = [
		requested,
		jsce.eIntent.relative,
		jsce.eIntent.perceptual,
		jsce.eIntent.saturation,
	];
	for (const candidate of candidates) {
		if (lutSlots[INTENT_TO_LUT_INDEX[candidate]]) return candidate;
	}
	throw new Error(
		`ICC profile has no ${direction} lookup table; it cannot convert colors in this direction`,
	);
}

function toEngineIntent(
	jsce: JsColorEngineModule,
	intent: RenderingIntent,
): number {
	switch (intent) {
		case "perceptual":
			return jsce.eIntent.perceptual;
		case "relative-colorimetric":
			return jsce.eIntent.relative;
		case "saturation":
			return jsce.eIntent.saturation;
		case "absolute-colorimetric":
			return jsce.eIntent.absolute;
	}
}

function fnv1aHash(bytes: Uint8Array): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < bytes.length; i++) {
		hash ^= bytes[i];
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16);
}
