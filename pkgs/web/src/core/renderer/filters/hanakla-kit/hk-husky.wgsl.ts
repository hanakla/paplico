// hk:husky multi-pass shaders: melt → blur/thin → bleed+veil, composing as
// bleed(thin(blur(melt(image)))). Each stage reads the previous stage's
// texture, keeping tap counts linear — the single-pass version re-evaluated
// the whole blur×melt chain for every bleed channel (~400 texture reads and
// ~230 fBm evaluations per pixel).

const HUSKY_COMMON = /* wgsl */ `
struct Uniforms {
	resolution: vec2f,
	dpiScale: f32,
	angle: f32,
	horizontalEnabled: f32,
	verticalEnabled: f32,
	blurIntensity: f32,
	bleedIntensity: f32,
	breathiness: f32,
	melt: f32,
	maxOffset: f32,
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

// Omnidirectional scatter: each spot streaks along its own smoothly-varying
// noise direction, so the form loosens in all directions instead of along
// one fixed angle. The field turns exactly once over the noise range (any
// more reads as turbulence) and varies over a broad ~96 px wavelength so
// nearby streaks stay coherent. The angle / horizontalEnabled /
// verticalEnabled params are retained in documents but no longer steer the
// smear.
fn huskyFlowDirection(posPx: vec2f, noiseSeed: f32) -> vec2f {
	let dirAngle = fractalNoise(posPx / 96.0 + vec2f(2.7, 9.1), noiseSeed + 150.0) * 6.7021;
	return vec2f(cos(dirAngle), sin(dirAngle));
}
`;

/** Pass 1 — melt: rim bite + wisps over the raw source. The handler skips
 *  this pass entirely when melt is 0. */
export const HK_HUSKY_MELT_SHADER = /* wgsl */ `
${HUSKY_COMMON}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
	let dims = uniforms.resolution;
	let coord = input.texCoord;
	let dpiScale = uniforms.dpiScale;
	let noiseSeed = uniforms.randomSeed * 100.0;
	let posPx = coord * dims / dpiScale;

	let sourceColor = textureSample(inputTexture, inputSampler, coord);

	// Eat the rim first: noise bites erode coverage in the boundary band,
	// so the contour dissolves raggedly instead of staying a clean blurred
	// line. The wisps below then rise from what the edge loses.
	// The band comes from the source alpha *gradient* — plain "alpha is
	// mid-range" also fires across semi-transparent interiors, biting where
	// there is no edge at all.
	let gradUv = vec2f(3.0 * dpiScale, 3.0 * dpiScale) / dims;
	let aL = textureSample(inputTexture, inputSampler, clamp(coord - vec2f(gradUv.x, 0.0), vec2f(0.0), vec2f(1.0))).a;
	let aR = textureSample(inputTexture, inputSampler, clamp(coord + vec2f(gradUv.x, 0.0), vec2f(0.0), vec2f(1.0))).a;
	let aT = textureSample(inputTexture, inputSampler, clamp(coord - vec2f(0.0, gradUv.y), vec2f(0.0), vec2f(1.0))).a;
	let aB = textureSample(inputTexture, inputSampler, clamp(coord + vec2f(0.0, gradUv.y), vec2f(0.0), vec2f(1.0))).a;
	let edgeBand = clamp((abs(aR - aL) + abs(aB - aT)) * 1.5, 0.0, 1.0);
	let biteNoise = fractalNoise(posPx / 22.0 + vec2f(8.4, 3.2), noiseSeed + 140.0);
	let bite = uniforms.melt * edgeBand * smoothstep(0.35, 0.85, biteNoise) * 0.85;
	var color = sourceColor * (1.0 - bite);

	// Melt-out: pull interior color outward along a smooth noise flow so
	// the boundary extends as connected wisps (never discrete specks),
	// fading as it dissolves into the air.
	let flowUV = vec2f(
		fractalNoise(posPx / 48.0, noiseSeed + 40.0),
		fractalNoise(posPx / 48.0 + vec2f(11.7, 3.9), noiseSeed + 50.0)
	) * 2.0 - 1.0;
	let meltPx = flowUV * uniforms.melt * 40.0 * dpiScale;
	let meltCoord = clamp(coord + meltPx / dims, vec2f(0.0), vec2f(1.0));
	let meltSample = textureSample(inputTexture, inputSampler, meltCoord);

	// Wisps appear only where the displaced source has more substance than
	// this spot originally had — i.e. just outside the silhouette. Inside
	// and across uniform semi-transparency the difference is zero, so no
	// ghost copy of the image can appear.
	let gain = clamp(meltSample.a - sourceColor.a, 0.0, 1.0) * uniforms.melt * 0.7;
	// Carry the pulled color unchanged: flat whitening here painted a white
	// border where wisps meet the silhouette. The white-breath look belongs
	// to the breathiness veil, which is balanced separately.
	var wispColor = vec3f(0.0);
	if (meltSample.a > 0.001) {
		wispColor = meltSample.rgb / meltSample.a;
	}
	// Under-composite: wisps only fill uncovered air, connecting seamlessly
	// to the rim they rise from.
	let air = 1.0 - color.a;
	return vec4f(
		color.rgb + wispColor * gain * air,
		min(color.a + gain * air, 1.0)
	);
}
`;

/** Pass 2 — blur + thinning: noise-modulated directional streak over the
 *  melted image, then stretch-thinning. The handler skips this pass when
 *  blurIntensity is 0. */
export const HK_HUSKY_BLUR_SHADER = /* wgsl */ `
${HUSKY_COMMON}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
	let dims = uniforms.resolution;
	let coord = input.texCoord;
	let dpiScale = uniforms.dpiScale;
	let noiseSeed = uniforms.randomSeed * 100.0;
	let posPx = coord * dims / dpiScale;
	let noiseUV = coord * 3.0;
	// 30 stays the reference full-strength point (documents tuned below 30
	// look identical), but the slider now reaches 50: the overshoot keeps
	// strengthening the flow smear and stretch-thinning up to their caps.
	let intensityNorm = clamp(uniforms.blurIntensity / 30.0, 0.0, 50.0 / 30.0);
	let direction = huskyFlowDirection(posPx, noiseSeed);

	// Melt flow: intensity stretches the form along a smooth local flow.
	// Advection (a line smear along the flow) cannot fold like a coordinate
	// warp, so matter elongates into connected runs instead of duplicating.
	let flowA = vec2f(
		fractalNoise(posPx / 56.0 + vec2f(5.1, 1.3), noiseSeed + 80.0),
		fractalNoise(posPx / 56.0 + vec2f(9.2, 7.4), noiseSeed + 90.0)
	) * 2.0 - 1.0;
	let flowB = vec2f(
		fractalNoise(posPx / 17.0 + vec2f(3.3, 8.8), noiseSeed + 110.0),
		fractalNoise(posPx / 17.0 + vec2f(6.6, 2.2), noiseSeed + 120.0)
	) * 2.0 - 1.0;
	let flow = flowA * 0.65 + flowB * 0.35;
	// Squared so most spots stay near-intact while a few stretch far.
	let pull = pow(fractalNoise(posPx / 34.0 + vec2f(7.7, 4.4), noiseSeed + 130.0), 2.0);
	let flowSmear = flow * intensityNorm * uniforms.maxOffset * dpiScale * pull;
	// Stretched matter thins: couple the fade to how hard this spot is
	// pulled, so heavily melted runs dissolve into air.
	let meltThin = clamp(intensityNorm * (0.05 + 1.3 * pull * length(flow)), 0.0, 0.85);

	let blurNoiseValue = fractalNoise(noiseUV, noiseSeed) * 2.0 - 1.0;
	let offsetScale = uniforms.maxOffset * dpiScale * 0.5;
	var blurOffset = direction * blurNoiseValue * uniforms.blurIntensity * offsetScale + flowSmear;
	// Cap the streak at the expansion margin: anything longer only spreads
	// the taps apart (gappy ghosts) since it clips at the texture anyway.
	let maxLen = uniforms.maxOffset * dpiScale;
	let len = length(blurOffset);
	if (len > maxLen) {
		blurOffset = blurOffset * (maxLen / len);
	}

	let center = textureSample(inputTexture, inputSampler, coord);

	var blurred = vec4f(0.0, 0.0, 0.0, 0.0);
	var totalWeight = 0.0;
	// Dense enough that a full-margin smear reads as one continuous streak;
	// the sparse 6-tap version separated into discrete ghost copies.
	let sampleCount = 16;

	for (var i = 0; i < sampleCount; i = i + 1) {
		let t = f32(i) / f32(sampleCount - 1);
		let envelope = 1.0 - abs(t - 0.5) * 2.0;
		// Ghost comb: periodic weight peaks leave echo images along the
		// streak; the base term keeps the echoes smoothly connected.
		let comb = 0.5 + 0.5 * cos((t - 0.5) * 6.2831853 * 3.0);
		let weight = envelope * (0.3 + 0.7 * comb * comb);

		let sampleOffset = blurOffset * (t - 0.5) * 2.0;
		let sampleCoord = coord + sampleOffset / dims;

		let clampedCoord = clamp(sampleCoord, vec2f(0.0), vec2f(1.0));
		let sampleColor = textureSample(inputTexture, inputSampler, clampedCoord);
		let inBounds = f32(sampleCoord.x >= 0.0 && sampleCoord.x <= 1.0 && sampleCoord.y >= 0.0 && sampleCoord.y <= 1.0);
		blurred = blurred + sampleColor * weight * inBounds;
		totalWeight = totalWeight + weight * inBounds;
	}

	var color = center;
	if (totalWeight > 0.0) {
		color = blurred / totalWeight;
	}

	return color * (1.0 - meltThin);
}
`;

/** Pass 3 — bleed + breath veil: channel-splits the finished body, then adds
 *  the white veil keyed to the ORIGINAL source alpha (bound separately, since
 *  the chain texture's alpha has already been thinned and melted). Always
 *  runs — with bleed and breathiness at 0 it degenerates to a copy. */
export const HK_HUSKY_BLEED_SHADER = /* wgsl */ `
${HUSKY_COMMON}

@group(0) @binding(3) var sourceAlphaTexture: texture_2d<f32>;

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
	let dims = uniforms.resolution;
	let texCoord = input.texCoord;
	let dpiScale = uniforms.dpiScale;
	let noiseSeed = uniforms.randomSeed * 100.0;
	let posPx = texCoord * dims / dpiScale;
	let noiseUV = texCoord * 3.0;
	let direction = huskyFlowDirection(posPx, noiseSeed);

	var finalColor = textureSample(inputTexture, inputSampler, texCoord);

	if (uniforms.bleedIntensity > 0.0) {
		let redNoiseValue = fractalNoise(noiseUV + vec2f(1.234, 5.678), noiseSeed);
		let greenNoiseValue = fractalNoise(noiseUV + vec2f(4.321, 8.765), noiseSeed + 10.0);
		let blueNoiseValue = fractalNoise(noiseUV + vec2f(7.890, 1.234), noiseSeed + 20.0);

		let redOffset = (redNoiseValue * 2.0 - 1.0) * uniforms.bleedIntensity;
		let greenOffset = (greenNoiseValue * 2.0 - 1.0) * uniforms.bleedIntensity * 0.7;
		let blueOffset = (blueNoiseValue * 2.0 - 1.0) * uniforms.bleedIntensity;

		let offsetScale = uniforms.maxOffset * dpiScale * 0.4;

		let redTexCoord = texCoord + direction * redOffset * offsetScale / dims;
		let greenTexCoord = texCoord + direction * greenOffset * offsetScale / dims;
		let blueTexCoord = texCoord + direction * blueOffset * offsetScale / dims;

		// Each channel samples the finished body so bleed engulfs the blurred
		// melt as well. With bleed → 0 the samples converge to the local body
		// color, keeping the ramp-in continuous.
		let redSample = textureSample(inputTexture, inputSampler, clamp(redTexCoord, vec2f(0.0), vec2f(1.0)));
		let redInBounds = f32(redTexCoord.x >= 0.0 && redTexCoord.x <= 1.0 && redTexCoord.y >= 0.0 && redTexCoord.y <= 1.0);
		let redValue = mix(finalColor.r, redSample.r, redInBounds);

		let greenSample = textureSample(inputTexture, inputSampler, clamp(greenTexCoord, vec2f(0.0), vec2f(1.0)));
		let greenInBounds = f32(greenTexCoord.x >= 0.0 && greenTexCoord.x <= 1.0 && greenTexCoord.y >= 0.0 && greenTexCoord.y <= 1.0);
		let greenValue = mix(finalColor.g, greenSample.g, greenInBounds);

		let blueSample = textureSample(inputTexture, inputSampler, clamp(blueTexCoord, vec2f(0.0), vec2f(1.0)));
		let blueInBounds = f32(blueTexCoord.x >= 0.0 && blueTexCoord.x <= 1.0 && blueTexCoord.y >= 0.0 && blueTexCoord.y <= 1.0);
		let blueValue = mix(finalColor.b, blueSample.b, blueInBounds);

		// Premultiplied channel split: pair the recombined channels with their
		// average coverage. Keeping the local alpha let halo fringes carry rgb
		// far above alpha and clip to white on composite (monochrome bleed).
		let bleedAlpha = (mix(finalColor.a, redSample.a, redInBounds)
			+ mix(finalColor.a, greenSample.a, greenInBounds)
			+ mix(finalColor.a, blueSample.a, blueInBounds)) / 3.0;
		finalColor = vec4f(redValue, greenValue, blueValue, bleedAlpha);
	}

	if (uniforms.breathiness > 0.0) {
		// White breath: a two-layer veil — slow breathing billows plus fine
		// airy grain — strongest at the boundary, dissolving it into light.
		let billow = fractalNoise(posPx / 110.0, noiseSeed + 60.0);
		let grain = noise(posPx / 2.5, noiseSeed + 70.0);
		let breath = billow * 0.75 + grain * 0.25;
		let a = finalColor.a;
		// Key the veil on the source boundary: post-effect alpha thins across
		// the interior at high intensity, which whitened the whole object.
		let srcA = textureSample(sourceAlphaTexture, inputSampler, texCoord).a;
		let edgeWeight = clamp(srcA * (1.0 - srcA) * 4.0 + srcA * 0.25, 0.0, 1.0);
		let veil = uniforms.breathiness * breath * edgeWeight * 0.55;
		finalColor = vec4f(
			finalColor.rgb + vec3f(veil * max(a, 0.15)),
			min(finalColor.a + veil * 0.3, 1.0)
		);
	}

	return finalColor;
}
`;
