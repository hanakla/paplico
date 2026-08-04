/**
 * Shared WGSL color-mixing helpers: sRGB<->OkLab/OkLCH conversion and the
 * vivid (OkLCH, chroma-preserving) / muted (OkLAB, straight-line) pigment
 * interpolation pair used by the wet-ink seed pass and the brush mix pass.
 * Interpolate between the two with a 0..1 blend-style factor.
 */
export const COLOR_MIX_WGSL = /* wgsl */ `
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
	let rgb = clamp(c, vec3f(0.0), vec3f(1.0));
	let r = srgbToLinear(rgb.x);
	let g = srgbToLinear(rgb.y);
	let b = srgbToLinear(rgb.z);
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

fn srgbToOklch(rgb: vec3f) -> vec3f {
	let lab = srgbToOklab(rgb);
	return vec3f(lab.x, sqrt(lab.y * lab.y + lab.z * lab.z), atan2(lab.z, lab.y));
}

fn oklchToSrgb(lch: vec3f) -> vec3f {
	return oklabToSrgb(vec3f(lch.x, cos(lch.z) * lch.y, sin(lch.z) * lch.y));
}

fn mixOklchHue(a: vec3f, b: vec3f, t: f32) -> f32 {
	const PI: f32 = 3.141592653589793;
	const TAU: f32 = 6.283185307179586;
	var fromHue = a.z;
	var toHue = b.z;
	if a.y < 0.0001 {
		fromHue = toHue;
	}
	if b.y < 0.0001 {
		toHue = fromHue;
	}
	var delta = toHue - fromHue;
	if delta > PI {
		delta -= TAU;
	}
	if delta < -PI {
		delta += TAU;
	}
	return fromHue + delta * t;
}

fn mixOklchPigmentColor(a: vec3f, b: vec3f, t: f32) -> vec3f {
	let labA = srgbToOklab(a);
	let labB = srgbToOklab(b);
	let labMixed = mix(labA, labB, t);
	let chromaA = sqrt(labA.y * labA.y + labA.z * labA.z);
	let chromaB = sqrt(labB.y * labB.y + labB.z * labB.z);
	let targetChroma = mix(chromaA, chromaB, t);
	let mixedChroma = sqrt(labMixed.y * labMixed.y + labMixed.z * labMixed.z);
	let rawScale = targetChroma / max(mixedChroma, 1e-5);
	let chromaBlend = smoothstep(0.0, 0.015, mixedChroma);
	let scale = mix(1.0, min(rawScale, 4.0), chromaBlend);
	return oklabToSrgb(vec3f(labMixed.x, labMixed.y * scale, labMixed.z * scale));
}

fn mixOklabPigmentColor(a: vec3f, b: vec3f, t: f32) -> vec3f {
	let labA = srgbToOklab(a);
	let labB = srgbToOklab(b);
	return oklabToSrgb(mix(labA, labB, t));
}
`;
