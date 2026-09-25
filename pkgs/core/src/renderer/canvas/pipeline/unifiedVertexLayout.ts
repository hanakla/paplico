/**
 * Single source of truth for the unified geometry vertex layout.
 *
 * The unified layout is position2 + color4 + offset2 + elementIndex = 9 floats
 * per vertex. GeometryStore, ElementVertexBuffer, and RunBatcher derive their
 * stride from here; RenderOrchestrator builds the unified vertex buffer
 * layout's `arrayStride` and attribute offsets from these constants; and the
 * vertex-pulling WGSL (unifiedPulled.wgsl.ts) interpolates its stride and
 * component indices from the same metadata. `unifiedVertexLayout.test.ts`
 * checks that the components tile the stride exactly and that the CPU packer
 * and generated WGSL agree with this metadata.
 *
 * Internal to the renderer — not exported through any barrel.
 */

/** Float offset of each vertex component within one unified vertex. */
export const UNIFIED_VERTEX_OFFSETS = {
	position: 0,
	color: 2,
	offset: 6,
	elementIndex: 8,
} as const;

/** Float width of each vertex component (same keys as UNIFIED_VERTEX_OFFSETS). */
export const UNIFIED_VERTEX_COMPONENT_FLOATS = {
	position: 2,
	color: 4,
	offset: 2,
	elementIndex: 1,
} as const;

export const UNIFIED_VERTEX_FLOATS = 9;
export const UNIFIED_VERTEX_BYTES = UNIFIED_VERTEX_FLOATS * 4;
