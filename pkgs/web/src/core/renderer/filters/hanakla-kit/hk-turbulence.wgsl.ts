export const HK_TURBULENCE_SHADER = /* wgsl */ `
struct Uniforms {
	resolution: vec2f,
	contentOffset: vec2f,
	worldOrigin: vec2f,
	elementSize: vec2f,
	dpiScale: f32,
	scale: f32,
	octaves: i32,
	seed: f32,
	displacementX: f32,
	displacementY: f32,
	displacementMode: i32, // 0: cartesian, 1: radial, 2: twist
	edgeMode: i32, // 0: clamp, 1: wrap, 2: mirror
	opacity: f32,
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

// Simplex noise functions
fn mod289(x: vec3f) -> vec3f {
	return x - floor(x * (1.0 / 289.0)) * 289.0;
}

fn mod289_vec4(x: vec4f) -> vec4f {
	return x - floor(x * (1.0 / 289.0)) * 289.0;
}

fn permute(x: vec4f) -> vec4f {
	return mod289_vec4((x * 34.0 + 1.0) * x);
}

fn taylorInvSqrt(r: vec4f) -> vec4f {
	return 1.79284291400159 - 0.85373472095314 * r;
}

fn simplexNoise(v: vec3f) -> f32 {
	let C = vec2f(1.0/6.0, 1.0/3.0);
	let D = vec4f(0.0, 0.5, 1.0, 2.0);

	var i = floor(v + dot(v, vec3f(C.y)));
	let x0 = v - i + dot(i, vec3f(C.x));

	let g = step(x0.yzx, x0.xyz);
	let l = 1.0 - g;
	let i1 = min(g.xyz, l.zxy);
	let i2 = max(g.xyz, l.zxy);

	let x1 = x0 - i1 + C.x;
	let x2 = x0 - i2 + C.y;
	let x3 = x0 - D.yyy;

	i = mod289(i);
	let p = permute(permute(permute(
		i.z + vec4f(0.0, i1.z, i2.z, 1.0))
		+ i.y + vec4f(0.0, i1.y, i2.y, 1.0))
		+ i.x + vec4f(0.0, i1.x, i2.x, 1.0));

	let ns = 0.142857142857;
	let j = p - 49.0 * floor(p * ns * ns);

	let x_ = floor(j * ns);
	let y_ = floor(j - 7.0 * x_);

	let x = x_ * ns + vec4f(ns) - 1.0;
	let y = y_ * ns + vec4f(ns) - 1.0;
	let h = 1.0 - abs(x) - abs(y);

	let b0 = vec4f(x.xy, y.xy);
	let b1 = vec4f(x.zw, y.zw);

	let s0 = floor(b0) * 2.0 + 1.0;
	let s1 = floor(b1) * 2.0 + 1.0;
	let sh = -step(h, vec4f(0.0));

	let a0 = b0.xzyw + s0.xzyw * sh.xxyy;
	let a1 = b1.xzyw + s1.xzyw * sh.zzww;

	var p0 = vec3f(a0.xy, h.x);
	var p1 = vec3f(a0.zw, h.y);
	var p2 = vec3f(a1.xy, h.z);
	var p3 = vec3f(a1.zw, h.w);

	let norm = taylorInvSqrt(vec4f(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
	p0 *= norm.x;
	p1 *= norm.y;
	p2 *= norm.z;
	p3 *= norm.w;

	var m = max(0.6 - vec4f(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), vec4f(0.0));
	m = m * m;
	return 42.0 * dot(m * m, vec4f(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}

fn turbulence(pos: vec3f, octaves: i32) -> f32 {
	var value = 0.0;
	var amplitude = 1.0;
	var frequency = 1.0;
	var maxValue = 0.0;

	for (var i = 0; i < octaves; i++) {
		value += simplexNoise(pos * frequency) * amplitude;
		maxValue += amplitude;
		amplitude *= 0.5;
		frequency *= 2.0;
	}

	return (value / maxValue) * 0.5 + 0.5; // Normalize to 0-1 range
}

// World-anchored noise position: the editor clamps the bake to the viewport,
// so texCoord 0 is not the element corner and the texture scale follows the
// live zoom. Mapping back through contentOffset/dpiScale and shifting by
// worldOrigin anchors the noise field to the FULL element rect, keeping the
// pattern fixed while zooming or panning.
fn turbulenceWorldPos(texCoord: vec2f) -> vec2f {
	return (texCoord * uniforms.resolution - uniforms.contentOffset) / uniforms.dpiScale
		+ uniforms.worldOrigin;
}

fn sampleWithEdgeMode(texCoord: vec2f) -> vec4f {
	var coord = texCoord;

	if (uniforms.edgeMode == 0) { // clamp
		coord = clamp(coord, vec2f(0.0), vec2f(1.0));
	} else if (uniforms.edgeMode == 1) { // wrap
		coord = fract(coord);
	} else if (uniforms.edgeMode == 2) { // mirror
		coord = abs(fract(coord * 0.5) * 2.0 - 1.0);
	}

	return textureSample(inputTexture, inputSampler, coord);
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
	let dims = uniforms.resolution;
	let texCoord = input.texCoord;

	let dpiScale = uniforms.dpiScale;

	// Generate turbulence noise with separate X and Y components.
	// Stable UV: world position normalized by the full element rect, matching
	// the legacy texCoord domain of an unclamped bake so the noise pattern
	// stays fixed while zooming or panning.
	let stableUV = turbulenceWorldPos(texCoord) / uniforms.elementSize;
	let noiseScale = uniforms.scale * 0.01;
	let noisePosX = vec3f(
		stableUV.x * noiseScale,
		stableUV.y * noiseScale,
		uniforms.seed
	);
	let noisePosY = vec3f(
		stableUV.x * noiseScale,
		stableUV.y * noiseScale,
		uniforms.seed + 100.0
	);

	let noiseX = turbulence(noisePosX, uniforms.octaves);
	let noiseY = turbulence(noisePosY, uniforms.octaves);

	var displacement = vec2f(0.0);
	let scaledDisplacementX = uniforms.displacementX * dpiScale;
	let scaledDisplacementY = uniforms.displacementY * dpiScale;

	if (uniforms.displacementMode == 0) { // cartesian
		displacement = vec2f(
			(noiseX * 2.0 - 1.0) * scaledDisplacementX / dims.x,
			(noiseY * 2.0 - 1.0) * scaledDisplacementY / dims.y
		);
	} else if (uniforms.displacementMode == 1) { // radial
		let center = vec2f(0.5);
		let offset = texCoord - center;
		let distance = length(offset);
		if (distance > 0.001) {
			let direction = offset / distance;
			let noiseValue = (noiseX * 2.0 - 1.0);
			// Use distance to modulate the effect (stronger at edges)
			let strength = noiseValue * distance * length(vec2f(scaledDisplacementX, scaledDisplacementY));
			displacement = direction * strength / min(dims.x, dims.y);
		}
	} else if (uniforms.displacementMode == 2) { // twist
		let center = vec2f(0.5);
		let offset = texCoord - center;
		let distance = length(offset);
		if (distance > 0.001) {
			// Angle increases with distance from center
			let twistAngle = (noiseX * 2.0 - 1.0) * scaledDisplacementX * distance * 0.1;
			let cosA = cos(twistAngle);
			let sinA = sin(twistAngle);
			let rotated = vec2f(
				offset.x * cosA - offset.y * sinA,
				offset.x * sinA + offset.y * cosA
			);
			displacement = (rotated - offset) * scaledDisplacementY * 0.02;
		}
	}

	let displacedCoord = texCoord + displacement;
	let displacedColor = sampleWithEdgeMode(displacedCoord);
	let originalColor = sampleWithEdgeMode(texCoord);

	let finalColor = mix(originalColor, displacedColor, uniforms.opacity);

	return finalColor;
}
`;
