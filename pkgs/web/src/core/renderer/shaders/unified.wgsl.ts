/**
 * Unified Geometry Shader — handles solid fill, stroke, and gradient fill
 * in a single shader module via the `gradientType` uniform discriminator.
 *
 * Bind groups:
 *   BG0: Viewport uniforms (shared by all renderers)
 *   BG1: Element transforms storage buffer
 *   BG2: Paint data (see paintCommon.wgsl); solid paint uses the vertex colour.
 *   BG3: Clip mask atlas
 */

import { MASK_COMMON_WGSL } from "./maskCommon.wgsl";
import { PAINT_COMMON_WGSL } from "./paintCommon.wgsl";
import { TRANSFORM_COMMON_WGSL } from "./transformCommon.wgsl";

export const UNIFIED_GEOMETRY_SHADER = /* wgsl */ `
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

@group(3) @binding(0) var maskAtlas: texture_2d<f32>;
@group(3) @binding(1) var maskSampler: sampler;

struct VertexInput {
	@location(0) position: vec2f,
	@location(1) color: vec4f,
	@location(2) offset: vec2f,
	@location(3) elementIndex: u32,
}

struct VertexOutput {
	@builtin(position) position: vec4f,
	@location(0) color: vec4f,
	@location(1) worldPos: vec2f,
	@location(2) @interpolate(flat) maskIndex: u32,
	@location(3) maskBoundsMin: vec2f,
	@location(4) maskBoundsMax: vec2f,
	@location(5) transformedWorldPos: vec2f,
}

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
	var out: VertexOutput;
	let et = transforms[in.elementIndex];
	let transformed = applyElementTransform(in.position, et);
	let worldPos = transformed + in.offset * (1.0 / uniforms.zoom);
	let relX = (worldPos.x - uniforms.viewportX) * uniforms.zoom;
	let relY = (worldPos.y - uniforms.viewportY) * uniforms.zoom;
	let rotX = relX * uniforms.rotCos - relY * uniforms.rotSin;
	let rotY = relX * uniforms.rotSin + relY * uniforms.rotCos;
	let ndcX = rotX / (uniforms.canvasWidth * 0.5);
	let ndcY = rotY / (uniforms.canvasHeight * 0.5);
	out.position = vec4f(ndcX, ndcY, 0.0, 1.0);
	out.color = in.color;
	// Pre-transform position for gradient UV calculation.
	// CPU-side boundsMin/boundsMax are in local (pre-transform) space.
	out.worldPos = in.position + in.offset * (1.0 / uniforms.zoom);
	out.maskIndex = et.maskIndex;
	out.maskBoundsMin = et.maskBoundsMin;
	out.maskBoundsMax = et.maskBoundsMax;
	// Post-transform world-space position for clip mask UV calculation.
	out.transformedWorldPos = worldPos;
	return out;
}

${MASK_COMMON_WGSL}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
	let paint = paintColor(in.worldPos, in.color, in.color.rg);
	return applyClipMask(paint, in.maskIndex, in.maskBoundsMin, in.maskBoundsMax, in.transformedWorldPos);
}
`;
