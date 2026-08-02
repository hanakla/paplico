/**
 * Composite Shader - Blend source texture over destination texture with custom blend modes.
 * Used only for non-normal blend mode rendering.
 */

export const COMPOSITE_SHADER = /* wgsl */ `
	struct Uniforms {
		viewportX: f32,
		viewportY: f32,
		zoom: f32,
		canvasWidth: f32,
		canvasHeight: f32,
		rotSin: f32,
		rotCos: f32,
	}

	struct CompositeUniforms {
		boundsMinX: f32,
		boundsMinY: f32,
		boundsMaxX: f32,
		boundsMaxY: f32,
		blendMode: u32,
		compositionMode: u32,
		opacity: f32,
		uvScaleX: f32,
		uvScaleY: f32,
	}

	@group(0) @binding(0) var<uniform> uniforms: Uniforms;
	@group(1) @binding(0) var<uniform> compositeUniforms: CompositeUniforms;
	@group(1) @binding(1) var texSampler: sampler;
	@group(1) @binding(2) var sourceTexture: texture_2d<f32>;
	@group(1) @binding(3) var destTexture: texture_2d<f32>;
	@group(1) @binding(4) var baseTexture: texture_2d<f32>;

	struct VertexOutput {
		@builtin(position) position: vec4f,
		@location(0) srcTexCoord: vec2f,
	}

	fn unpremultiply(color: vec4f) -> vec3f {
		let a = max(color.a, 0.001);
		return color.rgb / a;
	}

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

	@vertex
	fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
		var output: VertexOutput;

		var positions = array<vec2f, 6>(
			vec2f(-1.0, -1.0),
			vec2f(1.0, -1.0),
			vec2f(-1.0, 1.0),
			vec2f(-1.0, 1.0),
			vec2f(1.0, -1.0),
			vec2f(1.0, 1.0),
		);

		var texCoords = array<vec2f, 6>(
			vec2f(0.0, 1.0),
			vec2f(1.0, 1.0),
			vec2f(0.0, 0.0),
			vec2f(0.0, 0.0),
			vec2f(1.0, 1.0),
			vec2f(1.0, 0.0),
		);

		let quadPos = positions[vertexIndex];
		let rawTexCoord = texCoords[vertexIndex];
		// When pool quantises textures larger than requested, the rendered
		// content occupies a centred sub-region.  uvScale < 1 crops margin.
		let uvScale = vec2f(compositeUniforms.uvScaleX, compositeUniforms.uvScaleY);
		let srcTexCoord = vec2f(0.5) + (rawTexCoord - vec2f(0.5)) * uvScale;

		let worldX = mix(
			compositeUniforms.boundsMinX,
			compositeUniforms.boundsMaxX,
			(quadPos.x + 1.0) * 0.5,
		);
		let worldY = mix(
			compositeUniforms.boundsMinY,
			compositeUniforms.boundsMaxY,
			(quadPos.y + 1.0) * 0.5,
		);

		let x = (worldX - uniforms.viewportX) * uniforms.zoom;
		let y = (worldY - uniforms.viewportY) * uniforms.zoom;
		let rotX = x * uniforms.rotCos - y * uniforms.rotSin;
		let rotY = x * uniforms.rotSin + y * uniforms.rotCos;

		let ndcX = rotX / (uniforms.canvasWidth * 0.5);
		let ndcY = rotY / (uniforms.canvasHeight * 0.5);

		output.position = vec4f(ndcX, ndcY, 0.0, 1.0);
		output.srcTexCoord = srcTexCoord;

		return output;
	}

	@fragment
	fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
		// Compute destination UV from actual fragment screen position (post-clip).
		// Previously this was computed in the vertex shader with clamp, but when
		// the composite quad extends beyond the viewport (NDC outside [-1,1]),
		// GPU hardware clipping interpolated the clamped values incorrectly,
		// causing destination texture sampling to smear/overflow.
		let dstTexCoord = vec2f(
			input.position.x / uniforms.canvasWidth,
			input.position.y / uniforms.canvasHeight,
		);

		// All textureSample calls must occur before any early return to
		// satisfy WGSL uniform control flow requirements.
		let srcPremultiplied = textureSample(sourceTexture, texSampler, input.srcTexCoord);
		let dstPremultiplied = textureSample(destTexture, texSampler, dstTexCoord);
		let basePremul = textureSample(baseTexture, texSampler, dstTexCoord);

		if (srcPremultiplied.a < 0.001) {
			return dstPremultiplied;
		}

		let srcRGB = unpremultiply(srcPremultiplied);
		let dstRGB = unpremultiply(dstPremultiplied);
		let srcA = clamp(srcPremultiplied.a * compositeUniforms.opacity, 0.0, 1.0);
		let dstA = clamp(dstPremultiplied.a, 0.0, 1.0);

		// Reconstruct the visual backdrop for blend mode calculations.
		// In offscreen layer paths, destTexture contains only layer content
		// (transparent background).  baseTexture holds the parent canvas
		// snapshot taken before the layer started.  Compositing dest over base
		// (source-over) gives the full visual backdrop that canvas-direct
		// rendering would see.  When baseTexture is a 1x1 transparent dummy
		// (normal compositing), the computation collapses to just dstRGB.
		let baseA = clamp(basePremul.a, 0.0, 1.0);
		let mergedA = dstA + baseA * (1.0 - dstA);
		let mergedPremulRGB = dstPremultiplied.rgb + basePremul.rgb * (1.0 - dstA);
		let blendBase = mergedPremulRGB / max(mergedA, 0.001);
		let blended = applyBlendMode(blendBase, srcRGB, compositeUniforms.blendMode);
		// W3C compositing weights the blend result by the backdrop alpha
		// (Cs' = (1 - ab) * Cs + ab * B(Cb, Cs)): where the backdrop is
		// transparent the source color passes through unchanged instead of
		// blending against the black reconstructed base.
		let effectiveSrc = mix(srcRGB, blended, mergedA);

		if (compositeUniforms.compositionMode == 1u) {
			// alpha-lock (source-atop): draw only where dest has alpha, preserve dest alpha
			let outA = dstA;
			let outRGB = effectiveSrc * srcA + dstRGB * (1.0 - srcA);
			return vec4f(outRGB * outA, outA);
		}

		let outA = srcA + dstA * (1.0 - srcA);
		let outRGB = (
			effectiveSrc * srcA + dstRGB * dstA * (1.0 - srcA)
		) / max(outA, 0.001);

		return vec4f(outRGB * outA, outA);
	}
`;
