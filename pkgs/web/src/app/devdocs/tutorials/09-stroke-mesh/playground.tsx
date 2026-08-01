"use client";

import { loader } from "@monaco-editor/react";
import { useEffect, useRef, useState } from "react";
import { CodeEditor } from "../_components/CodeEditor";
import { runInWorker } from "../_components/runInWorker";
import { TutorialCanvasWebGPU } from "../_components/TutorialCanvasWebGPU";

const STARTER = `// 第9章: 線を三角形のあつまりにしよう

type Vec2 = { x: number; y: number };

export function tessellateStroke(points: Vec2[], strokeWidth: number): Float32Array {
	// TODO:
	//   1. 各点で接線 T を計算 (前後点の差分の正規化、両端は片側差分)
	//   2. 法線 N = (-T.y, T.x) に半幅 (strokeWidth / 2) を掛けてずらす
	//   3. 各点で L = p + N * half, R = p - N * half を作る
	//   4. 隣接点間で 2 つの三角形:
	//      [L_i, R_i, L_{i+1}] と [R_i, R_{i+1}, L_{i+1}]
	//   5. すべての三角形の頂点 (x, y, x, y, ...) を Float32Array で返す
	return new Float32Array(0);
}
`;

const SOLUTION = `// 第9章: 解答例

type Vec2 = { x: number; y: number };

export function tessellateStroke(points: Vec2[], strokeWidth: number): Float32Array {
	const n = points.length;
	if (n < 2) return new Float32Array(0);
	const half = strokeWidth / 2;
	const lefts: Vec2[] = [];
	const rights: Vec2[] = [];
	for (let i = 0; i < n; i++) {
		let tx: number, ty: number;
		if (i === 0) {
			tx = points[1].x - points[0].x;
			ty = points[1].y - points[0].y;
		} else if (i === n - 1) {
			tx = points[n - 1].x - points[n - 2].x;
			ty = points[n - 1].y - points[n - 2].y;
		} else {
			tx = points[i + 1].x - points[i - 1].x;
			ty = points[i + 1].y - points[i - 1].y;
		}
		const len = Math.hypot(tx, ty) || 1;
		tx /= len; ty /= len;
		const nx = -ty;
		const ny = tx;
		lefts.push({ x: points[i].x + nx * half, y: points[i].y + ny * half });
		rights.push({ x: points[i].x - nx * half, y: points[i].y - ny * half });
	}
	const out = new Float32Array((n - 1) * 12);
	let o = 0;
	for (let i = 0; i < n - 1; i++) {
		const l0 = lefts[i], r0 = rights[i], l1 = lefts[i + 1], r1 = rights[i + 1];
		out[o++] = l0.x; out[o++] = l0.y;
		out[o++] = r0.x; out[o++] = r0.y;
		out[o++] = l1.x; out[o++] = l1.y;
		out[o++] = r0.x; out[o++] = r0.y;
		out[o++] = r1.x; out[o++] = r1.y;
		out[o++] = l1.x; out[o++] = l1.y;
	}
	return out;
}
`;

const STROKE_WIDTH = 30;
const STORAGE_KEY = "tutorial:09-stroke-mesh";

const CENTER_LINE: { x: number; y: number }[] = (() => {
	const pts: { x: number; y: number }[] = [];
	for (let i = 0; i <= 60; i++) {
		const t = i / 60;
		const x = -220 + t * 440;
		const y = 70 * Math.sin(t * Math.PI * 2);
		pts.push({ x, y });
	}
	return pts;
})();

const HARNESS = `
self.onmessage = () => {
	try {
		if (typeof tessellateStroke !== "function") {
			self.postMessage({ ok: false, error: "tessellateStroke を export してね" });
			return;
		}
		const points = ${JSON.stringify(CENTER_LINE)};
		const result = tessellateStroke(points, ${STROKE_WIDTH});
		self.postMessage({ ok: true, result });
	} catch (err) {
		self.postMessage({ ok: false, error: (err && err.stack) || String(err) });
	}
};
`;

// lint-unused-ignore
export default function Playground() {
	const [draft, setDraft] = useState(STARTER);
	const [showSolution, setShowSolution] = useState(false);
	const [vertices, setVertices] = useState<Float32Array | null>(null);
	const [error, setError] = useState<string | null>(null);
	const showSolutionRef = useRef(showSolution);
	showSolutionRef.current = showSolution;

	const displayed = showSolution ? SOLUTION : draft;

	useEffect(() => {
		let cancelled = false;
		const controller = new AbortController();
		(async () => {
			try {
				const monaco = await loader.init();
				const uri = monaco.Uri.parse(`file:///09-stroke-mesh-${Date.now()}.ts`);
				const model = monaco.editor.createModel(displayed, "typescript", uri);
				const worker = await monaco.languages.typescript.getTypeScriptWorker();
				const client = await worker(model.uri);
				const out = await client.getEmitOutput(model.uri.toString());
				model.dispose();
				const js = out.outputFiles[0]?.text ?? "";
				if (!js) return;
				const result = await runInWorker<Float32Array | unknown>({
					jsCode: js,
					harness: HARNESS,
					signal: controller.signal,
				});
				if (cancelled) return;
				if (result instanceof Float32Array && result.length >= 6) {
					setVertices(result);
				} else if (
					result &&
					typeof (result as { length?: number }).length === "number"
				) {
					setVertices(new Float32Array(result as ArrayLike<number>));
				} else {
					setVertices(null);
				}
				setError(null);
			} catch (e) {
				if (cancelled) return;
				if (e instanceof DOMException && e.name === "AbortError") return;
				setError(e instanceof Error ? e.message : String(e));
				setVertices(null);
			}
		})();
		return () => {
			cancelled = true;
			controller.abort();
		};
	}, [displayed]);

	const handleEditorChange = (next: string) => {
		if (showSolutionRef.current) return;
		setDraft(next);
	};

	const handleReset = () => {
		setDraft(STARTER);
		setShowSolution(false);
		try {
			localStorage.removeItem(STORAGE_KEY);
		} catch {
			// ignore
		}
	};

	return (
		<div className="relative left-1/2 right-1/2 -ml-[50vw] -mr-[50vw] my-8 w-screen px-4 sm:px-6">
			<div className="mx-auto grid max-w-[1400px] grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(420px,520px)]">
				<div className="flex flex-col gap-2">
					<div className="flex items-center justify-between text-xs">
						<span className="text-muted-foreground">コードを書いてみよう</span>
						<div className="flex gap-2">
							<button
								type="button"
								onClick={handleReset}
								className="rounded border border-border px-2 py-0.5 hover:bg-accent"
							>
								リセット
							</button>
							<button
								type="button"
								onClick={() => setShowSolution((v) => !v)}
								className="rounded border border-border px-2 py-0.5 hover:bg-accent"
							>
								{showSolution ? "解答を隠す" : "解答を見る"}
							</button>
						</div>
					</div>
					<CodeEditor
						value={displayed}
						onChange={handleEditorChange}
						storageKey={showSolution ? undefined : STORAGE_KEY}
						readOnly={showSolution}
						height={480}
					/>
					{error && (
						<pre className="overflow-x-auto rounded border border-red-500/50 bg-red-500/10 p-2 text-xs text-red-500">
							{error}
						</pre>
					)}
				</div>
				<div className="flex flex-col gap-2">
					<span className="text-xs text-muted-foreground">結果 (WebGPU)</span>
					<TutorialCanvasWebGPU
						width={500}
						height={350}
						worldUnit={1}
						vertices={vertices}
						fillColor={[0.23, 0.52, 1.0, 0.85]}
					/>
				</div>
			</div>
		</div>
	);
}
