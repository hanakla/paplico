"use client";

import { AlgorithmRunner } from "../_components/AlgorithmRunner";
import type { AABB, CubicBezier } from "../_components/TutorialCanvas2D";

const STARTER = `// 第2章: ベジェ曲線の AABB を作ろう

type Vec2 = { x: number; y: number };
type CubicBezier = { p0: Vec2; p1: Vec2; p2: Vec2; p3: Vec2 };
type AABB = { min: Vec2; max: Vec2 };

export function bezierAABB(c: CubicBezier): AABB {
	// TODO: 4つの制御点 (p0, p1, p2, p3) の x と y の min と max を出そう！
	// ヒント:
	//   const xs = [c.p0.x, c.p1.x, c.p2.x, c.p3.x];
	//   const ys = [c.p0.y, c.p1.y, c.p2.y, c.p3.y];
	//   Math.min(...xs) と Math.max(...xs) で min と max が取れるよ
	return { min: { x: 0, y: 0 }, max: { x: 0, y: 0 } };
}
`;

const SOLUTION = `// 第2章: 解答例

type Vec2 = { x: number; y: number };
type CubicBezier = { p0: Vec2; p1: Vec2; p2: Vec2; p3: Vec2 };
type AABB = { min: Vec2; max: Vec2 };

export function bezierAABB(c: CubicBezier): AABB {
	const xs = [c.p0.x, c.p1.x, c.p2.x, c.p3.x];
	const ys = [c.p0.y, c.p1.y, c.p2.y, c.p3.y];
	return {
		min: { x: Math.min(...xs), y: Math.min(...ys) },
		max: { x: Math.max(...xs), y: Math.max(...ys) },
	};
}
`;

const TEST_BEZIER: CubicBezier = {
	p0: { x: -150, y: -50 },
	p1: { x: -50, y: 100 },
	p2: { x: 50, y: -100 },
	p3: { x: 150, y: 50 },
};

const HARNESS = `
self.onmessage = () => {
	try {
		if (typeof bezierAABB !== "function") {
			self.postMessage({ ok: false, error: "bezierAABB を export してね" });
			return;
		}
		const c = ${JSON.stringify(TEST_BEZIER)};
		const box = bezierAABB(c);
		self.postMessage({ ok: true, result: box });
	} catch (err) {
		self.postMessage({ ok: false, error: (err && err.stack) || String(err) });
	}
};
`;

// lint-unused-ignore
export default function Playground() {
	return (
		<AlgorithmRunner
			storageKey="02-bounds"
			starter={STARTER}
			solution={SOLUTION}
			harness={HARNESS}
			width={500}
			height={350}
			worldUnit={1}
			render={(result, helpers) => {
				helpers.drawAxes();
				helpers.drawBezier(TEST_BEZIER, { showHandles: true });
				const box = result as AABB | null;
				if (
					box?.min &&
					box?.max &&
					typeof box.min.x === "number" &&
					typeof box.max.x === "number"
				) {
					helpers.drawAABB(box, {
						color: "#f4a261",
						fill: "rgb(244 162 97 / 0.18)",
					});
				}
			}}
		/>
	);
}
