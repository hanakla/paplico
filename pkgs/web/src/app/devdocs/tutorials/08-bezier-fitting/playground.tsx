"use client";

import { AlgorithmRunner } from "../_components/AlgorithmRunner";
import type { CubicBezier, Vec2 } from "../_components/TutorialCanvas2D";

const STARTER = `// 第8章: 点列に最適なベジェ曲線を 1 本フィットしよう

type Vec2 = { x: number; y: number };
type CubicBezier = { p0: Vec2; p1: Vec2; p2: Vec2; p3: Vec2 };

function vsub(a: Vec2, b: Vec2): Vec2 {
	return { x: a.x - b.x, y: a.y - b.y };
}
function vlen(v: Vec2): number {
	return Math.hypot(v.x, v.y);
}
function vnorm(v: Vec2): Vec2 {
	const l = vlen(v) || 1;
	return { x: v.x / l, y: v.y / l };
}

const B0 = (t: number) => { const u = 1 - t; return u * u * u; };
const B1 = (t: number) => { const u = 1 - t; return 3 * u * u * t; };
const B2 = (t: number) => { const u = 1 - t; return 3 * u * t * t; };
const B3 = (t: number) => t * t * t;

export function fitCubicBezier(points: Vec2[]): CubicBezier {
	const n = points.length;
	const p0 = points[0];
	const p3 = points[n - 1];
	if (n < 3) return { p0, p1: p0, p2: p3, p3 };

	const tHat0 = vnorm(vsub(points[1], p0));
	const tHat3 = vnorm(vsub(points[n - 2], p3));
	const d = vlen(vsub(p3, p0)) / 3;
	let alpha1 = d;
	let alpha2 = d;

	// TODO 1: chord-length parameterization で各点に t をふろう
	// const ts: number[] = ...

	// TODO 2: Bernstein 基底 B1/B2 と接線方向から 2x2 の式を組もう
	// let c00 = 0, c01 = 0, c11 = 0, r0 = 0, r1 = 0;
	// for (...) {
	//   const t = ts[i];
	//   const a = B1(t);
	//   const b = B2(t);
	//   const ex = points[i].x - ((B0(t) + B1(t)) * p0.x + (B2(t) + B3(t)) * p3.x);
	//   const ey = points[i].y - ((B0(t) + B1(t)) * p0.y + (B2(t) + B3(t)) * p3.y);
	//   ...
	// }

	// TODO 3: det が十分大きければ α1, α2 をクラメル法で更新しよう
	// const det = c00 * c11 - c01 * c01;
	// alpha1 = (c11 * r0 - c01 * r1) / det;
	// alpha2 = (c00 * r1 - c01 * r0) / det;
	// α が 0 以下なら、このまま fallback の d を使おう

	return {
		p0,
		p1: { x: p0.x + tHat0.x * alpha1, y: p0.y + tHat0.y * alpha1 },
		p2: { x: p3.x + tHat3.x * alpha2, y: p3.y + tHat3.y * alpha2 },
		p3,
	};
}
`;

const SOLUTION = `// 第8章: 解答例 (簡易版 Schneider — Newton 反復なし)

type Vec2 = { x: number; y: number };
type CubicBezier = { p0: Vec2; p1: Vec2; p2: Vec2; p3: Vec2 };

function vsub(a: Vec2, b: Vec2): Vec2 { return { x: a.x - b.x, y: a.y - b.y }; }
function vlen(v: Vec2): number { return Math.hypot(v.x, v.y); }
function vnorm(v: Vec2): Vec2 { const l = vlen(v) || 1; return { x: v.x / l, y: v.y / l }; }

const B0 = (t: number) => { const u = 1 - t; return u * u * u; };
const B1 = (t: number) => { const u = 1 - t; return 3 * u * u * t; };
const B2 = (t: number) => { const u = 1 - t; return 3 * u * t * t; };
const B3 = (t: number) => t * t * t;

export function fitCubicBezier(points: Vec2[]): CubicBezier {
	const n = points.length;
	const p0 = points[0];
	const p3 = points[n - 1];
	if (n < 3) return { p0, p1: p0, p2: p3, p3 };

	const tHat0 = vnorm(vsub(points[1], p0));
	const tHat3 = vnorm(vsub(points[n - 2], p3));

	const ts: number[] = new Array(n);
	ts[0] = 0;
	let total = 0;
	for (let i = 1; i < n; i++) {
		total += vlen(vsub(points[i], points[i - 1]));
		ts[i] = total;
	}
	for (let i = 0; i < n; i++) ts[i] /= total || 1;

	let c00 = 0, c01 = 0, c11 = 0, r0 = 0, r1 = 0;
	const dot0 = tHat0.x * tHat0.x + tHat0.y * tHat0.y;
	const dot01 = tHat0.x * tHat3.x + tHat0.y * tHat3.y;
	const dot3 = tHat3.x * tHat3.x + tHat3.y * tHat3.y;
	for (let i = 0; i < n; i++) {
		const t = ts[i];
		const a = B1(t);
		const b = B2(t);
		c00 += a * a * dot0;
		c01 += a * b * dot01;
		c11 += b * b * dot3;
		const ex = points[i].x - ((B0(t) + B1(t)) * p0.x + (B2(t) + B3(t)) * p3.x);
		const ey = points[i].y - ((B0(t) + B1(t)) * p0.y + (B2(t) + B3(t)) * p3.y);
		r0 += a * (ex * tHat0.x + ey * tHat0.y);
		r1 += b * (ex * tHat3.x + ey * tHat3.y);
	}
	const det = c00 * c11 - c01 * c01;
	let alpha1 = 0, alpha2 = 0;
	if (Math.abs(det) > 1e-9) {
		alpha1 = (c11 * r0 - c01 * r1) / det;
		alpha2 = (c00 * r1 - c01 * r0) / det;
	}
	if (alpha1 < 1e-3 || alpha2 < 1e-3) {
		const fallback = vlen(vsub(p3, p0)) / 3;
		alpha1 = fallback;
		alpha2 = fallback;
	}
	return {
		p0,
		p1: { x: p0.x + tHat0.x * alpha1, y: p0.y + tHat0.y * alpha1 },
		p2: { x: p3.x + tHat3.x * alpha2, y: p3.y + tHat3.y * alpha2 },
		p3,
	};
}
`;

// 入力点列は「真の」3次ベジェ曲線をサンプリングした上に、端点では 0 になる小さなノイズを乗せる。
// fallback の |p3 - p0| / 3 では visibly ずれ、LSQ まで書くと点列の中心線へ近づく形にしている。
const RAW_POINTS: Vec2[] = (() => {
	const SRC = {
		p0: { x: -180, y: 0 },
		p1: { x: -150, y: 150 },
		p2: { x: 130, y: 150 },
		p3: { x: 180, y: 0 },
	};
	const pts: Vec2[] = [];
	for (let i = 0; i <= 48; i++) {
		const t = i / 48;
		const u = 1 - t;
		const b0 = u * u * u;
		const b1 = 3 * u * u * t;
		const b2 = 3 * u * t * t;
		const b3 = t * t * t;
		const baseX = b0 * SRC.p0.x + b1 * SRC.p1.x + b2 * SRC.p2.x + b3 * SRC.p3.x;
		const baseY = b0 * SRC.p0.y + b1 * SRC.p1.y + b2 * SRC.p2.y + b3 * SRC.p3.y;
		const envelope = Math.sin(Math.PI * t);
		const noise =
			envelope *
			3 *
			(0.55 * Math.sin(t * 17.1 + 0.4) +
				0.35 * Math.sin(t * 31.7 + 1.2) +
				0.1 * Math.cos(t * 43.9));
		pts.push({ x: baseX, y: baseY + noise });
	}
	return pts;
})();

const HARNESS = `
self.onmessage = () => {
	try {
		if (typeof fitCubicBezier !== "function") {
			self.postMessage({ ok: false, error: "fitCubicBezier を export してね" });
			return;
		}
		const points = ${JSON.stringify(RAW_POINTS)};
		const bez = fitCubicBezier(points);
		self.postMessage({ ok: true, result: bez });
	} catch (err) {
		self.postMessage({ ok: false, error: (err && err.stack) || String(err) });
	}
};
`;

// lint-unused-ignore
export default function Playground() {
	return (
		<AlgorithmRunner
			storageKey="08-bezier-fitting"
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
				for (const p of RAW_POINTS) {
					helpers.drawPoint(p, {
						color: "rgb(127 127 127 / 0.5)",
						radius: 2,
					});
				}
				const bez = result as CubicBezier | null;
				if (
					bez?.p0 &&
					bez?.p1 &&
					bez?.p2 &&
					bez?.p3 &&
					typeof bez.p1.x === "number"
				) {
					helpers.drawBezier(bez, {
						color: "#3a86ff",
						width: 2.5,
						showHandles: true,
					});
				}
			}}
		/>
	);
}
