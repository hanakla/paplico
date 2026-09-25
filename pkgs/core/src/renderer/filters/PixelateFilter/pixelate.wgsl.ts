export const PIXELATE_SHADER = /* wgsl */ `
struct Uniforms {
	resolution: vec2f,
	// Fractional texel position of the content's top-left inside the texture.
	contentOffset: vec2f,
	// Captured source position within the unclipped effect region in world px.
	sourceOffset: vec2f,
	dpiScale: f32,
	// Block cell size in world px — invariant to rasterization DPI and to
	// the content/capture region size.
	blockWidth: f32,
	blockHeight: f32,
	mode: i32, // 0: bilinear, 1: bicubic
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var inputSampler: sampler;

struct VertexOutput {
	@builtin(position) position: vec4f,
	@location(0) texCoord: vec2f,
}

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
	let texCoord = input.texCoord;

	// Cut the block grid in exact world px anchored to the content corner,
	// not in UV: the texture's UV extent is ceil-quantized per rasterization
	// DPI (resolution = ceil(world * dpiScale)) and the content sits a
	// DPI-dependent sub-texel amount off the texture origin, so a grid
	// divided in UV space drifts with the DPI on both counts.
	let sourceWorld = (texCoord * uniforms.resolution - uniforms.contentOffset) / uniforms.dpiScale;
	let effectWorld = sourceWorld + uniforms.sourceOffset;
	let cell = vec2f(uniforms.blockWidth, uniforms.blockHeight);
	let blockIndex = floor(effectWorld / cell);
	let centerWorld = (blockIndex + vec2f(0.5, 0.5)) * cell - uniforms.sourceOffset;
	let downscaledCoord = clamp(
		(centerWorld * uniforms.dpiScale + uniforms.contentOffset) / uniforms.resolution,
		vec2f(0.0),
		vec2f(1.0)
	);

	return textureSample(inputTexture, inputSampler, downscaledCoord);
}
`;
