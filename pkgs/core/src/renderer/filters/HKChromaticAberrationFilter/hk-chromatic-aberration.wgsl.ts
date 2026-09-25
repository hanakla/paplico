export const HK_CHROMATIC_ABERRATION_SHADER = /* wgsl */ `
struct Uniforms {
	resolution: vec2f,
	dpiScale: f32,
	strength: f32,
	angle: f32,
	colorMode: f32,
	opacity: f32,
	blendMode: f32,
	useFocusPoint: f32,
	focusPointX: f32,
	focusPointY: f32,
	focusGradient: f32,
	shiftType: f32,
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

// Screen-space angle (0° = right, CCW-positive) to a UV-space direction
// (texture Y points down).
fn getOffset(angle: f32) -> vec2f {
	let radians = angle * 3.14159 / 180.0;
	return vec2f(cos(radians), -sin(radians));
}

fn screenBlend(a: f32, b: f32) -> f32 {
	return 1.0 - (1.0 - a) * (1.0 - b);
}

fn unpremultiply(color: vec4f) -> vec3f {
	if (color.a > 0.001) {
		return color.rgb / color.a;
	}
	return color.rgb;
}

const DEG120: f32 = 2.0943951;
const DEG240: f32 = 4.1887902;

// Rotate a UV-space offset screen-CCW in texel space (texture Y points
// down), so channel separation angles stay true on non-square textures.
fn rotateOffset(offset: vec2f, dims: vec2f, radians: f32) -> vec2f {
	let px = offset * dims;
	let c = cos(radians);
	let s = sin(radians);
	return vec2f(px.x * c + px.y * s, -px.x * s + px.y * c) / dims;
}

fn calculateDistanceBasedOffset(texCoord: vec2f, focusPoint: vec2f, baseOffset: vec2f, gradient: f32) -> vec2f {
	let dist = length(texCoord - focusPoint);
	let adjustedDistance = pow(dist, gradient);
	return baseOffset * adjustedDistance;
}

fn calculateZoomOffset(texCoord: vec2f, focusPoint: vec2f, strengthPixels: f32, dims: vec2f) -> vec2f {
	let direction = texCoord - focusPoint;
	return vec2f(
		direction.x * (strengthPixels / dims.x),
		direction.y * (strengthPixels / dims.y)
	);
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
	let dims = uniforms.resolution;
	let texCoord = input.texCoord;

	let dpiScale = uniforms.dpiScale;

	let basePixelOffset = getOffset(uniforms.angle) * uniforms.strength * dpiScale;
	let baseTexOffset = basePixelOffset / dims;

	let focusPoint = select(
		vec2f(0.5, 0.5),
		vec2f(uniforms.focusPointX, uniforms.focusPointY),
		uniforms.useFocusPoint > 0.5
	);

	// texOffset is the first channel's on-screen displacement in UV units;
	// each channel samples at texCoord - (its per-channel displacement).
	var texOffset: vec2f;
	if (uniforms.shiftType < 0.5) {
		// move mode
		if (uniforms.useFocusPoint > 0.5) {
			texOffset = calculateDistanceBasedOffset(texCoord, focusPoint, baseTexOffset, uniforms.focusGradient);
		} else {
			texOffset = baseTexOffset;
		}
	} else {
		// zoom mode
		let zoomOffset = calculateZoomOffset(texCoord, focusPoint, uniforms.strength * dpiScale, dims);

		let angleRad = uniforms.angle * 3.14159 / 180.0;
		texOffset = rotateOffset(zoomOffset, dims, angleRad);

		if (uniforms.useFocusPoint > 0.5) {
			let dist = length(texCoord - focusPoint);
			let adjustedDistance = pow(dist, uniforms.focusGradient);
			texOffset = texOffset * adjustedDistance;
		}
	}

	// Second/third channel displacements: move mode splits directions evenly
	// (120 degrees apart); zoom mode splits zoom factors evenly (+1 / 0 / -1)
	// instead — rotating the radial vector would swirl, not zoom.
	var disp2: vec2f;
	var disp3: vec2f;
	if (uniforms.shiftType < 0.5) {
		disp2 = rotateOffset(texOffset, dims, DEG120);
		disp3 = rotateOffset(texOffset, dims, DEG240);
	} else {
		disp2 = vec2f(0.0, 0.0);
		disp3 = -texOffset;
	}

	let opacityFactor = uniforms.opacity;

	var effectColor: vec4f;
	let originalColor = textureSample(inputTexture, inputSampler, texCoord);

	let colorModeInt = i32(uniforms.colorMode + 0.5);

	if (colorModeInt == 0) {
		// RGB mode
		let redOffset = texCoord - texOffset;
		let greenOffset = texCoord - disp2;
		let blueOffset = texCoord - disp3;

		let rs = textureSample(inputTexture, inputSampler, redOffset);
		let gs = textureSample(inputTexture, inputSampler, greenOffset);
		let bs = textureSample(inputTexture, inputSampler, blueOffset);

		// Premultiplied channel split: each channel keeps its own sample's
		// alpha weight. Average coverage keeps fringes translucent; channel
		// values may exceed alpha and composite additively.
		let a = (rs.a + gs.a + bs.a) / 3.0;

		effectColor = vec4f(rs.r, gs.g, bs.b, a);
	} else if (colorModeInt == 1) {
		// CMYK mode
		let cyanOffset = texCoord - texOffset;
		let magentaOffset = texCoord - disp2;
		let yellowOffset = texCoord - disp3;

		let cs = textureSample(inputTexture, inputSampler, cyanOffset);
		let ms = textureSample(inputTexture, inputSampler, magentaOffset);
		let ys = textureSample(inputTexture, inputSampler, yellowOffset);

		// Channel scaling and max-combination assume straight alpha.
		let c = unpremultiply(cs);
		let m = unpremultiply(ms);
		let y = unpremultiply(ys);

		let cyanColor = vec3f(c.r * 0.3, c.g * 1.0, c.b * 1.0);
		let magentaColor = vec3f(m.r * 1.0, m.g * 0.3, m.b * 1.0);
		let yellowColor = vec3f(y.r * 1.0, y.g * 1.0, y.b * 0.3);

		let combinedColor = vec3f(
			max(max(cyanColor.r, magentaColor.r), yellowColor.r),
			max(max(cyanColor.g, magentaColor.g), yellowColor.g),
			max(max(cyanColor.b, magentaColor.b), yellowColor.b)
		);

		// Opacity is applied once in the final blend below.
		let a = screenBlend(screenBlend(cs.a, ms.a), ys.a);

		let blendRatio = clamp(uniforms.strength, 0.0, 1.0);
		let result = mix(unpremultiply(originalColor), combinedColor, blendRatio);

		effectColor = vec4f(result * a, a);
	} else if (colorModeInt == 2) {
		// Pastel mode
		let ch1Offset = texCoord - texOffset;
		let ch2Offset = texCoord - disp2;
		let ch3Offset = texCoord - disp3;

		let ch1s = textureSample(inputTexture, inputSampler, ch1Offset);
		let ch2s = textureSample(inputTexture, inputSampler, ch2Offset);
		let ch3s = textureSample(inputTexture, inputSampler, ch3Offset);

		// Coefficient mixing assumes straight alpha.
		let s1 = unpremultiply(ch1s);
		let s2 = unpremultiply(ch2s);
		let s3 = unpremultiply(ch3s);

		let ch1 = vec3f(s1.r * 0.56, s1.g * 0.29, s1.b * 0.42);
		let ch2 = vec3f(s2.r * 0.0, s2.g * 0.28, s2.b * 0.45);
		let ch3 = vec3f(s3.r * 0.44, s3.g * 0.43, s3.b * 0.13);

		let combinedColor = ch1 + ch2 + ch3;

		// Opacity is applied once in the final blend below.
		let a = screenBlend(screenBlend(ch1s.a, ch2s.a), ch3s.a);

		let blendRatio = clamp(uniforms.strength, 0.0, 1.0);
		let result = mix(unpremultiply(originalColor), combinedColor, blendRatio);

		effectColor = vec4f(result * a, a);
	} else {
		// Red & Cyan mode: two components split evenly, 180 degrees apart.
		let redOffset = texCoord - texOffset;
		let cyanOffset = texCoord + texOffset;

		let rs = textureSample(inputTexture, inputSampler, redOffset);
		let gs = textureSample(inputTexture, inputSampler, cyanOffset);
		let bs = textureSample(inputTexture, inputSampler, cyanOffset);

		// Same premultiplied channel split as RGB mode.
		let a = (rs.a + gs.a + bs.a) / 3.0;

		effectColor = vec4f(rs.r, gs.g, bs.b, a);
	}

	var finalColor: vec4f;

	if (opacityFactor <= 0.0) {
		finalColor = originalColor;
	} else {
		let blendedRgb = mix(originalColor.rgb, effectColor.rgb, opacityFactor);

		let alphaDifference = effectColor.a - originalColor.a;
		let adjustedAlpha = originalColor.a + alphaDifference * opacityFactor;

		finalColor = vec4f(blendedRgb, adjustedAlpha);
	}

	return finalColor;
}
`;
