"use client";

import { loader } from "@monaco-editor/react";
import { useEffect, useRef, useState } from "react";
import { CodeEditor } from "../_components/CodeEditor";
import { runInWorker } from "../_components/runInWorker";
import { TutorialCanvasWebGPU } from "../_components/TutorialCanvasWebGPU";

const STARTER = `// 第10章: 多角形を三角形に分けよう (Ear Clipping)

type Vec2 = { x: number; y: number };

function cross(a: Vec2, b: Vec2, c: Vec2): number {
	return (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
}

function pointInTriangle(p: Vec2, a: Vec2, b: Vec2, c: Vec2): boolean {
	const d1 = cross(a, b, p);
	const d2 = cross(b, c, p);
	const d3 = cross(c, a, p);
	const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
	const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
	return !(hasNeg && hasPos);
}

export function earClip(polygon: Vec2[]): Float32Array {
	// TODO:
	//   1. const verts = [...polygon] (作業用に複製)
	//   2. while (verts.length > 3): 各 i について
	//      - prev = verts[(i-1+N)%N], curr = verts[i], next = verts[(i+1)%N]
	//      - cross(prev, curr, next) > 0 なら凸
	//      - 他の頂点が三角形の中に無ければ ear → 出力に追加 + verts.splice(i, 1)
	//   3. 残り 3 頂点を最後の三角形として出力
	//   4. Float32Array に [x, y, x, y, ...] で詰める
	return new Float32Array(0);
}
`;

const SOLUTION = `// 第10章: 解答例

type Vec2 = { x: number; y: number };

function cross(a: Vec2, b: Vec2, c: Vec2): number {
	return (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
}

function pointInTriangle(p: Vec2, a: Vec2, b: Vec2, c: Vec2): boolean {
	const d1 = cross(a, b, p);
	const d2 = cross(b, c, p);
	const d3 = cross(c, a, p);
	const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
	const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
	return !(hasNeg && hasPos);
}

export function earClip(polygon: Vec2[]): Float32Array {
	const verts = polygon.slice();
	const tris: number[] = [];
	let guard = verts.length * verts.length;
	while (verts.length > 3 && guard-- > 0) {
		const n = verts.length;
		let earFound = false;
		for (let i = 0; i < n; i++) {
			const prev = verts[(i - 1 + n) % n];
			const curr = verts[i];
			const next = verts[(i + 1) % n];
			if (cross(prev, curr, next) <= 0) continue;
			let hasInside = false;
			for (let j = 0; j < n; j++) {
				if (j === (i - 1 + n) % n || j === i || j === (i + 1) % n) continue;
				if (pointInTriangle(verts[j], prev, curr, next)) {
					hasInside = true;
					break;
				}
			}
			if (hasInside) continue;
			tris.push(prev.x, prev.y, curr.x, curr.y, next.x, next.y);
			verts.splice(i, 1);
			earFound = true;
			break;
		}
		if (!earFound) break;
	}
	if (verts.length === 3) {
		tris.push(
			verts[0].x, verts[0].y,
			verts[1].x, verts[1].y,
			verts[2].x, verts[2].y,
		);
	}
	return new Float32Array(tris);
}
`;

const STORAGE_KEY = "tutorial:10-ear-clipping";

const STAR_POLYGON: { x: number; y: number }[] = (() => {
	const points: { x: number; y: number }[] = [];
	const outer = 130;
	const inner = 55;
	for (let i = 0; i < 10; i++) {
		const r = i % 2 === 0 ? outer : inner;
		const a = (Math.PI * 2 * i) / 10 - Math.PI / 2;
		points.push({ x: r * Math.cos(a), y: -r * Math.sin(a) });
	}
	return points.reverse();
})();

const HARNESS = `
self.onmessage = () => {
	try {
		if (typeof earClip !== "function") {
			self.postMessage({ ok: false, error: "earClip を export してね" });
			return;
		}
		const polygon = ${JSON.stringify(STAR_POLYGON)};
		const result = earClip(polygon);
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
				const uri = monaco.Uri.parse(
					`file:///10-ear-clipping-${Date.now()}.ts`,
				);
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
