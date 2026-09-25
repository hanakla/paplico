/**
 * Ported from AviUtl script "RadRotDirBlur_S" by sigma-axis
 * Original: https://github.com/sigma-axis/aviutl_script_RadRotDirBlur_S
 * License: MIT - https://github.com/sigma-axis/aviutl_script_RadRotDirBlur_S/blob/main/LICENSE
 */

export const HK_RADIAL_ROT_DIR_SHADER = /* wgsl */ `
struct Uniforms {
	resolution: vec2f,
	dpiScale: f32,
	count: f32,
	scaleRotMat: mat2x2f,
	delta: vec2f,
	iniScaleRotMat: mat2x2f,
	iniDelta: vec2f,
	center: vec2f,
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
	let count = i32(uniforms.count);

	var v = uniforms.iniScaleRotMat * (texCoord - uniforms.center + uniforms.iniDelta);
	var d = uniforms.iniScaleRotMat * uniforms.delta;

	// Samples are premultiplied, so their plain mean is the correct
	// premultiplied result — no unpremultiply, which blew semi-transparent
	// areas out to white when the straight-alpha rgb hit the compositor.
	var color = textureSample(inputTexture, inputSampler, v + uniforms.center);

	for (var i = 0; i < count; i++) {
		v = uniforms.scaleRotMat * (v + d);
		d = uniforms.scaleRotMat * d;

		color += textureSample(inputTexture, inputSampler, v + uniforms.center);
	}

	return color / f32(count + 1);
}
`;
