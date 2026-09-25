/**
 * Sparse-strip shader for document paths: one instance per strip of
 * TILE_SIZE rows, drawn as a quad in pass pixels. The fragment stage loads the
 * strip's coverage from the alpha page and multiplies it into the shared paint
 * stage, so fills, strokes, gradients, patterns and clip masks all paint
 * through the same code as before.
 *
 * Bind groups:
 *   BG0: Viewport uniforms of the pass being drawn into
 *   BG1: Element transforms storage buffer + alpha page + params page
 *   BG2: Paint data (paintCommon.wgsl)
 *   BG3: Clip mask atlas
 */

import {
	STRIP_HAS_PARAMS_BIT,
	STRIP_HEIGHT_SHIFT,
	STRIP_PAGE_WIDTH,
	STRIP_PAGE_WIDTH_BITS,
	STRIP_PARAMS_SLOT_MASK,
	STRIP_ROW_OFFSET_SHIFT,
} from "../canvas/pipeline/strips/stripInstanceLayout";
import { MASK_COMMON_WGSL } from "./maskCommon.wgsl";
import { PAINT_COMMON_WGSL } from "./paintCommon.wgsl";
import { TRANSFORM_COMMON_WGSL } from "./transformCommon.wgsl";

export const STRIP_SHADER = /* wgsl */ `
struct Uniforms {
	viewportX: f32,
	viewportY: f32,
	zoom: f32,
	canvasWidth: f32,
	canvasHeight: f32,
	rotSin: f32,
	rotCos: f32,
}

${TRANSFORM_COMMON_WGSL}

${PAINT_COMMON_WGSL}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(1) @binding(0) var<storage, read> transforms: array<ElementTransform>;
@group(1) @binding(1) var alphaPage: texture_2d<f32>;
@group(1) @binding(2) var paramsPage: texture_2d<f32>;

@group(3) @binding(0) var maskAtlas: texture_2d<f32>;
@group(3) @binding(1) var maskSampler: sampler;

const PAGE_WIDTH_BITS: u32 = ${STRIP_PAGE_WIDTH_BITS}u;
const PAGE_WIDTH_MASK: u32 = ${STRIP_PAGE_WIDTH - 1}u;
const PARAMS_SLOT_MASK: u32 = ${STRIP_PARAMS_SLOT_MASK}u;
const ROW_OFFSET_SHIFT: u32 = ${STRIP_ROW_OFFSET_SHIFT}u;
const HEIGHT_SHIFT: u32 = ${STRIP_HEIGHT_SHIFT}u;
const HAS_PARAMS_BIT: u32 = ${STRIP_HAS_PARAMS_BIT}u;

struct StripInput {
	@location(0) xy: u32,
	@location(1) widths: u32,
	@location(2) slot: u32,
	@location(3) params: u32,
	@location(4) elementIndex: u32,
	@location(5) color: vec4f,
}

struct StripOutput {
	@builtin(position) position: vec4f,
	// Pixel offset inside the strip; drives the alpha lookup, so it must not
	// come from @builtin(position), which a pass viewport can shift.
	@location(0) local: vec2f,
	@location(1) worldPos: vec2f,
	@location(2) transformedWorldPos: vec2f,
	@location(3) @interpolate(flat) color: vec4f,
	@location(4) @interpolate(flat) slot: u32,
	@location(5) @interpolate(flat) denseWidth: u32,
	@location(6) @interpolate(flat) params: u32,
	@location(7) @interpolate(flat) maskIndex: u32,
	@location(8) maskBoundsMin: vec2f,
	@location(9) maskBoundsMax: vec2f,
}

/** Texel of a slot's row inside a page. */
fn pageTexel(slot: u32, row: u32) -> vec2u {
	return vec2u(slot & PAGE_WIDTH_MASK, (slot >> PAGE_WIDTH_BITS) * 4u + row);
}

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32, in: StripInput) -> StripOutput {
	var out: StripOutput;
	let corner = vec2f(f32(vertexIndex & 1u), f32(vertexIndex >> 1u));
	let origin = vec2f(f32(in.xy & 0xffffu), f32(in.xy >> 16u));
	let width = f32(in.widths & 0xffffu);
	let height = f32((in.params >> HEIGHT_SHIFT) & 7u);
	let local = corner * vec2f(width, height);
	let px = origin + local;
	out.position = vec4f(
		px.x / uniforms.canvasWidth * 2.0 - 1.0,
		1.0 - px.y / uniforms.canvasHeight * 2.0,
		0.0,
		1.0,
	);
	out.local = local;

	// Invert the viewport mapping of unified.wgsl: pixel → rotated → world.
	let rel = vec2f(
		px.x - uniforms.canvasWidth * 0.5,
		uniforms.canvasHeight * 0.5 - px.y,
	);
	let unrotated = vec2f(
		rel.x * uniforms.rotCos + rel.y * uniforms.rotSin,
		-rel.x * uniforms.rotSin + rel.y * uniforms.rotCos,
	);
	let world = unrotated / uniforms.zoom + vec2f(uniforms.viewportX, uniforms.viewportY);
	out.transformedWorldPos = world;

	// Invert the element transform for the pre-transform paint position.
	let et = transforms[in.elementIndex];
	let origin2 = vec2f(et.originX, et.originY);
	let d = world - origin2 - vec2f(et.tx, et.ty);
	let det = et.m00 * et.m11 - et.m01 * et.m10;
	var localPos = world;
	if (abs(det) > 1e-12) {
		localPos = origin2 + vec2f(d.x * et.m11 - d.y * et.m01, d.y * et.m00 - d.x * et.m10) / det;
	}
	out.worldPos = localPos;

	out.color = in.color;
	out.slot = in.slot;
	out.denseWidth = in.widths >> 16u;
	out.params = in.params;
	out.maskIndex = et.maskIndex;
	out.maskBoundsMin = et.maskBoundsMin;
	out.maskBoundsMax = et.maskBoundsMax;
	return out;
}

${MASK_COMMON_WGSL}

@fragment
fn fs_main(in: StripOutput) -> @location(0) vec4f {
	let column = u32(floor(in.local.x));
	let row = u32(floor(in.local.y)) + ((in.params >> ROW_OFFSET_SHIFT) & 3u);
	var coverage = 1.0;
	if (column < in.denseWidth) {
		coverage = textureLoad(alphaPage, pageTexel(in.slot + column, row), 0).r;
	}
	var tu = in.color.rg;
	if ((in.params & HAS_PARAMS_BIT) != 0u) {
		tu = textureLoad(paramsPage, pageTexel((in.params & PARAMS_SLOT_MASK) + column, row), 0).rg;
	}
	let paint = paintColor(in.worldPos, in.color, tu) * coverage;
	return applyClipMask(paint, in.maskIndex, in.maskBoundsMin, in.maskBoundsMax, in.transformedWorldPos);
}
`;
