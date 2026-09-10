import {
	SVG_FULLSCREEN_VERTEX_WGSL,
	SVG_PREMULTIPLY_WGSL,
	SVG_TEXEL_FETCH_WGSL,
} from "./svg-wgsl-includes";

/**
 * feDisplacementMap: every texel of `in` is fetched from the position the
 * straight-alpha channels of `in2` point to. The displaced position is
 * truncated to a whole texel to match resvg's nearest fetch.
 */
export const SVG_DISPLACEMENT_MAP_SHADER = /* wgsl */ `
	struct Uniforms {
		// Displacement scale in texels.
		scale: f32,
		inputMode: u32,
		mapMode: u32,
		// Channel indices into the map texel (0 = R .. 3 = A).
		xChannel: u32,
		yChannel: u32,
	}

	@group(0) @binding(0) var<uniform> uniforms: Uniforms;
	@group(0) @binding(1) var inputTexture: texture_2d<f32>;
	@group(0) @binding(2) var mapTexture: texture_2d<f32>;

	${SVG_FULLSCREEN_VERTEX_WGSL}
	${SVG_PREMULTIPLY_WGSL}
	${SVG_TEXEL_FETCH_WGSL}

	@fragment
	fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
		let p = vec2i(floor(input.position.xy));
		let map = unpremultiply(fetchInput(mapTexture, p, uniforms.mapMode));
		let offset = vec2f(map[uniforms.xChannel], map[uniforms.yChannel]) - 0.5;
		let displaced = vec2f(p) + uniforms.scale * offset;
		return fetchInput(inputTexture, vec2i(displaced), uniforms.inputMode);
	}
`;
