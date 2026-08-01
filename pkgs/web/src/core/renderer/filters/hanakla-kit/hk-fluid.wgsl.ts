export const HK_FLUID_SHADER = /* wgsl */ `
struct Uniforms {
	resolution: vec2f,
	contentOffset: vec2f,
	worldOrigin: vec2f,
	elementSize: vec2f,
	dpiScale: f32,
	intensity: f32,
	speed: f32,
	scale: f32,
	turbulence: f32,
	colorShift: f32,
	timeSeed: f32,
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

// Simplex noise functions based on https://gist.github.com/patriciogonzalezvivo/670c22f3966e662d2f83
fn permute4(x: vec4f) -> vec4f {
	return ((x * 34.0) + 1.0) * x % 289.0;
}

fn taylorInvSqrt4(r: vec4f) -> vec4f {
	return 1.79284291400159 - 0.85373472095314 * r;
}

fn noise3D(v: vec3f) -> f32 {
	let C = vec2f(1.0 / 6.0, 1.0 / 3.0);
	let D = vec4f(0.0, 0.5, 1.0, 2.0);

	// First corner
	var i = floor(v + dot(v, C.yyy));
	let x0 = v - i + dot(i, C.xxx);

	// Other corners
	let g = step(x0.yzx, x0.xyz);
	let l = 1.0 - g;
	let i1 = min(g.xyz, l.zxy);
	let i2 = max(g.xyz, l.zxy);

	// x0 = x0 - 0.0 + 0.0 * C.xxx;
	let x1 = x0 - i1 + 1.0 * C.xxx;
	let x2 = x0 - i2 + 2.0 * C.xxx;
	let x3 = x0 - 1.0 + 3.0 * C.xxx;

	// Permutations
	i = i % 289.0;
	let p = permute4(permute4(permute4(
			i.z + vec4f(0.0, i1.z, i2.z, 1.0)) +
			i.y + vec4f(0.0, i1.y, i2.y, 1.0)) +
			i.x + vec4f(0.0, i1.x, i2.x, 1.0));

	// Gradients
	let n_ = 1.0 / 7.0; // N=7
	let ns = n_ * D.wyz - D.xzx;

	let j = p - 49.0 * floor(p * ns.z * ns.z);

	let x_ = floor(j * ns.z);
	let y_ = floor(j - 7.0 * x_);

	let x = x_ * ns.x + ns.yyyy;
	let y = y_ * ns.x + ns.yyyy;
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

	// Normalise gradients
	let norm = taylorInvSqrt4(vec4f(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
	p0 = p0 * norm.x;
	p1 = p1 * norm.y;
	p2 = p2 * norm.z;
	p3 = p3 * norm.w;

	// Mix final noise value
	var m = max(0.6 - vec4f(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), vec4f(0.0));
	m = m * m;
	return 42.0 * dot(m * m, vec4f(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}

// World-anchored noise position: the editor clamps the bake to the viewport,
// so texCoord 0 is not the element corner and the texture scale follows the
// live zoom. Mapping back through contentOffset/dpiScale and shifting by
// worldOrigin anchors the noise field to the FULL element rect, keeping the
// pattern fixed while zooming or panning.
fn fluidWorldPos(texCoord: vec2f) -> vec2f {
	return (texCoord * uniforms.resolution - uniforms.contentOffset) / uniforms.dpiScale
		+ uniforms.worldOrigin;
}

// Function to create fluid-like distortion
fn fluidDistortion(uv: vec2f, time: f32, scale: f32, turbulence: f32) -> vec2f {
	let t = time * 0.1;

	// Create different frequency noise patterns
	// Base layer - smooth flow
	let baseNoiseX = noise3D(vec3f(uv.x * scale, uv.y * scale, t));
	let baseNoiseY = noise3D(vec3f(uv.x * scale * 1.2, uv.y * scale * 1.2, t * 1.3));

	// Turbulent layer - higher frequency and more chaotic
	let turbNoiseX = noise3D(vec3f(uv.y * scale * 2.5, uv.x * scale * 2.5, t * 1.7));
	let turbNoiseY = noise3D(vec3f(uv.y * scale * 3.0, uv.x * scale * 2.0, t * 1.9));

	// Additional chaotic pattern for extreme turbulence
	let chaosNoiseX = noise3D(vec3f(uv.y * scale * 4.0 + baseNoiseX, uv.x * scale * 3.5, t * 2.3));
	let chaosNoiseY = noise3D(vec3f(uv.x * scale * 4.5 + baseNoiseY, uv.y * scale * 4.0, t * 2.1));

	// Apply non-linear turbulence mixing for more dramatic effect
	let turb = turbulence * turbulence; // Non-linear scaling for stronger effect

	// First interpolate between base and turbulent noise
	let mixedNoiseX = mix(baseNoiseX, turbNoiseX, min(turb, 1.0));
	let mixedNoiseY = mix(baseNoiseY, turbNoiseY, min(turb, 1.0));

	// For high turbulence (>1.0), blend in chaotic patterns using select function
	let extremeFactor = max(0.0, turbulence - 1.0);
	let hasExtremeTurbulence = turbulence > 1.0;

	// Use the select function to conditionally mix in chaotic noise
	let finalNoiseX = select(
		mixedNoiseX,
		mix(mixedNoiseX, chaosNoiseX, extremeFactor),
		hasExtremeTurbulence
	);

	let finalNoiseY = select(
		mixedNoiseY,
		mix(mixedNoiseY, chaosNoiseY, extremeFactor),
		hasExtremeTurbulence
	);

	return vec2f(finalNoiseX, finalNoiseY);
}

// Out-of-range reads must resolve to transparent, not clamp-to-edge smears:
// with padding = 0 the outermost texels are the artwork's anti-aliased edge
// pixels, and smearing them reads as a translucent ghost of the source.
fn sampleBounded(coord: vec2f) -> vec4f {
	let inside = f32(all(coord >= vec2f(0.0)) && all(coord <= vec2f(1.0)));
	return textureSample(inputTexture, inputSampler, coord) * inside;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
	let dims = uniforms.resolution;
	let texCoord = input.texCoord;

	// Stable UV: world position normalized by the full element rect, matching
	// the legacy texCoord domain of an unclamped bake so the noise pattern
	// stays fixed while zooming or panning.
	let stableUV = fluidWorldPos(texCoord) / uniforms.elementSize;

	let distortionVec = fluidDistortion(
		stableUV,
		uniforms.timeSeed * uniforms.speed,
		uniforms.scale,
		uniforms.turbulence
	);

	// Adjust distortion amount based on turbulence
	let turbulenceBoost = 1.0 + (uniforms.turbulence * 0.5);
	let distortionAmount = (uniforms.intensity / 1000.0) * turbulenceBoost;
	let distortedCoord = texCoord + distortionVec * distortionAmount;

	// Apply chromatic aberration
	let chromaticShift = uniforms.colorShift * 0.01 * (1.0 + uniforms.turbulence * 0.3);
	let redOffset = distortedCoord + distortionVec * chromaticShift;
	let blueOffset = distortedCoord - distortionVec * chromaticShift;

	// Sample the texture with the distorted coordinates
	let rs = sampleBounded(redOffset);
	let gs = sampleBounded(distortedCoord);
	let bs = sampleBounded(blueOffset);

	// Premultiplied channel split (same rule as hk:chromatic-aberration):
	// each channel keeps its own sample's alpha weight, and the averaged
	// coverage keeps fringes translucent instead of borrowing the alpha
	// sampled at the center coordinate.
	let alpha = (rs.a + gs.a + bs.a) / 3.0;

	return vec4f(rs.r, gs.g, bs.b, alpha);
}
`;
