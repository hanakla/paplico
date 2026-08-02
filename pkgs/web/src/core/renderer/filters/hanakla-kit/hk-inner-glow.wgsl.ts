// Distance-field glow: the shared jump-flood field (JumpFloodDistanceField)
// supplies each pixel's nearest silhouette (outer mode) or background (inner
// mode) coordinate; this resolve pass turns it into a smooth glow gradient in
// a single fullscreen draw. All distances are in texels — the handler
// pre-multiplies the world-px weight by the rasterization scale.

/** Final pass — distance to the nearest seed becomes a glow falloff,
 *  composited over the shape (inner) or under it (outer, premultiplied). */
export const HK_INNER_GLOW_RESOLVE_SHADER = /* wgsl */ `
struct Uniforms {
	radius: f32,
	glowType: f32, // 0 = inner, 1 = outer
	colorR: f32,
	colorG: f32,
	colorB: f32,
	colorA: f32,
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

	// Fades from 1 at the silhouette to 0 at the glow radius; pixels beyond
	// the field's reach carry the sentinel and get no glow.
	var falloff = 0.0;
	if (seed.x > -1e5) {
		let dist = distance(seed, input.position.xy);
		falloff = 1.0 - smoothstep(0.0, uniforms.radius, dist);
	}

	let glowRgb = vec3f(uniforms.colorR, uniforms.colorG, uniforms.colorB);

	if (uniforms.glowType < 0.5) {
		// Inner: glow over the shape. The mix factor must not be scaled by
		// the coverage — that let the fill color bleed through the
		// anti-aliased rim; coverage only premultiplies the glow term.
		let g = falloff * uniforms.colorA;
		return vec4f(
			glowRgb * g * original.a + original.rgb * (1.0 - g),
			original.a
		);
	}

	// Outer: soft halo composited under the original (premultiplied over).
	let glowA = falloff * uniforms.colorA;
	return vec4f(
		original.rgb + glowRgb * glowA * (1.0 - original.a),
		original.a + glowA * (1.0 - original.a)
	);
}
`;
