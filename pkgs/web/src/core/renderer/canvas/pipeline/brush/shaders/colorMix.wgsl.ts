/**
 * Shared WGSL pigment-mixing helpers: the vivid (OkLCH, chroma-preserving)
 * and muted (OkLAB, straight-line) interpolation pair used by the wet-ink
 * seed pass and the brush mix pass. Interpolate between the two with a 0..1
 * blend-style factor.
 *
 * Requires GRADIENT_COMMON_WGSL ahead of it — the sRGB<->OkLab conversions
 * live there.
 */
export const COLOR_MIX_WGSL = /* wgsl */ `
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
