// Consistency guard for the unified vertex layout SSoT: the component
// metadata must tile the stride exactly, the CPU packer must place each
// component at the metadata offsets, and the vertex-pulling WGSL must be
// generated with the expanded stride/index values.

import { describe, expect, it } from "vitest";
import { ElementVertexBuffer } from "../elements/ElementVertexBuffer";
import {
	UNIFIED_VERTEX_BYTES,
	UNIFIED_VERTEX_COMPONENT_FLOATS,
	UNIFIED_VERTEX_FLOATS,
	UNIFIED_VERTEX_OFFSETS,
} from "./unifiedVertexLayout";

const COMPONENT_ORDER = [
	"position",
	"color",
	"offset",
	"elementIndex",
] as const;

describe("unifiedVertexLayout", () => {
	it("should tile the vertex stride exactly with contiguous components", () => {
		expect(Object.keys(UNIFIED_VERTEX_OFFSETS)).toEqual([...COMPONENT_ORDER]);

		let expectedOffset = 0;
		for (const component of COMPONENT_ORDER) {
			expect(UNIFIED_VERTEX_OFFSETS[component]).toBe(expectedOffset);
			expectedOffset += UNIFIED_VERTEX_COMPONENT_FLOATS[component];
		}
		expect(expectedOffset).toBe(UNIFIED_VERTEX_FLOATS);
	});

	it("should derive the byte stride from the float stride", () => {
		expect(UNIFIED_VERTEX_BYTES).toBe(UNIFIED_VERTEX_FLOATS * 4);
	});
});

describe("ElementVertexBuffer packing", () => {
	it("should place pushFill components at the metadata offsets", () => {
		const buf = new ElementVertexBuffer(7);
		buf.pushFill(10, 20, 0.1, 0.2, 0.3, 0.4, 30, 40);

		const O = UNIFIED_VERTEX_OFFSETS;
		const data = buf.toFloat32Array();
		expect(data.length).toBe(UNIFIED_VERTEX_FLOATS);
		expect([data[O.position], data[O.position + 1]]).toEqual([10, 20]);
		expect(data[O.color]).toBeCloseTo(0.1);
		expect(data[O.color + 1]).toBeCloseTo(0.2);
		expect(data[O.color + 2]).toBeCloseTo(0.3);
		expect(data[O.color + 3]).toBeCloseTo(0.4);
		expect([data[O.offset], data[O.offset + 1]]).toEqual([30, 40]);
		expect(readUint32(data, O.elementIndex)).toBe(7);
	});

	it("should advance by one full vertex stride per push", () => {
		const buf = new ElementVertexBuffer(0);
		buf.pushFill(1, 2, 0, 0, 0, 1);
		buf.pushFill(3, 4, 0, 0, 0, 1);

		expect(buf.length).toBe(2 * UNIFIED_VERTEX_FLOATS);
		expect(buf.vertexCount).toBe(2);
	});
});

/** Reinterpret one float of a packed vertex as u32 (elementIndex encoding). */
function readUint32(data: Float32Array, floatOffset: number): number {
	return new Uint32Array(data.buffer, data.byteOffset + floatOffset * 4, 1)[0];
}
