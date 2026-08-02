"use client";

import { AlgorithmRunner } from "../_components/AlgorithmRunner";
import type { CubicBezier } from "../_components/TutorialCanvas2D";

const STARTER = `// 第5章: ベジェ曲線をパラメータ t で 2 つに分けよう

type Vec2 = { x: number; y: number };
type CubicBezier = { p0: Vec2; p1: Vec2; p2: Vec2; p3: Vec2 };

function lerp(a: Vec2, b: Vec2, t: number): Vec2 {
	// TODO: 線形補間。a と b の間で t (0~1) の場所の点を返そう
	return { x: 0, y: 0 };
}

export function splitCubicAtT(c: CubicBezier, t: number): [CubicBezier, CubicBezier] {
	// TODO:
	//   1. lerp で m01, m12, m23 を計算
	//   2. lerp で m012, m123 を計算
	//   3. lerp で m0123 を計算 (これが分割点)
	//   4. 左 = { p0, m01, m012, m0123 }, 右 = { m0123, m123, m23, p3 } を返す
	return [c, c];
}
`;

const SOLUTION = `// 第5章: 解答例

type Vec2 = { x: number; y: number };
type CubicBezier = { p0: Vec2; p1: Vec2; p2: Vec2; p3: Vec2 };

function lerp(a: Vec2, b: Vec2, t: number): Vec2 {
	return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

export function splitCubicAtT(c: CubicBezier, t: number): [CubicBezier, CubicBezier] {
	const m01 = lerp(c.p0, c.p1, t);
	const m12 = lerp(c.p1, c.p2, t);
	const m23 = lerp(c.p2, c.p3, t);
	const m012 = lerp(m01, m12, t);
	const m123 = lerp(m12, m23, t);
	const m0123 = lerp(m012, m123, t);
	return [
		{ p0: c.p0, p1: m01, p2: m012, p3: m0123 },
		{ p0: m0123, p1: m123, p2: m23, p3: c.p3 },
	];
}
`;

const TEST_BEZIER: CubicBezier = {
	p0: { x: -150, y: -60 },
	p1: { x: -50, y: 130 },
	p2: { x: 50, y: -130 },
	p3: { x: 150, y: 60 },
};

const SPLIT_T = 0.4;

const HARNESS = `
self.onmessage = () => {
	try {
		if (typeof splitCubicAtT !== "function") {
			self.postMessage({ ok: false, error: "splitCubicAtT を export してね" });
			return;
		}
		const c = ${JSON.stringify(TEST_BEZIER)};
		const result = splitCubicAtT(c, ${SPLIT_T});
		self.postMessage({ ok: true, result });
	} catch (err) {
		self.postMessage({ ok: false, error: (err && err.stack) || String(err) });
	}
};
`;

// lint-unused-ignore
export default function Playground() {
	return (
		<AlgorithmRunner
			storageKey="05-bezier-split"
			starter={STARTER}
			solution={SOLUTION}
			harness={HARNESS}
			width={500}
			height={350}
			worldUnit={1}
			render={(result, helpers) => {
				helpers.drawAxes();
				helpers.drawBezier(TEST_BEZIER, {
					color: "rgb(127 127 127 / 0.4)",
					width: 6,
				});
				const r = result as [CubicBezier, CubicBezier] | null;
				if (Array.isArray(r) && r.length === 2) {
					const [left, right] = r;
					helpers.drawBezier(left, {
						color: "#2a9d8f",
						width: 2.5,
						showHandles: true,
					});
					helpers.drawBezier(right, {
						color: "#f4a261",
						width: 2.5,
						showHandles: true,
					});
					helpers.drawPoint(left.p3, {
						color: "#3a86ff",
						radius: 6,
						label: `t=${SPLIT_T}`,
					});
					helpers.drawText(
						{ x: 0, y: helpers.height / 2 - 14 },
						"緑(左) + 橙(右) が元の灰色の曲線に重なれば OK！",
						{ anchor: "center" },
					);
				}
			}}
		/>
	);
}
