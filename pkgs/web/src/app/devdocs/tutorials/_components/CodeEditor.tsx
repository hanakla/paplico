"use client";

import type { OnMount } from "@monaco-editor/react";
import dynamic from "next/dynamic";
import { useEffect, useRef } from "react";

const Editor = dynamic(() => import("@monaco-editor/react"), { ssr: false });

const SHARED_TYPES = `
declare global {
	type Vec2 = { x: number; y: number };
	type CubicBezier = { p0: Vec2; p1: Vec2; p2: Vec2; p3: Vec2 };
	type AABB = { min: Vec2; max: Vec2 };
	type RawPoint = Vec2 & { pressure: number; timestamp: number };
}
export {};
`;

type Props = {
	value: string;
	onChange: (value: string) => void;
	language?: string;
	height?: number | string;
	storageKey?: string;
	readOnly?: boolean;
};

export function CodeEditor({
	value,
	onChange,
	language = "typescript",
	height = 320,
	storageKey,
	readOnly = false,
}: Props) {
	const initialLoadRef = useRef(false);

	useEffect(() => {
		if (!storageKey || initialLoadRef.current) return;
		initialLoadRef.current = true;
		try {
			const saved = localStorage.getItem(storageKey);
			if (saved && saved !== value) {
				onChange(saved);
			}
		} catch {
			// localStorage 不可の環境では無視
		}
	}, [storageKey, value, onChange]);

	const handleMount: OnMount = (_editor, monaco) => {
		monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
			target: monaco.languages.typescript.ScriptTarget.ES2020,
			module: monaco.languages.typescript.ModuleKind.ESNext,
			strict: true,
			noImplicitAny: true,
			jsx: monaco.languages.typescript.JsxEmit.None,
			isolatedModules: true,
			esModuleInterop: true,
			allowNonTsExtensions: true,
		});
		monaco.languages.typescript.typescriptDefaults.addExtraLib(
			SHARED_TYPES,
			"file:///node_modules/@tutorial/shared.d.ts",
		);
	};

	const handleChange = (val: string | undefined) => {
		const next = val ?? "";
		onChange(next);
		if (storageKey) {
			try {
				localStorage.setItem(storageKey, next);
			} catch {
				// 容量制限などは握り潰す
			}
		}
	};

	return (
		<div className="overflow-hidden rounded-lg border border-border">
			<Editor
				value={value}
				defaultLanguage={language}
				height={height}
				theme="vs-dark"
				onMount={handleMount}
				onChange={handleChange}
				options={{
					minimap: { enabled: false },
					fontSize: 13,
					lineNumbers: "on",
					scrollBeyondLastLine: false,
					tabSize: 2,
					wordWrap: "on",
					automaticLayout: true,
					readOnly,
				}}
			/>
		</div>
	);
}
