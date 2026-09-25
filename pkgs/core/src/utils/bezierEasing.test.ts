import type { BlendEasingNode } from "../schema";
import {
	createLinearBezierEasing,
	evaluateBezierEasing,
	insertBezierEasingNode,
	sanitizeBezierEasingNodes,
} from "./bezierEasing";

describe("evaluateBezierEasing", () => {
	it("should return the input for the linear curve", () => {
		const nodes = createLinearBezierEasing();
		for (const x of [0, 0.1, 0.37, 0.5, 0.9, 1]) {
			expect(evaluateBezierEasing(nodes, x)).toBeCloseTo(x, 6);
		}
	});

	it("should pass through every node", () => {
		const nodes = sCurve();
		expect(evaluateBezierEasing(nodes, 0.4)).toBeCloseTo(0.7, 6);
	});

	it("should reach outside 0..1 when a node does", () => {
		const nodes = sanitizeBezierEasingNodes([
			...createLinearBezierEasing(),
			node(0.5, 1.4, 0.1),
		]);
		expect(evaluateBezierEasing(nodes, 0.5)).toBeCloseTo(1.4, 6);
	});
});

describe("insertBezierEasingNode", () => {
	it("should keep the curve's shape when a node is added", () => {
		const before = sCurve();
		const { nodes: after, index } = insertBezierEasingNode(before, 0.7);

		expect(after).toHaveLength(before.length + 1);
		expect(after[index].x).toBeCloseTo(0.7, 6);
		for (const x of [0.05, 0.3, 0.55, 0.7, 0.85, 0.99]) {
			expect(evaluateBezierEasing(after, x)).toBeCloseTo(
				evaluateBezierEasing(before, x),
				5,
			);
		}
	});
});

describe("sanitizeBezierEasingNodes", () => {
	it("should reorder a node dragged past its neighbor", () => {
		const nodes = sanitizeBezierEasingNodes([
			...createLinearBezierEasing(),
			node(0.3, 0.2, 0.05),
			node(0.2, 0.8, 0.05),
		]);
		expect(nodes.map((n) => [n.x, n.y])).toEqual([
			[0, 0],
			[0.2, 0.8],
			[0.3, 0.2],
			[1, 1],
		]);
	});

	it("should pin the end nodes to (0, 0) and (1, 1)", () => {
		const nodes = sanitizeBezierEasingNodes([
			{ ...createLinearBezierEasing()[0], y: 0.4 },
			{ ...createLinearBezierEasing()[1], y: 0.4 },
		]);
		expect(nodes[0]).toMatchObject({ x: 0, y: 0 });
		expect(nodes[1]).toMatchObject({ x: 1, y: 1 });
	});

	it("should shorten a handle that reaches past its segment and keep its direction", () => {
		const nodes = sanitizeBezierEasingNodes([
			...createLinearBezierEasing(),
			{ x: 0.9, y: 0.5, inX: -0.2, inY: -0.1, outX: 0.4, outY: 0.2 },
		]);
		const middle = nodes[1];
		expect(middle.outX).toBeCloseTo(0.1, 6);
		expect(middle.outY).toBeCloseTo(0.05, 6);
		expect(middle.inX).toBeCloseTo(-0.2, 6);
	});
});

/** An interior node with level handles reaching `reach` to either side. */
function node(x: number, y: number, reach: number): BlendEasingNode {
	return { x, y, inX: -reach, inY: 0, outX: reach, outY: 0 };
}

/** A curve rising steeply through (0.4, 0.7) and settling into (1, 1). */
function sCurve(): BlendEasingNode[] {
	return [
		{ x: 0, y: 0, inX: 0, inY: 0, outX: 0.1, outY: 0.3 },
		{ x: 0.4, y: 0.7, inX: -0.1, inY: -0.1, outX: 0.2, outY: 0.2 },
		{ x: 1, y: 1, inX: -0.2, inY: 0, outX: 0, outY: 0 },
	];
}
