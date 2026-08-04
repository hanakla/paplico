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

/**
 * The dab's straight-alpha color for the given sampling position.
 *
 * \`worldPos\` is the transformed dab center (constant per dab, so the "within
 * bounds" gradient is a per-dab value too) and \`acrossDistance\` is the
 * signed normalized distance across the stroke width — the only genuinely
 * per-fragment input. The mix pass passes 0 for it, which resolves the
 * across-width gradient at the width's center: mixing owns one color per dab
 * and cannot carry a gradient inside a single dab.
 */
fn resolveDabColor(
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
