/**
 * Shared WGSL helper functions for Hanakla Kit filters.
 * Provides Oklab and Oklch color space mixing utilities.
 */

/** Oklab color space mixing functions (drop-in replacement for mix() on RGB colors) */
export function includeOklabMix(): string {
	return /* wgsl */ `
	fn mixOklab(rgbColor1: vec3<f32>, rgbColor2: vec3<f32>, t: f32) -> vec3<f32> {
		let linearColor1 = vec3<f32>(
			select(rgbColor1.r / 12.92, pow((rgbColor1.r + 0.055) / 1.055, 2.4), rgbColor1.r <= 0.04045),
			select(rgbColor1.g / 12.92, pow((rgbColor1.g + 0.055) / 1.055, 2.4), rgbColor1.g <= 0.04045),
			select(rgbColor1.b / 12.92, pow((rgbColor1.b + 0.055) / 1.055, 2.4), rgbColor1.b <= 0.04045),
		);

		let linearColor2 = vec3<f32>(
			select(rgbColor2.r / 12.92, pow((rgbColor2.r + 0.055) / 1.055, 2.4), rgbColor2.r <= 0.04045),
			select(rgbColor2.g / 12.92, pow((rgbColor2.g + 0.055) / 1.055, 2.4), rgbColor2.g <= 0.04045),
			select(rgbColor2.b / 12.92, pow((rgbColor2.b + 0.055) / 1.055, 2.4), rgbColor2.b <= 0.04045),
		);

		let lms1 = mat3x3<f32>(
			0.4122214708, 0.5363325363, 0.0514459929,
			0.2119034982, 0.6806995451, 0.1073969566,
			0.0883024619, 0.2817188376, 0.6299787005
		) * linearColor1;

		let lms2 = mat3x3<f32>(
			0.4122214708, 0.5363325363, 0.0514459929,
			0.2119034982, 0.6806995451, 0.1073969566,
			0.0883024619, 0.2817188376, 0.6299787005
		) * linearColor2;

		let lms1_pow = vec3<f32>(pow(lms1.x, 1.0/3.0), pow(lms1.y, 1.0/3.0), pow(lms1.z, 1.0/3.0));
		let lms2_pow = vec3<f32>(pow(lms2.x, 1.0/3.0), pow(lms2.y, 1.0/3.0), pow(lms2.z, 1.0/3.0));

		let oklabMatrix = mat3x3<f32>(
			0.2104542553, 0.7936177850, -0.0040720468,
			1.9779984951, -2.4285922050, 0.4505937099,
			0.0259040371, 0.7827717662, -0.8086757660
		);

		let oklab1 = oklabMatrix * lms1_pow;
		let oklab2 = oklabMatrix * lms2_pow;

		let oklab_mixed = mix(oklab1, oklab2, t);

		let oklabInverseMatrix = mat3x3<f32>(
			1.0, 0.3963377774, 0.2158037573,
			1.0, -0.1055613458, -0.0638541728,
			1.0, -0.0894841775, -1.2914855480
		);

		let lms_pow = oklabInverseMatrix * oklab_mixed;
		let lms = vec3<f32>(
			pow(lms_pow.x, 3.0),
			pow(lms_pow.y, 3.0),
			pow(lms_pow.z, 3.0)
		);

		let lmsToRgbMatrix = mat3x3<f32>(
			4.0767416621, -3.3077115913, 0.2309699292,
			-1.2684380046, 2.6097574011, -0.3413193965,
			-0.0041960863, -0.7034186147, 1.7076147010
		);

		let linearRgb = lmsToRgbMatrix * lms;

		let rgbResult = vec3<f32>(
			select(linearRgb.r * 12.92, 1.055 * pow(linearRgb.r, 1.0/2.4) - 0.055, linearRgb.r <= 0.0031308),
			select(linearRgb.g * 12.92, 1.055 * pow(linearRgb.g, 1.0/2.4) - 0.055, linearRgb.g <= 0.0031308),
			select(linearRgb.b * 12.92, 1.055 * pow(linearRgb.b, 1.0/2.4) - 0.055, linearRgb.b <= 0.0031308)
		);

		return clamp(rgbResult, vec3<f32>(0.0), vec3<f32>(1.0));
	}

	fn mixOklabVec4(rgbColor1: vec4<f32>, rgbColor2: vec4<f32>, t: f32) -> vec4<f32> {
		return vec4<f32>(
			mixOklab(rgbColor1.rgb, rgbColor2.rgb, t),
			mix(rgbColor1.a, rgbColor2.a, t)
		);
	}
`;
}
