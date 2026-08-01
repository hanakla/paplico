// Distance-field outline: the shared jump-flood field (JumpFloodDistanceField)
// supplies each pixel's nearest silhouette coordinate; this resolve pass turns
// it into a uniform-width, anti-aliased ring in a single fullscreen draw.
// All distances are in texels — the handler pre-multiplies the world-px
// thickness by the rasterization scale.

/** Final pass — distance to the nearest seed becomes an anti-aliased solid
 *  disc of the outline color, composited under the original (premultiplied). */
export const HK_OUTLINE_RESOLVE_SHADER = /* wgsl */ `
struct Uniforms {
	radius: f32,
	colorR: f32,
	colorG: f32,
	colorB: f32,
	colorA: f32,
	opacity: f32,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var coordTexture: texture_2d<f32>;
@group(0) @binding(2) var inputTexture: texture_2d<f32>;

struct VertexOutput {
	@builtin(position) position: vec4f,
}

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
	var output: VertexOutput;
	let x = f32((vertexIndex & 1u) << 1u);
	let y = f32(vertexIndex & 2u);
	output.position = vec4f(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);
	return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
	let p = vec2i(input.position.xy);
	let original = textureLoad(inputTexture, p, 0);
	let seed = textureLoad(coordTexture, p, 0).xy;

	var ringAlpha = 0.0;
	if (seed.x > -1e5) {
		let dist = distance(seed, input.position.xy);
		// ~1 texel anti-aliased rim at the outline radius.
		ringAlpha = 1.0 - smoothstep(uniforms.radius - 0.75, uniforms.radius + 0.75, dist);
	}

	let outlineA = ringAlpha * uniforms.colorA * uniforms.opacity;
	let outlineRgb = vec3f(uniforms.colorR, uniforms.colorG, uniforms.colorB) * outlineA;

	// Premultiplied source-over: the original sits above the outline disc.
	return vec4f(
		original.rgb + outlineRgb * (1.0 - original.a),
		original.a + outlineA * (1.0 - original.a)
	);
}
`;
