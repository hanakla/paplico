import {
	SVG_FULLSCREEN_VERTEX_WGSL,
	SVG_PREMULTIPLY_WGSL,
} from "./svg-wgsl-includes";
import {
	TURBULENCE_GRADIENT_COUNT,
	TURBULENCE_LATTICE_SIZE,
	TURBULENCE_PERLIN_N,
} from "./turbulenceLattice";

/**
 * The feTurbulence reference `noise2` / `turbulence` from the SVG Filter
 * Effects specification, reading the seeded lattice from a storage buffer
 * (see turbulenceLattice.ts). The frequency stitching adjustment of the
 * reference happens on the CPU; the shader only applies the per-octave wrap
 * updates. The lattice index is masked after the stitch comparison, not
 * before, since a pre-masked index can never reach the wrap threshold.
 */
const SVG_TURBULENCE_NOISE_WGSL = /* wgsl */ `
	const PERLIN_N: i32 = ${TURBULENCE_PERLIN_N};
	const LATTICE_MASK: i32 = 0xff;
	const LATTICE_SIZE: i32 = ${TURBULENCE_LATTICE_SIZE};

	struct Lattice {
		selector: array<i32, LATTICE_SIZE>,
		gradient: array<vec2f, ${TURBULENCE_GRADIENT_COUNT}>,
	}

	fn sCurve(t: f32) -> f32 {
		return t * t * (3.0 - 2.0 * t);
	}

	fn noise2(channel: i32, v: vec2f, stitch: bool, wrap: vec2i, size: vec2i) -> f32 {
		var t = v.x + f32(PERLIN_N);
		var bx0 = i32(t);
		var bx1 = bx0 + 1;
		let rx0 = t - f32(i32(t));
		let rx1 = rx0 - 1.0;
		t = v.y + f32(PERLIN_N);
		var by0 = i32(t);
		var by1 = by0 + 1;
		let ry0 = t - f32(i32(t));
		let ry1 = ry0 - 1.0;
		if (stitch) {
			if (bx0 >= wrap.x) { bx0 -= size.x; }
			if (bx1 >= wrap.x) { bx1 -= size.x; }
			if (by0 >= wrap.y) { by0 -= size.y; }
			if (by1 >= wrap.y) { by1 -= size.y; }
		}
		bx0 &= LATTICE_MASK;
		bx1 &= LATTICE_MASK;
		by0 &= LATTICE_MASK;
		by1 &= LATTICE_MASK;
		let i = lattice.selector[bx0];
		let j = lattice.selector[bx1];
		let b00 = lattice.selector[i + by0];
		let b10 = lattice.selector[j + by0];
		let b01 = lattice.selector[i + by1];
		let b11 = lattice.selector[j + by1];
		let sx = sCurve(rx0);
		let sy = sCurve(ry0);
		let base = channel * LATTICE_SIZE;
		var q = lattice.gradient[base + b00];
		var u = rx0 * q.x + ry0 * q.y;
		q = lattice.gradient[base + b10];
		var w = rx1 * q.x + ry0 * q.y;
		let a = mix(u, w, sx);
		q = lattice.gradient[base + b01];
		u = rx0 * q.x + ry1 * q.y;
		q = lattice.gradient[base + b11];
		w = rx1 * q.x + ry1 * q.y;
		let b = mix(u, w, sx);
		return mix(a, b, sy);
	}

	fn turbulence(
		channel: i32,
		point: vec2f,
		baseFrequency: vec2f,
		numOctaves: u32,
		fractalSum: bool,
		stitch: bool,
		initialWrap: vec2i,
		initialSize: vec2i,
	) -> f32 {
		var sum = 0.0;
		var v = point * baseFrequency;
		var ratio = 1.0;
		var wrap = initialWrap;
		var size = initialSize;
		for (var octave = 0u; octave < numOctaves; octave++) {
			let n = noise2(channel, v, stitch, wrap, size);
			sum += select(abs(n), n, fractalSum) / ratio;
			v *= 2.0;
			ratio *= 2.0;
			size *= 2;
			wrap = 2 * wrap - PERLIN_N;
		}
		return sum;
	}
	`;

export const SVG_TURBULENCE_SHADER = /* wgsl */ `
	struct Uniforms {
		// Cycles per user-space px, already stitch-adjusted when stitching.
		baseFrequency: vec2f,
		// Texel position of the content's top-left: the user-space origin.
		contentOrigin: vec2f,
		stitchWrap: vec2i,
		stitchSize: vec2i,
		// User-space px per texel.
		invDpiScale: f32,
		numOctaves: u32,
		fractalNoise: u32,
		stitchTiles: u32,
	}

	@group(0) @binding(0) var<uniform> uniforms: Uniforms;
	@group(0) @binding(1) var<storage, read> lattice: Lattice;

	${SVG_FULLSCREEN_VERTEX_WGSL}
	${SVG_PREMULTIPLY_WGSL}
	${SVG_TURBULENCE_NOISE_WGSL}

	@fragment
	fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
		// resvg evaluates the noise at integer device pixel coordinates, so
		// the texel origin is used without the half-texel centre offset.
		let point = (floor(input.position.xy) - uniforms.contentOrigin) * uniforms.invDpiScale;
		var color = vec4f(0.0);
		for (var channel = 0; channel < 4; channel++) {
			var n = turbulence(
				channel,
				point,
				uniforms.baseFrequency,
				uniforms.numOctaves,
				uniforms.fractalNoise == 1u,
				uniforms.stitchTiles == 1u,
				uniforms.stitchWrap,
				uniforms.stitchSize,
			);
			if (uniforms.fractalNoise == 1u) {
				n = (n + 1.0) * 0.5;
			}
			color[channel] = clamp(n, 0.0, 1.0);
		}
		return premultiply(color);
	}
`;
