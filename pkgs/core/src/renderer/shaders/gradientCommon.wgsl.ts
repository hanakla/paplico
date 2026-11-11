/**
 * Gradient Common WGSL - OKLab色空間変換とColorStop構造体
 *
 * gradientFill.wgsl.ts と brushDab.wgsl.ts で共有する
 * OKLab perceptual色空間の変換関数群。
 *
 * WGSLにはinclude機構がないため、TypeScript文字列テンプレートとして
 * 各シェーダーに結合して使用する。
 */

export const GRADIENT_COMMON_WGSL = /* wgsl */ `
struct ColorStop {
	offset: f32,
	r: f32,
	g: f32,
	b: f32,
	a: f32,
	midpoint: f32,
}

// Photoshop-style piecewise-linear midpoint remap. fRaw is the raw linear
// position within a stop segment (0-1); midpoint biases where the visual
// 50% point falls. Clamp guards both halves against a degenerate midpoint
// sitting on 0 or 1 (zero-width half-segment).
fn remapGradientT(fRaw: f32, midpoint: f32) -> f32 {
	let mp = clamp(midpoint, 0.0001, 0.9999);
	if fRaw < mp {
		return 0.5 * fRaw / mp;
	}
	return 0.5 + 0.5 * (fRaw - mp) / (1.0 - mp);
}

// --- sRGB ↔ OKLab color space conversion ---

fn srgbToLinear(c: f32) -> f32 {
	if c <= 0.04045 {
		return c / 12.92;
	}
	return pow((c + 0.055) / 1.055, 2.4);
}

fn linearToSrgb(c: f32) -> f32 {
	if c <= 0.0031308 {
		return c * 12.92;
	}
	return 1.055 * pow(c, 1.0 / 2.4) - 0.055;
}

fn srgbToOklab(c: vec3f) -> vec3f {
	let r = srgbToLinear(c.x);
	let g = srgbToLinear(c.y);
	let b = srgbToLinear(c.z);
	let l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
	let m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
	let s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
	let l_ = pow(max(l, 0.0), 1.0 / 3.0);
	let m_ = pow(max(m, 0.0), 1.0 / 3.0);
	let s_ = pow(max(s, 0.0), 1.0 / 3.0);
	return vec3f(
		0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
		1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
		0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
	);
}

fn oklabToSrgb(lab: vec3f) -> vec3f {
	let l_ = lab.x + 0.3963377774 * lab.y + 0.2158037573 * lab.z;
	let m_ = lab.x - 0.1055613458 * lab.y - 0.0638541728 * lab.z;
	let s_ = lab.x - 0.0894841775 * lab.y - 1.2914855480 * lab.z;
	let l = l_ * l_ * l_;
	let m = m_ * m_ * m_;
	let s = s_ * s_ * s_;
	let r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
	let g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
	let b = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
	return vec3f(
		linearToSrgb(clamp(r, 0.0, 1.0)),
		linearToSrgb(clamp(g, 0.0, 1.0)),
		linearToSrgb(clamp(b, 0.0, 1.0)),
	);
}
`;
