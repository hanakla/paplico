// Bitonic pixel sort ported to WGSL from ruccho/BitonicPixelSorter (MIT):
// https://github.com/ruccho/BitonicPixelSorter
//
// One workgroup sorts one chunk of one line entirely in workgroup memory:
// pack sort keys (index + f16 brightness), resolve in-threshold span
// boundaries with parallel scans, size the bitonic network to the longest
// span, sort, then gather full-color pixels by the sorted indices.
// Deviations from the original:
// - lines longer than one chunk split into independently sorted chunks
//   (the original rejects sources over 4096px)
// - lines run at an arbitrary angle as shear-decomposed digital lines
//   (minor = c + round(major * slope), axes swapped for steep angles), so
//   every pixel belongs to exactly one line and colors are never resampled
// - a strength uniform truncates the bitonic stage schedule (partial sort)

export const PIXEL_SORT_THREADS = 128;
export const PIXEL_SORT_CHUNK_SIZE = 2048;
const PIXEL_SORT_PAIRS = PIXEL_SORT_CHUNK_SIZE / PIXEL_SORT_THREADS / 2;

export const HK_PIXEL_SORT_SHADER = /* wgsl */ `
const MAX_THREADS = ${PIXEL_SORT_THREADS}u;
const MAX_SIZE = ${PIXEL_SORT_CHUNK_SIZE}u;
const MAX_PAIRS = ${PIXEL_SORT_PAIRS}u; // comparator pairs per thread

struct Uniforms {
	thresholdMin: f32,
	thresholdMax: f32,
	// 1 = ascending brightness along the traversal direction
	ordering: u32,
	// 1: lines step along x with y sheared, 0: along y with x sheared
	xMajor: u32,
	// minor-axis shear per major-axis step (tan/cot of the sort angle, in [-1, 1])
	slope: f32,
	// line index of workgroup 0 (precomputed CPU-side with slack lines)
	cMin: i32,
	// fraction of the bitonic stage schedule to run (0-1 partial sort)
	strength: f32,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var srcTex: texture_2d<f32>;
@group(0) @binding(2) var sortTex: texture_storage_2d<rgba8unorm, write>;
// Bound only by the blit entry points below, never by sortPass
@group(0) @binding(3) var blitTexture: texture_2d<f32>;

// groupCache entry: original chunk-local index in the high 16 bits and the
// f16 brightness in the low 16 bits, so a compare-exchange is a u32 swap.
var<workgroup> groupCache: array<u32, MAX_SIZE>;
var<workgroup> scanCache: array<u32, MAX_THREADS>;

fn brightness(col: vec4f) -> f32 {
	return saturate(dot(col.rgb, vec3f(0.298912, 0.586611, 0.114478)));
}

// Texel of line c at position t along the major axis. The digital lines
// minor = c + floor(major * slope + 0.5) partition the pixel grid exactly:
// every pixel belongs to exactly one (c, t) pair.
fn texelFor(c: i32, t: u32) -> vec2i {
	let sheared = c + i32(floor(f32(t) * uniforms.slope + 0.5));
	return select(vec2i(sheared, i32(t)), vec2i(i32(t), sheared), uniforms.xMajor == 1u);
}

fn copyTexel(dst: vec2i, src: vec2i, dims: vec2i) {
	if (all(dst >= vec2i(0)) && all(dst < dims)) {
		textureStore(sortTex, vec2u(dst), textureLoad(srcTex, src, 0));
	}
}

@compute @workgroup_size(${PIXEL_SORT_THREADS})
fn sortPass(
	@builtin(workgroup_id) workgroupId: vec3u,
	@builtin(local_invocation_id) localId: vec3u,
) {
	let c = i32(workgroupId.x) + uniforms.cMin; // line index
	let chunkBase = workgroupId.y * MAX_SIZE;
	let gtid = localId.x;

	let ascendingOrder = uniforms.ordering != 0u;
	let dims = vec2i(textureDimensions(srcTex));
	let majorSize = u32(select(dims.y, dims.x, uniforms.xMajor == 1u));
	let size = min(majorSize - chunkBase, MAX_SIZE);

	let reducedSize = (size + 1u) >> 1u;
	let ops = (reducedSize + MAX_THREADS - 1u) / MAX_THREADS;
	let pairBase = gtid * ops; // contiguous chunk of pairs per thread

	// load pixels: build sort keys and an in-threshold mask for this thread's chunk
	var rangeMask = 0u; // bit (2t): xL in threshold range, bit (2t+1): xR
	for (var t = 0u; t < ops; t++) {
		let xL = (pairBase + t) << 1u;
		let xR = xL + 1u;

		let posL = texelFor(c, chunkBase + xL);
		let posR = texelFor(c, chunkBase + xR);
		let inRectL = all(posL >= vec2i(0)) && all(posL < dims);
		let inRectR = all(posR >= vec2i(0)) && all(posR < dims);

		let brL = brightness(textureLoad(srcTex, posL, 0));
		let brR = brightness(textureLoad(srcTex, posR, 0));

		let inL = xL < size && inRectL && uniforms.thresholdMin <= brL && brL <= uniforms.thresholdMax;
		let inR = xR < size && inRectR && uniforms.thresholdMin <= brR && brR <= uniforms.thresholdMax;

		rangeMask |= select(0u, 1u, inL) << (t * 2u);
		rangeMask |= select(0u, 1u, inR) << (t * 2u + 1u);

		groupCache[xL] = (xL << 16u) | (pack2x16float(vec2f(brL, 0.0)) & 0xFFFFu);
		groupCache[xR] = (xR << 16u) | (pack2x16float(vec2f(brR, 0.0)) & 0xFFFFu);
	}

	// A chunk with no in-threshold pixel has nothing to sort (common for
	// transparent padding, out-of-threshold regions and the slack lines of
	// the shear dispatch): copy the line through and skip the span scans +
	// sort network entirely.
	scanCache[gtid] = rangeMask;
	workgroupBarrier();
	for (var offset = MAX_THREADS >> 1u; offset > 0u; offset >>= 1u) {
		if (gtid < offset) { scanCache[gtid] |= scanCache[gtid + offset]; }
		workgroupBarrier();
	}
	if (workgroupUniformLoad(&scanCache[0]) == 0u) {
		for (var t = 0u; t < ops; t++) {
			let xL = (pairBase + t) << 1u;
			let xR = xL + 1u;
			if (xL < size) {
				let pos = texelFor(c, chunkBase + xL);
				copyTexel(pos, pos, dims);
			}
			if (xR < size) {
				let pos = texelFor(c, chunkBase + xR);
				copyTexel(pos, pos, dims);
			}
		}
		return;
	}

	var preMeta: array<u32, MAX_PAIRS>;

	// forward pass: resolve the start index of the span containing each pair
	{
		// (last out-of-threshold index in this chunk) + 1, 0 if none
		var seed = 0u;
		for (var t = 0u; t < ops; t++) {
			let xL = (pairBase + t) << 1u;
			if ((rangeMask & (1u << (t * 2u))) == 0u) { seed = xL + 1u; }
			if ((rangeMask & (2u << (t * 2u))) == 0u) { seed = xL + 2u; }
		}

		scanCache[gtid] = seed;
		workgroupBarrier();

		// inclusive prefix-max scan across threads (Hillis-Steele)
		for (var offset = 1u; offset < MAX_THREADS; offset <<= 1u) {
			let own = scanCache[gtid];
			let other = scanCache[max(gtid, offset) - offset]; // clamped to keep the index valid
			workgroupBarrier();
			scanCache[gtid] = max(own, select(0u, other, gtid >= offset));
			workgroupBarrier();
		}

		var carry = select(0u, scanCache[max(gtid, 1u) - 1u], gtid > 0u); // exclusive prefix

		for (var t = 0u; t < ops; t++) {
			let xL = (pairBase + t) << 1u;
			let inL = (rangeMask & (1u << (t * 2u))) != 0u;
			let inR = (rangeMask & (2u << (t * 2u))) != 0u;

			var start: u32;
			if (inL) {
				start = carry; // span containing xL
			} else {
				carry = xL + 1u;
				start = select(xL, carry, inR); // span starting at xR, or a no-op pair
			}
			if (!inR) { carry = xL + 2u; }

			preMeta[t] = start << 16u;
		}

		workgroupBarrier(); // scanCache reads are done; safe to reuse below
	}

	var lineLevels = 0u;

	// backward pass: resolve the end index of each span and the longest span in this line
	{
		// first out-of-threshold index in this chunk, 0xFFFF if none
		var seed = 0xFFFFu;
		for (var ti = ops; ti > 0u; ti--) {
			let t = ti - 1u;
			let xL = (pairBase + t) << 1u;
			if ((rangeMask & (2u << (t * 2u))) == 0u) { seed = xL + 1u; }
			if ((rangeMask & (1u << (t * 2u))) == 0u) { seed = xL; }
		}

		scanCache[gtid] = seed;
		workgroupBarrier();

		// inclusive suffix-min scan across threads (Hillis-Steele)
		for (var offset = 1u; offset < MAX_THREADS; offset <<= 1u) {
			let own = scanCache[gtid];
			let other = scanCache[min(gtid + offset, MAX_THREADS - 1u)]; // clamped to keep the index valid
			workgroupBarrier();
			scanCache[gtid] = min(own, select(0xFFFFu, other, gtid + offset < MAX_THREADS));
			workgroupBarrier();
		}

		var carry = select(0xFFFFu, scanCache[min(gtid + 1u, MAX_THREADS - 1u)], gtid + 1u < MAX_THREADS); // exclusive suffix

		var maxLen = 1u;
		for (var ti = ops; ti > 0u; ti--) {
			let t = ti - 1u;
			let xL = (pairBase + t) << 1u;
			let inL = (rangeMask & (1u << (t * 2u))) != 0u;
			let inR = (rangeMask & (2u << (t * 2u))) != 0u;

			if (!inR) { carry = xL + 1u; }

			var start = preMeta[t] >> 16u;
			var end = select(xL, min(carry, size) - 1u, inL || inR);

			if (!inL) { carry = xL; }

			// pairs whose comparator slot falls outside the span must not emit comparators
			// (they would race with the thread that owns the slot)
			let xSlot = xL + (start & 1u);
			let valid = end > start && xSlot <= end;
			start = select(xSlot, start, valid);
			end = select(xSlot, end, valid);

			preMeta[t] = (start << 16u) | end;
			maxLen = max(maxLen, end - start + 1u);
		}

		workgroupBarrier(); // scanCache reads are done; safe to reuse below

		scanCache[gtid] = maxLen;
		workgroupBarrier();

		for (var offset = MAX_THREADS >> 1u; offset > 0u; offset >>= 1u) {
			if (gtid < offset) { scanCache[gtid] = max(scanCache[gtid], scanCache[gtid + offset]); }
			workgroupBarrier();
		}

		let lineMax = workgroupUniformLoad(&scanCache[0]);

		// just enough phases for the longest span. one extra merge phase for exact
		// power-of-two lengths so that every span ends up merged in the same direction
		lineLevels = select(firstLeadingBit(lineMax) + 1u, 0u, lineMax <= 1u);
	}

	// partial sort: run only the leading fraction of the stage schedule
	let totalStages = lineLevels * (lineLevels + 1u) / 2u;
	let runStages = min(totalStages, u32(ceil(f32(totalStages) * saturate(uniforms.strength))));

	var stage = 0u;
	for (var level = 0u; level < lineLevels; level++) {
		for (var subShift = level + 1u; subShift > 0u; subShift--) {
			let sublevel = subShift - 1u;
			workgroupBarrier();

			if (stage < runStages) {
				for (var t = 0u; t < ops; t++) {
					let metaPacked = preMeta[t];
					let rangeStart = metaPacked >> 16u;
					let rangeEnd = metaPacked & 0xFFFFu;

					let x = (pairBase + t) << 1u;

					let useR = rangeStart & 1u;
					let posInRange = x - rangeStart + useR;
					let swapIndex = posInRange >> 1u;
					let comparatorSize = 1u << sublevel;
					let a = rangeStart + (swapIndex & (comparatorSize - 1u))
						+ (swapIndex >> sublevel) * (comparatorSize << 1u);

					var b = a + comparatorSize;
					b = select(a, b, b <= rangeEnd); // odd-network: clamp to a self-compare

					// "block" is a reserved word for wgsl_reflect (webgpu-utils), hence mergeBlock
					let mergeBlock = (posInRange >> 1u) >> level;
					let n = rangeEnd - rangeStart + 1u;
					let endBlock = n >> (level + 1u);
					let endBlockEven = (endBlock & 1u) == 0u;
					let ascPattern = endBlockEven == ascendingOrder;
					let mergeBlockEven = (mergeBlock & 1u) == 0u;
					let asc = mergeBlockEven == ascPattern;

					// compare

					let valA = groupCache[a];
					let valB = groupCache[b];

					let brA = unpack2x16float(valA & 0xFFFFu).x;
					let brB = unpack2x16float(valB & 0xFFFFu).x;

					let comp = brA < brB;
					let keepOrder = asc == comp;

					groupCache[a] = select(valB, valA, keepOrder);
					groupCache[b] = select(valA, valB, keepOrder);
				}
			}
			stage = stage + 1u;
		}
	}

	workgroupBarrier(); // make the last level's cross-thread swaps visible

	// gather full-color pixels from the source by the sorted indices
	for (var t = 0u; t < ops; t++) {
		let xL = (pairBase + t) << 1u;
		let xR = xL + 1u;

		if (xL < size) {
			let idx = groupCache[xL] >> 16u;
			copyTexel(texelFor(c, chunkBase + xL), texelFor(c, chunkBase + idx), dims);
		}
		if (xR < size) {
			let idx = groupCache[xR] >> 16u;
			copyTexel(texelFor(c, chunkBase + xR), texelFor(c, chunkBase + idx), dims);
		}
	}
}

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
fn blitMain(input: VertexOutput) -> @location(0) vec4f {
	return textureLoad(blitTexture, vec2u(input.position.xy), 0);
}
`;
