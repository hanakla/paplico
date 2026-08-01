"use client";

import { loader } from "@monaco-editor/react";
import { useEffect, useRef, useState } from "react";
import { CodeEditor } from "./CodeEditor";
import { runInWorker } from "./runInWorker";
import { type CanvasHelpers, TutorialCanvas2D } from "./TutorialCanvas2D";

type Props = {
	storageKey: string;
	starter: string;
	solution: string;
	harness: string;
	width?: number;
	height?: number;
	worldUnit?: number;
	render: (result: unknown, helpers: CanvasHelpers) => void;
	controls?: React.ReactNode;
	resultLabel?: string;
	editorHeight?: number;
	fullBleed?: boolean;
	timeoutMs?: number;
};

export function AlgorithmRunner({
	storageKey,
	starter,
	solution,
	harness,
	width = 600,
	height = 400,
	worldUnit = 1,
	render,
	controls,
	resultLabel = "結果",
	editorHeight = 480,
	fullBleed = true,
	timeoutMs = 1500,
}: Props) {
	const [draft, setDraft] = useState(starter);
	const [result, setResult] = useState<unknown>(null);
	const [error, setError] = useState<string | null>(null);
	const [showSolution, setShowSolution] = useState(false);
	const renderRef = useRef(render);
	renderRef.current = render;
	const showSolutionRef = useRef(showSolution);
	showSolutionRef.current = showSolution;

	const displayedSource = showSolution ? solution : draft;
	const lsKey = `tutorial:${storageKey}`;

	useEffect(() => {
		let cancelled = false;
		const controller = new AbortController();
		(async () => {
			try {
				const monaco = await loader.init();
				const uri = monaco.Uri.parse(
					`file:///${storageKey}-${Date.now()}-${Math.random()
						.toString(36)
						.slice(2)}.ts`,
				);
				const model = monaco.editor.createModel(
					displayedSource,
					"typescript",
					uri,
				);
				const worker = await monaco.languages.typescript.getTypeScriptWorker();
				const client = await worker(model.uri);
				const out = await client.getEmitOutput(model.uri.toString());
				model.dispose();
				const js = out.outputFiles[0]?.text ?? "";
				if (!js) {
					if (!cancelled) {
						setError("コードが空だよ");
						setResult(null);
					}
					return;
				}
				const r = await runInWorker({
					jsCode: js,
					harness,
					timeoutMs,
					signal: controller.signal,
				});
				if (cancelled) return;
				setResult(r);
				setError(null);
			} catch (e) {
				if (cancelled) return;
				if (e instanceof DOMException && e.name === "AbortError") return;
				setError(e instanceof Error ? e.message : String(e));
				setResult(null);
			}
		})();
		return () => {
			cancelled = true;
			controller.abort();
		};
	}, [displayedSource, storageKey, harness, timeoutMs]);

	const draw = (helpers: CanvasHelpers) => {
		if (result === null) {
			helpers.drawText({ x: 0, y: 0 }, "コードを書くと結果が出るよ", {
				anchor: "center",
				color: "rgb(127 127 127 / 0.7)",
			});
			return;
		}
		try {
			renderRef.current(result, helpers);
		} catch (e) {
			console.error("[tutorial] render error:", e);
			helpers.drawText({ x: 0, y: 0 }, "描画エラー", {
				anchor: "center",
				color: "#e0457b",
			});
		}
	};

	const handleEditorChange = (next: string) => {
		if (showSolutionRef.current) return;
		setDraft(next);
	};

	const handleReset = () => {
		setDraft(starter);
		setShowSolution(false);
		try {
			localStorage.removeItem(lsKey);
		} catch {
			// localStorage 不可の環境では無視
		}
	};

	const wrapperClass = fullBleed
		? "relative left-1/2 right-1/2 -ml-[50vw] -mr-[50vw] my-8 w-screen px-4 sm:px-6"
		: "my-6";

	return (
		<div className={wrapperClass}>
			<div className="mx-auto grid max-w-[1400px] grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(420px,520px)]">
				<div className="flex flex-col gap-2">
					<div className="flex items-center justify-between text-xs">
						<span className="text-muted-foreground">コードを書いてみよう</span>
						<div className="flex gap-2">
							<button
								type="button"
								onClick={handleReset}
								className="rounded border border-border px-2 py-0.5 hover:bg-accent"
								title="スターターのコードに戻し、保存内容も消すよ"
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
						value={displayedSource}
						onChange={handleEditorChange}
						storageKey={showSolution ? undefined : lsKey}
						readOnly={showSolution}
						height={editorHeight}
					/>
					{error && (
						<pre className="overflow-x-auto rounded border border-red-500/50 bg-red-500/10 p-2 text-xs text-red-500">
							{error}
						</pre>
					)}
				</div>
				<div className="flex flex-col gap-2">
					<span className="text-xs text-muted-foreground">{resultLabel}</span>
					<TutorialCanvas2D
						width={width}
						height={height}
						worldUnit={worldUnit}
						draw={draw}
					/>
					{controls}
				</div>
			</div>
		</div>
	);
}
