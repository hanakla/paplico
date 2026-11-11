/**
 * Separable blend mode functions shared by every shader that blends
 * unpremultiplied RGB: the layer/element composite pass and the SVG feBlend
 * filter. `applyBlendMode` indexes modes by BLEND_MODE_ORDER.
 */
export const BLEND_MODE_FUNCTIONS_WGSL = /* wgsl */ `
	fn blendNormal(base: vec3f, blend: vec3f) -> vec3f {
		return blend;
	}

	fn blendMultiply(base: vec3f, blend: vec3f) -> vec3f {
		return base * blend;
	}

	fn blendScreen(base: vec3f, blend: vec3f) -> vec3f {
		return vec3f(1.0) - (vec3f(1.0) - base) * (vec3f(1.0) - blend);
	}

	fn blendOverlayChannel(base: f32, blend: f32) -> f32 {
		if (base < 0.5) {
			return 2.0 * base * blend;
		}
		return 1.0 - 2.0 * (1.0 - base) * (1.0 - blend);
	}

	fn blendOverlay(base: vec3f, blend: vec3f) -> vec3f {
		return vec3f(
			blendOverlayChannel(base.r, blend.r),
			blendOverlayChannel(base.g, blend.g),
			blendOverlayChannel(base.b, blend.b),
		);
	}

	fn blendDarken(base: vec3f, blend: vec3f) -> vec3f {
		return min(base, blend);
	}

	fn blendLighten(base: vec3f, blend: vec3f) -> vec3f {
		return max(base, blend);
	}

	fn blendColorDodgeChannel(base: f32, blend: f32) -> f32 {
		if (blend >= 1.0) {
			return 1.0;
		}
		return min(base / max(1.0 - blend, 0.001), 1.0);
	}

	fn blendColorDodge(base: vec3f, blend: vec3f) -> vec3f {
		return vec3f(
			blendColorDodgeChannel(base.r, blend.r),
			blendColorDodgeChannel(base.g, blend.g),
			blendColorDodgeChannel(base.b, blend.b),
		);
	}

	fn blendColorBurnChannel(base: f32, blend: f32) -> f32 {
		if (blend <= 0.0) {
			return 0.0;
		}
		return max(1.0 - (1.0 - base) / blend, 0.0);
	}

	fn blendColorBurn(base: vec3f, blend: vec3f) -> vec3f {
		return vec3f(
			blendColorBurnChannel(base.r, blend.r),
			blendColorBurnChannel(base.g, blend.g),
			blendColorBurnChannel(base.b, blend.b),
		);
	}

	fn blendHardLight(base: vec3f, blend: vec3f) -> vec3f {
		return blendOverlay(blend, base);
	}

	fn blendSoftLightChannel(base: f32, blend: f32) -> f32 {
		if (blend < 0.5) {
			return base - (1.0 - 2.0 * blend) * base * (1.0 - base);
		}
		let d = select(
			sqrt(base),
			((16.0 * base - 12.0) * base + 4.0) * base,
			base <= 0.25,
		);
		return base + (2.0 * blend - 1.0) * (d - base);
	}

	fn blendSoftLight(base: vec3f, blend: vec3f) -> vec3f {
		return vec3f(
			blendSoftLightChannel(base.r, blend.r),
			blendSoftLightChannel(base.g, blend.g),
			blendSoftLightChannel(base.b, blend.b),
		);
	}

	fn blendDifference(base: vec3f, blend: vec3f) -> vec3f {
		return abs(base - blend);
	}

	fn blendExclusion(base: vec3f, blend: vec3f) -> vec3f {
		return base + blend - 2.0 * base * blend;
	}

	fn applyBlendMode(base: vec3f, blend: vec3f, blendMode: u32) -> vec3f {
		switch blendMode {
			case 0u: {
				return blendNormal(base, blend);
			}
			case 1u: {
				return blendMultiply(base, blend);
			}
			case 2u: {
				return blendScreen(base, blend);
			}
			case 3u: {
				return blendOverlay(base, blend);
			}
			case 4u: {
				return blendDarken(base, blend);
			}
			case 5u: {
				return blendLighten(base, blend);
			}
			case 6u: {
				return blendColorDodge(base, blend);
			}
			case 7u: {
				return blendColorBurn(base, blend);
			}
			case 8u: {
				return blendHardLight(base, blend);
			}
			case 9u: {
				return blendSoftLight(base, blend);
			}
			case 10u: {
				return blendDifference(base, blend);
			}
			case 11u: {
				return blendExclusion(base, blend);
			}
			default: {
				return blendNormal(base, blend);
			}
		}
	}
	`;
