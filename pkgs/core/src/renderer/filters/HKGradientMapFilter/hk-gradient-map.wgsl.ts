export const HK_GRADIENT_MAP_SHADER = /* wgsl */ `
struct Uniforms {
	resolution: vec2f,
	dpiScale: f32,
	preset: i32,
	strength: f32,
	stopCount: i32,
	stops: array<vec4f, 16>,
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

fn getLuminance(color: vec3f) -> f32 {
	return dot(color, vec3f(0.2126, 0.7152, 0.0722));
}

// Preset 0: blackAndWhite - 2 stops
fn gradientBlackAndWhite(lum: f32) -> vec4f {
	return vec4f(vec3f(lum), 1.0);
}

// Preset 1: sepia - 2 stops
fn gradientSepia(lum: f32) -> vec4f {
	let dark = vec3f(0.2, 0.05, 0.0);
	let light = vec3f(1.0, 0.9, 0.7);
	return vec4f(mix(dark, light, lum), 1.0);
}

// Preset 2: duotone - 2 stops
fn gradientDuotone(lum: f32) -> vec4f {
	let dark = vec3f(0.05, 0.2, 0.6);
	let light = vec3f(1.0, 0.8, 0.2);
	return vec4f(mix(dark, light, lum), 1.0);
}

// Preset 3: rainbow - 6 stops at positions 0.0, 0.2, 0.4, 0.6, 0.8, 1.0
fn gradientRainbow(lum: f32) -> vec4f {
	let c0 = vec3f(1.0, 0.0, 0.0); // red @ 0.0
	let c1 = vec3f(1.0, 1.0, 0.0); // yellow @ 0.2
	let c2 = vec3f(0.0, 1.0, 0.0); // green @ 0.4
	let c3 = vec3f(0.0, 1.0, 1.0); // cyan @ 0.6
	let c4 = vec3f(0.0, 0.0, 1.0); // blue @ 0.8
	let c5 = vec3f(1.0, 0.0, 1.0); // magenta @ 1.0

	var result = c0;
	if (lum < 0.2) {
		result = mix(c0, c1, lum / 0.2);
	} else if (lum < 0.4) {
		result = mix(c1, c2, (lum - 0.2) / 0.2);
	} else if (lum < 0.6) {
		result = mix(c2, c3, (lum - 0.4) / 0.2);
	} else if (lum < 0.8) {
		result = mix(c3, c4, (lum - 0.6) / 0.2);
	} else {
		result = mix(c4, c5, (lum - 0.8) / 0.2);
	}

	return vec4f(result, 1.0);
}

// Preset 4: custom - piecewise linear between user stops (xyz=rgb, w=offset, sorted by offset)
fn gradientCustom(lum: f32) -> vec4f {
	let count = uniforms.stopCount;
	if (lum <= uniforms.stops[0].w) {
		return vec4f(uniforms.stops[0].xyz, 1.0);
	}
	for (var i = 1; i < count; i++) {
		let prev = uniforms.stops[i - 1];
		let curr = uniforms.stops[i];
		if (lum <= curr.w) {
			let t = (lum - prev.w) / max(curr.w - prev.w, 1e-5);
			return vec4f(mix(prev.xyz, curr.xyz, t), 1.0);
		}
	}
	return vec4f(uniforms.stops[count - 1].xyz, 1.0);
}

fn getGradientColor(luminance: f32) -> vec4f {
	let lum = clamp(luminance, 0.0, 1.0);

	switch uniforms.preset {
		case 0: { return gradientBlackAndWhite(lum); }
		case 1: { return gradientSepia(lum); }
		case 2: { return gradientDuotone(lum); }
		case 3: { return gradientRainbow(lum); }
		case 4: { return gradientCustom(lum); }
		default: { return gradientBlackAndWhite(lum); }
	}
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
	let texCoord = input.texCoord;
	let originalColor = textureSample(inputTexture, inputSampler, texCoord);

	if (originalColor.a < 0.001) {
		return originalColor;
	}

	let luminance = getLuminance(originalColor.rgb);
	let gradientColor = getGradientColor(luminance);

	let mixStrength = uniforms.strength;

	var finalColor = originalColor;
	if (mixStrength >= 1.0) {
		finalColor = vec4f(gradientColor.rgb, originalColor.a);
	} else if (mixStrength <= 0.0) {
		// No effect
	} else {
		finalColor = vec4f(
			mix(originalColor.rgb, gradientColor.rgb, mixStrength),
			originalColor.a,
		);
	}

	return finalColor;
}
`;
