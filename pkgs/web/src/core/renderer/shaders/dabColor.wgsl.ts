/**
 * Shared per-dab color resolution (design §10). The dab fragment shader and
 * the mix pass's chunk scan must agree on what color a dab carries, so the
 * PathMeta layout, the gradient stop sampling and the gradient-mode switch
 * live here once and both include them.
 *
 * Requires ahead of it: the DabInstance struct, GRADIENT_COMMON_WGSL
 * (ColorStop + remapGradientT + OkLab conversion), STROKE_WIDTH_COMMON_WGSL,
 * and a `colorStops: array<ColorStop>` binding.
 */
/** Float count of the PathMeta struct below; CPU writers stride by this. */
export const PATH_META_FLOATS = 20;

export function buildDabColorWgsl(stampMetaIndexMask: number): string {
	return /* wgsl */ `
struct PathMeta {
	colorR: f32,
	colorG: f32,
	colorB: f32,
	colorA: f32,
	gradientMode: u32,
	stopCount: u32,
	stopOffset: u32,
	transformIndex: u32,
	linearStart: vec2f,
	linearEnd: vec2f,
	boundsMin: vec2f,
	boundsMax: vec2f,
	/** 0 = no grain, 1 = multiply, 2 = subtract. */
	grainMode: u32,
	/** Grain UV period in world units. */
	grainScale: f32,
	/** Per-stroke UV offset, in grain periods. */
	grainOffset: vec2f,
}

fn pathIndexOf(dab: DabInstance) -> u32 {
	return dab.packedMeta & ${stampMetaIndexMask}u;
}

// OKLab perceptual gradient stop sampling — the ONE copy for dab rendering.
fn sampleGradientStops(t: f32, pm: PathMeta) -> vec4f {
	let ct = clamp(t, 0.0, 1.0);
	let count = pm.stopCount;
	let baseOffset = pm.stopOffset;

	if count == 0u {
		return vec4f(0.0, 0.0, 0.0, 1.0);
	}
	if count == 1u {
		let s = colorStops[baseOffset];
		return vec4f(s.r, s.g, s.b, s.a);
	}

	if ct <= colorStops[baseOffset].offset {
		let s = colorStops[baseOffset];
		return vec4f(s.r, s.g, s.b, s.a);
	}

	let lastIdx = count - 1u;
	if ct >= colorStops[baseOffset + lastIdx].offset {
		let s = colorStops[baseOffset + lastIdx];
		return vec4f(s.r, s.g, s.b, s.a);
	}

	for (var i = 0u; i < lastIdx; i = i + 1u) {
		let s0 = colorStops[baseOffset + i];
		let s1 = colorStops[baseOffset + i + 1u];
		if ct >= s0.offset && ct <= s1.offset {
			let range = s1.offset - s0.offset;
			var f = 0.0;
			if range > 0.0 {
				f = remapGradientT((ct - s0.offset) / range, s0.midpoint);
			}
			let lab0 = srgbToOklab(vec3f(s0.r, s0.g, s0.b));
			let lab1 = srgbToOklab(vec3f(s1.r, s1.g, s1.b));
			let rgb = oklabToSrgb(mix(lab0, lab1, f));
			return vec4f(rgb, mix(s0.a, s1.a, f));
		}
	}

	let s = colorStops[baseOffset + lastIdx];
	return vec4f(s.r, s.g, s.b, s.a);
}

fn rgbToHsv(c: vec3f) -> vec3f {
	let maxC = max(c.r, max(c.g, c.b));
	let minC = min(c.r, min(c.g, c.b));
	let delta = maxC - minC;
	var hue = 0.0;
	if delta > 1e-6 {
		if maxC == c.r {
			hue = ((c.g - c.b) / delta) % 6.0;
		} else if maxC == c.g {
			hue = (c.b - c.r) / delta + 2.0;
		} else {
			hue = (c.r - c.g) / delta + 4.0;
		}
		hue = hue / 6.0;
		if hue < 0.0 {
			hue = hue + 1.0;
		}
	}
	let sat = select(0.0, delta / maxC, maxC > 1e-6);
	return vec3f(hue, sat, maxC);
}

fn hsvToRgb(hsv: vec3f) -> vec3f {
	let h = fract(hsv.x) * 6.0;
	let c = hsv.z * hsv.y;
	let x = c * (1.0 - abs(h % 2.0 - 1.0));
	let m = hsv.z - c;
	var rgb = vec3f(0.0);
	if h < 1.0 { rgb = vec3f(c, x, 0.0); }
	else if h < 2.0 { rgb = vec3f(x, c, 0.0); }
	else if h < 3.0 { rgb = vec3f(0.0, c, x); }
	else if h < 4.0 { rgb = vec3f(0.0, x, c); }
	else if h < 5.0 { rgb = vec3f(x, 0.0, c); }
	else { rgb = vec3f(c, 0.0, x); }
	return rgb + vec3f(m);
}

/** Per-dab color dynamics: hue rotates, saturation and value offset. */
fn applyDabColorShift(dab: DabInstance, rgb: vec3f) -> vec3f {
	let packed0 = unpack2x16snorm(bitcast<u32>(dab.packedColorShift0));
	let hueShift = packed0.x;
	let satShift = packed0.y;
	let valShift = unpack2x16snorm(bitcast<u32>(dab.packedColorShift1)).x;
	if abs(hueShift) < 1e-4 && abs(satShift) < 1e-4 && abs(valShift) < 1e-4 {
		return rgb;
	}
	let hsv = rgbToHsv(clamp(rgb, vec3f(0.0), vec3f(1.0)));
	return hsvToRgb(vec3f(
		hsv.x + hueShift,
		clamp(hsv.y + satShift, 0.0, 1.0),
		clamp(hsv.z + valShift, 0.0, 1.0),
	));
}

/**
 * The dab's straight-alpha color for the given sampling position.
 *
 * Gradient resolution plus the dab's own color dynamics offsets.
 *
 * \`worldPos\` is the transformed dab center (constant per dab, so the "within
 * bounds" gradient is a per-dab value too) and \`acrossDistance\` is the
 * signed normalized distance across the stroke width — the only genuinely
 * per-fragment input. The mix pass passes 0 for it, which resolves the
 * across-width gradient at the width's center: mixing owns one color per dab
 * and cannot carry a gradient inside a single dab.
 */
fn resolveDabColor(
	dab: DabInstance,
	pm: PathMeta,
	worldPos: vec2f,
	pathT: f32,
	acrossDistance: f32,
) -> vec4f {
	let base = resolveDabBaseColor(pm, worldPos, pathT, acrossDistance);
	return vec4f(applyDabColorShift(dab, base.rgb), base.a);
}

fn resolveDabBaseColor(
	pm: PathMeta,
	worldPos: vec2f,
	pathT: f32,
	acrossDistance: f32,
) -> vec4f {
	switch pm.gradientMode & 0xFFFFu {
		// Solid color
		case 0u: {
			return vec4f(pm.colorR, pm.colorG, pm.colorB, pm.colorA);
		}
		// Within: bbox-based linear gradient
		case 1u: {
			let boundsSize = pm.boundsMax - pm.boundsMin;
			let uv = (worldPos - pm.boundsMin) / boundsSize;
			let dir = pm.linearEnd - pm.linearStart;
			let lenSq = dot(dir, dir);
			var t = 0.0;
			if lenSq > 0.0 {
				t = dot(uv - pm.linearStart, dir) / lenSq;
			}
			return sampleGradientStops(t, pm);
		}
		// Along the path
		case 2u: {
			return sampleGradientStops(pathT, pm);
		}
		// Across the stroke width
		case 3u: {
			return sampleGradientStops(strokeWidthAcrossUV(acrossDistance), pm);
		}
		default: {
			return vec4f(0.0, 0.0, 0.0, 1.0);
		}
	}
}
`;
}
