"use client";

import { AlgorithmRunner } from "../_components/AlgorithmRunner";
import type { Vec2 } from "../_components/TutorialCanvas2D";

const STARTER = `// 第7章: ぐにゃぐにゃの点列をなめらかにしよう

type Vec2 = { x: number; y: number };

export function gaussianSmooth(points: Vec2[], sigma: number): Vec2[] {
	// TODO: 各点 i について、隣接点を Gaussian 重みで加重平均しよう！
	// ヒント:
	//   1. radius = Math.ceil(sigma * 3)
	//   2. 各 i について、k = -radius..radius の範囲で:
	//      j = i + k が範囲外ならスキップ
	//      w = Math.exp(-(k*k) / (2*sigma*sigma))
	//      x, y に points[j].x*w, points[j].y*w を加算 / 合計重みも加算
	//   3. 加重平均 = 合計 / 合計重み
	return points;
}
`;

const SOLUTION = `// 第7章: 解答例

type Vec2 = { x: number; y: number };

export function gaussianSmooth(points: Vec2[], sigma: number): Vec2[] {
	if (sigma <= 0 || points.length < 3) return points;
	const radius = Math.ceil(sigma * 3);
	const result: Vec2[] = [];
	for (let i = 0; i < points.length; i++) {
		let sx = 0, sy = 0, sw = 0;
		for (let k = -radius; k <= radius; k++) {
			const j = i + k;
			if (j < 0 || j >= points.length) continue;
			const w = Math.exp(-(k * k) / (2 * sigma * sigma));
			sx += points[j].x * w;
			sy += points[j].y * w;
			sw += w;
		}
		result.push({ x: sx / sw, y: sy / sw });
	}
	return result;
}
`;

const SIGMA = 2;

const RAW_POINTS: Vec2[] = (() => {
	const pts: Vec2[] = [];
	for (let i = 0; i <= 80; i++) {
		const t = i / 80;
		const x = -200 + t * 400;
		const baseY = 60 * Math.sin(t * Math.PI * 2.2);
		// 高周波の sin/cos 合成で滑らかな擬似ノイズ
		const noise =
			12 * Math.sin(t * 47.3 + 0.7) +
			8 * Math.cos(t * 73.1 + 2.1) +
			5 * Math.sin(t * 113.9 + 1.3);
		pts.push({ x, y: baseY + noise });
	}
	return pts;
})();

const HARNESS = `
self.onmessage = () => {
	try {
		if (typeof gaussianSmooth !== "function") {
			self.postMessage({ ok: false, error: "gaussianSmooth を export してね" });
			return;
		}
		const points = ${JSON.stringify(RAW_POINTS)};
		const smoothed = gaussianSmooth(points, ${SIGMA});
		self.postMessage({ ok: true, result: smoothed });
	} catch (err) {
		self.postMessage({ ok: false, error: (err && err.stack) || String(err) });
	}
};
`;

// lint-unused-ignore
export default function Playground() {
	return (
		<AlgorithmRunner
			storageKey="07-smoothing"
			starter={STARTER}
			solution={SOLUTION}
			harness={HARNESS}
			width={500}
			height={350}
			worldUnit={1}
			render={(result, helpers) => {
				helpers.drawAxes();
				helpers.drawPath(RAW_POINTS, {
					color: "rgb(127 127 127 / 0.7)",
					width: 1.5,
				});
				const smoothed = result as Vec2[] | null;
				if (Array.isArray(smoothed) && smoothed.length >= 2) {
					helpers.drawPath(smoothed, { color: "#e0457b", width: 2.5 });
					helpers.drawText(
						{ x: 0, y: helpers.height / 2 - 14 },
						`σ = ${SIGMA} (灰=入力 / 赤=なめらかにした結果)`,
						{ anchor: "center" },
					);
				}
			}}
		/>
	);
}
