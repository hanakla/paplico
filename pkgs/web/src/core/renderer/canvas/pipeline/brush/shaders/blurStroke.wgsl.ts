/**
 * Backdrop blur stroke composite: one fullscreen pass over the stroke's
 * coverage texture that writes the blurred backdrop, premultiplied by the
 * coverage, so the blit replaces the backdrop exactly where the stroke
 * landed. The blur itself comes from the coordinator's shared pyramid; this
 * pass only lerps the two levels bracketing the stroke's sigma, like the
 * frost glass pyramid path does.
 */
export const BLUR_STROKE_SHADER = /* wgsl */ `
struct BlurStrokeUniforms {
	/** World position at coverage uv (0, 0). */
	uvOrigin: vec2f,
	/** World extent of one full uv step; y runs downward on screen. */
	uvSpan: vec2f,
	/** Captured backdrop region, world bounds. */
	regionMin: vec2f,
	regionSize: vec2f,
	/** Region uv -> batch uv: batch = xy + uv * zw. */
	remap: vec4f,
	loCtl: vec4f,
	hiCtl: vec4f,
	blurMix: f32,
}

struct VertexOutput {
	@builtin(position) position: vec4f,
	@location(0) texCoord: vec2f,
}

@group(0) @binding(0) var<uniform> u: BlurStrokeUniforms;
@group(0) @binding(1) var coverageTexture: texture_2d<f32>;
@group(0) @binding(2) var blurLoTexture: texture_2d<f32>;
@group(0) @binding(3) var blurHiTexture: texture_2d<f32>;
@group(0) @binding(4) var samp: sampler;

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
	var output: VertexOutput;
	let x = f32((vertexIndex & 1u) << 1u);
	let y = f32(vertexIndex & 2u);
	output.position = vec4f(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);
	output.texCoord = vec2f(x, y);
	return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
	let world = u.uvOrigin + input.texCoord * u.uvSpan;
	let regionUv = clamp(
		vec2f(
			(world.x - u.regionMin.x) / u.regionSize.x,
			1.0 - (world.y - u.regionMin.y) / u.regionSize.y,
		),
		vec2f(0.0),
		vec2f(1.0),
	);
	let batchUv = u.remap.xy + regionUv * u.remap.zw;
	let loUv = clamp(batchUv, u.loCtl.zw, vec2f(1.0) - u.loCtl.zw) * u.loCtl.xy;
	let hiUv = clamp(batchUv, u.hiCtl.zw, vec2f(1.0) - u.hiCtl.zw) * u.hiCtl.xy;
	let blurred = mix(
		textureSample(blurLoTexture, samp, loUv),
		textureSample(blurHiTexture, samp, hiUv),
		u.blurMix,
	);
	let coverage = textureSample(coverageTexture, samp, input.texCoord).a;
	return blurred * coverage;
}
`;
