"use client";

import { loader } from "@monaco-editor/react";
import { useEffect, useRef, useState } from "react";
import { CodeEditor } from "../_components/CodeEditor";
import { runInWorker } from "../_components/runInWorker";
import { TutorialCanvasWebGPU } from "../_components/TutorialCanvasWebGPU";

const STARTER = `// 第11章: 重心ファンを作ろう (Stencil-then-Cover の前半)

type Vec2 = { x: number; y: number };

export function buildFanTriangles(points: Vec2[]): Float32Array {
	// TODO:
	//   1. 全頂点の平均で重心 c を求める
	//   2. 各 i について、三角形 (c, points[i], points[(i+1)%n]) を出力に追加
	//   3. Float32Array に [x, y, x, y, ...] で詰めて返す
	return new Float32Array(0);
}
`;

const SOLUTION = `// 第11章: 解答例

type Vec2 = { x: number; y: number };

export function buildFanTriangles(points: Vec2[]): Float32Array {
	const n = points.length;
	if (n < 3) return new Float32Array(0);
	let cx = 0, cy = 0;
	for (const p of points) { cx += p.x; cy += p.y; }
	cx /= n; cy /= n;
	const out = new Float32Array(n * 6);
	let o = 0;
	for (let i = 0; i < n; i++) {
		const a = points[i];
		const b = points[(i + 1) % n];
		out[o++] = cx; out[o++] = cy;
		out[o++] = a.x; out[o++] = a.y;
		out[o++] = b.x; out[o++] = b.y;
	}
	return out;
}
`;

const STORAGE_KEY = "tutorial:11-stencil-then-cover";

const STAR_POLYGON: { x: number; y: number }[] = (() => {
	const points: { x: number; y: number }[] = [];
	const outer = 130;
	const inner = 55;
	for (let i = 0; i < 10; i++) {
		const r = i % 2 === 0 ? outer : inner;
		const a = (Math.PI * 2 * i) / 10 - Math.PI / 2;
		points.push({ x: r * Math.cos(a), y: -r * Math.sin(a) });
	}
	return points;
})();

const HARNESS = `
self.onmessage = () => {
	try {
		if (typeof buildFanTriangles !== "function") {
			self.postMessage({ ok: false, error: "buildFanTriangles を export してね" });
			return;
		}
		const polygon = ${JSON.stringify(STAR_POLYGON)};
		const result = buildFanTriangles(polygon);
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
				const uri = monaco.Uri.parse(`file:///11-stencil-${Date.now()}.ts`);
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
					<span className="text-xs text-muted-foreground">
						結果 (半透明で重ね描き — 凹部分は重なって濃く見えるよ)
					</span>
					<TutorialCanvasWebGPU
						width={500}
						height={350}
						worldUnit={1}
						vertices={vertices}
						fillColor={[0.23, 0.52, 1.0, 0.25]}
					/>
				</div>
			</div>
		</div>
	);
}
