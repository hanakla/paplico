/**
 * PathMeta / ColorStops encoding shared by every brush route. The layout is
 * the one `dabColor.wgsl` declares as PATH_META_FLOATS. The dab, wet seed,
 * mixed and ribbon pipelines all read the same entry.
 */

import {
	type BrushSettings,
	type ColorStop,
	colorToRawRGBA,
	type Path,
	type StrokeColor,
} from "../../../../schema";
import { calculateElementBounds } from "../../../../utils/geometry/bounds";
import type { BrushFrameBuffers } from "./BrushFrameBuffers";
import type { StrokeDrawInput } from "./BrushRenderer";
import { PATH_META_FLOATS } from "./shaders/dabColor.wgsl";

/** ColorStop: 6 floats (24 bytes) per stop */
export const COLOR_STOP_FLOATS = 6;

/** The GPU buffers holding one stroke's PathMeta and its color stops. */
interface StrokeMetaBuffers {
	pathMetaBuffer: GPUBuffer;
	colorStopsBuffer: GPUBuffer;
}

/**
 * Encode one stroke's PathMeta and color stops and upload them into
 * frame-pooled buffers. Every single-stroke draw route binds these as
 * group(1): dab, wet seed, mixed and immediate ribbon.
 */
export function uploadSingleStrokeMeta(
	device: GPUDevice,
	buffers: BrushFrameBuffers,
	input: Omit<StrokeDrawInput, "segments">,
	ribbonTextureAspectRatio = 1,
): StrokeMetaBuffers {
	const singleMeta = new Float32Array(PATH_META_FLOATS);
	writeSinglePathMeta(singleMeta, 0, input, 0, ribbonTextureAspectRatio);
	const pathMetaBuffer = buffers.acquirePathMetaBuffer(PATH_META_FLOATS * 4);
	device.queue.writeBuffer(pathMetaBuffer, 0, singleMeta);

	const stopData = buildColorStopsData(input.strokeColor);
	const colorStopsBuffer = buffers.acquireColorStopsBuffer(stopData.byteLength);
	device.queue.writeBuffer(colorStopsBuffer, 0, stopData);
	return { pathMetaBuffer, colorStopsBuffer };
}

/**
 * Write one PathMeta entry at `offset`. `stopOffset` is where the stroke's
 * color stops start in the ColorStops buffer. `ribbonTextureAspectRatio` is
 * the resolved ribbon texture's aspect. Non-ribbon brushes never read it.
 */
export function writeSinglePathMeta(
	data: Float32Array,
	offset: number,
	input: Omit<StrokeDrawInput, "segments">,
	stopOffset: number,
	ribbonTextureAspectRatio: number,
): void {
	const { strokeColor, settings, path, alphaMultiplier, transformIndex } =
		input;
	const sm = resolveStrokeColorMeta(strokeColor, path);
	const a = sm.a * alphaMultiplier;

	// Pack colorMode into upper bits of gradientMode (bit 16)
	const colorModeBit = settings.colorMode === "color" ? 1 << 16 : 0;

	data[offset] = sm.r;
	data[offset + 1] = sm.g;
	data[offset + 2] = sm.b;
	data[offset + 3] = a;
	data[offset + 4] = u32AsF32(sm.gradientMode | colorModeBit);
	data[offset + 5] = u32AsF32(sm.stopCount);
	data[offset + 6] = u32AsF32(stopOffset);
	data[offset + 7] = u32AsF32(transformIndex);
	data[offset + 8] = sm.lsx;
	data[offset + 9] = sm.lsy;
	data[offset + 10] = sm.lex;
	data[offset + 11] = sm.ley;
	data[offset + 12] = sm.bMinX;
	data[offset + 13] = sm.bMinY;
	data[offset + 14] = sm.bMaxX;
	data[offset + 15] = sm.bMaxY;

	// Grain rides on the stroke, not the dab: mode/scale/offset are
	// per-stroke, only its strength is modulated per dab.
	const grain = grainMetaOf(settings);
	data[offset + 16] = u32AsF32(grain.mode);
	data[offset + 17] = grain.scale;
	data[offset + 18] = grain.offsetX;
	data[offset + 19] = grain.offsetY;

	// Ribbon tiling is per path: a batch-wide uniform would let the last
	// path in a run dictate every other path's tiling.
	const ribbon = ribbonMetaOf(settings, ribbonTextureAspectRatio);
	data[offset + 20] = ribbon.stretch;
	data[offset + 21] = ribbon.uvOffset;
	data[offset + 22] = ribbon.aspectRatio;
	data[offset + 23] = ribbon.stampAngle;
}

/** The flat numeric fields of a PathMeta entry that derive from the
 *  stroke colour: base colour, gradient mode and its geometry. Gradient
 *  colour stops are written separately. */
interface StrokeColorMeta {
	gradientMode: number;
	r: number;
	g: number;
	b: number;
	a: number;
	stopCount: number;
	lsx: number;
	lsy: number;
	lex: number;
	ley: number;
	bMinX: number;
	bMinY: number;
	bMaxX: number;
	bMaxY: number;
}

function resolveStrokeColorMeta(
	strokeColor: StrokeColor,
	path: Path,
): StrokeColorMeta {
	const meta: StrokeColorMeta = {
		gradientMode: 0,
		r: 0,
		g: 0,
		b: 0,
		a: 1,
		stopCount: 0,
		lsx: 0,
		lsy: 0,
		lex: 1,
		ley: 0,
		bMinX: 0,
		bMinY: 0,
		bMaxX: 1,
		bMaxY: 1,
	};
	if (strokeColor.type === "solid") {
		return { ...meta, ...colorToRawRGBA(strokeColor.color) };
	}
	if (strokeColor.type !== "stroke-gradient") return meta;

	const { gradient } = strokeColor;
	meta.gradientMode = GRADIENT_MODE_MAP[strokeColor.mode];
	meta.stopCount = gradient.stops.length;
	if (meta.gradientMode === 1) {
		const eb = calculateElementBounds(path);
		meta.bMinX = eb.minX;
		meta.bMinY = eb.minY;
		meta.bMaxX = eb.maxX;
		meta.bMaxY = eb.maxY;
	}
	meta.lsx = gradient.x1;
	meta.lsy = gradient.y1;
	meta.lex = gradient.x2;
	meta.ley = gradient.y2;
	if (gradient.stops.length > 0) {
		Object.assign(meta, colorToRawRGBA(gradient.stops[0].color));
	}
	return meta;
}

/** Build the ColorStops data of one stroke. Always holds at least one entry. */
function buildColorStopsData(
	strokeColor: StrokeColor | undefined,
): Float32Array<ArrayBuffer> {
	const stops =
		strokeColor?.type === "stroke-gradient" ? strokeColor.gradient.stops : [];
	const stopData = new Float32Array(
		Math.max(stops.length, 1) * COLOR_STOP_FLOATS,
	);
	for (let i = 0; i < stops.length; i++) {
		writeColorStop(stopData, i * COLOR_STOP_FLOATS, stops[i]);
	}
	return stopData;
}

/** Write one gradient stop at `offset`. */
export function writeColorStop(
	data: Float32Array,
	offset: number,
	stop: ColorStop,
): void {
	const c = colorToRawRGBA(stop.color);
	data[offset] = stop.offset;
	data[offset + 1] = c.r;
	data[offset + 2] = c.g;
	data[offset + 3] = c.b;
	data[offset + 4] = c.a;
	data[offset + 5] = stop.midpoint;
}

/** Per-stroke grain parameters for the path meta. Grain is a
 *  stroke-level texture: only its strength varies per dab. */
function grainMetaOf(settings: BrushSettings): {
	mode: number;
	scale: number;
	offsetX: number;
	offsetY: number;
} {
	const { grain, randomSeed } = settings;
	if (grain == null) return { mode: 0, scale: 1, offsetX: 0, offsetY: 0 };
	const mode = grain.mode === "subtract" ? 2 : 1;
	if (!grain.randomOffsetPerStroke) {
		return { mode, scale: grain.scale, offsetX: 0, offsetY: 0 };
	}
	// Seeded so the offset stays a pure function of the stroke's settings.
	let state = (randomSeed ^ 0x85ebca6b) >>> 0;
	const rand = (): number => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	return { mode, scale: grain.scale, offsetX: rand(), offsetY: rand() };
}

/** Per-path ribbon tiling for the path meta. Zeroed for non-ribbon
 *  brushes, which never read these fields. */
function ribbonMetaOf(
	settings: BrushSettings,
	textureAspectRatio: number,
): {
	stretch: number;
	uvOffset: number;
	aspectRatio: number;
	stampAngle: number;
} {
	const ribbon = settings.engine === "ribbon" ? settings.ribbon : undefined;
	if (!ribbon)
		return { stretch: 0, uvOffset: 0, aspectRatio: 1, stampAngle: 0 };
	return {
		// A stretched ribbon spans the stroke once, so it has no tiling to
		// scale; only repeat mode reads this.
		stretch: ribbon.uvMode === "repeat" ? ribbon.tileScale - 1 : 0,
		uvOffset: ribbon.uvMode === "repeat" ? (ribbon.uvOffset ?? 0) : 0,
		aspectRatio: textureAspectRatio,
		// The shader rotates the ribbon's texture by this stamp angle.
		stampAngle: settings.properties.angle?.base ?? 0,
	};
}

// Shared scratch for u32 -> f32 bit-casts
const _u32Scratch = new Uint32Array(1);
const _f32Scratch = new Float32Array(_u32Scratch.buffer);

function u32AsF32(value: number): number {
	_u32Scratch[0] = value;
	return _f32Scratch[0];
}

const GRADIENT_MODE_MAP = { within: 1, along: 2, across: 3 } as const;
