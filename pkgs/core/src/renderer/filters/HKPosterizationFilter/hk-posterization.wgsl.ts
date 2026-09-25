export const HK_POSTERIZATION_SHADER = /* wgsl */ `
struct Uniforms {
	resolution: vec2f,
	dpiScale: f32,
	levels: i32,
	strength: f32,
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

fn posterizeChannel(value: f32, levels: f32) -> f32 {
	return floor(value * (levels - 1.0) + 0.5) / (levels - 1.0);
}

fn posterizeColor(color: vec3f, levels: f32) -> vec3f {
	return vec3f(
		posterizeChannel(color.r, levels),
		posterizeChannel(color.g, levels),
		posterizeChannel(color.b, levels),
	);
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
	let texCoord = input.texCoord;
	let originalColor = textureSample(inputTexture, inputSampler, texCoord);

	if (originalColor.a < 0.001) {
		return originalColor;
	}

	let levels = f32(uniforms.levels);
	let posterizedRGB = posterizeColor(originalColor.rgb, levels);

	let finalColor = vec4f(
		mix(originalColor.rgb, posterizedRGB, uniforms.strength),
		originalColor.a,
	);

	return finalColor;
}
`;
