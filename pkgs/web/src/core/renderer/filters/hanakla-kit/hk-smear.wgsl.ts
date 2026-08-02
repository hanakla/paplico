export const HK_SMEAR_SHADER = /* wgsl */ `
struct Uniforms {
	resolution: vec2f,
	contentOffset: vec2f,
	worldOrigin: vec2f,
	dpiScale: f32,
	angle: f32,
	intensity: f32,
	streakLength: f32,
	streakWidth: f32,
	softness: f32,
	randomSeed: f32,
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

fn random(co: vec2f) -> f32 {
	return fract(sin(dot(co, vec2f(12.9898, 78.233))) * 43758.5453);
}

fn noise(p: vec2f, seed: f32) -> f32 {
	let pi = floor(p);
	let pf = fract(p);

	let seedVec = vec2f(seed, seed * 1.374);

	let n00 = random(pi + seedVec);
	let n10 = random(pi + vec2f(1.0, 0.0) + seedVec);
	let n01 = random(pi + vec2f(0.0, 1.0) + seedVec);
	let n11 = random(pi + vec2f(1.0, 1.0) + seedVec);

	let u = pf * pf * (3.0 - 2.0 * pf);

	let nx0 = mix(n00, n10, u.x);
	let nx1 = mix(n01, n11, u.x);

	return mix(nx0, nx1, u.y);
}

fn fractalNoise(p: vec2f, seed: f32) -> f32 {
	var value = 0.0;
	var amplitude = 0.5;
	var frequency = 1.0;
	let octaves = 4;
	let lacunarity = 2.0;
	let persistence = 0.5;

	for (var i = 0; i < octaves; i = i + 1) {
		value = value + noise(p * frequency, seed + f32(i) * 13.371) * amplitude;
		amplitude = amplitude * persistence;
		frequency = frequency * lacunarity;
	}

	return value;
}

// World-anchored noise position: the editor clamps the bake to the viewport,
// so texCoord 0 is not the element corner and the texture scale follows the
// live zoom. Mapping back through contentOffset/dpiScale and shifting by
// worldOrigin anchors the streak noise to the FULL element rect, keeping the
// pattern fixed while zooming or panning.
fn smearWorldPos(texCoord: vec2f) -> vec2f {
	return (texCoord * uniforms.resolution - uniforms.contentOffset) / uniforms.dpiScale
		+ uniforms.worldOrigin;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
	let texCoord = input.texCoord;
	let originalColor = textureSample(inputTexture, inputSampler, texCoord);

	if (uniforms.intensity <= 0.0) {
		return originalColor;
	}

	let angleRad = uniforms.angle * 3.14159265359 / 180.0;
	// Screen-space angle (0° = right, CCW-positive) in UV space (Y down).
	let streakDir = vec2f(cos(angleRad), -sin(angleRad));
	let streakPerp = vec2f(-streakDir.y, streakDir.x);

	// Streak-space noise coords in world px: long wavelength along the
	// direction, short across it, producing fiber-like streaks.
	let posPx = smearWorldPos(texCoord);
	let streakUV = vec2f(
		dot(posPx, streakDir) / max(uniforms.streakLength, 1.0),
		dot(posPx, streakPerp) / max(uniforms.streakWidth, 0.5)
	);

	// Dry-brush breakup: erode coverage where streak noise falls below the
	// threshold. originalColor is premultiplied, so scaling the whole vector
	// erodes color and alpha together.
	let streakNoise = fractalNoise(streakUV, uniforms.randomSeed * 100.0);
	let keep = smoothstep(
		uniforms.intensity - uniforms.softness,
		uniforms.intensity + uniforms.softness,
		streakNoise
	);
	return originalColor * keep;
}
`;
