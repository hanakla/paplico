import { SVG_FULLSCREEN_VERTEX_WGSL } from "./svg-wgsl-includes";

export const SVG_FLOOD_SHADER = /* wgsl */ `
	struct Uniforms {
		// Premultiplied flood color.
		color: vec4f,
	}

	@group(0) @binding(0) var<uniform> uniforms: Uniforms;

	${SVG_FULLSCREEN_VERTEX_WGSL}

	@fragment
	fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
		return uniforms.color;
	}
`;
