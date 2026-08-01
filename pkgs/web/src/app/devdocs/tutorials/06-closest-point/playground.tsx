"use client";

import { AlgorithmRunner } from "../_components/AlgorithmRunner";
import type { CubicBezier, Vec2 } from "../_components/TutorialCanvas2D";

const STARTER = `// 第6章: 点 P から、ベジェ曲線の上で一番近い点を探そう

type Vec2 = { x: number; y: number };
type CubicBezier = { p0: Vec2; p1: Vec2; p2: Vec2; p3: Vec2 };

function bezierAt(c: CubicBezier, t: number): Vec2 {
	const u = 1 - t;
	return {
		x: u*u*u*c.p0.x + 3*u*u*t*c.p1.x + 3*u*t*t*c.p2.x + t*t*t*c.p3.x,
		y: u*u*u*c.p0.y + 3*u*u*t*c.p1.y + 3*u*t*t*c.p2.y + t*t*t*c.p3.y,
	};
}

function distSq(a: Vec2, b: Vec2): number {
	const dx = a.x - b.x;
	const dy = a.y - b.y;
	return dx*dx + dy*dy;
}

export function closestPointOnCubic(
	p: Vec2,
	c: CubicBezier,
): { point: Vec2; t: number } {
	// TODO:
	//   1. t を 0 から 1 まで N 等分し、distSq(p, bezierAt(c, t)) が最小の t を見つける
	//   2. その t の左右 ±1/N で三分探索 (lo, hi を 20 回くらい狭める)
	//   3. (lo + hi) / 2 を最終 t として、bezierAt(c, t) を返す
	return { point: c.p0, t: 0 };
}
`;

const SOLUTION = `// 第6章: 解答例

type Vec2 = { x: number; y: number };
type CubicBezier = { p0: Vec2; p1: Vec2; p2: Vec2; p3: Vec2 };

function bezierAt(c: CubicBezier, t: number): Vec2 {
	const u = 1 - t;
	return {
		x: u*u*u*c.p0.x + 3*u*u*t*c.p1.x + 3*u*t*t*c.p2.x + t*t*t*c.p3.x,
		y: u*u*u*c.p0.y + 3*u*u*t*c.p1.y + 3*u*t*t*c.p2.y + t*t*t*c.p3.y,
	};
}

function distSq(a: Vec2, b: Vec2): number {
	const dx = a.x - b.x;
	const dy = a.y - b.y;
	return dx*dx + dy*dy;
}

export function closestPointOnCubic(
	p: Vec2,
	c: CubicBezier,
): { point: Vec2; t: number } {
	const N = 50;
	let bestT = 0;
	let bestD = distSq(p, bezierAt(c, 0));
	for (let i = 1; i <= N; i++) {
		const t = i / N;
		const d = distSq(p, bezierAt(c, t));
		if (d < bestD) { bestD = d; bestT = t; }
	}
	const span = 1 / N;
	let lo = Math.max(0, bestT - span);
	let hi = Math.min(1, bestT + span);
	for (let iter = 0; iter < 24; iter++) {
		const m1 = lo + (hi - lo) / 3;
		const m2 = hi - (hi - lo) / 3;
		if (distSq(p, bezierAt(c, m1)) < distSq(p, bezierAt(c, m2))) {
			hi = m2;
		} else {
			lo = m1;
		}
	}
	const finalT = (lo + hi) / 2;
	return { point: bezierAt(c, finalT), t: finalT };
}
`;

const TEST_BEZIER: CubicBezier = {
	p0: { x: -180, y: 0 },
	p1: { x: -90, y: 130 },
	p2: { x: 90, y: -130 },
	p3: { x: 180, y: 0 },
};

const TEST_POINTS: Vec2[] = [
	{ x: -120, y: -90 },
	{ x: -40, y: 90 },
	{ x: 40, y: -90 },
	{ x: 120, y: 90 },
	{ x: 0, y: 120 },
];

const HARNESS = `
self.onmessage = () => {
	try {
		if (typeof closestPointOnCubic !== "function") {
			self.postMessage({ ok: false, error: "closestPointOnCubic を export してね" });
			return;
		}
		const c = ${JSON.stringify(TEST_BEZIER)};
		const tests = ${JSON.stringify(TEST_POINTS)};
		const results = tests.map((p) => closestPointOnCubic(p, c));
		self.postMessage({ ok: true, result: { tests, results } });
	} catch (err) {
		self.postMessage({ ok: false, error: (err && err.stack) || String(err) });
	}
};
`;

type RenderResult = {
	tests: Vec2[];
	results: { point: Vec2; t: number }[];
};

// lint-unused-ignore
export default function Playground() {
	return (
		<AlgorithmRunner
			storageKey="06-closest-point"
			starter={STARTER}
			solution={SOLUTION}
			harness={HARNESS}
			width={500}
			height={350}
			worldUnit={1}
			render={(result, helpers) => {
				helpers.drawAxes();
				helpers.drawBezier(TEST_BEZIER, {
					color: "#3a86ff",
					width: 2.5,
					showHandles: true,
				});
				const r = result as RenderResult | null;
				if (!r) return;
				for (let i = 0; i < r.tests.length; i++) {
					const p = r.tests[i];
					const out = r.results[i];
					if (
						out?.point &&
						typeof out.point.x === "number" &&
						typeof out.point.y === "number"
					) {
						helpers.drawLine(p, out.point, {
							color: "#888",
							width: 1.2,
							dash: [4, 3],
						});
						helpers.drawPoint(out.point, {
							color: "#2a9d8f",
							radius: 4,
						});
					}
					helpers.drawPoint(p, { color: "#e0457b", radius: 5 });
				}
			}}
		/>
	);
}
