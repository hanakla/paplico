import { PROJECTIVE_QUAD_WGSL } from "./quadProjection.wgsl";

/**
 * Quad Blit Shader — blit a texture onto an arbitrary 4-corner quadrilateral
 * in world space. Used by ImageElementRenderer when preProcess filters (such
 * as 3d-rotate) deform the image's 4 corners.
 *
 * Uniform layout (20 f32 = 80 bytes):
 *   [0..1]  TL (x, y)
 *   [2..3]  TR (x, y)
 *   [4..5]  BR (x, y)
 *   [6..7]  BL (x, y)
 *   [8]     opacity
 *   [9..11] _pad
 *   [12..15] uvMinX, uvMinY, uvMaxX, uvMaxY
 *   [16..19] projective q for TL, TR, BR, BL
 *
 * Reuses the standard blit bind-group layout: uniform buffer, sampler, texture.
 */

/**
 * Outer-mask sampling, shared by every blit shader that can be clipped.
 * Expects `outerMaskAtlas` / `outerMaskSampler` at group(2) and a
 * `blitUniforms` with the outerMask bounds.
 *
 * Mirrors `applyClipMask` in maskCommon.wgsl: the mask texture holds
 * premultiplied alpha, so its luminance is already "brightness x opacity". A
 * flat white silhouette has RGB (1,1,1)*a, which makes this identical to the
 * plain `.r` read it replaced — clip paths are unaffected.
 */
const OUTER_CLIP_MASK_WGSL = /* wgsl */ `
	fn applyOuterClipMask(premultiplied: vec4f, boundsMin: vec2f, boundsMax: vec2f, worldPos: vec2f, invert: f32) -> vec4f {
		// boundsMin == boundsMax is the sentinel for "no outer mask".
		if (boundsMin.x == boundsMax.x && boundsMin.y == boundsMax.y) {
			return premultiplied;
		}
		let rawUV = (worldPos - boundsMin) / (boundsMax - boundsMin);
		let maskUV = vec2f(rawUV.x, 1.0 - rawUV.y);
		let clampedUV = clamp(maskUV, vec2f(0.0), vec2f(1.0));
		let sampled = textureSampleLevel(outerMaskAtlas, outerMaskSampler, clampedUV, 0.0);
		let inBounds = step(0.0, maskUV.x) * step(maskUV.x, 1.0)
		             * step(0.0, maskUV.y) * step(maskUV.y, 1.0);
		// Outside the covered area the mask reads as empty, which an inverted
		// mask turns into "fully visible" — the mirror of the normal case.
		let covered = dot(sampled.rgb, vec3f(0.2126, 0.7152, 0.0722)) * inBounds;
		return premultiplied * mix(covered, 1.0 - covered, invert);
	}
`;

export const QUAD_BLIT_SHADER = /* wgsl */ `
${PROJECTIVE_QUAD_WGSL}

	struct Uniforms {
		viewportX: f32,
		viewportY: f32,
		zoom: f32,
		canvasWidth: f32,
		canvasHeight: f32,
		rotSin: f32,
		rotCos: f32,
	}

	struct QuadBlitUniforms {
		tlX: f32, tlY: f32,
		trX: f32, trY: f32,
		brX: f32, brY: f32,
		blX: f32, blY: f32,
		opacity: f32,
		/** 1 = invert the outer mask, 0 = leave it as-is. */
		outerMaskInvert: f32,
		_pad1: f32,
		_pad2: f32,
		uvMinX: f32,
		uvMinY: f32,
		uvMaxX: f32,
		uvMaxY: f32,
		tlQ: f32,
		trQ: f32,
		brQ: f32,
		blQ: f32,
	}

	@group(0) @binding(0) var<uniform> uniforms: Uniforms;
	@group(1) @binding(0) var<uniform> quadUniforms: QuadBlitUniforms;
	@group(1) @binding(1) var texSampler: sampler;
	@group(1) @binding(2) var sourceTexture: texture_2d<f32>;

	struct VertexOutput {
		@builtin(position) position: vec4f,
		@location(0) texCoordQ: vec2f,
		@location(1) q: f32,
	}

	@vertex
	fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
		var qWeights = array<f32, 4>(
			quadUniforms.tlQ,
			quadUniforms.trQ,
			quadUniforms.brQ,
			quadUniforms.blQ,
		);

		let ci = quadCornerIndex(vertexIndex);
		var worldX: f32;
		var worldY: f32;
		switch ci {
			case 0u: { worldX = quadUniforms.tlX; worldY = quadUniforms.tlY; }
			case 1u: { worldX = quadUniforms.trX; worldY = quadUniforms.trY; }
			case 2u: { worldX = quadUniforms.brX; worldY = quadUniforms.brY; }
			default: { worldX = quadUniforms.blX; worldY = quadUniforms.blY; }
		}

		// World to NDC transformation (same as the AABB blit shader).
		let x = (worldX - uniforms.viewportX) * uniforms.zoom;
		let y = (worldY - uniforms.viewportY) * uniforms.zoom;
		let rotX = x * uniforms.rotCos - y * uniforms.rotSin;
		let rotY = x * uniforms.rotSin + y * uniforms.rotCos;

		let ndcX = rotX / (uniforms.canvasWidth * 0.5);
		let ndcY = rotY / (uniforms.canvasHeight * 0.5);

		let uv = quadCornerUv(ci);
		let q = qWeights[ci];
		let texCoord = vec2f(
			mix(quadUniforms.uvMinX, quadUniforms.uvMaxX, uv.x),
			mix(quadUniforms.uvMinY, quadUniforms.uvMaxY, uv.y),
		);
		var output: VertexOutput;
		output.position = vec4f(ndcX, ndcY, 0.0, 1.0);
		output.texCoordQ = texCoord * q;
		output.q = q;
		return output;
	}

	@fragment
	fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
		let sampled = textureSample(
			sourceTexture,
			texSampler,
			projectiveQuadUv(input.texCoordQ, input.q),
		);
		return sampled * quadUniforms.opacity;
	}
	`;

/**
 * Mesh Blit Shader — blit a texture onto an arbitrary tessellated triangle
 * mesh in world space. Used by the mesh warp container to bend an image
 * child's interior along the Coons cage (the 4-corner quad blit only maps
 * the corners projectively, so cage curvature never reached the interior).
 *
 * Vertex buffer layout (16 bytes / vertex, triangle-list):
 *   @location(0) pos: vec2f  — world-space position (already warped on CPU)
 *   @location(1) uv:  vec2f  — source UV in 0..1 image space
 *
 * Uniform layout (8 f32 = 32 bytes):
 *   [0]     opacity
 *   [1..3]  _pad
 *   [4..7]  uvMinX, uvMinY, uvMaxX, uvMaxY
 *
 * Reuses the standard blit bind-group layout: uniform buffer, sampler, texture.
 */
export const MESH_BLIT_SHADER = /* wgsl */ `
	struct Uniforms {
		viewportX: f32,
		viewportY: f32,
		zoom: f32,
		canvasWidth: f32,
		canvasHeight: f32,
		rotSin: f32,
		rotCos: f32,
	}

	struct MeshBlitUniforms {
		opacity: f32,
		_pad1: f32,
		_pad2: f32,
		_pad3: f32,
		uvMinX: f32,
		uvMinY: f32,
		uvMaxX: f32,
		uvMaxY: f32,
	}

	@group(0) @binding(0) var<uniform> uniforms: Uniforms;
	@group(1) @binding(0) var<uniform> meshUniforms: MeshBlitUniforms;
	@group(1) @binding(1) var texSampler: sampler;
	@group(1) @binding(2) var sourceTexture: texture_2d<f32>;

	struct VertexOutput {
		@builtin(position) position: vec4f,
		@location(0) texCoord: vec2f,
	}

	@vertex
	fn vertexMain(
		@location(0) pos: vec2f,
		@location(1) uv: vec2f,
	) -> VertexOutput {
		// World to NDC transformation (same as the AABB blit shader).
		let x = (pos.x - uniforms.viewportX) * uniforms.zoom;
		let y = (pos.y - uniforms.viewportY) * uniforms.zoom;
		let rotX = x * uniforms.rotCos - y * uniforms.rotSin;
		let rotY = x * uniforms.rotSin + y * uniforms.rotCos;

		var output: VertexOutput;
		output.position = vec4f(
			rotX / (uniforms.canvasWidth * 0.5),
			rotY / (uniforms.canvasHeight * 0.5),
			0.0,
			1.0,
		);
		output.texCoord = vec2f(
			mix(meshUniforms.uvMinX, meshUniforms.uvMaxX, uv.x),
			mix(meshUniforms.uvMinY, meshUniforms.uvMaxY, uv.y),
		);
		return output;
	}

	@fragment
	fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
		let sampled = textureSample(sourceTexture, texSampler, input.texCoord);
		return sampled * meshUniforms.opacity;
	}
	`;

/**
 * Blit Shader - Composite filtered textures to canvas
 * Simple fullscreen quad shader for texture sampling
 */

export const BLIT_SHADER = /* wgsl */ `
	struct Uniforms {
		viewportX: f32,
		viewportY: f32,
		zoom: f32,
		canvasWidth: f32,
		canvasHeight: f32,
		rotSin: f32,
		rotCos: f32,
	}

	struct BlitUniforms {
		boundsMinX: f32,
		boundsMinY: f32,
		boundsMaxX: f32,
		boundsMaxY: f32,
		opacity: f32,
		/** 1 = invert the outer mask, 0 = leave it as-is. */
		outerMaskInvert: f32,
		_pad1: f32,
		_pad2: f32,
		uvMinX: f32,
		uvMinY: f32,
		uvMaxX: f32,
		uvMaxY: f32,
	}

	@group(0) @binding(0) var<uniform> uniforms: Uniforms;
	@group(1) @binding(0) var<uniform> blitUniforms: BlitUniforms;
	@group(1) @binding(1) var texSampler: sampler;
	@group(1) @binding(2) var sourceTexture: texture_2d<f32>;

	struct VertexOutput {
		@builtin(position) position: vec4f,
		@location(0) texCoord: vec2f,
	}

	@vertex
	fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
		var output: VertexOutput;

		// Fullscreen quad vertices (NDC space)
		var positions = array<vec2f, 6>(
			vec2f(-1.0, -1.0),
			vec2f(1.0, -1.0),
			vec2f(-1.0, 1.0),
			vec2f(-1.0, 1.0),
			vec2f(1.0, -1.0),
			vec2f(1.0, 1.0),
		);

		// Texture coordinates (0,0 = top-left, 1,1 = bottom-right)
		var texCoords = array<vec2f, 6>(
			vec2f(0.0, 1.0),
			vec2f(1.0, 1.0),
			vec2f(0.0, 0.0),
			vec2f(0.0, 0.0),
			vec2f(1.0, 1.0),
			vec2f(1.0, 0.0),
		);

		let quadPos = positions[vertexIndex];
		let texCoord = texCoords[vertexIndex];

		// Transform from fullscreen quad to element bounds in world space
		let worldX = mix(blitUniforms.boundsMinX, blitUniforms.boundsMaxX, (quadPos.x + 1.0) * 0.5);
		let worldY = mix(blitUniforms.boundsMinY, blitUniforms.boundsMaxY, (quadPos.y + 1.0) * 0.5);

		// World to NDC transformation (same as stroke.wgsl.ts)
		let x = (worldX - uniforms.viewportX) * uniforms.zoom;
		let y = (worldY - uniforms.viewportY) * uniforms.zoom;
		let rotX = x * uniforms.rotCos - y * uniforms.rotSin;
		let rotY = x * uniforms.rotSin + y * uniforms.rotCos;

		let ndcX = rotX / (uniforms.canvasWidth * 0.5);
		let ndcY = rotY / (uniforms.canvasHeight * 0.5);

		output.position = vec4f(ndcX, ndcY, 0.0, 1.0);
		output.texCoord = vec2f(
			mix(blitUniforms.uvMinX, blitUniforms.uvMaxX, texCoord.x),
			mix(blitUniforms.uvMinY, blitUniforms.uvMaxY, texCoord.y),
		);

		return output;
	}

	@fragment
	fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
		let sampled = textureSample(sourceTexture, texSampler, input.texCoord);
		// Keep premultiplied alpha consistent by scaling all channels.
		return sampled * blitUniforms.opacity;
	}
	`;

/**
 * Glass Punch Shader — destination punch for the glass intermediate route.
 *
 * A glass extrude with downstream filters or an inline mask lands in an
 * intermediate texture whose pixels are a REPLACEMENT for the backdrop
 * within the solid's coverage. Blitting that texture src-over keys on its
 * alpha and leaks the sharp backdrop wherever the refracted result is
 * translucent. This shader runs as an extra draw right before that blit
 * (blend zero / one-minus-src-alpha) and scales the destination so the
 * blit's own over-blend lands on a total destination weight of
 * (1 − coverage·opacity):
 *
 *   p = 1 − (1 − cov·o) / (1 − fA·o)      (clamped to [0, 1])
 *
 * cov = coverage texture alpha (the solid's footprint, masked/cropped in
 * lockstep with the color), fA = the filtered color's alpha. Inside the
 * solid (cov = 1) this punches fully — replace. Where downstream filters
 * spread content outside the solid (cov = 0) p clamps to 0 — plain
 * src-over. On opaque grounds without downstream filters fA = a·cov makes
 * p = 0, leaving today's output untouched.
 *
 * Bindings match blitWithMaskBindGroupLayout (uniforms, sampler, source,
 * coverage); both textures share the same uvRect/crop.
 */
export const BLIT_GLASS_PUNCH_SHADER = /* wgsl */ `
	struct Uniforms {
		viewportX: f32,
		viewportY: f32,
		zoom: f32,
		canvasWidth: f32,
		canvasHeight: f32,
		rotSin: f32,
		rotCos: f32,
	}

	struct BlitUniforms {
		boundsMinX: f32,
		boundsMinY: f32,
		boundsMaxX: f32,
		boundsMaxY: f32,
		opacity: f32,
		_pad0: f32,
		_pad1: f32,
		_pad2: f32,
		uvMinX: f32,
		uvMinY: f32,
		uvMaxX: f32,
		uvMaxY: f32,
	}

	@group(0) @binding(0) var<uniform> uniforms: Uniforms;
	@group(1) @binding(0) var<uniform> blitUniforms: BlitUniforms;
	@group(1) @binding(1) var texSampler: sampler;
	@group(1) @binding(2) var sourceTexture: texture_2d<f32>;
	@group(1) @binding(3) var coverageTexture: texture_2d<f32>;

	struct VertexOutput {
		@builtin(position) position: vec4f,
		@location(0) texCoord: vec2f,
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
		let texCoord = texCoords[vertexIndex];

		let worldX = mix(blitUniforms.boundsMinX, blitUniforms.boundsMaxX, (quadPos.x + 1.0) * 0.5);
		let worldY = mix(blitUniforms.boundsMinY, blitUniforms.boundsMaxY, (quadPos.y + 1.0) * 0.5);

		let x = (worldX - uniforms.viewportX) * uniforms.zoom;
		let y = (worldY - uniforms.viewportY) * uniforms.zoom;
		let rotX = x * uniforms.rotCos - y * uniforms.rotSin;
		let rotY = x * uniforms.rotSin + y * uniforms.rotCos;

		let ndcX = rotX / (uniforms.canvasWidth * 0.5);
		let ndcY = rotY / (uniforms.canvasHeight * 0.5);

		output.position = vec4f(ndcX, ndcY, 0.0, 1.0);
		output.texCoord = vec2f(
			mix(blitUniforms.uvMinX, blitUniforms.uvMaxX, texCoord.x),
			mix(blitUniforms.uvMinY, blitUniforms.uvMaxY, texCoord.y),
		);

		return output;
	}

	@fragment
	fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
		let fA = textureSample(sourceTexture, texSampler, input.texCoord).a;
		let cov = textureSample(coverageTexture, texSampler, input.texCoord).a;
		let o = blitUniforms.opacity;
		let p = clamp(1.0 - (1.0 - cov * o) / max(1.0 - fA * o, 1e-4), 0.0, 1.0);
		return vec4f(0.0, 0.0, 0.0, p);
	}
	`;

/**
 * Blit Shader with Mask - Composite filtered textures with alpha mask
 * Used for backdrop filters to clip the result to element shape
 */
export const BLIT_WITH_MASK_SHADER = /* wgsl */ `
	struct Uniforms {
		viewportX: f32,
		viewportY: f32,
		zoom: f32,
		canvasWidth: f32,
		canvasHeight: f32,
		rotSin: f32,
		rotCos: f32,
	}

	struct BlitUniforms {
		boundsMinX: f32,
		boundsMinY: f32,
		boundsMaxX: f32,
		boundsMaxY: f32,
		opacity: f32,
		/** 1 = invert the outer mask, 0 = leave it as-is. */
		outerMaskInvert: f32,
		_pad1: f32,
		_pad2: f32,
		uvMinX: f32,
		uvMinY: f32,
		uvMaxX: f32,
		uvMaxY: f32,
		outerMaskMinX: f32,
		outerMaskMinY: f32,
		outerMaskMaxX: f32,
		outerMaskMaxY: f32,
	}

	@group(0) @binding(0) var<uniform> uniforms: Uniforms;
	@group(1) @binding(0) var<uniform> blitUniforms: BlitUniforms;
	@group(1) @binding(1) var texSampler: sampler;
	@group(1) @binding(2) var sourceTexture: texture_2d<f32>;
	@group(1) @binding(3) var maskTexture: texture_2d<f32>;
	@group(2) @binding(0) var outerMaskAtlas: texture_2d<f32>;
	@group(2) @binding(1) var outerMaskSampler: sampler;

	struct VertexOutput {
		@builtin(position) position: vec4f,
		@location(0) texCoord: vec2f,
		@location(1) worldPos: vec2f,
	}

${OUTER_CLIP_MASK_WGSL}

	@vertex
	fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
		var output: VertexOutput;

		// Fullscreen quad vertices (NDC space)
		var positions = array<vec2f, 6>(
			vec2f(-1.0, -1.0),
			vec2f(1.0, -1.0),
			vec2f(-1.0, 1.0),
			vec2f(-1.0, 1.0),
			vec2f(1.0, -1.0),
			vec2f(1.0, 1.0),
		);

		// Texture coordinates (0,0 = top-left, 1,1 = bottom-right)
		var texCoords = array<vec2f, 6>(
			vec2f(0.0, 1.0),
			vec2f(1.0, 1.0),
			vec2f(0.0, 0.0),
			vec2f(0.0, 0.0),
			vec2f(1.0, 1.0),
			vec2f(1.0, 0.0),
		);

		let quadPos = positions[vertexIndex];
		let texCoord = texCoords[vertexIndex];

		// Transform from fullscreen quad to element bounds in world space
		let worldX = mix(blitUniforms.boundsMinX, blitUniforms.boundsMaxX, (quadPos.x + 1.0) * 0.5);
		let worldY = mix(blitUniforms.boundsMinY, blitUniforms.boundsMaxY, (quadPos.y + 1.0) * 0.5);

		// World to NDC transformation (same as stroke.wgsl.ts)
		let x = (worldX - uniforms.viewportX) * uniforms.zoom;
		let y = (worldY - uniforms.viewportY) * uniforms.zoom;
		let rotX = x * uniforms.rotCos - y * uniforms.rotSin;
		let rotY = x * uniforms.rotSin + y * uniforms.rotCos;

		let ndcX = rotX / (uniforms.canvasWidth * 0.5);
		let ndcY = rotY / (uniforms.canvasHeight * 0.5);

		output.position = vec4f(ndcX, ndcY, 0.0, 1.0);
		output.texCoord = vec2f(
			mix(blitUniforms.uvMinX, blitUniforms.uvMaxX, texCoord.x),
			mix(blitUniforms.uvMinY, blitUniforms.uvMaxY, texCoord.y),
		);
		output.worldPos = vec2f(worldX, worldY);

		return output;
	}

	@fragment
	fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
		let color = textureSample(sourceTexture, texSampler, input.texCoord);
		let mask = textureSample(maskTexture, texSampler, input.texCoord);

		// Apply mask (red channel) to premultiplied color.
		// Works with both canvas-format masks (MASK_SHADER outputs white,
		// so .r = 1 for filled pixels) and r32float compute masks.
		let masked = color * (mask.r * blitUniforms.opacity);
		return applyOuterClipMask(masked, vec2f(blitUniforms.outerMaskMinX, blitUniforms.outerMaskMinY), vec2f(blitUniforms.outerMaskMaxX, blitUniforms.outerMaskMaxY), input.worldPos, blitUniforms.outerMaskInvert);
	}
	`;

/**
 * Blit With Mask Chain — applies up to 4 world-space masks in a single pass.
 *
 * Replaces chained BLIT_WITH_MASK_SHADER passes: each mask used to cost one
 * offscreen pass + one intermediate texture, so a 3-deep clip stack tripled
 * the pass count. Here every mask is sampled by world position against its
 * own bounds and the coverages multiply in one fragment invocation.
 *
 * Unused mask slots carry the boundsMin == boundsMax sentinel (same as
 * applyOuterClipMask) and a white 1x1 texture, so they multiply by 1.
 *
 * Bind groups:
 *   group(0) — viewport uniforms (shared)
 *   group(1) — BlitUniforms + sampler + source texture + unused mask slot
 *              (same layout as BLIT_WITH_MASK_SHADER so callers reuse the
 *              blitWithMask bind group construction)
 *   group(2) — MaskChainUniforms + 4 mask textures + sampler
 */
export const BLIT_WITH_MASK_CHAIN_SHADER = /* wgsl */ `
	struct Uniforms {
		viewportX: f32,
		viewportY: f32,
		zoom: f32,
		canvasWidth: f32,
		canvasHeight: f32,
		rotSin: f32,
		rotCos: f32,
	}

	struct BlitUniforms {
		boundsMinX: f32,
		boundsMinY: f32,
		boundsMaxX: f32,
		boundsMaxY: f32,
		opacity: f32,
		outerMaskInvert: f32,
		_pad1: f32,
		_pad2: f32,
		uvMinX: f32,
		uvMinY: f32,
		uvMaxX: f32,
		uvMaxY: f32,
		outerMaskMinX: f32,
		outerMaskMinY: f32,
		outerMaskMaxX: f32,
		outerMaskMaxY: f32,
	}

	struct MaskChainUniforms {
		// One vec4f (minX, minY, maxX, maxY) per mask slot, world space.
		bounds0: vec4f,
		bounds1: vec4f,
		bounds2: vec4f,
		bounds3: vec4f,
		// 1 = invert that slot's coverage, 0 = leave as-is.
		inverts: vec4f,
		// Pixel-space atlas rects (x, y, width, height). Zero size = full texture.
		rect0: vec4f,
		rect1: vec4f,
		rect2: vec4f,
		rect3: vec4f,
	}

	@group(0) @binding(0) var<uniform> uniforms: Uniforms;
	@group(1) @binding(0) var<uniform> blitUniforms: BlitUniforms;
	@group(1) @binding(1) var texSampler: sampler;
	@group(1) @binding(2) var sourceTexture: texture_2d<f32>;
	@group(1) @binding(3) var unusedMaskTexture: texture_2d<f32>;
	@group(2) @binding(0) var<uniform> maskChain: MaskChainUniforms;
	@group(2) @binding(1) var maskTexture0: texture_2d<f32>;
	@group(2) @binding(2) var maskTexture1: texture_2d<f32>;
	@group(2) @binding(3) var maskTexture2: texture_2d<f32>;
	@group(2) @binding(4) var maskTexture3: texture_2d<f32>;
	@group(2) @binding(5) var maskSampler: sampler;

	struct VertexOutput {
		@builtin(position) position: vec4f,
		@location(0) texCoord: vec2f,
		@location(1) worldPos: vec2f,
	}

	// Mirrors applyOuterClipMask in OUTER_CLIP_MASK_WGSL: premultiplied mask,
	// luminance = brightness x opacity, empty-outside semantics for inversion.
	fn maskCoverage(sampled: vec4f, bounds: vec4f, worldPos: vec2f, invert: f32) -> f32 {
		if (bounds.x == bounds.z && bounds.y == bounds.w) {
			return 1.0;
		}
		let rawUV = (worldPos - bounds.xy) / (bounds.zw - bounds.xy);
		let maskUV = vec2f(rawUV.x, 1.0 - rawUV.y);
		let inBounds = step(0.0, maskUV.x) * step(maskUV.x, 1.0)
		             * step(0.0, maskUV.y) * step(maskUV.y, 1.0);
		let covered = dot(sampled.rgb, vec3f(0.2126, 0.7152, 0.0722)) * inBounds;
		return mix(covered, 1.0 - covered, invert);
	}

	fn maskUVFor(bounds: vec4f, rect: vec4f, textureSize: vec2f, worldPos: vec2f) -> vec2f {
		// Sentinel slots divide by zero here; the result is discarded by
		// maskCoverage's early return, and the sample itself is well-defined
		// (clamped UV into a white texture).
		let safeSize = max(bounds.zw - bounds.xy, vec2f(1e-6));
		let rawUV = (worldPos - bounds.xy) / safeSize;
		let clampedUV = clamp(vec2f(rawUV.x, 1.0 - rawUV.y), vec2f(0.0), vec2f(1.0));
		if (rect.z > 0.0 && rect.w > 0.0) {
			return (rect.xy + vec2f(0.5) + clampedUV * max(rect.zw - vec2f(1.0), vec2f(0.0))) / textureSize;
		}
		return clampedUV;
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
		let texCoord = texCoords[vertexIndex];

		let worldX = mix(blitUniforms.boundsMinX, blitUniforms.boundsMaxX, (quadPos.x + 1.0) * 0.5);
		let worldY = mix(blitUniforms.boundsMinY, blitUniforms.boundsMaxY, (quadPos.y + 1.0) * 0.5);

		let x = (worldX - uniforms.viewportX) * uniforms.zoom;
		let y = (worldY - uniforms.viewportY) * uniforms.zoom;
		let rotX = x * uniforms.rotCos - y * uniforms.rotSin;
		let rotY = x * uniforms.rotSin + y * uniforms.rotCos;

		output.position = vec4f(rotX / (uniforms.canvasWidth * 0.5), rotY / (uniforms.canvasHeight * 0.5), 0.0, 1.0);
		output.texCoord = vec2f(
			mix(blitUniforms.uvMinX, blitUniforms.uvMaxX, texCoord.x),
			mix(blitUniforms.uvMinY, blitUniforms.uvMaxY, texCoord.y),
		);
		output.worldPos = vec2f(worldX, worldY);

		return output;
	}

	@fragment
	fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
		let color = textureSample(sourceTexture, texSampler, input.texCoord);
		// textureSampleLevel needs no derivatives, so sentinel slots sampling a
		// white 1x1 dummy stay well-defined.
		let s0 = textureSampleLevel(maskTexture0, maskSampler, maskUVFor(maskChain.bounds0, maskChain.rect0, vec2f(textureDimensions(maskTexture0)), input.worldPos), 0.0);
		let s1 = textureSampleLevel(maskTexture1, maskSampler, maskUVFor(maskChain.bounds1, maskChain.rect1, vec2f(textureDimensions(maskTexture1)), input.worldPos), 0.0);
		let s2 = textureSampleLevel(maskTexture2, maskSampler, maskUVFor(maskChain.bounds2, maskChain.rect2, vec2f(textureDimensions(maskTexture2)), input.worldPos), 0.0);
		let s3 = textureSampleLevel(maskTexture3, maskSampler, maskUVFor(maskChain.bounds3, maskChain.rect3, vec2f(textureDimensions(maskTexture3)), input.worldPos), 0.0);
		let coverage = maskCoverage(s0, maskChain.bounds0, input.worldPos, maskChain.inverts.x)
		             * maskCoverage(s1, maskChain.bounds1, input.worldPos, maskChain.inverts.y)
		             * maskCoverage(s2, maskChain.bounds2, input.worldPos, maskChain.inverts.z)
		             * maskCoverage(s3, maskChain.bounds3, input.worldPos, maskChain.inverts.w);
		return color * (coverage * blitUniforms.opacity);
	}
	`;

/**
 * Blit Backdrop With Mask — replaces BLIT_WITH_STENCIL_SHADER.
 *
 * Designed for backdrop filters where the source (captured backdrop) is
 * screen-space aligned and the mask (element shape) is prebuf-sized.
 *
 * Two UV mappings:
 *   - sourceUV: derived from screen position, mapped to captured region
 *     (via sourceMinU/V/MaxU/V in BlitUniforms — identical to the old
 *     BLIT_WITH_STENCIL_SHADER UV derivation)
 *   - maskUV: (screenU, screenV) sampling the prebuf-sized mask texture
 *
 * BlitUniforms layout (same 12-float layout as other blit shaders):
 *   [0..3]  boundsMinX, boundsMinY, boundsMaxX, boundsMaxY  (world coords)
 *   [4]     opacity
 *   [5..7]  _pad
 *   [8..11] sourceMinU, sourceMinV, sourceMaxU, sourceMaxV
 */
export const BLIT_BACKDROP_WITH_MASK_SHADER = /* wgsl */ `
	struct Uniforms {
		viewportX: f32,
		viewportY: f32,
		zoom: f32,
		canvasWidth: f32,
		canvasHeight: f32,
		rotSin: f32,
		rotCos: f32,
	}

	struct BlitUniforms {
		boundsMinX: f32,
		boundsMinY: f32,
		boundsMaxX: f32,
		boundsMaxY: f32,
		opacity: f32,
		/** 1 = invert the outer mask, 0 = leave it as-is. */
		outerMaskInvert: f32,
		_pad1: f32,
		_pad2: f32,
		sourceMinU: f32,
		sourceMinV: f32,
		sourceMaxU: f32,
		sourceMaxV: f32,
		outerMaskMinX: f32,
		outerMaskMinY: f32,
		outerMaskMaxX: f32,
		outerMaskMaxY: f32,
	}

	@group(0) @binding(0) var<uniform> uniforms: Uniforms;
	@group(1) @binding(0) var<uniform> blitUniforms: BlitUniforms;
	@group(1) @binding(1) var texSampler: sampler;
	@group(1) @binding(2) var sourceTexture: texture_2d<f32>;
	@group(1) @binding(3) var maskTexture: texture_2d<f32>;
	@group(2) @binding(0) var outerMaskAtlas: texture_2d<f32>;
	@group(2) @binding(1) var outerMaskSampler: sampler;

	struct VertexOutput {
		@builtin(position) position: vec4f,
		@location(0) sourceUV: vec2f,
		@location(1) maskUV: vec2f,
		@location(2) worldPos: vec2f,
	}

${OUTER_CLIP_MASK_WGSL}

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

		let quadPos = positions[vertexIndex];

		// Transform from fullscreen quad to element bounds in world space
		let worldX = mix(blitUniforms.boundsMinX, blitUniforms.boundsMaxX, (quadPos.x + 1.0) * 0.5);
		let worldY = mix(blitUniforms.boundsMinY, blitUniforms.boundsMaxY, (quadPos.y + 1.0) * 0.5);

		// World to NDC transformation
		let x = (worldX - uniforms.viewportX) * uniforms.zoom;
		let y = (worldY - uniforms.viewportY) * uniforms.zoom;
		let rotX = x * uniforms.rotCos - y * uniforms.rotSin;
		let rotY = x * uniforms.rotSin + y * uniforms.rotCos;

		let ndcX = rotX / (uniforms.canvasWidth * 0.5);
		let ndcY = rotY / (uniforms.canvasHeight * 0.5);

		output.position = vec4f(ndcX, ndcY, 0.0, 1.0);

		// NDC -> prebuf UV (0,0 = top-left, 1,1 = bottom-right)
		let screenU = (ndcX + 1.0) * 0.5;
		let screenV = (1.0 - ndcY) * 0.5;

		// Source UV: map the bounds-local quad into the texture's used region.
		// Persistent tile assemblies may occupy only part of a quantized texture,
		// so these uniforms are texture UVs rather than prebuffer coordinates.
		let boundsUV = vec2f((quadPos.x + 1.0) * 0.5, (1.0 - quadPos.y) * 0.5);
		output.sourceUV = mix(
			vec2f(blitUniforms.sourceMinU, blitUniforms.sourceMinV),
			vec2f(blitUniforms.sourceMaxU, blitUniforms.sourceMaxV),
			boundsUV,
		);

		// Mask UV: full prebuf position (mask texture is prebuf-sized)
		output.maskUV = vec2f(screenU, screenV);

		output.worldPos = vec2f(worldX, worldY);

		return output;
	}

	@fragment
	fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
		let color = textureSample(sourceTexture, texSampler, input.sourceUV);
		let mask = textureSample(maskTexture, texSampler, input.maskUV);
		let masked = color * mask.r * blitUniforms.opacity;
		return applyOuterClipMask(masked, vec2f(blitUniforms.outerMaskMinX, blitUniforms.outerMaskMinY), vec2f(blitUniforms.outerMaskMaxX, blitUniforms.outerMaskMaxY), input.worldPos, blitUniforms.outerMaskInvert);
	}

	// Punch entry for the two-draw backdrop composite: outputs only the mask
	// coverage in alpha so a zero/one-minus-src-alpha blend scales the
	// destination by (1 - coverage) before the additive draw writes the
	// filtered backdrop. Plain src-over keyed on the filtered alpha would
	// leave the sharp backdrop showing through wherever blur softened an
	// alpha edge (visible on transparent-background exports).
	@fragment
	fn fragmentPunch(input: VertexOutput) -> @location(0) vec4f {
		let mask = textureSample(maskTexture, texSampler, input.maskUV);
		let coverage = vec4f(0.0, 0.0, 0.0, mask.r * blitUniforms.opacity);
		return applyOuterClipMask(coverage, vec2f(blitUniforms.outerMaskMinX, blitUniforms.outerMaskMinY), vec2f(blitUniforms.outerMaskMaxX, blitUniforms.outerMaskMaxY), input.worldPos, blitUniforms.outerMaskInvert);
	}
	`;

/**
 * Backdrop Resample Shader — resample a region of the (display-resolution)
 * backdrop into a fixed-resolution texture.
 *
 * Backdrop filters (frost glass, pixelate) compute their effect on a
 * rasterization-DPI grid (R = rasterizationDpi/72) instead of the live
 * viewport-zoom grid, so the result is invariant to zoom/pan. Since the
 * on-screen backdrop only exists at display resolution, we resample the
 * captured region (`uvMin`..`uvMax` in prebuf UV) into an R-sized texture
 * before filtering.
 *
 * ResampleUniforms layout (4 f32 = 16 bytes): uvMinX, uvMinY, uvMaxX, uvMaxY
 */
export const BACKDROP_RESAMPLE_SHADER = /* wgsl */ `
	struct ResampleUniforms {
		uvMin: vec2f,
		uvMax: vec2f,
	}

	@group(0) @binding(0) var<uniform> uniforms: ResampleUniforms;
	@group(0) @binding(1) var texSampler: sampler;
	@group(0) @binding(2) var sourceTexture: texture_2d<f32>;

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
		let src = mix(uniforms.uvMin, uniforms.uvMax, input.texCoord);
		return textureSample(sourceTexture, texSampler, src);
	}
	`;

/**
 * Blit with Erase Mask — Alpha subtraction compositing.
 *
 * Renders source element with mask subtracted from its alpha:
 *   finalColor = source * (1.0 - mask.a * opacity)
 *
 * Used for non-destructive erase masks on brush strokes.
 * Same bind group layout as BLIT_WITH_MASK_SHADER.
 */
export const BLIT_WITH_ERASE_MASK_SHADER = /* wgsl */ `
	struct Uniforms {
		viewportX: f32,
		viewportY: f32,
		zoom: f32,
		canvasWidth: f32,
		canvasHeight: f32,
		rotSin: f32,
		rotCos: f32,
	}

	struct BlitUniforms {
		boundsMinX: f32,
		boundsMinY: f32,
		boundsMaxX: f32,
		boundsMaxY: f32,
		opacity: f32,
		/** 1 = invert the outer mask, 0 = leave it as-is. */
		outerMaskInvert: f32,
		_pad1: f32,
		_pad2: f32,
		uvMinX: f32,
		uvMinY: f32,
		uvMaxX: f32,
		uvMaxY: f32,
		maskUvMinX: f32,
		maskUvMinY: f32,
		maskUvMaxX: f32,
		maskUvMaxY: f32,
		outerMaskMinX: f32,
		outerMaskMinY: f32,
		outerMaskMaxX: f32,
		outerMaskMaxY: f32,
	}

	@group(0) @binding(0) var<uniform> uniforms: Uniforms;
	@group(1) @binding(0) var<uniform> blitUniforms: BlitUniforms;
	@group(1) @binding(1) var texSampler: sampler;
	@group(1) @binding(2) var sourceTexture: texture_2d<f32>;
	@group(1) @binding(3) var maskTexture: texture_2d<f32>;
	@group(2) @binding(0) var outerMaskAtlas: texture_2d<f32>;
	@group(2) @binding(1) var outerMaskSampler: sampler;

	struct VertexOutput {
		@builtin(position) position: vec4f,
		@location(0) texCoord: vec2f,
		@location(1) maskTexCoord: vec2f,
		@location(2) worldPos: vec2f,
	}

${OUTER_CLIP_MASK_WGSL}

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
		let texCoord = texCoords[vertexIndex];

		let worldX = mix(blitUniforms.boundsMinX, blitUniforms.boundsMaxX, (quadPos.x + 1.0) * 0.5);
		let worldY = mix(blitUniforms.boundsMinY, blitUniforms.boundsMaxY, (quadPos.y + 1.0) * 0.5);

		let x = (worldX - uniforms.viewportX) * uniforms.zoom;
		let y = (worldY - uniforms.viewportY) * uniforms.zoom;
		let rotX = x * uniforms.rotCos - y * uniforms.rotSin;
		let rotY = x * uniforms.rotSin + y * uniforms.rotCos;

		let ndcX = rotX / (uniforms.canvasWidth * 0.5);
		let ndcY = rotY / (uniforms.canvasHeight * 0.5);

		output.position = vec4f(ndcX, ndcY, 0.0, 1.0);
		output.texCoord = vec2f(
			mix(blitUniforms.uvMinX, blitUniforms.uvMaxX, texCoord.x),
			mix(blitUniforms.uvMinY, blitUniforms.uvMaxY, texCoord.y),
		);
		output.maskTexCoord = vec2f(
			mix(blitUniforms.maskUvMinX, blitUniforms.maskUvMaxX, texCoord.x),
			mix(blitUniforms.maskUvMinY, blitUniforms.maskUvMaxY, texCoord.y),
		);
		output.worldPos = vec2f(worldX, worldY);

		return output;
	}

	@fragment
	fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
		let color = textureSample(sourceTexture, texSampler, input.texCoord);
		let mask = textureSample(maskTexture, texSampler, input.maskTexCoord);

		// Alpha subtraction: erase where mask covers
		// For premultiplied alpha: scale all channels by the erase factor
		let eraseFactor = 1.0 - mask.a * blitUniforms.opacity;
		let erased = color * eraseFactor;
		return applyOuterClipMask(erased, vec2f(blitUniforms.outerMaskMinX, blitUniforms.outerMaskMinY), vec2f(blitUniforms.outerMaskMaxX, blitUniforms.outerMaskMaxY), input.worldPos, blitUniforms.outerMaskInvert);
	}
	`;

/**
 * Exposure Blit Shader - Apply exposure and simulate PQ encode/decode roundtrip.
 *
 * The shader simulates the same pipeline as AVIF HDR export:
 *   linear × exposure → EDR headroom clamp → PQ encode → 10-bit quantize →
 *   PQ decode → linear
 *
 * This ensures the canvas preview matches the AVIF viewer output.
 * The canvas colorSpace:"display-p3" applies sRGB transfer on display.
 *
 * Uniforms:
 *   exposure:    EV stops (0 = no change)
 *   maxNits:     BT.2408 reference white (203 cd/m²). Must match exporter.
 *   edrHeadroom: max linear value as multiple of SDR white. Must match exporter.
 */
export const EXPOSURE_BLIT_SHADER = /* wgsl */ `
		struct ExposureUniforms {
			exposure: f32,
			maxNits: f32,
			edrHeadroom: f32,
		}

		struct PremultipliedColor {
			value: vec4f,
		}

		struct StraightColor {
			rgb: vec3f,
			alpha: f32,
		}

		@group(0) @binding(0) var<uniform> exposureUniforms: ExposureUniforms;
		@group(0) @binding(1) var texSampler: sampler;
		@group(0) @binding(2) var sourceTexture: texture_2d<f32>;

	struct VertexOutput {
		@builtin(position) position: vec4f,
		@location(0) texCoord: vec2f,
	}

	// sRGB EOTF: gamma signal [0,∞) → linear light [0,∞)
	// Canvas colorSpace is "display-p3" which uses sRGB transfer.
	// Values > 1.0 are extrapolated for HDR (toneMapping: "extended").
	fn srgbEotf(v: f32) -> f32 {
		if (v <= 0.04045) { return v / 12.92; }
		return pow((v + 0.055) / 1.055, 2.4);
	}

	// sRGB OETF: linear light [0,∞) → gamma signal [0,∞)
		fn srgbOetf(v: f32) -> f32 {
			if (v <= 0.0031308) { return 12.92 * v; }
			return 1.055 * pow(v, 1.0 / 2.4) - 0.055;
		}

		fn toStraight(color: PremultipliedColor) -> StraightColor {
			return StraightColor(color.value.rgb / color.value.a, color.value.a);
		}

		fn toPremultiplied(color: StraightColor) -> PremultipliedColor {
			return PremultipliedColor(vec4f(color.rgb * color.alpha, color.alpha));
		}

		// PQ constants (SMPTE ST 2084)
		const PQ_M1: f32 = 0.1593017578125;
		const PQ_M2: f32 = 78.84375;
	const PQ_C1: f32 = 0.8359375;
	const PQ_C2: f32 = 18.8515625;
	const PQ_C3: f32 = 18.6875;

	fn pqOetf(nits: f32) -> f32 {
		let y = nits / 10000.0;
		let yPow = pow(max(y, 0.0), PQ_M1);
		let num = PQ_C1 + PQ_C2 * yPow;
		let den = 1.0 + PQ_C3 * yPow;
		return pow(num / den, PQ_M2);
	}

	fn pqEotf(pq: f32) -> f32 {
		let pqPow = pow(max(pq, 0.0), 1.0 / PQ_M2);
		let num = max(pqPow - PQ_C1, 0.0);
		let den = PQ_C2 - PQ_C3 * pqPow;
		return 10000.0 * pow(num / den, 1.0 / PQ_M1);
	}

	// PQ roundtrip on LINEAR input: encode → 10-bit quantize → decode.
	// Input/output are linear light relative to maxNits (1.0 = SDR white).
	fn pqRoundtripLinear(linear: f32, maxNits: f32, headroom: f32) -> f32 {
		let clamped = min(linear, headroom);
		let pq = pqOetf(clamped * maxNits);
		let quantized = round(pq * 1023.0) / 1023.0;
		return pqEotf(quantized) / maxNits;
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

		output.position = vec4f(positions[vertexIndex], 0.0, 1.0);
		output.texCoord = texCoords[vertexIndex];
		return output;
	}

		@fragment
		fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
			let premultiplied = PremultipliedColor(
				textureSample(sourceTexture, texSampler, input.texCoord),
			);
			if (premultiplied.value.a <= 0.0) {
				return vec4f(0.0);
			}
			let straight = toStraight(premultiplied);
			let scale = pow(2.0, exposureUniforms.exposure);

			let maxNits = exposureUniforms.maxNits;
			let headroom = exposureUniforms.edrHeadroom;

			// 1. Linearize straight RGB from sRGB gamma.
			let linR = srgbEotf(straight.rgb.r);
			let linG = srgbEotf(straight.rgb.g);
			let linB = srgbEotf(straight.rgb.b);

		// 2. Apply exposure in linear light space
		let expR = linR * scale;
		let expG = linG * scale;
		let expB = linB * scale;

		// 3. PQ roundtrip on linear values (simulate AVIF 10-bit quantization)
		let r = pqRoundtripLinear(expR, maxNits, headroom);
		let g = pqRoundtripLinear(expG, maxNits, headroom);
			let b = pqRoundtripLinear(expB, maxNits, headroom);

			// 4. Re-encode to sRGB gamma, then restore premultiplied alpha.
			return toPremultiplied(
				StraightColor(
					vec3f(srgbOetf(r), srgbOetf(g), srgbOetf(b)),
					straight.alpha,
				),
			).value;
		}
	`;
