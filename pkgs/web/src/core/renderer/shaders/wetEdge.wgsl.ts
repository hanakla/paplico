/**
 * Wet-edge (watercolor rim) shaders for wash strokes (design §9).
 *
 * Two fullscreen passes over the isolated wash appearance texture:
 * 1. erode (run twice, X then Y): separable min-filter of coverage alpha —
 *    the eroded alpha marks the stroke interior.
 * 2. compose: rim = alpha - eroded; darken the straight color by
 *    rim*darkening and raise alpha by rim*intensity (clamped).
 */
export const WET_EDGE_SHADER = /* wgsl */ `
struct Uniforms {
	// Texel step for one erosion tap (direction baked in: (1/w,0) or (0,1/h)).
	stepUv: vec2<f32>,
	// Erosion tap count to each side.
	radius: f32,
	intensity: f32,
	darkening: f32,
	// 0 = read coverage from alpha (rgba source), 1 = from red (r8 eroded).
	sourceChannel: f32,
	_pad1: f32,
	_pad2: f32,
}

@group(0) @binding(0) var srcTexture: texture_2d<f32>;
@group(0) @binding(1) var srcSampler: sampler;
@group(0) @binding(2) var<uniform> uniforms: Uniforms;
@group(0) @binding(3) var erodedTexture: texture_2d<f32>;

struct VertexOutput {
	@builtin(position) position: vec4<f32>,
	@location(0) uv: vec2<f32>,
}

@vertex
fn vs_main(@builtin(vertex_index) index: u32) -> VertexOutput {
	let pos = array<vec2<f32>, 3>(
		vec2<f32>(-1.0, -1.0),
		vec2<f32>(3.0, -1.0),
		vec2<f32>(-1.0, 3.0),
	);
	var out: VertexOutput;
	out.position = vec4<f32>(pos[index], 0.0, 1.0);
	out.uv = pos[index] * vec2<f32>(0.5, -0.5) + vec2<f32>(0.5, 0.5);
	return out;
}

const MAX_EROSION_TAPS: i32 = 48;

@fragment
fn fs_erode(in: VertexOutput) -> @location(0) vec4<f32> {
	let radius = i32(uniforms.radius);
	var minAlpha = 1.0;
	for (var i = -MAX_EROSION_TAPS; i <= MAX_EROSION_TAPS; i++) {
		if (i < -radius || i > radius) { continue; }
		let uv = in.uv + uniforms.stepUv * f32(i);
		let s = textureSampleLevel(srcTexture, srcSampler, uv, 0.0);
		minAlpha = min(minAlpha, select(s.a, s.r, uniforms.sourceChannel > 0.5));
	}
	return vec4<f32>(minAlpha, 0.0, 0.0, 1.0);
}

@fragment
fn fs_compose(in: VertexOutput) -> @location(0) vec4<f32> {
	let src = textureSampleLevel(srcTexture, srcSampler, in.uv, 0.0);
	let eroded = textureSampleLevel(erodedTexture, srcSampler, in.uv, 0.0).r;
	let rim = clamp(src.a - eroded, 0.0, 1.0);
	if (src.a <= 0.0) { return vec4<f32>(0.0); }
	let straight = src.rgb / src.a;
	let outAlpha = min(src.a * (1.0 + rim * uniforms.intensity), 1.0);
	let darkened = straight * clamp(1.0 - rim * uniforms.darkening, 0.0, 1.0);
	return vec4<f32>(darkened * outAlpha, outAlpha);
}
`;
