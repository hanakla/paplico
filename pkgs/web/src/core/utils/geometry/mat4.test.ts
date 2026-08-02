import { describe, expect, it } from "vitest";
import {
	mat4Identity,
	mat4Multiply,
	mat4Orthographic,
	mat4PerspectiveDistanceFromFov,
	mat4RotationX,
	mat4RotationY,
	mat4RotationZ,
	mat4SimplePerspective,
	mat4TransformPoint,
	mat4Translation,
} from "./mat4";

describe("mat4", () => {
	it("should leave points unchanged under the identity matrix", () => {
		const p = mat4TransformPoint(mat4Identity(), [3, -2, 7]);
		expect(p).toEqual([3, -2, 7]);
	});

	it("should translate points", () => {
		const p = mat4TransformPoint(mat4Translation(1, 2, 3), [10, 20, 30]);
		expect(p).toEqual([11, 22, 33]);
	});

	it("should rotate +Y toward +Z with rotateX(90°)", () => {
		const p = mat4TransformPoint(mat4RotationX(Math.PI / 2), [0, 1, 0]);
		expect(p[0]).toBeCloseTo(0);
		expect(p[1]).toBeCloseTo(0);
		expect(p[2]).toBeCloseTo(1);
	});

	it("should rotate +Z toward +X with rotateY(90°)", () => {
		const p = mat4TransformPoint(mat4RotationY(Math.PI / 2), [0, 0, 1]);
		expect(p[0]).toBeCloseTo(1);
		expect(p[1]).toBeCloseTo(0);
		expect(p[2]).toBeCloseTo(0);
	});

	it("should rotate +X toward +Y with rotateZ(90°)", () => {
		const p = mat4TransformPoint(mat4RotationZ(Math.PI / 2), [1, 0, 0]);
		expect(p[0]).toBeCloseTo(0);
		expect(p[1]).toBeCloseTo(1);
		expect(p[2]).toBeCloseTo(0);
	});

	it("should compose transforms right-to-left in mat4Multiply", () => {
		// Translate then rotate: rotateY(90°) · T(0,0,1) applied to origin.
		const m = mat4Multiply(
			mat4RotationY(Math.PI / 2),
			mat4Translation(0, 0, 1),
		);
		const p = mat4TransformPoint(m, [0, 0, 0]);
		expect(p[0]).toBeCloseTo(1);
		expect(p[2]).toBeCloseTo(0);
	});

	it("should map the ortho box corners onto clip-space extremes", () => {
		// Camera looks down -Z: zNear (closest, z=10) → depth 0, zFar (z=-10) → 1.
		const m = mat4Orthographic(-5, 15, -3, 7, 10, -10);
		const [lx, by, nearZ] = mat4TransformPoint(m, [-5, -3, 10]);
		expect(lx).toBeCloseTo(-1);
		expect(by).toBeCloseTo(-1);
		expect(nearZ).toBeCloseTo(0);
		const [rx, ty, farZ] = mat4TransformPoint(m, [15, 7, -10]);
		expect(rx).toBeCloseTo(1);
		expect(ty).toBeCloseTo(1);
		expect(farZ).toBeCloseTo(1);
	});

	it("should shrink geometry behind the XY plane with the simple perspective", () => {
		const m = mat4SimplePerspective(100);
		// z = -100 → w = 2 → x halves.
		const p = mat4TransformPoint(m, [10, 4, -100]);
		expect(p[0]).toBeCloseTo(5);
		expect(p[1]).toBeCloseTo(2);
		// z = 0 stays unchanged.
		const q = mat4TransformPoint(m, [10, 4, 0]);
		expect(q[0]).toBeCloseTo(10);
	});

	it("should shrink perspective around the supplied principal point", () => {
		const m = mat4SimplePerspective(100, 1_000, 200);
		const p = mat4TransformPoint(m, [1_010, 220, -100]);
		expect(p[0]).toBeCloseTo(1_005);
		expect(p[1]).toBeCloseTo(210);
	});

	it("should return non-finite coordinates on the perspective plane", () => {
		const m = mat4SimplePerspective(100);
		const p = mat4TransformPoint(m, [10, 4, 100]);
		expect(p.every(Number.isFinite)).toBe(false);
	});

	it("should derive perspective distance from a Rotate3D-compatible FOV", () => {
		expect(mat4PerspectiveDistanceFromFov(90, 50)).toBeCloseTo(50);
		expect(mat4PerspectiveDistanceFromFov(150, 50)).toBeLessThan(
			mat4PerspectiveDistanceFromFov(60, 50),
		);
	});
});
