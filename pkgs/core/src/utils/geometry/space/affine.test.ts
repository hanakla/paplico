import {
	describe,
	expect,
	it,
} from "../../../../../../node_modules/vitest/dist/index";
import {
	applyAffineToPoint,
	composeAffine,
	elementTransformToAffine,
} from "./affine";

describe("affine helpers", () => {
	it("composeAffine should apply the inner transform first", () => {
		const inner = elementTransformToAffine({
			x: 5,
			y: 0,
			rotation: 0,
			scaleX: 1,
			scaleY: 1,
		});
		const outer = elementTransformToAffine({
			x: 0,
			y: 0,
			rotation: 0,
			scaleX: 2,
			scaleY: 2,
		});
		// outer(inner(p)): translate by 5 then scale by 2 -> (0+5)*2 = 10.
		const p = applyAffineToPoint(composeAffine(outer, inner), { x: 0, y: 0 });
		expect(p.x).toBeCloseTo(10);
		expect(p.y).toBeCloseTo(0);
	});

	it("elementTransformToAffine should rotate around the local origin", () => {
		const m = elementTransformToAffine({
			x: 0,
			y: 0,
			rotation: Math.PI / 2,
			scaleX: 1,
			scaleY: 1,
		});
		const p = applyAffineToPoint(m, { x: 10, y: 0 });
		expect(p.x).toBeCloseTo(0);
		expect(p.y).toBeCloseTo(10);
	});
});
