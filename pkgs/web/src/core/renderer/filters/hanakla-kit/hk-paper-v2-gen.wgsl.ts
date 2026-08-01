// Stage A of the hk:paper-v2 generator: renders the unlit paper "height
// field" (value = height, grayscale, a = 1). Two entry-point pairs share one
// uniform struct: a fullscreen base pass (formation mottle, laid/chain lines,
// wire mark, specks, micro roughness) and a vertex-buffer fiber pass drawn on
// top. Every spatial term is anchored in world px through the same
// resolution/contentOffset idiom as pixelate.wgsl.ts, so the generated sheet
// is invariant to the rasterization DPI.

export const HK_PAPER_V2_GEN_SHADER = /* wgsl */ `
struct Uniforms {
	resolution: vec2f,
	contentOffset: vec2f,
	// Texture top-left relative to the element rect's top-left, in world px
	// (Y-down). Non-zero when the bake is clamped to the viewport, so every
	// world-anchored term stays fixed to the element instead of the bake.
	worldOrigin: vec2f,
	dpiScale: f32,
	seed: f32,
	roughnessAmp: f32,
	formationAmp: f32,
	laidAmp: f32,
	laidSpacingPx: f32,
	chainSpacingPx: f32,
	chainAmp: f32,
	wireAmp: f32,
	wireSpacingPx: f32,
	mdStretch: f32,
	speckDensity: f32,
	speckDarkness: f32,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

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

fn hash(n: f32) -> f32 {
	return fract(sin(n) * 43758.5453);
}

fn hash2(p: vec2f, seed: f32) -> f32 {
	return hash(p.x + p.y * 57.0 + seed * 131.0);
}

fn vnoise(p: vec2f, seed: f32) -> f32 {
	let i = floor(p);
	let f = fract(p);

	let a = hash2(i, seed);
	let b = hash2(i + vec2f(1.0, 0.0), seed);
	let c = hash2(i + vec2f(0.0, 1.0), seed);
	let d = hash2(i + vec2f(1.0, 1.0), seed);

	let u = f * f * (3.0 - 2.0 * f);

	return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

@fragment
fn baseFragmentMain(input: VertexOutput) -> @location(0) vec4f {
	// World px anchored to the element rect corner (pixelate.wgsl.ts idiom,
	// shifted by worldOrigin so a viewport-clamped bake samples the same field).
	let world = (input.texCoord * uniforms.resolution - uniforms.contentOffset) / uniforms.dpiScale
		+ uniforms.worldOrigin;

	// Micro surface roughness: per-world-px noise, matching the original's
	// 255 - rand * roughness * 40 base texture depth.
	var v = 1.0 - vnoise(world * 1.1, uniforms.seed) * uniforms.roughnessAmp * 0.16;

	// Formation mottle: cloudy density unevenness from the sheet-forming
	// stage, ~48 world px base wavelength, 4 octaves.
	var amp = 0.5;
	var freq = 1.0 / 48.0;
	var mottle = 0.0;
	for (var i = 0; i < 4; i++) {
		mottle += (vnoise(world * freq, uniforms.seed + 7.0 + f32(i) * 13.371) - 0.5) * amp;
		amp *= 0.5;
		freq *= 2.0;
	}
	v -= mottle * uniforms.formationAmp * 0.25;

	// Laid lines (washi screen ridges) + chain lines (binding threads).
	let laidRidge = abs(sin(world.y * 3.14159265 / uniforms.laidSpacingPx));
	v += (pow(laidRidge, 0.75) - 0.64) * uniforms.laidAmp * 0.07;
	let chainDist = abs(fract(world.x / uniforms.chainSpacingPx + 0.5) - 0.5) * uniforms.chainSpacingPx;
	v -= smoothstep(1.5, 0.0, chainDist) * uniforms.chainAmp * 0.08;

	// Wire/felt mark: fine cross grid plus machine-direction stretched noise.
	let wireGrid = abs(sin(world.x * 3.14159265 / uniforms.wireSpacingPx))
		* abs(sin(world.y * 3.14159265 / uniforms.wireSpacingPx));
	v -= (wireGrid - 0.4) * uniforms.wireAmp * 0.05;
	let mdNoise = vnoise(vec2f(world.x / (8.0 * max(uniforms.mdStretch, 1.0)), world.y / 2.5), uniforms.seed + 31.0);
	v -= (mdNoise - 0.5) * uniforms.wireAmp * 0.06;

	// Impurity specks (groundwood pulp): sparse dark dots on a 6 px cell grid.
	let cell = floor(world / 6.0);
	let cellHash = hash2(cell, uniforms.seed + 91.0);
	if (cellHash < uniforms.speckDensity * 0.05) {
		let center = (cell + vec2f(
			hash2(cell, uniforms.seed + 92.0),
			hash2(cell, uniforms.seed + 93.0)
		)) * 6.0;
		let radius = 0.4 + hash2(cell, uniforms.seed + 94.0) * 0.8;
		let fade = 1.0 - smoothstep(0.0, radius, distance(world, center));
		v -= fade * uniforms.speckDarkness;
	}

	let value = clamp(v, 0.0, 1.0);
	return vec4f(value, value, value, 1.0);
}

struct FiberVertexIn {
	@location(0) posWorld: vec2f,
	@location(1) gray: f32,
}

struct FiberVertexOut {
	@builtin(position) position: vec4f,
	@location(0) gray: f32,
}

@vertex
fn fiberVertexMain(input: FiberVertexIn) -> FiberVertexOut {
	var output: FiberVertexOut;
	let texel = (input.posWorld - uniforms.worldOrigin) * uniforms.dpiScale + uniforms.contentOffset;
	let ndc = texel / uniforms.resolution * 2.0 - 1.0;
	output.position = vec4f(ndc.x, -ndc.y, 0.0, 1.0);
	output.gray = input.gray;
	return output;
}

@fragment
fn fiberFragmentMain(input: FiberVertexOut) -> @location(0) vec4f {
	return vec4f(input.gray, input.gray, input.gray, 1.0);
}
`;
