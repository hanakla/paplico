import { describe, expect, it } from "vitest";
import {
	buildTurbulenceLattice,
	packTurbulenceLattice,
	TURBULENCE_GRADIENT_COUNT,
	TURBULENCE_LATTICE_SIZE,
} from "./turbulenceLattice";

describe("buildTurbulenceLattice", () => {
	it("should fill lattice[0..255] with a permutation of 0..255", () => {
		const { lattice } = buildTurbulenceLattice(42);
		const sorted = [...lattice.subarray(0, 256)].sort((a, b) => a - b);
		expect(sorted).toEqual([...Array(256).keys()]);
	});

	it("should duplicate the first 258 lattice entries into 256..513", () => {
		const { lattice } = buildTurbulenceLattice(42);
		expect(lattice.length).toBe(TURBULENCE_LATTICE_SIZE);
		for (let i = 0; i < 258; i++) {
			expect(lattice[256 + i]).toBe(lattice[i]);
		}
	});

	it("should produce unit-length gradients for every channel", () => {
		const { gradient } = buildTurbulenceLattice(7);
		for (let i = 0; i < TURBULENCE_GRADIENT_COUNT; i++) {
			expect(Math.hypot(gradient[i * 2], gradient[i * 2 + 1])).toBeCloseTo(
				1,
				5,
			);
		}
	});

	it("should duplicate the gradients of index 0..257 into 256..513 per channel", () => {
		const { gradient } = buildTurbulenceLattice(7);
		for (let k = 0; k < 4; k++) {
			for (let i = 0; i < 258; i++) {
				const from = (k * TURBULENCE_LATTICE_SIZE + i) * 2;
				const to = (k * TURBULENCE_LATTICE_SIZE + 256 + i) * 2;
				expect(gradient[to]).toBe(gradient[from]);
				expect(gradient[to + 1]).toBe(gradient[from + 1]);
			}
		}
	});

	it("should treat seed 0 like seed 1", () => {
		const zero = buildTurbulenceLattice(0);
		const one = buildTurbulenceLattice(1);
		expect(zero.lattice).toEqual(one.lattice);
		expect(zero.gradient).toEqual(one.gradient);
	});

	it("should be deterministic for the same seed", () => {
		const a = buildTurbulenceLattice(1234);
		const b = buildTurbulenceLattice(1234);
		expect(a.lattice).toEqual(b.lattice);
		expect(a.gradient).toEqual(b.gradient);
	});

	it("should differ between seeds", () => {
		const a = buildTurbulenceLattice(1);
		const b = buildTurbulenceLattice(2);
		expect(a.lattice).not.toEqual(b.lattice);
	});
});

describe("packTurbulenceLattice", () => {
	it("should place the gradients right after the 514 selector ints", () => {
		const built = buildTurbulenceLattice(3);
		const packed = packTurbulenceLattice(built);
		expect(packed.byteLength).toBe(
			TURBULENCE_LATTICE_SIZE * 4 + TURBULENCE_GRADIENT_COUNT * 8,
		);
		expect(new Int32Array(packed, 0, TURBULENCE_LATTICE_SIZE)).toEqual(
			built.lattice,
		);
		expect(
			new Float32Array(
				packed,
				TURBULENCE_LATTICE_SIZE * 4,
				TURBULENCE_GRADIENT_COUNT * 2,
			),
		).toEqual(built.gradient);
	});
});
