"use client";

import { AlgorithmRunner } from "../_components/AlgorithmRunner";
import type { CubicBezier, Vec2 } from "../_components/TutorialCanvas2D";

const STARTER = `// 第4章: ベジェ曲線をまっすぐな線の集まりに分けよう

type Vec2 = { x: number; y: number };
type CubicBezier = { p0: Vec2; p1: Vec2; p2: Vec2; p3: Vec2 };

export function flattenCubic(c: CubicBezier, tolerance: number): Vec2[] {
	// TODO: ベジェ曲線をたくさんの直線の集まりに分けよう！
	// ステップ:
	//   1. 弦 (p0 → p3) と制御点 p1, p2 の距離を測る
	//      const dx = c.p3.x - c.p0.x, dy = c.p3.y - c.p0.y;
	//      const lenSq = dx * dx + dy * dy;
	//      const distFromLine = (p) => Math.abs((p.x-c.p0.x)*dy - (p.y-c.p0.y)*dx) / Math.sqrt(lenSq);
	//   2. 距離 d1, d2 の最大値が tolerance 以下なら [c.p0, c.p3] を返す
	//   3. そうでなければ、中点を取って曲線を 2 つに分ける
	//      m01  = ((c.p0.x+c.p1.x)/2, (c.p0.y+c.p1.y)/2)  ... など 6 個
	//      左 = { p0:c.p0, p1:m01, p2:m012, p3:m0123 }
	//      右 = { p0:m0123, p1:m123, p2:m23, p3:c.p3 }
	//   4. flattenCubic(左, tolerance) と flattenCubic(右, tolerance) を結合
	//      (右側の最初の点は左の最後と同じだから 1 つ落とす)
	return [c.p0, c.p3];
}
`;

const SOLUTION = `// 第4章: 解答例

type Vec2 = { x: number; y: number };
type CubicBezier = { p0: Vec2; p1: Vec2; p2: Vec2; p3: Vec2 };

function mid(a: Vec2, b: Vec2): Vec2 {
	return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function distFromLine(p: Vec2, a: Vec2, b: Vec2): number {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const lenSq = dx * dx + dy * dy;
	if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
	const cross = (p.x - a.x) * dy - (p.y - a.y) * dx;
	return Math.abs(cross) / Math.sqrt(lenSq);
}

export function flattenCubic(c: CubicBezier, tolerance: number): Vec2[] {
	const d1 = distFromLine(c.p1, c.p0, c.p3);
	const d2 = distFromLine(c.p2, c.p0, c.p3);
	if (Math.max(d1, d2) <= tolerance) {
		return [c.p0, c.p3];
	}
	const m01 = mid(c.p0, c.p1);
	const m12 = mid(c.p1, c.p2);
	const m23 = mid(c.p2, c.p3);
	const m012 = mid(m01, m12);
	const m123 = mid(m12, m23);
	const m0123 = mid(m012, m123);
	const left: CubicBezier = { p0: c.p0, p1: m01, p2: m012, p3: m0123 };
	const right: CubicBezier = { p0: m0123, p1: m123, p2: m23, p3: c.p3 };
	return [...flattenCubic(left, tolerance), ...flattenCubic(right, tolerance).slice(1)];
}
`;

const TEST_BEZIER: CubicBezier = {
	p0: { x: -150, y: -60 },
	p1: { x: -50, y: 130 },
	p2: { x: 50, y: -130 },
	p3: { x: 150, y: 60 },
};

const TOLERANCE = 2;

const HARNESS = `
self.onmessage = () => {
	try {
		if (typeof flattenCubic !== "function") {
			self.postMessage({ ok: false, error: "flattenCubic を export してね" });
			return;
		}
		const c = ${JSON.stringify(TEST_BEZIER)};
		const pts = flattenCubic(c, ${TOLERANCE});
		self.postMessage({ ok: true, result: pts });
	} catch (err) {
		self.postMessage({ ok: false, error: (err && err.stack) || String(err) });
	}
};
`;

// lint-unused-ignore
export default function Playground() {
	return (
		<AlgorithmRunner
			storageKey="04-bezier-flatten"
			starter={STARTER}
			solution={SOLUTION}
			harness={HARNESS}
			width={500}
			height={350}
			worldUnit={1}
			render={(result, helpers) => {
				helpers.drawAxes();
				helpers.drawBezier(TEST_BEZIER, {
					color: "rgb(58 134 255 / 0.5)",
					width: 6,
					showHandles: true,
				});
				const pts = result as Vec2[] | null;
				if (Array.isArray(pts) && pts.length >= 2) {
					helpers.drawPath(pts, { color: "#e0457b", width: 2 });
					for (const p of pts) {
						helpers.drawPoint(p, { color: "#e0457b", radius: 2.5 });
					}
					helpers.drawText(
						{ x: 0, y: helpers.height / 2 - 14 },
						`折れ線の頂点数: ${pts.length} (tolerance=${TOLERANCE})`,
						{ anchor: "center" },
					);
				}
			}}
		/>
	);
}
