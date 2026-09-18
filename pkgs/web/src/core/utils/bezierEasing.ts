/**
 * Custom blend easing curves: a chain of cubic Bézier segments over x in 0..1.
 * The blend interpolation and the curve editor both evaluate through here, so
 * the plotted curve is the one the intermediates follow.
 */
import type { BlendEasingNode } from "../schema";
import { clamp, lerp } from "./math";

/** Closest two nodes may get on the x axis, so every segment keeps a width. */
export const MIN_NODE_X_GAP = 1e-3;

const SOLVE_ITERATIONS = 32;

/** A straight line from (0, 0) to (1, 1), the starting shape of a custom curve. */
export function createLinearBezierEasing(): BlendEasingNode[] {
	return [
		{ x: 0, y: 0, inX: 0, inY: 0, outX: 1 / 3, outY: 1 / 3 },
		{ x: 1, y: 1, inX: -1 / 3, inY: -1 / 3, outX: 0, outY: 0 },
	];
}

/**
 * The curve's y at `x`. Expects sanitized nodes, where every segment's x is
 * monotone so exactly one point of the segment lies at `x`.
 */
export function evaluateBezierEasing(
	nodes: readonly BlendEasingNode[],
	x: number,
): number {
	const first = nodes[0];
	const last = nodes[nodes.length - 1];
	if (x <= first.x) return first.y;
	if (x >= last.x) return last.y;

	const index = findSegmentIndex(nodes, x);
	const [xs, ys] = segmentControls(nodes[index], nodes[index + 1]);
	return cubic(ys, solveT(xs, x));
}

/**
 * Put a node on the curve at `x` without changing the curve's shape: the
 * segment under `x` is split with de Casteljau, so the new node and its
 * neighbors get the handles of the two halves.
 */
export function insertBezierEasingNode(
	nodes: readonly BlendEasingNode[],
	x: number,
): { nodes: BlendEasingNode[]; index: number } {
	const index = findSegmentIndex(nodes, x);
	const a = nodes[index];
	const b = nodes[index + 1];
	const [xs, ys] = segmentControls(a, b);
	const t = solveT(xs, x);

	const sx = deCasteljau(xs, t);
	const sy = deCasteljau(ys, t);
	const inserted: BlendEasingNode = {
		x: sx.point,
		y: sy.point,
		inX: sx.leftInner - sx.point,
		inY: sy.leftInner - sy.point,
		outX: sx.rightInner - sx.point,
		outY: sy.rightInner - sy.point,
	};

	const next = nodes.map((node) => ({ ...node }));
	next[index] = { ...a, outX: sx.leftOuter - a.x, outY: sy.leftOuter - a.y };
	next[index + 1] = {
		...b,
		inX: sx.rightOuter - b.x,
		inY: sy.rightOuter - b.y,
	};
	next.splice(index + 1, 0, inserted);
	return { nodes: next, index: index + 1 };
}

/**
 * Normalize edited nodes into a valid curve: sort by x, pin the first node to
 * (0, 0) and the last to (1, 1), keep interior nodes strictly inside, and
 * shorten any handle whose x reaches past its segment. Shortening keeps the
 * handle's direction, so a smooth node stays smooth.
 */
export function sanitizeBezierEasingNodes(
	nodes: readonly BlendEasingNode[],
): BlendEasingNode[] {
	const sorted = nodes.map((node) => ({ ...node })).sort((a, b) => a.x - b.x);
	const lastIndex = sorted.length - 1;

	sorted.forEach((node, i) => {
		if (i === 0) Object.assign(node, { x: 0, y: 0, inX: 0, inY: 0 });
		else if (i === lastIndex)
			Object.assign(node, { x: 1, y: 1, outX: 0, outY: 0 });
		else node.x = clamp(node.x, MIN_NODE_X_GAP, 1 - MIN_NODE_X_GAP);
	});

	sorted.forEach((node, i) => {
		if (i > 0) {
			[node.inX, node.inY] = fitHandle(
				node.inX,
				node.inY,
				node.x - sorted[i - 1].x,
			);
		}
		if (i < lastIndex) {
			[node.outX, node.outY] = fitHandle(
				node.outX,
				node.outY,
				sorted[i + 1].x - node.x,
			);
		}
	});
	return sorted;
}

type Controls = readonly [number, number, number, number];

function findSegmentIndex(
	nodes: readonly BlendEasingNode[],
	x: number,
): number {
	let index = 0;
	while (index < nodes.length - 2 && nodes[index + 1].x < x) index++;
	return index;
}

function segmentControls(
	a: BlendEasingNode,
	b: BlendEasingNode,
): [Controls, Controls] {
	return [
		[a.x, a.x + a.outX, b.x + b.inX, b.x],
		[a.y, a.y + a.outY, b.y + b.inY, b.y],
	];
}

function cubic([p0, p1, p2, p3]: Controls, t: number): number {
	const u = 1 - t;
	return (
		u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3
	);
}

/** Bisection on the monotone x(t); robust where Newton stalls on flat handles. */
function solveT(xs: Controls, x: number): number {
	let lo = 0;
	let hi = 1;
	for (let i = 0; i < SOLVE_ITERATIONS; i++) {
		const mid = (lo + hi) / 2;
		if (cubic(xs, mid) < x) lo = mid;
		else hi = mid;
	}
	return (lo + hi) / 2;
}

/**
 * One coordinate of a segment split at t. The left half's controls are
 * (p0, leftOuter, leftInner, point), the right half's (point, rightInner,
 * rightOuter, p3).
 */
function deCasteljau([p0, p1, p2, p3]: Controls, t: number) {
	const leftOuter = lerp(p0, p1, t);
	const middle = lerp(p1, p2, t);
	const rightOuter = lerp(p2, p3, t);
	const leftInner = lerp(leftOuter, middle, t);
	const rightInner = lerp(middle, rightOuter, t);
	return {
		leftOuter,
		leftInner,
		point: lerp(leftInner, rightInner, t),
		rightInner,
		rightOuter,
	};
}

function fitHandle(hx: number, hy: number, span: number): [number, number] {
	if (Math.abs(hx) <= span) return [hx, hy];
	const scale = span / Math.abs(hx);
	return [hx * scale, hy * scale];
}
