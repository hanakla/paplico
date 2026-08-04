import { generateDabInstanceWgsl } from "../canvas/pipeline/brush/DabInstanceLayout";
import { STAMP_META_INDEX_MASK } from "../canvas/pipeline/brush/StampPacking";
import { COLOR_MIX_WGSL } from "./colorMix.wgsl";
import { buildDabColorWgsl, PATH_META_WGSL } from "./dabColor.wgsl";
import { GRADIENT_COMMON_WGSL } from "./gradientCommon.wgsl";
import { STROKE_WIDTH_COMMON_WGSL } from "./strokeWidthCommon.wgsl";
import { TRANSFORM_COMMON_WGSL } from "./transformCommon.wgsl";

/**
 * Mix pass chunk compute (design §10-1). Two entry points share one bind
 * group layout:
 *
 * - cs_sample: one workgroup per dab; 64 threads average the backdrop
 *   (below snapshot + current stroke buffer, premultiplied over) across an
 *   8×8 footprint weighted by the tip falloff LUT, then thread 0 writes the
 *   straight-alpha sample.
 * - cs_scan: single thread walks the chunk in dab order, evolving the
 *   persistent smudge bucket and resolving each dab's output color:
 *     bucket = mix(sample, bucket, smudgeLength)
 *     rgb    = styleMix(bucket.rgb, brushColor.rgb, colorRate²)
 *     alpha  = mix(bucket.a, brushColor.a, alphaRate)
 *
 * The bucket buffer persists across chunks (and frames, for live strokes);
 * alpha < 0 marks the not-yet-initialized bucket.
 */
export const BRUSH_MIX_SHADER = /* wgsl */ `
${generateDabInstanceWgsl("DabInstance")}
${TRANSFORM_COMMON_WGSL}
${GRADIENT_COMMON_WGSL}
${STROKE_WIDTH_COMMON_WGSL}
${COLOR_MIX_WGSL}

struct MixUniforms {
	belowMin: vec2<f32>,
	belowSize: vec2<f32>,
	strokeMin: vec2<f32>,
	strokeSize: vec2<f32>,
	firstDab: u32,
	dabCount: u32,
	sampleRadiusRatio: f32,
	sampleTrail: f32,
	blendStyle: f32,
	hasStroke: f32,
}

@group(0) @binding(0) var<uniform> u: MixUniforms;
@group(0) @binding(1) var<storage, read> dabs: array<DabInstance>;
@group(0) @binding(2) var<storage, read> mixParams: array<vec4<f32>>;
@group(0) @binding(3) var below: texture_2d<f32>;
@group(0) @binding(4) var strokeTex: texture_2d<f32>;
@group(0) @binding(5) var samp: sampler;
@group(0) @binding(6) var falloffLut: texture_2d_array<f32>;
@group(0) @binding(7) var<storage, read_write> samples: array<vec4<f32>>;
@group(0) @binding(8) var<storage, read_write> bucket: array<vec4<f32>>;
@group(0) @binding(9) var<storage, read_write> outColors: array<vec4<f32>>;
@group(0) @binding(10) var<storage, read> pathMetas: array<PathMeta>;
@group(0) @binding(11) var<storage, read> colorStops: array<ColorStop>;
@group(0) @binding(12) var<storage, read> transforms: array<ElementTransform>;

${PATH_META_WGSL}
${buildDabColorWgsl(STAMP_META_INDEX_MASK)}

/** The dab's own brush color, resolved exactly as the dab shader would.
 *  Across-width gradients collapse to the width center (see resolveDabColor). */
fn brushColorOf(dab: DabInstance) -> vec4<f32> {
	let pm = pathMetas[pathIndexOf(dab)];
	let worldPos = applyElementTransform(
		vec2f(dab.positionX, dab.positionY),
		transforms[pm.transformIndex],
	);
	return resolveDabColor(dab, pm, worldPos, dab.pathT, 0.0);
}

const FOOT: u32 = 8u;

var<workgroup> wgColor: array<vec4f, 64>;
var<workgroup> wgWeight: array<f32, 64>;

@compute @workgroup_size(64)
fn cs_sample(
	@builtin(workgroup_id) wg: vec3u,
	@builtin(local_invocation_index) li: u32,
) {
	let dab = dabs[u.firstDab + wg.x];
	let radius = max(max(dab.sizeX, dab.sizeY) * 0.5 * u.sampleRadiusRatio, 0.5);
	let dir = vec2f(dab.strokeDirX, dab.strokeDirY);
	let center = vec2f(dab.positionX, dab.positionY)
		+ dir * (u.sampleTrail * radius);
	let cell = vec2f(f32(li % FOOT), f32(li / FOOT));
	let off = ((cell + vec2f(0.5)) / f32(FOOT)) * 2.0 - vec2f(1.0);
	let r = length(off);
	var weight = 0.0;
	var color = vec4f(0.0);
	if (r <= 1.0) {
		let lutLayer = clamp(i32(round(dab.hardnessLutIndex)), 0, 31);
		weight = textureSampleLevel(
			falloffLut, samp, vec2f(r, 0.5), lutLayer, 0.0,
		).r;
		let p = center + off * radius;
		let uv = vec2f(
			(p.x - u.belowMin.x) / u.belowSize.x,
			1.0 - (p.y - u.belowMin.y) / u.belowSize.y,
		);
		if (all(uv >= vec2f(0.0)) && all(uv <= vec2f(1.0))) {
			var c = textureSampleLevel(below, samp, uv, 0.0);
			if (u.hasStroke > 0.5) {
				// The stroke buffer spans its own world rect, not the backdrop's
				// canvas-clamped one: sample it through its own uv.
				let strokeUv = vec2f(
					(p.x - u.strokeMin.x) / u.strokeSize.x,
					1.0 - (p.y - u.strokeMin.y) / u.strokeSize.y,
				);
				if (all(strokeUv >= vec2f(0.0)) && all(strokeUv <= vec2f(1.0))) {
					let s = textureSampleLevel(strokeTex, samp, strokeUv, 0.0);
					c = s + c * (1.0 - s.a);
				}
			}
			color = c * weight;
		} else {
			weight = 0.0;
		}
	}
	wgColor[li] = color;
	wgWeight[li] = weight;
	workgroupBarrier();
	var stride = 32u;
	loop {
		if (li < stride) {
			wgColor[li] += wgColor[li + stride];
			wgWeight[li] += wgWeight[li + stride];
		}
		workgroupBarrier();
		if (stride == 1u) { break; }
		stride = stride >> 1u;
	}
	if (li == 0u) {
		let totalWeight = wgWeight[0];
		let accumulated = wgColor[0];
		var sampled: vec4f;
		if (totalWeight <= 1e-6 || accumulated.a <= 1e-5 * totalWeight) {
			// Transparent footprint: nothing to pick up. cs_scan substitutes
			// the dab's own brush color for the zero-alpha sample.
			sampled = vec4f(0.0);
		} else {
			let avg = accumulated / totalWeight;
			sampled = vec4f(avg.rgb / max(avg.a, 1e-5), avg.a);
		}
		samples[wg.x] = sampled;
	}
}

@compute @workgroup_size(1)
fn cs_scan() {
	var b = bucket[0];
	for (var i = 0u; i < u.dabCount; i++) {
		let brushColor = brushColorOf(dabs[u.firstDab + i]);
		var smp = samples[i];
		if (smp.a <= 0.0) {
			smp = vec4f(brushColor.rgb, 0.0);
		}
		let mp = mixParams[i];
		if (b.w < 0.0) {
			b = smp;
		}
		b = mix(smp, b, clamp(mp.z, 0.0, 1.0));
		let rate = clamp(mp.x, 0.0, 1.0);
		let rgbRate = rate * rate;
		let vivid = mixOklchPigmentColor(b.rgb, brushColor.rgb, rgbRate);
		let muted = mixOklabPigmentColor(b.rgb, brushColor.rgb, rgbRate);
		let rgb = mix(vivid, muted, clamp(u.blendStyle, 0.0, 1.0));
		let alpha = mix(b.a, brushColor.a, clamp(mp.y, 0.0, 1.0));
		outColors[i] = vec4f(rgb, alpha);
	}
	bucket[0] = b;
}
`;
