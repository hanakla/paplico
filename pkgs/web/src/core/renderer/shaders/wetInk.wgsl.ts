export const WET_INK_SHADER = /* wgsl */ `
struct Uniforms {
	targetResolution: vec2f,
	domainResolution: vec2f,
	bboxOriginPx: vec2f,
	targetWorldOrigin: vec2f,
	domainWorldOrigin: vec2f,
	targetWorldPerPixel: f32,
	domainWorldPerPixel: f32,
	edgeDarkening: f32,
	edgeRoughness: f32,
	paperGrain: f32,
	paperScale: f32,
	wetness: f32,
	pigmentLoad: f32,
	absorption: f32,
	granulation: f32,
	randomSeed: f32,
	pad0: f32,
	pad1: f32,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var diffusedPigment: texture_2d<f32>;
@group(0) @binding(2) var diffusedWater: texture_2d<f32>;
@group(0) @binding(3) var inputSampler: sampler;

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

fn hash21(p: vec2f) -> f32 {
	let q = fract(p * vec2f(123.34, 456.21));
	let r = q + dot(q, q + vec2f(45.32, 78.93));
	return fract(r.x * r.y);
}

fn valueNoise(p: vec2f) -> f32 {
	let i = floor(p);
	let f = fract(p);
	let u = f * f * (vec2f(3.0) - 2.0 * f);
	let seed = vec2f(uniforms.randomSeed, uniforms.randomSeed * 1.7);
	let a = hash21(i + seed);
	let b = hash21(i + vec2f(1.0, 0.0) + seed);
	let c = hash21(i + vec2f(0.0, 1.0) + seed);
	let d = hash21(i + vec2f(1.0, 1.0) + seed);
	return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

fn fbm(p0: vec2f) -> f32 {
	var p = p0;
	var amp = 0.5;
	var sum = 0.0;
	for (var i = 0; i < 3; i = i + 1) {
		sum += amp * valueNoise(p);
		p = p * 2.0;
		amp = amp * 0.5;
	}
	return sum;
}

fn samplePigmentUv(uv: vec2f) -> vec4f {
	return textureSampleLevel(diffusedPigment, inputSampler, uv, 0.0);
}

fn sampleWaterUv(uv: vec2f) -> vec4f {
	return textureSampleLevel(diffusedWater, inputSampler, uv, 0.0);
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
	let targetPx = input.position.xy;
	let worldPos = vec2f(
		uniforms.targetWorldOrigin.x + targetPx.x * uniforms.targetWorldPerPixel,
		uniforms.targetWorldOrigin.y - targetPx.y * uniforms.targetWorldPerPixel,
	);
	let domainPx = vec2f(
		(worldPos.x - uniforms.domainWorldOrigin.x) / uniforms.domainWorldPerPixel,
		(uniforms.domainWorldOrigin.y - worldPos.y) / uniforms.domainWorldPerPixel,
	);
	if (
		domainPx.x < 0.0 ||
		domainPx.y < 0.0 ||
		domainPx.x >= uniforms.domainResolution.x ||
		domainPx.y >= uniforms.domainResolution.y
	) {
		return vec4f(0.0);
	}
	let pigmentTexSize = vec2f(textureDimensions(diffusedPigment, 0));
	let logicalMaxPx = max(uniforms.domainResolution - vec2f(1.0), vec2f(0.0));
	let samplePx = clamp(domainPx, vec2f(0.0), logicalMaxPx);
	let domainUv = (samplePx + vec2f(0.5)) / pigmentTexSize;
	let domainTexel = 1.0 / max(pigmentTexSize, vec2f(1.0));
	let neighborMinUv = vec2f(0.5) / pigmentTexSize;
	let neighborMaxUv = (logicalMaxPx + vec2f(0.5)) / pigmentTexSize;
	let center = samplePigmentUv(domainUv);
	let water = sampleWaterUv(domainUv);
	let l = samplePigmentUv(clamp(domainUv + vec2f(-domainTexel.x, 0.0), neighborMinUv, neighborMaxUv));
	let r = samplePigmentUv(clamp(domainUv + vec2f(domainTexel.x, 0.0), neighborMinUv, neighborMaxUv));
	let d = samplePigmentUv(clamp(domainUv + vec2f(0.0, -domainTexel.y), neighborMinUv, neighborMaxUv));
	let u = samplePigmentUv(clamp(domainUv + vec2f(0.0, domainTexel.y), neighborMinUv, neighborMaxUv));

	let density = max(center.a, 0.0);
	if (density <= 0.00001) {
		return vec4f(0.0);
	}

	let grad = length(vec2f(r.a - l.a, u.a - d.a)) * 0.5;
	let waterBoundary = smoothstep(0.01, 0.18, grad + max(water.b, 0.0) * 0.015);
	// Wider detection band so the rim reads as a gradual deposit, not a hard line.
	let pigmentBoundary = smoothstep(0.015, 0.3, grad);
	let wetEdge = waterBoundary * pigmentBoundary;
	let noisePos = worldPos * max(0.0001, uniforms.paperScale);
	let grain = fbm(noisePos * 2.7);
	let rough = mix(1.0, smoothstep(0.18, 0.82, fbm(noisePos + vec2f(17.0))), uniforms.edgeRoughness * wetEdge * 0.65);
	let dryingEdge = wetEdge * smoothstep(0.05, 0.85, 1.0 - clamp(water.b, 0.0, 1.0));
	// Perceptual sqrt curve on edgeDarkening; deposit is capped at x1.25.
	let edgeDeposit = 1.0 + sqrt(uniforms.edgeDarkening) * dryingEdge * (0.10 + uniforms.wetness * 0.15);
	let paperHold = mix(1.0, 0.82 + grain * 0.36, uniforms.absorption * uniforms.paperGrain);
	let granulationMod = 1.0 + uniforms.granulation * (grain - 0.5) * uniforms.paperGrain;
	let displayDensity = max(0.0, density * rough * edgeDeposit * paperHold * granulationMod);
	let bodyAlpha = 1.0 - exp(-density * max(uniforms.pigmentLoad, 0.0) * 1.15);
	let alpha = clamp(max(1.0 - exp(-displayDensity * max(uniforms.pigmentLoad, 0.0)), bodyAlpha * 0.92), 0.0, 1.0);
	let baseColor = max(center.rgb / max(density, 1e-5), vec3f(0.0));
	return vec4f(baseColor * alpha, alpha);
}
`;
