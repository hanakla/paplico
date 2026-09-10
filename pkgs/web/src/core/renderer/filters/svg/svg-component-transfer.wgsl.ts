import {
	SVG_FULLSCREEN_VERTEX_WGSL,
	SVG_PREMULTIPLY_WGSL,
	SVG_TEXEL_FETCH_WGSL,
} from "./svg-wgsl-includes";

/**
 * feComponentTransfer: one transfer function per channel applied to
 * straight-alpha values. Table values of every channel sit back to back in
 * one storage buffer, so a table can be as long as the author wrote it.
 */
export const SVG_COMPONENT_TRANSFER_SHADER = /* wgsl */ `
	const TYPE_IDENTITY = 0u;
	const TYPE_TABLE = 1u;
	const TYPE_DISCRETE = 2u;
	const TYPE_LINEAR = 3u;
	const TYPE_GAMMA = 4u;

	struct Channel {
		kind: u32,
		// First index into the tables buffer and number of values (table / discrete only).
		offset: u32,
		count: u32,
		// linear: (slope, intercept, 0, 0); gamma: (amplitude, exponent, offset, 0).
		coeffs: vec4f,
	}

	struct Uniforms {
		channels: array<Channel, 4>,
		inputMode: u32,
	}

	@group(0) @binding(0) var<uniform> uniforms: Uniforms;
	@group(0) @binding(1) var inputTexture: texture_2d<f32>;
	@group(0) @binding(2) var<storage, read> tables: array<f32>;

	${SVG_FULLSCREEN_VERTEX_WGSL}
	${SVG_PREMULTIPLY_WGSL}
	${SVG_TEXEL_FETCH_WGSL}

	fn tableValue(channel: u32, k: u32) -> f32 {
		return tables[uniforms.channels[channel].offset + k];
	}

	fn transfer(value: f32, channel: u32) -> f32 {
		let kind = uniforms.channels[channel].kind;
		let count = uniforms.channels[channel].count;
		let coeffs = uniforms.channels[channel].coeffs;
		if (kind == TYPE_LINEAR) {
			return coeffs.x * value + coeffs.y;
		}
		if (kind == TYPE_GAMMA) {
			return coeffs.x * pow(value, coeffs.y) + coeffs.z;
		}
		if (kind == TYPE_TABLE && count > 0u) {
			if (count == 1u) {
				return tableValue(channel, 0u);
			}
			let n = f32(count - 1u);
			let k = min(u32(floor(value * n)), count - 2u);
			let v0 = tableValue(channel, k);
			let v1 = tableValue(channel, k + 1u);
			return v0 + (value - f32(k) / n) * n * (v1 - v0);
		}
		if (kind == TYPE_DISCRETE && count > 0u) {
			let k = min(u32(floor(value * f32(count))), count - 1u);
			return tableValue(channel, k);
		}
		return value;
	}

	@fragment
	fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
		let p = vec2i(floor(input.position.xy));
		let straight = unpremultiply(fetchInput(inputTexture, p, uniforms.inputMode));
		let mapped = clamp(
			vec4f(
				transfer(straight.r, 0u),
				transfer(straight.g, 1u),
				transfer(straight.b, 2u),
				transfer(straight.a, 3u),
			),
			vec4f(0.0),
			vec4f(1.0),
		);
		return premultiply(mapped);
	}
`;
