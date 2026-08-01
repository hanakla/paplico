"use client";

import { loader } from "@monaco-editor/react";
import { useEffect, useRef, useState } from "react";
import { CodeEditor } from "../_components/CodeEditor";
import { runInWorker } from "../_components/runInWorker";

const STARTER = `// 第12章: 4 隅の色をなめらかにつないで塗ろう

type Color = { r: number; g: number; b: number };

function lerp(a: number, b: number, t: number): number {
	return a + (b - a) * t;
}

export function bilinearInterp(
	u: number,
	v: number,
	c00: Color,
	c10: Color,
	c11: Color,
	c01: Color,
): Color {
	// TODO:
	//   1. top    = lerp(c00, c10, u)   ← 上辺の u 位置の色
	//   2. bottom = lerp(c01, c11, u)   ← 下辺の u 位置の色
	//   3. result = lerp(top, bottom, v)
	//   r, g, b の 3 成分でそれぞれ計算してね
	//   例: r = lerp(lerp(c00.r, c10.r, u), lerp(c01.r, c11.r, u), v)
	return { r: 0, g: 0, b: 0 };
}
`;

const SOLUTION = `// 第12章: 解答例

type Color = { r: number; g: number; b: number };

function lerp(a: number, b: number, t: number): number {
	return a + (b - a) * t;
}

export function bilinearInterp(
	u: number,
	v: number,
	c00: Color,
	c10: Color,
	c11: Color,
	c01: Color,
): Color {
	const r = lerp(lerp(c00.r, c10.r, u), lerp(c01.r, c11.r, u), v);
	const g = lerp(lerp(c00.g, c10.g, u), lerp(c01.g, c11.g, u), v);
	const b = lerp(lerp(c00.b, c10.b, u), lerp(c01.b, c11.b, u), v);
	return { r, g, b };
}
`;

const STORAGE_KEY = "tutorial:12-coons-patch";

const C00 = { r: 224, g: 69, b: 123 }; // pink
const C10 = { r: 58, g: 134, b: 255 }; // blue
const C11 = { r: 244, g: 162, b: 97 }; // orange
const C01 = { r: 42, g: 157, b: 143 }; // teal

const CANVAS_W = 360;
const CANVAS_H = 280;

const HARNESS = `
self.onmessage = () => {
	try {
		if (typeof bilinearInterp !== "function") {
			self.postMessage({ ok: false, error: "bilinearInterp を export してね" });
			return;
		}
		const W = ${CANVAS_W};
		const H = ${CANVAS_H};
		const c00 = ${JSON.stringify(C00)};
		const c10 = ${JSON.stringify(C10)};
		const c11 = ${JSON.stringify(C11)};
		const c01 = ${JSON.stringify(C01)};
		const data = new Uint8ClampedArray(W * H * 4);
		for (let y = 0; y < H; y++) {
			const v = y / (H - 1);
			for (let x = 0; x < W; x++) {
				const u = x / (W - 1);
				const c = bilinearInterp(u, v, c00, c10, c11, c01);
				const idx = (y * W + x) * 4;
				if (c && typeof c.r === "number") {
					data[idx] = c.r | 0;
					data[idx + 1] = c.g | 0;
					data[idx + 2] = c.b | 0;
				}
				data[idx + 3] = 255;
			}
		}
		self.postMessage({ ok: true, result: data }, [data.buffer]);
	} catch (err) {
		self.postMessage({ ok: false, error: (err && err.stack) || String(err) });
	}
};
`;

// lint-unused-ignore
export default function Playground() {
	const [draft, setDraft] = useState(STARTER);
	const [showSolution, setShowSolution] = useState(false);
	const [pixelData, setPixelData] = useState<Uint8ClampedArray | null>(null);
	const [error, setError] = useState<string | null>(null);
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const showSolutionRef = useRef(showSolution);
	showSolutionRef.current = showSolution;

	const displayed = showSolution ? SOLUTION : draft;

	useEffect(() => {
		let cancelled = false;
		const controller = new AbortController();
		(async () => {
			try {
				const monaco = await loader.init();
				const uri = monaco.Uri.parse(`file:///12-coons-${Date.now()}.ts`);
				const model = monaco.editor.createModel(displayed, "typescript", uri);
				const worker = await monaco.languages.typescript.getTypeScriptWorker();
				const client = await worker(model.uri);
				const out = await client.getEmitOutput(model.uri.toString());
				model.dispose();
				const js = out.outputFiles[0]?.text ?? "";
				if (!js) return;
				const result = await runInWorker<Uint8ClampedArray | unknown>({
					jsCode: js,
					harness: HARNESS,
					timeoutMs: 5000,
					signal: controller.signal,
				});
				if (cancelled) return;
				if (result instanceof Uint8ClampedArray) {
					setPixelData(result);
				} else if (
					result &&
					typeof (result as { length?: number }).length === "number"
				) {
					setPixelData(new Uint8ClampedArray(result as ArrayLike<number>));
				} else {
					setPixelData(null);
				}
				setError(null);
			} catch (e) {
				if (cancelled) return;
				if (e instanceof DOMException && e.name === "AbortError") return;
				setError(e instanceof Error ? e.message : String(e));
				setPixelData(null);
			}
		})();
		return () => {
			cancelled = true;
			controller.abort();
		};
	}, [displayed]);

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		const dpr = window.devicePixelRatio || 1;
		canvas.width = CANVAS_W * dpr;
		canvas.height = CANVAS_H * dpr;
		canvas.style.width = `${CANVAS_W}px`;
		canvas.style.height = `${CANVAS_H}px`;
		const ctx = canvas.getContext("2d");
		if (!ctx) return;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

		if (!pixelData || pixelData.length !== CANVAS_W * CANVAS_H * 4) {
			ctx.fillStyle = "rgb(127 127 127 / 0.6)";
			ctx.font = "14px ui-sans-serif, system-ui, sans-serif";
			ctx.textAlign = "center";
			ctx.fillText("関数の準備中…", CANVAS_W / 2, CANVAS_H / 2);
			return;
		}
		const img = ctx.createImageData(CANVAS_W, CANVAS_H);
		img.data.set(pixelData);
		ctx.putImageData(img, 0, 0);
	}, [pixelData]);

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
			<div className="mx-auto grid max-w-[1400px] grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(380px,420px)]">
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
						結果 (4 隅: pink / blue / teal / orange)
					</span>
					<canvas
						ref={canvasRef}
						className="block rounded-lg border border-border bg-background"
					/>
				</div>
			</div>
		</div>
	);
}
