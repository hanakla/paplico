/**
 * Vertex-Pulling Geometry Shader — draws merged runs of SOLID unified
 * geometry without a vertex buffer or index buffer. The RunBatcher passes
 * a run-table slice via @builtin(instance_index) (instanceCount is always
 * 1); each vertex binary-searches its member entry and pulls the unified
 * vertex straight from the GeometryStore bound as storage. The vertex
 * stride and component indices are interpolated from unifiedVertexLayout.ts
 * (the layout SSoT).
 *
 * Bind groups:
 *   BG0: Viewport uniforms (same layout as the unified shader)
 *   BG1: Element transforms storage buffer (same layout)
 *   BG2: REPURPOSED from the gradient group — solid geometry never samples
 *        gradients (vertex colors carry everything), so the slot holds the
 *        vertex store (binding 0) and the run table (binding 1) instead.
 *   BG3: Clip mask atlas (same layout)
 *
 * Run table encoding (vec2u entries): the entry at `tableStart` is a
 * header { memberCount, 0 }; `memberCount` member entries follow, each
 * { cumulativeStart, storeFirstVertex } with cumulativeStart ascending
 * from 0 — the draw call is draw(totalVertexCount, 1, 0, tableStart).
 */

import {
	UNIFIED_VERTEX_FLOATS,
	UNIFIED_VERTEX_OFFSETS,
} from "../canvas/pipeline/unifiedVertexLayout";
import { MASK_COMMON_WGSL } from "./maskCommon.wgsl";
import { TRANSFORM_COMMON_WGSL } from "./transformCommon.wgsl";

export const UNIFIED_PULLED_GEOMETRY_SHADER = /* wgsl */ `
struct Uniforms {
	viewportX: f32,
	viewportY: f32,
	zoom: f32,
	canvasWidth: f32,
	canvasHeight: f32,
	rotSin: f32,
	rotCos: f32,
}

${TRANSFORM_COMMON_WGSL}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(1) @binding(0) var<storage, read> transforms: array<ElementTransform>;

@group(2) @binding(0) var<storage, read> vertices: array<f32>;
@group(2) @binding(1) var<storage, read> runTable: array<vec2u>;

@group(3) @binding(0) var maskAtlas: texture_2d<f32>;
@group(3) @binding(1) var maskSampler: sampler;

// Floats per unified vertex — must match GeometryStore's 36-byte stride.
const VERTEX_FLOATS = ${UNIFIED_VERTEX_FLOATS}u;

struct VertexOutput {
	@builtin(position) position: vec4f,
	@location(0) color: vec4f,
	@location(1) @interpolate(flat) maskIndex: u32,
	@location(2) maskBoundsMin: vec2f,
	@location(3) maskBoundsMax: vec2f,
	@location(4) transformedWorldPos: vec2f,
}

@vertex
fn vs_main(
	@builtin(vertex_index) vertexIndex: u32,
	@builtin(instance_index) tableStart: u32,
) -> VertexOutput {
	// Find the member whose cumulativeStart is the greatest one <= vertexIndex.
	let memberCount = runTable[tableStart].x;
	var lo = tableStart + 1u;
	var hi = tableStart + memberCount;
	while (lo < hi) {
		let mid = (lo + hi + 1u) / 2u;
		if (runTable[mid].x <= vertexIndex) {
			lo = mid;
		} else {
			hi = mid - 1u;
		}
	}
	let entry = runTable[lo];
	let base = (entry.y + (vertexIndex - entry.x)) * VERTEX_FLOATS;

	let position = vec2f(${pulledF32("position")}, ${pulledF32("position", 1)});
	let color = vec4f(
		${pulledF32("color")},
		${pulledF32("color", 1)},
		${pulledF32("color", 2)},
		${pulledF32("color", 3)},
	);
	let offset = vec2f(${pulledF32("offset")}, ${pulledF32("offset", 1)});
	let elementIndex = bitcast<u32>(${pulledF32("elementIndex")});

	var out: VertexOutput;
	let et = transforms[elementIndex];
	let transformed = applyElementTransform(position, et);
	let worldPos = transformed + offset * (1.0 / uniforms.zoom);
	let relX = (worldPos.x - uniforms.viewportX) * uniforms.zoom;
	let relY = (worldPos.y - uniforms.viewportY) * uniforms.zoom;
	let rotX = relX * uniforms.rotCos - relY * uniforms.rotSin;
	let rotY = relX * uniforms.rotSin + relY * uniforms.rotCos;
	let ndcX = rotX / (uniforms.canvasWidth * 0.5);
	let ndcY = rotY / (uniforms.canvasHeight * 0.5);
	out.position = vec4f(ndcX, ndcY, 0.0, 1.0);
	out.color = color;
	out.maskIndex = et.maskIndex;
	out.maskBoundsMin = et.maskBoundsMin;
	out.maskBoundsMax = et.maskBoundsMax;
	out.transformedWorldPos = worldPos;
	return out;
}

${MASK_COMMON_WGSL}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
	// Solid only: vertex color carries everything (premultiplied here).
	let a = in.color.a;
	let solid = vec4f(in.color.rgb * a, a);
	return applyClipMask(solid, in.maskIndex, in.maskBoundsMin, in.maskBoundsMax, in.transformedWorldPos);
}
`;

/**
 * WGSL expression pulling one float of a unified-vertex component from the
 * `vertices` storage array. `lane` selects a float within the component.
 * Offset 0 renders as `vertices[base]` (no `+ 0u`) to keep the generated
 * source identical to the previous hand-written form.
 */
function pulledF32(
	component: keyof typeof UNIFIED_VERTEX_OFFSETS,
	lane = 0,
): string {
	const floatOffset = UNIFIED_VERTEX_OFFSETS[component] + lane;
	return floatOffset === 0
		? "vertices[base]"
		: `vertices[base + ${floatOffset}u]`;
}
