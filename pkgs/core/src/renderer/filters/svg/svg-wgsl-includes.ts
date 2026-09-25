/**
 * Shared WGSL fragments for the SVG filter primitives. Every primitive is a
 * fullscreen pass over content-sized textures, reading texels with
 * textureLoad so the SVG filter-region semantics (transparent black outside)
 * hold exactly instead of a sampler's clamp-to-edge.
 */

/** Fullscreen triangle; `texCoord` is UV in [0, 1], `position` gives texel coords. */
export const SVG_FULLSCREEN_VERTEX_WGSL = /* wgsl */ `
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
	`;

/** Premultiplied <-> straight alpha conversion (transparent stays transparent black). */
export const SVG_PREMULTIPLY_WGSL = /* wgsl */ `
	fn unpremultiply(c: vec4f) -> vec4f {
		if (c.a <= 0.0) {
			return vec4f(0.0);
		}
		return vec4f(c.rgb / c.a, c.a);
	}

	fn premultiply(c: vec4f) -> vec4f {
		return vec4f(c.rgb * c.a, c.a);
	}
	`;

/**
 * Texel fetch returning transparent black outside the texture, plus the
 * input-mode reduction (SVG_INPUT_MODE_ALPHA keeps alpha only = SourceAlpha).
 */
export const SVG_TEXEL_FETCH_WGSL = /* wgsl */ `
	fn fetchOrZero(tex: texture_2d<f32>, p: vec2i) -> vec4f {
		let dim = vec2i(textureDimensions(tex));
		if (p.x < 0 || p.y < 0 || p.x >= dim.x || p.y >= dim.y) {
			return vec4f(0.0);
		}
		return textureLoad(tex, p, 0);
	}

	fn asInput(c: vec4f, mode: u32) -> vec4f {
		return select(c, vec4f(0.0, 0.0, 0.0, c.a), mode == 1u);
	}

	fn fetchInput(tex: texture_2d<f32>, p: vec2i, mode: u32) -> vec4f {
		return asInput(fetchOrZero(tex, p), mode);
	}
	`;
