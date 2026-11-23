/**
 * FrostGlass (Frosted Glass / Backdrop Blur) Filter Shaders
 * Blurs the background behind an element with optional tint and saturation adjustment.
 *
 * Two variants share the vertex/scatter/color helpers:
 * - FROST_GLASS_PYRAMID_SHADER: single pass that lerps the two pre-blurred
 *   backdrop pyramid levels bracketing the blur sigma (shared batch capture),
 *   then applies scatter/saturation/tint.
 * - FROST_GLASS_SHADER: self-contained separable Gaussian, used as a
 *   fallback when no shared pyramid is available (horizontal pass, then
 *   vertical pass with tint/saturation applied).
 * - FROST_GLASS_RIM_SHADER: optional last pass that refracts and lights the
 *   blurred result along the element's rounded edge.
 *
 * Backdrop mask is applied by FilterRenderer after all filter passes.
 */

const FROST_GLASS_COMMON = /* wgsl */ `
struct VertexOutput {
	@builtin(position) position: vec4f,
	@location(0) texCoord: vec2f,
}

// Fullscreen quad vertex shader
@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
	var output: VertexOutput;

	// Generate fullscreen triangle
	let x = f32((vertexIndex & 1u) << 1u);
	let y = f32(vertexIndex & 2u);

	output.position = vec4f(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);
	output.texCoord = vec2f(x, y);

	return output;
}

// Convert RGB to luminance
fn luminance(color: vec3f) -> f32 {
	return dot(color, vec3f(0.299, 0.587, 0.114));
}

// Apply saturation adjustment
fn adjustSaturation(color: vec3f, saturation: f32) -> vec3f {
	let lum = luminance(color);
	let grey = vec3f(lum);
	return mix(grey, color, saturation);
}

// Apply tint overlay
fn applyTint(color: vec3f, tint: vec3f, opacity: f32) -> vec3f {
	return mix(color, tint, opacity);
}

fn hash(p: vec2u, seed: u32) -> u32 {
	var state = p.x ^ (p.y << 8u) ^ seed;
	state = state ^ (state >> 16u);
	state = state * 0x45d9f3bu;
	state = state ^ (state >> 16u);
	state = state * 0x45d9f3bu;
	state = state ^ (state >> 16u);
	return state;
}

fn hashToFloat(h: u32) -> f32 {
	return f32(h) / 4294967295.0;
}

fn randomOffset(coord: vec2u, seed: u32, strength: f32) -> vec2f {
	let h1 = hash(coord, seed);
	let h2 = hash(coord + vec2u(1u, 0u), seed);

	let angle = hashToFloat(h1) * 6.28318530718;
	let radius = hashToFloat(h2) * strength;

	return vec2f(cos(angle) * radius, sin(angle) * radius);
}

// Spraying-style random displacement (block offset + finer per-world-px
// offset) applied before the blur, so the blur softens the scattered
// grain like a real frosted pane. Cells are hashed in world px so the
// pattern's form is invariant to rasterization scale and viewport zoom.
fn scatterCoord(
	texCoord: vec2f,
	resolution: vec2f,
	sourceOffset: vec2f,
	dpiScale: f32,
	scatter: f32,
	scatterGrain: f32,
) -> vec2f {
	let worldPos = sourceOffset + texCoord * resolution / dpiScale;
	let grain = max(scatterGrain, 1.0);
	let blockCoord = vec2u(worldPos / grain);
	let fineCoord = vec2u(worldPos);
	let scatterOffset = randomOffset(blockCoord, 0u, scatter)
		+ randomOffset(fineCoord, 12345u, scatter * 0.3);
	return texCoord + scatterOffset * dpiScale / resolution;
}
`;

export const FROST_GLASS_PYRAMID_SHADER = /* wgsl */ `
struct Uniforms {
	remap: vec4f, // region uv -> batch uv: batch = xy + uv * zw
	loCtl: vec4f, // blurLo used-area ctl (xy scale, zw half texel)
	hiCtl: vec4f, // blurHi used-area ctl
	blurMix: f32, // lerp factor between the two levels
	saturation: f32, // 0.0~2.0 (1.0 = normal)
	tintR: f32,
	tintG: f32,
	tintB: f32,
	tintOpacity: f32, // 0.0~1.0
	zoomCenter: vec2f, // pane centre in region uv
	zoom: f32, // read scale about zoomCenter (1 = read in place)
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var blurLoTexture: texture_2d<f32>;
@group(0) @binding(2) var blurHiTexture: texture_2d<f32>;
@group(0) @binding(3) var inputSampler: sampler;

${FROST_GLASS_COMMON}

// Lerp the two pre-blurred pyramid levels bracketing the blur sigma, then
// apply saturation and tint. The levels cover the whole shared batch
// capture, so the region uv is remapped into it first. Scatter never runs
// here: it must displace BEFORE the blur softens it, so scattering filters
// stay on the self-contained FROST_GLASS_SHADER path.
@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
	let uv = uniforms.zoomCenter + (input.texCoord - uniforms.zoomCenter) * uniforms.zoom;
	let regionUv = uniforms.remap.xy + uv * uniforms.remap.zw;
	let loUv = clamp(regionUv, uniforms.loCtl.zw, vec2f(1.0) - uniforms.loCtl.zw)
		* uniforms.loCtl.xy;
	let hiUv = clamp(regionUv, uniforms.hiCtl.zw, vec2f(1.0) - uniforms.hiCtl.zw)
		* uniforms.hiCtl.xy;
	let result = mix(
		textureSample(blurLoTexture, inputSampler, loUv),
		textureSample(blurHiTexture, inputSampler, hiUv),
		uniforms.blurMix,
	);

	let hasAlpha = result.a > 0.001;

	// Un-premultiply for perceptual color adjustments
	let straightRgb = select(vec3f(0.0), result.rgb / result.a, hasAlpha);
	var adjusted = adjustSaturation(straightRgb, uniforms.saturation);
	let tint = vec3f(uniforms.tintR, uniforms.tintG, uniforms.tintB);
	adjusted = applyTint(adjusted, tint, uniforms.tintOpacity);
	// Re-premultiply
	let adjustedResult = vec4f(adjusted * result.a, result.a);

	return select(result, adjustedResult, hasAlpha);
}
`;

export const FROST_GLASS_SHADER = /* wgsl */ `
struct Uniforms {
	resolution: vec2f,
	sourceOffset: vec2f, // captured subsection origin in the full region, in world px
	direction: vec2f, // (1, 0) for horizontal, (0, 1) for vertical
	radius: f32,
	saturation: f32, // 0.0~2.0 (1.0 = normal)
	// Tint color (applied in final pass only)
	tintR: f32,
	tintG: f32,
	tintB: f32,
	tintOpacity: f32, // 0.0~1.0
	applyEffects: f32, // 1.0 = apply saturation/tint (vertical pass), 0.0 = skip (horizontal pass)
	// Random backdrop displacement (frosted grain), in world px
	scatter: f32,
	scatterGrain: f32, // block size of the scatter pattern, in world px
	applyScatter: f32, // 1.0 = displace sample coords (horizontal pass only)
	dpiScale: f32, // texels per world px of the input texture
	zoomCenter: vec2f, // pane centre in uv
	zoom: f32, // read scale about zoomCenter; 1 in the vertical pass
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var inputSampler: sampler;

${FROST_GLASS_COMMON}

// FrostGlass fragment shader
// Combines Gaussian blur with saturation and tint adjustments
@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
	let texelSize = 1.0 / uniforms.resolution;
	let offset = uniforms.direction * texelSize;

	// A pane above the backdrop reads a wider patch of it. Scaling the read
	// before the horizontal blur gives the vertical pass the scaled picture.
	var baseCoord = uniforms.zoomCenter + (input.texCoord - uniforms.zoomCenter) * uniforms.zoom;
	if (uniforms.applyScatter > 0.5 && uniforms.scatter > 0.0) {
		baseCoord = scatterCoord(
			baseCoord,
			uniforms.resolution,
			uniforms.sourceOffset,
			uniforms.dpiScale,
			uniforms.scatter,
			uniforms.scatterGrain,
		);
	}

	// Kernel sized from the radius like the standalone blur filter, with
	// adjacent taps merged into bilinear pairs. The former fixed ±20-texel
	// loop capped the effective radius at 20/dpiScale world px, so high-DPI
	// exports and zoomed-in views sharpened the frost. The ±300-texel
	// bound is a GPU safety cap (covers a 50 world-px radius at 300 DPI).
	let radius = min(uniforms.radius, 300.0);
	let kernelSize = i32(ceil(radius * 2.0)) | 1;
	let halfKernel = kernelSize / 2;
	let sigma = max(radius / 2.0, 0.001);
	let sigma2 = sigma * sigma;

	var colorSum = textureSample(inputTexture, inputSampler, baseCoord);
	var totalWeight = 1.0;

	for (var i = 1; i <= halfKernel; i = i + 2) {
		let w1 = exp(-f32(i * i) / (2.0 * sigma2));
		if (i + 1 <= halfKernel) {
			let w2 = exp(-f32((i + 1) * (i + 1)) / (2.0 * sigma2));
			let w = w1 + w2;
			let t = (f32(i) * w1 + f32(i + 1) * w2) / w;

			colorSum += textureSample(inputTexture, inputSampler, baseCoord + t * offset) * w;
			colorSum += textureSample(inputTexture, inputSampler, baseCoord - t * offset) * w;
			totalWeight += 2.0 * w;
		} else {
			// Odd tail tap sampled alone to keep the discrete tap set.
			colorSum += textureSample(inputTexture, inputSampler, baseCoord + f32(i) * offset) * w1;
			colorSum += textureSample(inputTexture, inputSampler, baseCoord - f32(i) * offset) * w1;
			totalWeight += 2.0 * w1;
		}
	}

	var result = colorSum / totalWeight;

	// Apply saturation and tint only in the final pass (vertical pass)
	let hasAlpha = result.a > 0.001;
	let doEffects = uniforms.applyEffects > 0.5;

	// Un-premultiply for perceptual color adjustments
	let straightRgb = select(vec3f(0.0), result.rgb / result.a, hasAlpha);
	var adjusted = adjustSaturation(straightRgb, uniforms.saturation);
	let tint = vec3f(uniforms.tintR, uniforms.tintG, uniforms.tintB);
	adjusted = applyTint(adjusted, tint, uniforms.tintOpacity);
	// Re-premultiply
	let adjustedResult = vec4f(adjusted * result.a, result.a);

	// Select final result based on conditions (no branching)
	let effectResult = select(result, adjustedResult, doEffects && hasAlpha);

	return effectResult;
}
`;

/**
 * Lens rim pass, run on the blurred backdrop when refraction or highlight is
 * set. The element is treated as a flat pane whose edge rounds over a band
 * `bevel` texels wide. Inside that band the backdrop is read from further
 * inward, the way a convex rim magnifies, and a highlight brightens the rim
 * where it faces the light. The band is measured with the jump-flood field
 * seeded on the pixels outside the shape, so each pixel knows the nearest
 * outside point and therefore its distance and direction to the edge.
 */
export const FROST_GLASS_RIM_SHADER = /* wgsl */ `
struct Uniforms {
	resolution: vec2f,
	refraction: f32, // backdrop shift at the very edge, in texels
	bevel: f32, // width of the rounded rim, in texels
	aberration: f32, // per-channel spread of the shift (0 = none)
	highlight: f32, // rim highlight strength (0~1)
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var inputSampler: sampler;
@group(0) @binding(3) var coordTexture: texture_2d<f32>;

${FROST_GLASS_COMMON}

// Top-left in texture space (y down).
const LIGHT_DIR = vec2f(-0.70710678, -0.70710678);

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
	let uv = input.texCoord;
	let base = textureSampleLevel(inputTexture, inputSampler, uv, 0.0);
	let p = input.position.xy;
	let seed = textureLoad(coordTexture, vec2i(p), 0).xy;
	// Pixels outside the shape are their own seed (distance 0); pixels past
	// the field's reach carry the sentinel. Neither lies on the rim.
	let dist = distance(seed, p);
	if (seed.x <= -1e5 || dist < 0.5 || dist >= uniforms.bevel) {
		return base;
	}

	let outward = edgeNormal(p, dist);
	// 0 where the rim meets the flat face, 1 at the edge. Squared so the
	// shift grows smoothly out of the flat face without a visible crease.
	let t = 1.0 - clamp(edgeDistance(p) / uniforms.bevel, 0.0, 1.0);
	let shift = outward * (uniforms.refraction * t * t) / uniforms.resolution;
	let g = textureSampleLevel(inputTexture, inputSampler, uv - shift, 0.0);
	let r = textureSampleLevel(
		inputTexture, inputSampler, uv - shift * (1.0 + uniforms.aberration), 0.0,
	);
	let b = textureSampleLevel(
		inputTexture, inputSampler, uv - shift * (1.0 - uniforms.aberration), 0.0,
	);
	let refracted = vec4f(r.r, g.g, b.b, g.a);

	// Both the lit edge and the one opposite it catch light, like a real pane.
	let facing = abs(dot(outward, LIGHT_DIR));
	let rim = uniforms.highlight * t * t * t * (0.35 + 0.65 * facing);
	// Screen toward white inside the premultiplied coverage.
	return vec4f(
		refracted.rgb + (vec3f(refracted.a) - refracted.rgb) * rim,
		refracted.a,
	);
}

// The seeds sit on the texel staircase of the shape. The direction to the
// nearest one swings in a fan around each stair corner, and the distance per
// texel steps with each stair, which streaks a curved edge. Interpolating the
// distance between texels smooths the steps, and its slope over a ring that
// spans several stairs gives the edge's normal. A wider rim shifts the
// backdrop further, which magnifies any error in the normal, so the ring
// grows with the rim.
fn edgeNormal(p: vec2f, dist: f32) -> vec2f {
	let radius = max(max(3.0, uniforms.bevel * 0.15), dist * 0.5);
	var inward = vec2f(0.0);
	for (var i = 0; i < 16; i++) {
		let angle = f32(i) * 0.39269908;
		let direction = vec2f(cos(angle), sin(angle));
		inward += edgeDistance(p + direction * radius) * direction;
	}
	return -normalize(inward);
}

// Distance to the edge at any point, bilinear between the texel centres.
// Outside the shape it is 0.
fn edgeDistance(q: vec2f) -> f32 {
	let origin = floor(q - 0.5);
	let f = q - 0.5 - origin;
	let top = mix(texelDistance(origin), texelDistance(origin + vec2f(1.0, 0.0)), f.x);
	let bottom = mix(
		texelDistance(origin + vec2f(0.0, 1.0)),
		texelDistance(origin + vec2f(1.0, 1.0)),
		f.x,
	);
	return mix(top, bottom, f.y);
}

fn texelDistance(texel: vec2f) -> f32 {
	let dims = vec2f(textureDimensions(coordTexture, 0));
	let centre = clamp(texel, vec2f(0.0), dims - 1.0) + 0.5;
	let seed = textureLoad(coordTexture, vec2i(centre), 0).xy;
	// Past the field's reach the pixel is deep inside the flat face.
	return select(distance(seed, centre), uniforms.bevel, seed.x <= -1e5);
}
`;
