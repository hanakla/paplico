"use client";

import { AlgorithmRunner } from "../_components/AlgorithmRunner";
import type { Vec2 } from "../_components/TutorialCanvas2D";

const STARTER = `// 第3章: 点が多角形の中にあるか判定しよう

type Vec2 = { x: number; y: number };

export function pointInPolygon(point: Vec2, polygon: Vec2[]): boolean {
	// TODO: ray casting で判定しよう！
	// ヒント:
	//   1. inside = false から始める
	//   2. 多角形の各辺 (i, j=i-1) について…
	//   3. 辺の y の範囲が point.y を「またいで」いて、
	//      かつ 辺と y=point.y の交点の x が point.x より右なら、
	//      inside を反転 (inside = !inside)
	//   4. 全部の辺を見たあとの inside が答え
	return false;
}
`;

const SOLUTION = `// 第3章: 解答例

type Vec2 = { x: number; y: number };

export function pointInPolygon(point: Vec2, polygon: Vec2[]): boolean {
	let inside = false;
	const n = polygon.length;
	for (let i = 0, j = n - 1; i < n; j = i++) {
		const pi = polygon[i];
		const pj = polygon[j];
		const yCrosses = pi.y > point.y !== pj.y > point.y;
		if (yCrosses) {
			const xCross =
				((pj.x - pi.x) * (point.y - pi.y)) / (pj.y - pi.y) + pi.x;
			if (point.x < xCross) inside = !inside;
		}
	}
	return inside;
}
`;

const STAR_POLYGON: Vec2[] = (() => {
	const points: Vec2[] = [];
	const outer = 140;
	const inner = 60;
	for (let i = 0; i < 10; i++) {
		const r = i % 2 === 0 ? outer : inner;
		const a = (Math.PI * 2 * i) / 10 - Math.PI / 2;
		points.push({ x: r * Math.cos(a), y: r * Math.sin(a) });
	}
	return points;
})();

const STEP = 14;
const HALF_W = 500 / 2 - 12;
const HALF_H = 350 / 2 - 12;

const HARNESS = `
self.onmessage = () => {
	try {
		if (typeof pointInPolygon !== "function") {
			self.postMessage({ ok: false, error: "pointInPolygon を export してね" });
			return;
		}
		const polygon = ${JSON.stringify(STAR_POLYGON)};
		const step = ${STEP};
		const halfW = ${HALF_W};
		const halfH = ${HALF_H};
		const inside = [];
		const points = [];
		for (let wy = -halfH; wy <= halfH; wy += step) {
			for (let wx = -halfW; wx <= halfW; wx += step) {
				const p = { x: wx, y: wy };
				points.push(p);
				inside.push(!!pointInPolygon(p, polygon));
			}
		}
		self.postMessage({ ok: true, result: { points, inside } });
	} catch (err) {
		self.postMessage({ ok: false, error: (err && err.stack) || String(err) });
	}
};
`;

type RenderResult = {
	points: Vec2[];
	inside: boolean[];
};

// lint-unused-ignore
export default function Playground() {
	return (
		<AlgorithmRunner
			storageKey="03-hit-test"
			starter={STARTER}
			solution={SOLUTION}
			harness={HARNESS}
			width={500}
			height={350}
			worldUnit={1}
			render={(result, helpers) => {
				helpers.drawAxes();
				helpers.drawPath(STAR_POLYGON, {
					closed: true,
					color: "#3a86ff",
					width: 2,
					fill: "rgb(58 134 255 / 0.12)",
				});
				const r = result as RenderResult | null;
				if (!r) return;
				helpers.ctx.save();
				for (let i = 0; i < r.points.length; i++) {
					const p = r.points[i];
					const s = helpers.worldToScreen(p);
					helpers.ctx.fillStyle = r.inside[i]
						? "#3a86ff"
						: "rgb(127 127 127 / 0.35)";
					helpers.ctx.beginPath();
					helpers.ctx.arc(s.x, s.y, 2.2, 0, Math.PI * 2);
					helpers.ctx.fill();
				}
				helpers.ctx.restore();
			}}
		/>
	);
}
