import { PROJECTIVE_QUAD_WGSL } from "./quadProjection.wgsl";

/**
 * Glass refraction shader for the extrude appearance.
 *
 * Run by RefractionCompositor over a BackdropEffectSample (the shared capture
 * + Gaussian-pyramid levels built by BackdropEffectCoordinator).
 * Samples the solid's premultiplied color, its screen-space normal
 * (+ coverage, smoothed over a 5-tap cross to soften mesh face seams), and
 * the two pyramid levels bracketing the effect's blur sigma (lerped by a
 * variance-calibrated mix), then emits the solid OVER a refracted backdrop,
 * masked by coverage:
 *
 *   offset   = normal.xy · (ior − 1) · thickness       (rect uv, per pixel)
 *   refr     = blurred[uv + offset]                    (per-channel = aberration)
 *   inner    = meshColor + refr · (1 − meshColor.a)    (premultiplied over)
 *   dst      = inner · coverage + dst · (1 − coverage) (two-draw replace)
 *
 * The replace runs as two draws: fragmentPunch scales the destination by
 * (1 − coverage), then fragmentMain adds inner · coverage. Keying a single
 * src-over draw on inner's alpha instead would leave the sharp backdrop
 * showing through blur-softened alpha edges. The coverage mask keeps every
 * pixel OUTSIDE the solid untouched in the destination. This matters because
 * the backdrop sample can be OLDER than the destination (one capture shared
 * per epoch — and per FRAME during pan/zoom): rewriting the whole rect with
 * it would roll content drawn since the capture back to the artboard
 * background.
 *
 * The solid is drawn as its own projected QUAD in the compose viewport's NDC,
 * not as a full-viewport triangle: the mesh UV then follows the quad's
 * projective mapping (per-corner `quadQ` from computeQuadProjectiveWeights,
 * the same weights the quad blit uses), so a rotated or perspective-projected
 * solid samples its mesh and normal at the right place instead of through its
 * axis-aligned bounding box. The backdrop keeps being addressed in SCREEN
 * space, derived from the fragment position over the compose rect, because
 * the capture lives in screen space.
 *
 * The compose viewport covers the effect's own (canvas-clamped) rect;
 * backdropRemap maps its uv into the shared capture-region uv. Backdrop
 * textures may be pool-quantized (used region smaller than the texture), so
 * each carries a ctl vec4 (xy = used/quantized uv scale, zw = used-region half
 * texel) and is sampled through a clamp-then-scale, same idiom as meshUvRect
 * below.
 *
 * View is fixed on +Z (matching the mesh pass), so normal.xy is the tilt.
 * All texture reads use textureSampleLevel (explicit LOD): the backdrop has no
 * mips and the reads happen in per-fragment (coverage-dependent) control flow.
 */
export const EXTRUDE_REFRACTION_SHADER = /* wgsl */ `
${PROJECTIVE_QUAD_WGSL}

	struct Uniforms {
		// x: refraction offset scale (rect uv), y: aberration.
		params: vec4f,
		// Used sub-rect of the pool-quantized mesh color/normal textures.
		meshUvRect: vec4f,
		// Compose-viewport uv → shared capture-region uv: region = xy + uv·zw.
		backdropRemap: vec4f,
		// x: lerp factor between blurLo and blurHi (variance-calibrated).
		blurMix: vec4f,
		// Used-area sampling ctl per backdrop texture: xy = used/quantized uv
		// scale, zw = half texel of the used region in region uv (clamp margin).
		blurLoCtl: vec4f,
		blurHiCtl: vec4f,
		// The solid's projected quad in compose-viewport NDC: xy = TL, zw = TR.
		quadTlTr: vec4f,
		// xy = BR, zw = BL.
		quadBrBl: vec4f,
		// Projective weights per corner (TL, TR, BR, BL).
		quadQ: vec4f,
		// The compose viewport in framebuffer px: xy = origin, zw = size. Turns
		// the fragment position into the screen uv the backdrop is addressed in.
		rect: vec4f,
	}

	@group(0) @binding(0) var<uniform> uniforms: Uniforms;
	@group(0) @binding(1) var samp: sampler;
	@group(0) @binding(2) var meshColorTex: texture_2d<f32>;
	@group(0) @binding(3) var meshNormalTex: texture_2d<f32>;
	@group(0) @binding(4) var blurLoTex: texture_2d<f32>;
	@group(0) @binding(5) var blurHiTex: texture_2d<f32>;

	struct VertexOutput {
		@builtin(position) position: vec4f,
		@location(0) meshUvQ: vec2f,
		@location(1) q: f32,
	}

	@vertex
	fn vertexMain(@builtin(vertex_index) vi: u32) -> VertexOutput {
		var corners = array<vec2f, 4>(
			uniforms.quadTlTr.xy,
			uniforms.quadTlTr.zw,
			uniforms.quadBrBl.xy,
			uniforms.quadBrBl.zw,
		);
		var qWeights = array<f32, 4>(
			uniforms.quadQ.x,
			uniforms.quadQ.y,
			uniforms.quadQ.z,
			uniforms.quadQ.w,
		);

		let ci = quadCornerIndex(vi);
		let uv = quadCornerUv(ci);
		let q = qWeights[ci];
		let meshUv = mix(uniforms.meshUvRect.xy, uniforms.meshUvRect.zw, uv);

		var out: VertexOutput;
		out.position = vec4f(corners[ci], 0.0, 1.0);
		out.meshUvQ = meshUv * q;
		out.q = q;
		return out;
	}

	// The fragment's position over the compose rect — the screen-space uv the
	// backdrop capture is addressed in (the mesh uses the projective quad uv).
	fn screenUv(position: vec4f) -> vec2f {
		return (position.xy - uniforms.rect.xy) / uniforms.rect.zw;
	}

	// Clamp a region uv into a texture's used area, then scale to texture uv.
	fn regionToTexUv(regionUv: vec2f, ctl: vec4f) -> vec2f {
		return clamp(regionUv, ctl.zw, vec2f(1.0) - ctl.zw) * ctl.xy;
	}

	// The two pyramid levels bracketing the effect's sigma, lerped.
	fn sampleBlurred(regionUv: vec2f) -> vec4f {
		let lo = textureSampleLevel(
			blurLoTex, samp, regionToTexUv(regionUv, uniforms.blurLoCtl), 0.0,
		);
		let hi = textureSampleLevel(
			blurHiTex, samp, regionToTexUv(regionUv, uniforms.blurHiCtl), 0.0,
		);
		return mix(lo, hi, uniforms.blurMix.x);
	}

	fn sampleMeshNormal(meshUv: vec2f) -> vec4f {
		return textureSampleLevel(meshNormalTex, samp, meshUv, 0.0);
	}

	// 5-tap cross (center + 4 cardinal neighbors) instead of a full 3x3 box —
	// drops the 4 diagonal corners, which contribute the least to softening a
	// mesh face seam, for ~half the texture fetches.
	fn smoothMeshNormal(meshUv: vec2f) -> vec4f {
		let center = sampleMeshNormal(meshUv);
		let dimensions = vec2f(textureDimensions(meshNormalTex, 0));
		let texel = 1.0 / dimensions;
		var normalSum = (center.xy * 2.0 - vec2f(1.0)) * center.a;
		var coverageSum = center.a;

		let offsets = array<vec2f, 4>(
			vec2f(1.0, 0.0),
			vec2f(-1.0, 0.0),
			vec2f(0.0, 1.0),
			vec2f(0.0, -1.0),
		);
		for (var i = 0; i < 4; i = i + 1) {
			let sampleUv = clamp(
				meshUv + offsets[i] * texel,
				uniforms.meshUvRect.xy,
				uniforms.meshUvRect.zw,
			);
			let sample = sampleMeshNormal(sampleUv);
			normalSum += (sample.xy * 2.0 - vec2f(1.0)) * sample.a;
			coverageSum += sample.a;
		}

		if (coverageSum <= 0.0) {
			return center;
		}
		let averaged = normalSum / coverageSum;
		let n = select(averaged, center.xy * 2.0 - vec2f(1.0), length(averaged) < 1e-5);
		return vec4f(n * 0.5 + vec2f(0.5), 0.0, center.a);
	}

	@fragment
	fn fragmentMain(in: VertexOutput) -> @location(0) vec4f {
		// Projective mesh uv: the interpolated uv·q divided by the interpolated
		// q, so the mapping follows the quad instead of each triangle's plane.
		let meshUv = projectiveQuadUv(in.meshUvQ, in.q);
		let meshColor = textureSampleLevel(meshColorTex, samp, meshUv, 0.0);
		let nrm = smoothMeshNormal(meshUv);

		let coverage = nrm.a;
		let n = nrm.xy * 2.0 - vec2f(1.0);
		// Offsets are defined in the effect's rect uv; backdropRemap.zw converts
		// them into the shared capture-region uv the backdrop is sampled in.
		let offset = n * uniforms.params.x * uniforms.backdropRemap.zw;
		let ab = uniforms.params.y;
		let uv = screenUv(in.position);
		let regionUv = uniforms.backdropRemap.xy + uv * uniforms.backdropRemap.zw;

		// Refracted, pre-blurred backdrop under the solid. Per-channel offset
		// gives chromatic aberration at the edges; ab is a per-draw uniform
		// (same value for every fragment), so this branch is uniform control
		// flow — skipping the extra 2 fetches when aberration is off (the
		// common case) costs nothing on divergence.
		let blurredCenter = sampleBlurred(regionUv + offset);
		var blurredRGB = blurredCenter.rgb;
		if (ab != 0.0) {
			let r = sampleBlurred(regionUv + offset * (1.0 + ab)).r;
			let b = sampleBlurred(regionUv + offset * (1.0 - ab)).b;
			blurredRGB = vec3f(r, blurredCenter.g, b);
		}

		// Premultiplied "over": solid on top of the refracted backdrop. The
		// backdrop's alpha rides along so a transparent backdrop (e.g. a
		// transparent-background PNG export) stays transparent instead of
		// compositing to opaque black behind the glass.
		let rgb = meshColor.rgb + blurredRGB * (1.0 - meshColor.a);
		let a = meshColor.a + blurredCenter.a * (1.0 - meshColor.a);
		// Coverage-masked premultiplied output, added on top of the punched
		// destination (see fragmentPunch): within coverage the destination is
		// replaced with this refracted result, outside it stays untouched.
		return vec4f(rgb * coverage, a * coverage);
	}

	// Punch entry for the two-draw replace composite: outputs only the
	// coverage in alpha so a zero/one-minus-src-alpha blend scales the
	// destination by (1 - coverage) before the additive fragmentMain draw.
	// Blending fragmentMain with src-over instead would key on the refracted
	// result's alpha and leave the sharp backdrop showing through wherever
	// blur softened an alpha edge (visible on transparent grounds).
	@fragment
	fn fragmentPunch(in: VertexOutput) -> @location(0) vec4f {
		return vec4f(0.0, 0.0, 0.0, smoothMeshNormal(projectiveQuadUv(in.meshUvQ, in.q)).a);
	}

	// Coverage side-channel writer: premultiplied white x coverage, so the
	// accumulated texture masks with either channel — the glass punch reads
	// .a, the coverage cut-out reads .r.
	@fragment
	fn fragmentCoverageWrite(in: VertexOutput) -> @location(0) vec4f {
		return vec4f(smoothMeshNormal(projectiveQuadUv(in.meshUvQ, in.q)).a);
	}
`;

/**
 * Pixel-exact copy / coverage cut-out passes for the glass virtual-backdrop
 * composite (multi-entry intermediate route). textureLoad by target pixel
 * index keeps the pass correct across pool-quantized texture sizes — every
 * participating texture holds its content at the origin.
 */
export const EXTRUDE_COVERAGE_CUT_SHADER = /* wgsl */ `
	@group(0) @binding(0) var srcTex: texture_2d<f32>;
	@group(0) @binding(1) var covTex: texture_2d<f32>;

	@vertex
	fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> @builtin(position) vec4f {
		let x = f32((vertexIndex & 1u) << 2u) - 1.0;
		let y = f32((vertexIndex & 2u) << 1u) - 1.0;
		return vec4f(x, y, 0.0, 1.0);
	}

	/** target = src (plain copy; covTex is ignored). */
	@fragment
	fn fragmentCopy(@builtin(position) pos: vec4f) -> @location(0) vec4f {
		return textureLoad(srcTex, vec2i(pos.xy), 0);
	}

	/** target = src x coverage.r — cuts the union replace-result out of the
	 *  virtual backdrop so only glass content reaches downstream filters. */
	@fragment
	fn fragmentCut(@builtin(position) pos: vec4f) -> @location(0) vec4f {
		return textureLoad(srcTex, vec2i(pos.xy), 0) * textureLoad(covTex, vec2i(pos.xy), 0).r;
	}
`;
