// Consistency guard for the unified vertex layout SSoT: the component
// metadata must tile the stride exactly, the CPU packer must place each
// component at the metadata offsets, and the vertex-pulling WGSL must be
// generated with the expanded stride/index values.

import { describe, expect, it } from "vitest";
import { UNIFIED_PULLED_GEOMETRY_SHADER } from "../../shaders/unifiedPulled.wgsl";
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

describe("unifiedPulled WGSL generation", () => {
	it("should declare the expanded vertex stride", () => {
		expect(UNIFIED_PULLED_GEOMETRY_SHADER).toContain(
			`const VERTEX_FLOATS = ${UNIFIED_VERTEX_FLOATS}u;`,
		);
	});

	it("should pull each component at the metadata float offsets", () => {
		const O = UNIFIED_VERTEX_OFFSETS;
		expect(UNIFIED_PULLED_GEOMETRY_SHADER).toContain(
			`let position = vec2f(${wgslIndex(O.position)}, ${wgslIndex(O.position + 1)});`,
		);
		expect(UNIFIED_PULLED_GEOMETRY_SHADER).toContain(
			`let color = vec4f(\n\t\t${wgslIndex(O.color)},\n\t\t${wgslIndex(O.color + 1)},\n\t\t${wgslIndex(O.color + 2)},\n\t\t${wgslIndex(O.color + 3)},\n\t);`,
		);
		expect(UNIFIED_PULLED_GEOMETRY_SHADER).toContain(
			`let offset = vec2f(${wgslIndex(O.offset)}, ${wgslIndex(O.offset + 1)});`,
		);
		expect(UNIFIED_PULLED_GEOMETRY_SHADER).toContain(
			`let elementIndex = bitcast<u32>(${wgslIndex(O.elementIndex)});`,
		);
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

	it("should place pushGradient components at the metadata offsets", () => {
		const buf = new ElementVertexBuffer(11);
		buf.pushGradient(-5, 6, 0.5, 7, 8);

		const O = UNIFIED_VERTEX_OFFSETS;
		const data = buf.toFloat32Array();
		expect(data.length).toBe(UNIFIED_VERTEX_FLOATS);
		expect([data[O.position], data[O.position + 1]]).toEqual([-5, 6]);
		expect([data[O.color], data[O.color + 1], data[O.color + 2]]).toEqual([
			0, 0, 0,
		]);
		expect(data[O.color + 3]).toBeCloseTo(0.5);
		expect([data[O.offset], data[O.offset + 1]]).toEqual([7, 8]);
		expect(readUint32(data, O.elementIndex)).toBe(11);
	});

	it("should advance by one full vertex stride per push", () => {
		const buf = new ElementVertexBuffer(0);
		buf.pushFill(1, 2, 0, 0, 0, 1);
		buf.pushGradient(3, 4, 1);

		expect(buf.length).toBe(2 * UNIFIED_VERTEX_FLOATS);
		expect(buf.vertexCount).toBe(2);
	});
});

/** Format a pulled-vertex index the same way the WGSL template renders it. */
function wgslIndex(floatOffset: number): string {
	return floatOffset === 0
		? "vertices[base]"
		: `vertices[base + ${floatOffset}u]`;
}

/** Reinterpret one float of a packed vertex as u32 (elementIndex encoding). */
function readUint32(data: Float32Array, floatOffset: number): number {
	return new Uint32Array(data.buffer, data.byteOffset + floatOffset * 4, 1)[0];
}
