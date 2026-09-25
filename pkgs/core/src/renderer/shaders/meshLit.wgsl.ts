/**
 * Neutral lit-mesh shader (position + normal + uv, single uniform block).
 * Used by MeshPassRenderer for the extrude appearance today and reusable by
 * a future first-class Mesh3DObject — no extrude-specific logic.
 *
 * When useTexture is set, the per-vertex uv samples an optional albedo
 * texture (premultiplied) in place of baseColor, remapped through texUvRect
 * to the used sub-rect of a pool-quantized texture. The uv layout — including
 * any projection or flip — is the caller's responsibility (baked into the
 * vertex data); this shader only samples and lights.
 *
 * Output is premultiplied alpha, matching the blit pipelines' srcFactor
 * "one" blending.
 */
export const MESH_LIT_SHADER = /* wgsl */ `
	struct Uniforms {
		mvp: mat4x4f,
		// Rotation-only model matrix; safe as a normal matrix (no shear/scale).
		model: mat4x4f,
		baseColor: vec4f,
		// xyz: direction toward the light (world space).
		lightDir: vec4f,
		// Light color tinting diffuse and specular (ambient stays neutral).
		lightColor: vec4f,
		// Shaded-side (ambient) color multiplied under the base color.
		shadowColor: vec4f,
		// x: shading mode (0 = flat, 1 = lambert, 2 = blinn-phong)
		// y: specular exponent (blinn-phong only)
		// z: useTexture (0 = baseColor, 1 = sample albedo texture)
		shadingParams: vec4f,
		// Used sub-rect of the albedo texture: (minU, minV, maxU, maxV).
		// Samples are clamped to it so bilinear never bleeds into the
		// pool-quantization margin outside the baked content.
		texUvRect: vec4f,
		// Affine vertex-uv → texture-uv remap rows: texU = dot((uv,1), uvRemapU.xyz),
		// texV likewise. Lets the caller map uv through an arbitrary affine frame
		// (atlas sub-rect, rotated/scaled content, ...). Defaults reproduce a
		// plain texUvRect mix.
		uvRemapU: vec4f,
		uvRemapV: vec4f,
		// PBR-ish surface: (roughness, metalness, reflectivity, glass).
		// Neutral defaults (0.5, 0, 0, 0) reproduce the classic lambert/blinn look.
		pbrParams: vec4f,
		// Artistic rim (fresnel) falloff: (bias, scale, intensity, factor).
		fresnelParams: vec4f,
		// Rim color; .a is the enable flag (0 = no rim).
		fresnelColor: vec4f,
		// Surface-pattern tiling: (1/(tileW·scaleX), 1/(tileH·scaleY), cosR, sinR).
		// Maps the world-unit wrap uv (uv2) into repeating tile space.
		patternParams: vec4f,
		// Tile uv offset (x, y); z: pattern opacity; w unused.
		patternOffset: vec4f,
	}

	@group(0) @binding(0) var<uniform> uniforms: Uniforms;
	@group(0) @binding(1) var albedoTexture: texture_2d<f32>;
	@group(0) @binding(2) var albedoSampler: sampler;
	// Surface pattern tile (repeat-address sampler) — used only when
	// shadingParams.w flags it; a 1×1 placeholder is bound otherwise.
	@group(0) @binding(3) var patternTexture: texture_2d<f32>;
	@group(0) @binding(4) var patternSampler: sampler;

	struct VertexOutput {
		@builtin(position) position: vec4f,
		@location(0) normal: vec3f,
		@location(1) uv: vec2f,
		@location(2) uv2: vec2f,
	}

	@vertex
	fn vertexMain(
		@location(0) position: vec3f,
		@location(1) normal: vec3f,
		@location(2) uv: vec2f,
		@location(3) uv2: vec2f,
	) -> VertexOutput {
		var out: VertexOutput;
		out.position = uniforms.mvp * vec4f(position, 1.0);
		out.normal = (uniforms.model * vec4f(normal, 0.0)).xyz;
		out.uv = uv;
		out.uv2 = uv2;
		return out;
	}

	fn shade(in: VertexOutput) -> vec4f {
		let mode = uniforms.shadingParams.x;
		var base = uniforms.baseColor;

		// Baked fill (the element's own fill/stroke) replaces baseColor.
		if (uniforms.shadingParams.z > 0.5) {
			let uvh = vec3f(in.uv, 1.0);
			let texUv = clamp(
				vec2f(dot(uvh, uniforms.uvRemapU.xyz), dot(uvh, uniforms.uvRemapV.xyz)),
				uniforms.texUvRect.xy,
				uniforms.texUvRect.zw,
			);
			let s = textureSample(albedoTexture, albedoSampler, texUv);
			// Un-premultiply so lighting acts on the true albedo; re-premultiply
			// on output below.
			let albedo = select(s.rgb / s.a, vec3f(0.0), s.a <= 0.0);
			base = vec4f(albedo, s.a);
		}

		// Tiled surface pattern (Illustrator "Materials"): composited OVER the
		// fill/baseColor as a decal, so the original fill stays visible through
		// the pattern's transparent regions. The world-unit wrap uv is scaled
		// into tile space, rotated, offset, then sampled with a repeat address
		// mode so the seamless def tile repeats.
		if (uniforms.shadingParams.w > 0.5) {
			let p = in.uv2 * uniforms.patternParams.xy;
			let cosR = uniforms.patternParams.z;
			let sinR = uniforms.patternParams.w;
			let tuv = vec2f(p.x * cosR - p.y * sinR, p.x * sinR + p.y * cosR)
				+ uniforms.patternOffset.xy;
			let s = textureSample(patternTexture, patternSampler, tuv);
			let patternRgb = select(s.rgb / s.a, vec3f(0.0), s.a <= 0.0);
			// The pattern's coverage uses its own opacity (patternOffset.z),
			// independent of the surface/fill alpha, then composites straight-
			// alpha "over" the fill. So a surface texture on a semi-transparent
			// object can still be opaque where it's drawn.
			let pa = s.a * uniforms.patternOffset.z;
			let outA = pa + base.a * (1.0 - pa);
			let outRgb = select(
				(patternRgb * pa + base.rgb * base.a * (1.0 - pa)) / outA,
				vec3f(0.0),
				outA <= 0.0,
			);
			base = vec4f(outRgb, outA);
		}

		var rgb = base.rgb;
		let glass = clamp(uniforms.pbrParams.w, 0.0, 1.0);
		if (mode > 0.5) {
			let n = normalize(in.normal);
			let l = normalize(uniforms.lightDir.xyz);
			let diffuse = max(dot(n, l), 0.0);

			let roughness = clamp(uniforms.pbrParams.x, 0.04, 1.0);
			let metalness = clamp(uniforms.pbrParams.y, 0.0, 1.0);
			let reflectivity = uniforms.pbrParams.z;

			// Ambient floor keeps unlit faces readable in atari use.
			// Metals lose their diffuse albedo (1 − metalness).
			rgb = base.rgb *
				(uniforms.shadowColor.rgb + 0.75 * diffuse * uniforms.lightColor.rgb) *
				(1.0 - metalness);

			if (mode > 1.5) {
				// Blinn-Phong with the viewer on +Z (matches the ortho camera).
				let h = normalize(l + vec3f(0.0, 0.0, 1.0));
				let spec = pow(max(dot(n, h), 0.0), max(uniforms.shadingParams.y, 1.0));
				rgb += uniforms.lightColor.rgb * (spec * 0.5);
			}

			// View is fixed on +Z (the camera looks along −Z at the solid).
			let ndv = max(dot(n, vec3f(0.0, 0.0, 1.0)), 0.0);

			// Analytic hemisphere-env reflection (no scene environment exists):
			// reflect the fixed view off the normal, sample a 2-tone gradient,
			// flattened by roughness, Fresnel-weighted (Schlick), tinted by metal.
			if (reflectivity > 0.0) {
				let r = reflect(vec3f(0.0, 0.0, -1.0), n);
				let t = mix(0.5, saturate(r.y * 0.5 + 0.5), 1.0 - roughness);
				let env = mix(vec3f(0.15), vec3f(0.95), t);
				let f0 = mix(vec3f(0.04), base.rgb, metalness);
				let fres = f0 + (vec3f(1.0) - f0) * pow(1.0 - ndv, 5.0);
				rgb += reflectivity * env * fres;
			}

			// Artistic rim (separate from the reflection Fresnel above).
			if (uniforms.fresnelColor.a > 0.5) {
				let rim = saturate(
					uniforms.fresnelParams.x +
					uniforms.fresnelParams.y * pow(1.0 - ndv, max(uniforms.fresnelParams.w, 0.0)),
				);
				rgb += uniforms.fresnelParams.z * rim * uniforms.fresnelColor.rgb;
			}
		}

		// Glass: drop coverage so the real backdrop shows through at blit time.
		let outAlpha = base.a * (1.0 - glass);
		return vec4f(rgb * outAlpha, outAlpha);
	}

	@fragment
	fn fragmentMain(in: VertexOutput) -> @location(0) vec4f {
		return shade(in);
	}

	// MRT variant for glass refraction: also emits the screen-space normal
	// (view fixed on +Z, so world-space normal.xy is the screen tilt) plus a
	// coverage flag in alpha, consumed by the refraction compositor.
	struct MrtOutput {
		@location(0) color: vec4f,
		@location(1) normal: vec4f,
	}

	@fragment
	fn fragmentMainMRT(in: VertexOutput) -> MrtOutput {
		var out: MrtOutput;
		out.color = shade(in);
		let n = normalize(in.normal);
		out.normal = vec4f(n.x * 0.5 + 0.5, n.y * 0.5 + 0.5, 0.0, 1.0);
		return out;
	}
`;
