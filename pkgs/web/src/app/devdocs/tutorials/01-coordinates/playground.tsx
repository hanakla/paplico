"use client";

import { AlgorithmRunner } from "../_components/AlgorithmRunner";

const STARTER = `// 第1章: 画面の点と、世界の点を変換しよう

type Vec2 = { x: number; y: number };
type Viewport = { x: number; y: number; zoom: number };
type CanvasSize = { width: number; height: number };

export function screenToWorld(
	screen: Vec2,
	viewport: Viewport,
	canvas: CanvasSize,
): Vec2 {
	// TODO: 画面の点を世界の点に変えよう！
	//   1. 画面の中心 (canvas.width/2, canvas.height/2) を引く
	//   2. ズーム (viewport.zoom) で割る
	//   3. Y を反転する (符号を逆に)
	//   4. viewport の (x, y) を足す
	return { x: 0, y: 0 };
}

export function worldToScreen(
	world: Vec2,
	viewport: Viewport,
	canvas: CanvasSize,
): Vec2 {
	// TODO: 世界の点を画面の点に戻そう！
	//   screenToWorld の逆向きを考えよう。引いたら足す、割ったらかける、反転は反転。
	return { x: 0, y: 0 };
}
`;

const SOLUTION = `// 第1章: 解答例

type Vec2 = { x: number; y: number };
type Viewport = { x: number; y: number; zoom: number };
type CanvasSize = { width: number; height: number };

export function screenToWorld(
	screen: Vec2,
	viewport: Viewport,
	canvas: CanvasSize,
): Vec2 {
	const cx = canvas.width / 2;
	const cy = canvas.height / 2;
	return {
		x: (screen.x - cx) / viewport.zoom + viewport.x,
		y: -(screen.y - cy) / viewport.zoom + viewport.y,
	};
}

export function worldToScreen(
	world: Vec2,
	viewport: Viewport,
	canvas: CanvasSize,
): Vec2 {
	const cx = canvas.width / 2;
	const cy = canvas.height / 2;
	return {
		x: cx + (world.x - viewport.x) * viewport.zoom,
		y: cy - (world.y - viewport.y) * viewport.zoom,
	};
}
`;

const HARNESS = `
self.onmessage = () => {
	try {
		if (typeof worldToScreen !== "function") {
			self.postMessage({ ok: false, error: "worldToScreen を export してね" });
			return;
		}
		const tests = [
			{ x: 120, y: 0 },
			{ x: 0, y: 120 },
			{ x: -120, y: 0 },
			{ x: 0, y: -120 },
		];
		const viewport = { x: 0, y: 0, zoom: 1 };
		const canvas = { width: 500, height: 350 };
		const screens = tests.map((w) => worldToScreen(w, viewport, canvas));
		self.postMessage({ ok: true, result: { tests, screens } });
	} catch (err) {
		self.postMessage({ ok: false, error: (err && err.stack) || String(err) });
	}
};
`;

type RenderResult = {
	tests: { x: number; y: number }[];
	screens: { x: number; y: number }[];
};

// lint-unused-ignore
export default function Playground() {
	return (
		<AlgorithmRunner
			storageKey="01-coordinates"
			starter={STARTER}
			solution={SOLUTION}
			harness={HARNESS}
			width={500}
			height={350}
			worldUnit={1}
			render={(result, helpers) => {
				helpers.drawAxes();
				const r = result as RenderResult | null;
				if (!r) return;
				helpers.ctx.save();
				helpers.ctx.fillStyle = "#3a86ff";
				for (let i = 0; i < r.screens.length; i++) {
					const s = r.screens[i];
					const w = r.tests[i];
					if (s && typeof s.x === "number" && typeof s.y === "number") {
						helpers.ctx.beginPath();
						helpers.ctx.arc(s.x, s.y, 6, 0, Math.PI * 2);
						helpers.ctx.fill();
						helpers.ctx.font = "11px ui-sans-serif, system-ui, sans-serif";
						helpers.ctx.fillText(`(${w.x}, ${w.y})`, s.x + 8, s.y - 4);
					}
				}
				helpers.ctx.restore();
				helpers.drawText(
					{ x: 0, y: helpers.height / 2 / helpers.worldUnit - 12 },
					"4つの青い点が上下左右に散らばれば OK！",
					{ anchor: "center" },
				);
			}}
		/>
	);
}
