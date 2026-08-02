import { PROJECTIVE_QUAD_WGSL } from "../shaders/quadProjection.wgsl";

/**
 * Drop Shadow Filter Shader
 * Three-pass: spread (offset + dilation/erosion), horizontal blur, vertical blur + composite.
 *
 * Pass 0 (passType=0): Sample source alpha at the offset position. Spread
 *   (dilation/erosion) runs in the dedicated jump-flood spread pass below
 *   instead — a disc scan here would cost O(spread²) per pixel.
 *
 * Pass 1 (passType=1): Horizontal Gaussian blur on pass 0 result.
 *
 * Pass 2 (passType=2): Vertical Gaussian blur on pass 1 result,
 *   colorize shadow, composite original element on top (premultiplied alpha OVER).
 *
 * Pass 3 (passType=3): Vertical Gaussian blur + colorize, WITHOUT the original
 *   composite — the shadow alone, for callers that draw the element themselves
 *   (the coverage-driven underlay).
 *
 * This direct kernel costs 2·radius+1 taps per axis, so it only serves small
 * radii; DROP_SHADOW_PYRAMID_SHADER below takes over past
 * PYRAMID_BLUR_MIN_RADIUS.
 */

export const DROP_SHADOW_SHADER = /* wgsl */ `
	struct Uniforms {
		resolution: vec2f,
		direction: vec2f,
		blurRadius: f32,
		offsetX: f32,
		offsetY: f32,
		shadowR: f32,
		shadowG: f32,
		shadowB: f32,
		shadowOpacity: f32,
		passType: f32,
		spreadRadius: f32,
	}

	@group(0) @binding(0) var<uniform> uniforms: Uniforms;
	@group(0) @binding(1) var inputTexture: texture_2d<f32>;
	@group(0) @binding(2) var inputSampler: sampler;
	@group(0) @binding(3) var originalTexture: texture_2d<f32>;
	@group(0) @binding(4) var originalSampler: sampler;

	fn sampleInputAlpha(uv: vec2f) -> f32 {
		let alpha = textureSample(inputTexture, inputSampler, uv).a;
		let isInside = all(uv >= vec2f(0.0)) && all(uv <= vec2f(1.0));
		return select(0.0, alpha, isInside);
	}

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

	@fragment
	fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
		let texelSize = 1.0 / uniforms.resolution;
		let passType = i32(uniforms.passType + 0.5);

		// === Pass 0: Offset only (spread runs in the jump-flood spread pass) ===
		if (passType == 0) {
			let uvOffset = vec2f(uniforms.offsetX, uniforms.offsetY) * texelSize;
			let baseUV = input.texCoord - uvOffset;
			return vec4f(0.0, 0.0, 0.0, sampleInputAlpha(baseUV));
		}

		// === Pass 1 & 2: Gaussian blur ===
		let blurOffset = uniforms.direction * texelSize;
		// No upper clamp. This kernel only ever runs below
		// PYRAMID_BLUR_MIN_RADIUS — the processor routes anything wider to the
		// pyramid — so a ceiling here could not bind, and a ceiling in TEXELS
		// is the wrong shape regardless: whether it engaged would depend on the
		// rasterization DPI, silently narrowing the same shadow on a high-DPI
		// document. The radius is bounded by that routing threshold instead.
		let radius = max(uniforms.blurRadius, 0.0);
		let sigma = max(radius / 2.0, 0.001);
		let sigma2 = sigma * sigma;
		let doBlur = radius > 0.1;

		let kernelSize = i32(ceil(radius * 2.0)) | 1;
		let halfKernel = kernelSize / 2;

		var shadowAlpha = 0.0;
		var totalWeight = 0.0;

		if (doBlur) {
			for (var i = -halfKernel; i <= halfKernel; i = i + 1) {
				let gaussWeight = exp(-f32(i * i) / (2.0 * sigma2));
				let sampleUV = input.texCoord + f32(i) * blurOffset;
				shadowAlpha += sampleInputAlpha(sampleUV) * gaussWeight;
				totalWeight += gaussWeight;
			}
			shadowAlpha = shadowAlpha / max(totalWeight, 0.001);
		} else {
			shadowAlpha = sampleInputAlpha(input.texCoord);
		}

		// Pass 1: output blurred alpha
		if (passType == 1) {
			return vec4f(0.0, 0.0, 0.0, shadowAlpha);
		}

		// === Pass 2 / 3: colorize shadow (+ composite original on top) ===
		let finalShadowAlpha = shadowAlpha * uniforms.shadowOpacity;
		let shadowColor = vec3f(uniforms.shadowR, uniforms.shadowG, uniforms.shadowB);

		// Premultiplied alpha shadow
		let shadow = vec4f(shadowColor * finalShadowAlpha, finalShadowAlpha);

		// Pass 3: the shadow alone — the caller draws the element over it.
		if (passType == 3) {
			return shadow;
		}

		// Read original element
		let original = textureSample(originalTexture, originalSampler, input.texCoord);

		// Composite: original OVER shadow (premultiplied alpha blending)
		return original + shadow * (1.0 - original.a);
	}
`;

/**
 * Wide-radius drop shadow resolve.
 *
 * Reads the two levels of a calibrated Gaussian blur pyramid (BlurPyramid)
 * that bracket the shadow's sigma, lerps them with the variance-space mix
 * factor, then colorizes exactly like DROP_SHADOW_SHADER's pass 2/3. Cost is
 * flat in the radius: the pyramid's per-level kernel is fixed and each level
 * is a quarter of the previous one's texels, where the direct kernel grows
 * 2·radius+1 taps per axis (137 taps per axis at a 68-texel radius).
 */
export const DROP_SHADOW_PYRAMID_SHADER = /* wgsl */ `
	struct Uniforms {
		// rgb: shadow color, a: shadow opacity.
		shadowColor: vec4f,
		// x: variance-calibrated lerp between the lo and hi levels,
		// y: 1 = composite the original element on top, 0 = shadow only.
		control: vec4f,
		// Used-area sampling ctl per level: xy = used/quantized uv scale,
		// zw = half texel of the used region (clamp margin).
		loCtl: vec4f,
		hiCtl: vec4f,
	}

	@group(0) @binding(0) var<uniform> uniforms: Uniforms;
	@group(0) @binding(1) var samp: sampler;
	@group(0) @binding(2) var loTexture: texture_2d<f32>;
	@group(0) @binding(3) var hiTexture: texture_2d<f32>;
	@group(0) @binding(4) var originalTexture: texture_2d<f32>;

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

	fn sampleLevel(tex: texture_2d<f32>, ctl: vec4f, regionUv: vec2f) -> f32 {
		let clamped = clamp(regionUv, ctl.zw, vec2f(1.0) - ctl.zw);
		return textureSampleLevel(tex, samp, clamped * ctl.xy, 0.0).a;
	}

	@fragment
	fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
		let lo = sampleLevel(loTexture, uniforms.loCtl, input.texCoord);
		let hi = sampleLevel(hiTexture, uniforms.hiCtl, input.texCoord);
		let shadowAlpha = mix(lo, hi, uniforms.control.x) * uniforms.shadowColor.a;
		let shadow = vec4f(uniforms.shadowColor.rgb * shadowAlpha, shadowAlpha);
		if (uniforms.control.y < 0.5) {
			return shadow;
		}
		let original = textureSampleLevel(originalTexture, samp, input.texCoord, 0.0);
		return original + shadow * (1.0 - original.a);
	}
`;

/**
 * Coverage placement pass for the self-sized (underlay) drop shadow.
 *
 * The shadow needs room to spread past the element, so its texture spans the
 * element's world bounds grown by the filter's expansion margin. This pass
 * draws the coverage mask's world quad — already moved by the shadow offset
 * and expressed in the underlay's NDC — into that larger frame, leaving the
 * margin cleared for the blur to spread into. Everything downstream (spread /
 * blur / colorize) then works on one plain texture.
 *
 * Drawing the mask as a QUAD rather than a full-frame remap keeps a rotated
 * or perspective-projected solid's silhouette correct: the per-corner
 * `quadQ` weights (computeQuadProjectiveWeights) turn the GPU's per-triangle
 * linear UV interpolation into the projective one the quad actually needs.
 */
export const DROP_SHADOW_COVERAGE_PLACE_SHADER = /* wgsl */ `
${PROJECTIVE_QUAD_WGSL}

	struct Uniforms {
		// Quad corners in the underlay's NDC: xy = TL, zw = TR.
		cornersTlTr: vec4f,
		// xy = BR, zw = BL.
		cornersBrBl: vec4f,
		// Used sub-rect of the coverage texture (minU, minV, maxU, maxV).
		uvRect: vec4f,
		// Projective weights per corner (TL, TR, BR, BL).
		quadQ: vec4f,
	}

	@group(0) @binding(0) var<uniform> uniforms: Uniforms;
	@group(0) @binding(1) var samp: sampler;
	@group(0) @binding(2) var coverageTexture: texture_2d<f32>;

	struct VertexOutput {
		@builtin(position) position: vec4f,
		@location(0) texCoordQ: vec2f,
		@location(1) q: f32,
	}

	@vertex
	fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
		var positions = array<vec2f, 4>(
			uniforms.cornersTlTr.xy,
			uniforms.cornersTlTr.zw,
			uniforms.cornersBrBl.xy,
			uniforms.cornersBrBl.zw,
		);
		var qWeights = array<f32, 4>(
			uniforms.quadQ.x,
			uniforms.quadQ.y,
			uniforms.quadQ.z,
			uniforms.quadQ.w,
		);

		let ci = quadCornerIndex(vertexIndex);
		let uv = quadCornerUv(ci);
		let q = qWeights[ci];
		let texCoord = vec2f(
			mix(uniforms.uvRect.x, uniforms.uvRect.z, uv.x),
			mix(uniforms.uvRect.y, uniforms.uvRect.w, uv.y),
		);

		var output: VertexOutput;
		output.position = vec4f(positions[ci], 0.0, 1.0);
		output.texCoordQ = texCoord * q;
		output.q = q;
		return output;
	}

	@fragment
	fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
		let uv = projectiveQuadUv(input.texCoordQ, input.q);
		return vec4f(0.0, 0.0, 0.0, textureSampleLevel(coverageTexture, samp, uv, 0.0).a);
	}
`;

/** Spread pass — the shared jump-flood field turns dilation / erosion into a
 *  distance threshold: distance to the silhouette for spread > 0, distance to
 *  the background for spread < 0. Also applies the shadow offset, replacing
 *  the main shader's pass 0. */
export const DROP_SHADOW_SPREAD_SHADER = /* wgsl */ `
	struct Uniforms {
		offsetX: f32,
		offsetY: f32,
		spreadRadius: f32,
	}

	@group(0) @binding(0) var<uniform> uniforms: Uniforms;
	@group(0) @binding(1) var coordTexture: texture_2d<f32>;

	struct VertexOutput {
		@builtin(position) position: vec4f,
	}

	@vertex
	fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
		var output: VertexOutput;
		let x = f32((vertexIndex & 1u) << 1u);
		let y = f32(vertexIndex & 2u);
		output.position = vec4f(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);
		return output;
	}

	@fragment
	fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
		let dims = vec2i(textureDimensions(coordTexture, 0));
		let samplePos = input.position.xy - vec2f(uniforms.offsetX, uniforms.offsetY);
		let isInside = all(samplePos >= vec2f(0.0)) && all(samplePos < vec2f(dims));
		if (!isInside) {
			return vec4f(0.0);
		}
		let seed = textureLoad(coordTexture, vec2i(samplePos), 0).xy;

		var alpha = 0.0;
		if (uniforms.spreadRadius > 0.0) {
			// Dilation: solid up to the spread distance from the silhouette.
			if (seed.x > -1e5) {
				let dist = distance(seed, samplePos);
				alpha = 1.0 - smoothstep(uniforms.spreadRadius - 0.75, uniforms.spreadRadius + 0.75, dist);
			}
		} else {
			// Erosion: keep only pixels deeper than |spread| from the background.
			if (seed.x > -1e5) {
				let dist = distance(seed, samplePos);
				alpha = smoothstep(-uniforms.spreadRadius - 0.75, -uniforms.spreadRadius + 0.75, dist);
			} else {
				// No background within flood reach: deep inside the silhouette.
				alpha = 1.0;
			}
		}
		return vec4f(0.0, 0.0, 0.0, alpha);
	}
`;
