import {
	SVG_FULLSCREEN_VERTEX_WGSL,
	SVG_PREMULTIPLY_WGSL,
	SVG_TEXEL_FETCH_WGSL,
} from "./svg-wgsl-includes";

/**
 * feColorMatrix over straight-alpha values. The 4x5 spec matrix is split into
 * `matrix` (its first four columns) and `offset` (its fifth column), so
 * `matrix * rgba + offset` is exactly `M x [R G B A 1]^T`.
 */
export const SVG_COLOR_MATRIX_SHADER = /* wgsl */ `
	struct Uniforms {
		// Column-major: column j holds the j-th column of the spec matrix.
		matrix: mat4x4f,
		offset: vec4f,
		inputMode: u32,
	}

	@group(0) @binding(0) var<uniform> uniforms: Uniforms;
	@group(0) @binding(1) var inputTexture: texture_2d<f32>;

	${SVG_FULLSCREEN_VERTEX_WGSL}
	${SVG_PREMULTIPLY_WGSL}
	${SVG_TEXEL_FETCH_WGSL}

	@fragment
	fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
		let p = vec2i(floor(input.position.xy));
		let straight = unpremultiply(fetchInput(inputTexture, p, uniforms.inputMode));
		let mapped = clamp(uniforms.matrix * straight + uniforms.offset, vec4f(0.0), vec4f(1.0));
		return premultiply(mapped);
	}
`;
