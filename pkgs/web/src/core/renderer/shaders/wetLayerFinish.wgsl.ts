// Wet layer composite, v2 (design §13-2).
//
// Decodes the simulation's log-space pigment density into premultiplied
// colour and shapes it with the paper and the drying rim, exactly as v1 did.
// The difference is where the shaping coefficients come from: edge darkening,
// edge roughness, absorption and granulation are read per texel from the seed
// pass's coefficient targets, so a single stroke can deposit a hard rim at one
// end and none at the other.
//
// The rim itself is detected from the pigment gradient, which is why this pass
// samples the neighbourhood rather than trusting a stored edge factor.
export const WET_LAYER_FINISH_SHADER = /* wgsl */ `
struct Uniforms {
	targetResolution: vec2f,
	domainResolution: vec2f,
	targetWorldOrigin: vec2f,
	domainWorldOrigin: vec2f,
	targetWorldPerPixel: f32,
	domainWorldPerPixel: f32,
	paperGrain: f32,
	paperScale: f32,
	/** Radius, in domain texels, of the random displacement applied to where
	 *  each output texel reads its pigment. */
	scatter: f32,
	pigmentLoad: f32,
	randomSeed: f32,
	/** Domain texels per diffused-field texel: the fields run on a coarser
	 *  grid than the seeds, which is how the bleed reaches its distance. */
	fieldScale: f32,
	/** How much wider than its own body the stroke ended up. A stroke carries
	 *  the paint it was given, so spreading it has to thin it by the same
	 *  factor; without this a wide bleed paints more ink than a narrow one. */
	spreadDilution: f32,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var diffusedPigment: texture_2d<f32>;
@group(0) @binding(2) var diffusedMoisture: texture_2d<f32>;
@group(0) @binding(3) var absorptionGranulation: texture_2d<f32>;
@group(0) @binding(4) var softnessEdgeDarkening: texture_2d<f32>;
@group(0) @binding(5) var edgeRoughnessSeed: texture_2d<f32>;
@group(0) @binding(6) var inputSampler: sampler;

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
	let seed = vec2f(uniforms.randomSeed, uniforms.randomSeed * 1.913);
	let a = hash21(i + seed);
	let b = hash21(i + vec2f(1.0, 0.0) + seed);
	let c = hash21(i + vec2f(0.0, 1.0) + seed);
	let d = hash21(i + vec2f(1.0, 1.0) + seed);
	return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

fn fbm(p: vec2f) -> f32 {
	var value = 0.0;
	var amplitude = 0.5;
	var position = p;
	for (var i = 0; i < 3; i = i + 1) {
		value = value + amplitude * valueNoise(position);
		position = position * 2.0;
		amplitude = amplitude * 0.5;
	}
	return value;
}

fn samplePigmentUv(uv: vec2f) -> vec4f {
	return textureSampleLevel(diffusedPigment, inputSampler, uv, 0.0);
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
	let fieldScale = max(1.0, uniforms.fieldScale);
	let fieldResolution = ceil(uniforms.domainResolution / fieldScale);
	let logicalMaxPx = max(uniforms.domainResolution - vec2f(1.0), vec2f(0.0));
	let fieldMaxPx = max(fieldResolution - vec2f(1.0), vec2f(0.0));
	// Scattering displaces the read, not the write: each output texel takes
	// its pigment from a random spot nearby, which shuffles texels around and
	// breaks the field into grain. Displacing whole dabs instead moves pickup
	// and paint together and shuffles nothing.
	var readPx = domainPx;
	if (uniforms.scatter > 0.0) {
		let jitterSeed = floor(domainPx) + vec2f(uniforms.randomSeed * 131.0);
		let angle = hash21(jitterSeed) * 6.2831853;
		let dist = sqrt(hash21(jitterSeed + vec2f(37.0, 61.0))) * uniforms.scatter;
		readPx = domainPx + vec2f(cos(angle), sin(angle)) * dist;
	}
	let samplePx = clamp(readPx, vec2f(0.0), logicalMaxPx);
	// Coefficients are read at the seed grid, the fields at the coarser one.
	let fieldPx = clamp(samplePx / fieldScale, vec2f(0.0), fieldMaxPx);
	let domainUv = (fieldPx + vec2f(0.5)) / pigmentTexSize;
	let domainTexel = 1.0 / max(pigmentTexSize, vec2f(1.0));
	let neighborMinUv = vec2f(0.5) / pigmentTexSize;
	let neighborMaxUv = (fieldMaxPx + vec2f(0.5)) / pigmentTexSize;
	// The domain is finer than the target whenever the brush is small: one
	// tap per target pixel would skip whole rows of the field, which reads as
	// stripes and holes. Average a 3x3 box covering the target pixel's
	// footprint instead.
	let minify = max(
		uniforms.targetWorldPerPixel / (uniforms.domainWorldPerPixel * fieldScale),
		1.0,
	);
	let boxStep = domainTexel * (minify / 3.0);
	var boxSum = vec4f(0.0);
	for (var by = -1; by <= 1; by = by + 1) {
		for (var bx = -1; bx <= 1; bx = bx + 1) {
			boxSum += samplePigmentUv(clamp(
				domainUv + vec2f(f32(bx), f32(by)) * boxStep,
				neighborMinUv,
				neighborMaxUv,
			));
		}
	}
	let center = boxSum / 9.0;
	let moisture = textureSampleLevel(diffusedMoisture, inputSampler, domainUv, 0.0);
	let l = samplePigmentUv(clamp(domainUv + vec2f(-domainTexel.x, 0.0), neighborMinUv, neighborMaxUv));
	let r = samplePigmentUv(clamp(domainUv + vec2f(domainTexel.x, 0.0), neighborMinUv, neighborMaxUv));
	let d = samplePigmentUv(clamp(domainUv + vec2f(0.0, -domainTexel.y), neighborMinUv, neighborMaxUv));
	let u = samplePigmentUv(clamp(domainUv + vec2f(0.0, domainTexel.y), neighborMinUv, neighborMaxUv));

	let density = max(center.a, 0.0);
	if (density <= 0.00001) {
		return vec4f(0.0);
	}

	// Per-texel shaping coefficients, seeded by whichever dab covered here.
	let coord = vec2i(samplePx);
	let absorptionGranulationValue = textureLoad(absorptionGranulation, coord, 0);
	let absorption = clamp(absorptionGranulationValue.r, 0.0, 1.0);
	let granulation = clamp(absorptionGranulationValue.g, 0.0, 1.0);
	let edgeDarkening = clamp(
		textureLoad(softnessEdgeDarkening, coord, 0).g,
		0.0,
		1.0,
	);
	let edgeRoughness = clamp(
		textureLoad(edgeRoughnessSeed, coord, 0).r,
		0.0,
		1.0,
	);

	let grad = length(vec2f(r.a - l.a, u.a - d.a)) * 0.5;
	let waterBoundary = smoothstep(0.01, 0.18, grad + max(moisture.b, 0.0) * 0.015);
	// Wide detection band so the rim reads as a gradual deposit, not a line.
	let pigmentBoundary = smoothstep(0.015, 0.3, grad);
	let wetEdge = waterBoundary * pigmentBoundary;
	let noisePos = worldPos * max(0.0001, uniforms.paperScale);
	let grain = fbm(noisePos * 2.7);
	let rough = mix(
		1.0,
		smoothstep(0.18, 0.82, fbm(noisePos + vec2f(17.0))),
		edgeRoughness * wetEdge * 0.65,
	);
	let dryingEdge = wetEdge * smoothstep(0.05, 0.85, 1.0 - clamp(moisture.b, 0.0, 1.0));
	// Perceptual sqrt curve on edge darkening; the deposit caps at x1.25.
	let edgeDeposit = 1.0 + sqrt(edgeDarkening) * dryingEdge * 0.25;
	let paperHold = mix(1.0, 0.82 + grain * 0.36, absorption * uniforms.paperGrain);
	let granulationMod = 1.0 + granulation * (grain - 0.5) * uniforms.paperGrain;
	let displayDensity = max(0.0, density * rough * edgeDeposit * paperHold * granulationMod);
	let load = max(uniforms.pigmentLoad, 0.0) / max(uniforms.spreadDilution, 1.0);
	// The body alpha floor keeps edge shaping from thinning the stroke itself.
	let bodyAlpha = 1.0 - exp(-density * load * 1.15);
	let alpha = clamp(
		max(1.0 - exp(-displayDensity * load), bodyAlpha * 0.92),
		0.0,
		1.0,
	);
	let baseColor = max(center.rgb / max(density, 1e-5), vec3f(0.0));
	return vec4f(baseColor * alpha, alpha);
}
`;
