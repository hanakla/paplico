export const HK_VHS_INTERLACE_SHADER = /* wgsl */ `
struct Uniforms {
	worldSize: vec2f,
	sourceWorldSize: vec2f,
	sourceOffset: vec2f,
	intensity: f32,
	generation: f32,
	chromaBleed: f32,
	colorShift: f32,
	lumaSoftness: f32,
	ringing: f32,
	lineJitter: f32,
	verticalJitter: f32,
	trackingError: f32,
	headSwitching: f32,
	headSwitchingHeight: f32,
	noise: f32,
	noiseDistortion: f32,
	chromaNoise: f32,
	dropouts: f32,
	dropoutLength: f32,
	brightnessJitter: f32,
	scanlines: f32,
	interlaceGap: f32,
	combing: f32,
	tilt: f32,
	blackLift: f32,
	desaturation: f32,
	randomSeed: f32,
	enableVHSColor: f32,
	vhsColorR: f32,
	vhsColorG: f32,
	vhsColorB: f32,
	vhsColorA: f32,
	applyToTransparent: f32,
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

fn rand(co: vec2f) -> f32 {
	return fract(sin(dot(co, vec2f(12.9898, 78.233))) * 43758.5453);
}

fn noise1D(x: f32) -> f32 {
	return fract(sin(x) * 10000.0);
}

// VHS records chroma at a fraction of the luma bandwidth (color-under),
// so the two are degraded separately through a YIQ split.
fn rgbToYiq(c: vec3f) -> vec3f {
	return vec3f(
		dot(c, vec3f(0.299, 0.587, 0.114)),
		dot(c, vec3f(0.596, -0.274, -0.322)),
		dot(c, vec3f(0.211, -0.523, 0.312))
	);
}

fn yiqToRgb(c: vec3f) -> vec3f {
	return vec3f(
		c.x + 0.956 * c.y + 0.621 * c.z,
		c.x - 0.272 * c.y - 0.647 * c.z,
		c.x - 1.106 * c.y + 1.703 * c.z
	);
}

fn toSourceUV(coord: vec2f) -> vec2f {
	return (coord * uniforms.worldSize - uniforms.sourceOffset) / uniforms.sourceWorldSize;
}

fn lumaAt(coord: vec2f) -> f32 {
	return rgbToYiq(textureSampleLevel(inputTexture, inputSampler, toSourceUV(coord), 0.0).rgb).x;
}

fn chromaAt(coord: vec2f) -> vec2f {
	return rgbToYiq(textureSampleLevel(inputTexture, inputSampler, toSourceUV(coord), 0.0).rgb).yz;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
	let texCoord = input.texCoord;
	let worldSize = uniforms.worldSize;
	let effectTexCoord = (uniforms.sourceOffset + texCoord * uniforms.sourceWorldSize) / worldSize;

	let originalColor = textureSample(inputTexture, inputSampler, texCoord);

	let strength = uniforms.intensity;
	if (strength <= 0.0) {
		return originalColor;
	}

	// Flag transparent areas to skip processing (no early return to maintain uniform control flow)
	let skipProcessing = uniforms.applyToTransparent < 0.5 && originalColor.a < 0.01;

	let seed = uniforms.randomSeed;
	// UV distance of one 72dpi world px — anchoring everything to world px
	// keeps the output identical across rasterization DPI.
	let pxX = 1.0 / worldSize.x;
	let pxY = 1.0 / worldSize.y;

	// Dub generation piles baseline degradation on top of the detail params.
	let gen = clamp(uniforms.generation, 1.0, 5.0) - 1.0;
	let lumaSoft = clamp(uniforms.lumaSoftness * strength + gen * 0.12, 0.0, 1.0);
	let chromaBleed = clamp(uniforms.chromaBleed * strength + gen * 0.15, 0.0, 1.5);
	let noiseAmount = (uniforms.noise * strength + gen * 0.04) * 0.8;
	let chromaNoiseAmount = uniforms.chromaNoise * strength + gen * 0.05;
	let desaturation = clamp(uniforms.desaturation * strength + gen * 0.06, 0.0, 1.0);

	// ---- Transport: assemble the per-scanline source coordinate ----
	let centeredX = effectTexCoord.x - 0.5;
	let physicalY = (effectTexCoord.y - centeredX * uniforms.tilt) * worldSize.y;
	let line = floor(physicalY);

	var coord = effectTexCoord;

	// Time base error: each scanline starts slightly off-time, so vertical
	// edges wobble line by line (a slow drift plus a fine tremor).
	if (uniforms.lineJitter > 0.0) {
		let drift = noise1D(line * 0.085 + seed * 13.0) - 0.5;
		let tremor = rand(vec2f(line, seed * 41.0)) - 0.5;
		coord.x += (drift * 1.6 + tremor * 0.7) * uniforms.lineJitter * strength * 3.0 * pxX;
	}

	// Field combing: even/odd lines shifted in opposite directions.
	if (uniforms.combing > 0.0) {
		let parity = select(-1.0, 1.0, (line % 2.0) < 1.0);
		coord.x += parity * uniforms.combing * strength * 2.0 * pxX;
	}

	// Vertical jitter. The white-noise term is anchored to 72dpi world px
	// columns so the displacement field stays identical across DPI.
	let verticalDistortEffect = uniforms.verticalJitter * strength;
	if (verticalDistortEffect > 0.0) {
		let xNoise = rand(vec2f(floor(effectTexCoord.x * worldSize.x), seed * 100.0)) * 2.0 - 1.0;
		let timeSeed = seed * 10.0;
		let verticalNoiseA = sin(effectTexCoord.x * 150.0 + timeSeed) * 0.5;
		let verticalNoiseB = sin(effectTexCoord.x * 370.0 + timeSeed * 1.5) * 0.3;
		let verticalNoiseC = noise1D(effectTexCoord.x * 5.0 + timeSeed) * 0.2;
		let offsetWeight = (verticalNoiseA + verticalNoiseB + verticalNoiseC + xNoise) * verticalDistortEffect * 100.0 * pxY;
		coord.y += offsetWeight * (1.0 + abs(centeredX));
	}

	// Head switching: the head changeover tears the bottom lines sideways.
	var headSwitchTear = 0.0;
	if (uniforms.headSwitching > 0.0) {
		let bandLines = max(uniforms.headSwitchingHeight, 1.0);
		let linesFromBottom = worldSize.y - physicalY;
		if (linesFromBottom < bandLines) {
			let bandT = clamp(1.0 - linesFromBottom / bandLines, 0.0, 1.0);
			let lineRand = noise1D(line * 3.7 + seed * 7.0);
			headSwitchTear = bandT * bandT * (0.4 + lineRand * 0.6) * uniforms.headSwitching * strength;
			coord.x += headSwitchTear * 80.0 * pxX;
		}
	}

	// ---- Signal: band-limited luma, delayed and smeared chroma ----
	let centerSample = textureSampleLevel(inputTexture, inputSampler, toSourceUV(coord), 0.0);
	var outAlpha = centerSample.a;

	// Luma: small horizontal blur (limited horizontal resolution)
	let lumaRadius = lumaSoft * 2.5 * pxX;
	var luma = rgbToYiq(centerSample.rgb).x * 0.4;
	luma += lumaAt(coord + vec2f(lumaRadius * 0.5, 0.0)) * 0.15;
	luma += lumaAt(coord - vec2f(lumaRadius * 0.5, 0.0)) * 0.15;
	luma += lumaAt(coord + vec2f(lumaRadius, 0.0)) * 0.15;
	luma += lumaAt(coord - vec2f(lumaRadius, 0.0)) * 0.15;

	// Edge ringing: playback EQ overshoot trailing luma edges.
	if (uniforms.ringing > 0.0) {
		let ringDist = 2.0 * pxX;
		let lumaLeft = lumaAt(coord - vec2f(ringDist, 0.0));
		luma += (luma - lumaLeft) * uniforms.ringing * strength * 0.8;
	}

	// Chroma: delayed to the right (Y/C delay) and smeared over the
	// trailing pixels (low chroma bandwidth).
	let chromaBase = coord - vec2f(uniforms.colorShift * strength * 300.0 * pxX, 0.0);
	let chromaRadius = (1.0 + chromaBleed * 10.0) * pxX;
	var chroma = chromaAt(chromaBase) * 0.35;
	chroma += chromaAt(chromaBase - vec2f(chromaRadius * 0.5, 0.0)) * 0.25;
	chroma += chromaAt(chromaBase - vec2f(chromaRadius, 0.0)) * 0.2;
	chroma += chromaAt(chromaBase - vec2f(chromaRadius * 1.5, 0.0)) * 0.12;
	chroma += chromaAt(chromaBase - vec2f(chromaRadius * 2.0, 0.0)) * 0.08;

	// Chroma noise: coarse, horizontally stretched blotches.
	if (chromaNoiseAmount > 0.0) {
		let cell = vec2f(floor(coord.x * worldSize.x / 14.0), floor(physicalY / 2.0));
		chroma += vec2f(
			rand(cell + vec2f(seed, 0.0)) - 0.5,
			rand(cell * 1.7 + vec2f(0.0, seed)) - 0.5
		) * chromaNoiseAmount * 0.35;
	}

	chroma *= 1.0 - desaturation;

	var rgb = yiqToRgb(vec3f(luma, chroma));

	// The head-switch band carries its own burst of luma noise.
	if (headSwitchTear > 0.0) {
		let grainX = floor(coord.x * worldSize.x);
		rgb += vec3f((rand(vec2f(grainX, line) + vec2f(seed, seed)) - 0.5) * headSwitchTear);
	}

	// ---- Tape wear ----
	// Luma noise + sparkle
	{
		let noiseDistortionEffect = uniforms.noiseDistortion * strength;
		let baseNoiseX = floor(coord.x * worldSize.x);
		let baseNoiseY = floor(coord.y * worldSize.y);
		let distortedX = baseNoiseX + sin(baseNoiseX * 0.003 + seed * 50.0) * noiseDistortionEffect * 10.0;
		let distortedY = baseNoiseY + cos(baseNoiseY * 0.003 + seed * 60.0) * noiseDistortionEffect * 10.0;
		let noise1Val = rand(vec2f(distortedX * 0.1, distortedY * 0.1 + seed * 10.0));
		let noise2Val = rand(vec2f(distortedX * 0.05, distortedY * 0.05 - seed * 20.0));
		let noise3Val = rand(vec2f(distortedX * 0.02, distortedY * 0.02 + seed * 30.0));
		let combinedNoise = (noise1Val * 0.5 + noise2Val * 0.3 + noise3Val * 0.2) * noiseAmount;
		let sparkleThreshold = 0.97 - noiseAmount * 0.1;
		let sparkle = select(0.0, 1.0, noise1Val > sparkleThreshold);
		let adjustedNoise = (vec3f(combinedNoise) - vec3f(0.5)) * noiseAmount + vec3f(sparkle) * noiseAmount;

		rgb += adjustedNoise;

		if (uniforms.applyToTransparent > 0.5 && outAlpha < 0.01) {
			outAlpha = max(outAlpha, length(adjustedNoise) * 0.5);
		}
	}

	// Dropouts: oxide loss knocks out part of a line; the deck papers it
	// over with (roughly) the previous line.
	if (uniforms.dropouts > 0.0) {
		let lineKey = noise1D(line * 1.31 + seed * 99.0);
		if (lineKey < uniforms.dropouts * strength * 0.08) {
			let segStart = rand(vec2f(line, seed * 3.0)) * 0.9;
			let segLength = (0.02 + uniforms.dropoutLength * 0.25) * (0.3 + rand(vec2f(line, seed * 5.0)) * 0.7);
			if (coord.x > segStart && coord.x < segStart + segLength) {
				let previousLine = textureSampleLevel(inputTexture, inputSampler, toSourceUV(coord - vec2f(0.0, pxY)), 0.0);
				rgb = mix(vec3f(0.92), previousLine.rgb, 0.35);
				if (uniforms.applyToTransparent > 0.5) {
					outAlpha = max(outAlpha, 0.9);
				}
			}
		}
	}

	// Brightness flicker per line
	if (uniforms.brightnessJitter > 0.0) {
		let jitter = (rand(vec2f(seed, line * 0.1)) * 2.0 - 1.0) * uniforms.brightnessJitter * strength;
		rgb *= 1.0 + jitter;
	}

	// ---- Display ----
	// Interlace line shading + per-line tracking chroma wobble
	let physicalGap = max(uniforms.interlaceGap, 1.0);
	let isInterlaceLine = (line % (physicalGap * 2.0)) < physicalGap;
	if (isInterlaceLine) {
		rgb *= 1.05;

		if (uniforms.trackingError > 0.0) {
			let trackOffset = noise1D(line * 0.1 + seed) * uniforms.trackingError * strength * 10.0;
			let redSample = textureSampleLevel(inputTexture, inputSampler, toSourceUV(coord + vec2f(trackOffset * 0.015, 0.0)), 0.0);
			let blueSample = textureSampleLevel(inputTexture, inputSampler, toSourceUV(coord - vec2f(trackOffset * 0.010, 0.0)), 0.0);
			let wobble = vec3f(redSample.r, rgb.g, blueSample.b);
			rgb = mix(rgb, wobble, min(1.0, uniforms.trackingError * strength) * 0.7);
			outAlpha = max(outAlpha, max(redSample.a, blueSample.a));
		}
	} else {
		rgb *= 0.95;
	}

	// Scanline darkening
	if (uniforms.scanlines > 0.0) {
		let scanlineIntensity = uniforms.scanlines * strength;
		let scanlineValue = sin(physicalY * physicalGap) * 0.5 + 0.5;
		rgb *= 1.0 - scanlineValue * scanlineIntensity * 0.2;

		if (uniforms.applyToTransparent > 0.5 && outAlpha < 0.01) {
			outAlpha = max(outAlpha, scanlineValue * scanlineIntensity * 0.3);
		}
	}

	// ---- Tone ----
	let lift = uniforms.blackLift * strength * 0.15;
	rgb = vec3f(lift) + rgb * (1.0 - lift);

	if (uniforms.enableVHSColor > 0.5) {
		let castColor = vec3f(uniforms.vhsColorR, uniforms.vhsColorG, uniforms.vhsColorB);
		rgb = mix(rgb, castColor, uniforms.vhsColorA * strength);
	}

	let finalColor = vec4f(clamp(rgb, vec3f(0.0), vec3f(1.0)), outAlpha);
	return select(finalColor, originalColor, skipProcessing);
}
`;
