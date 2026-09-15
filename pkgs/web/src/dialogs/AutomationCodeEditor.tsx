"use client";

import Editor, {
	type BeforeMount,
	loader,
	type OnMount,
} from "@monaco-editor/react";
import {
	createScriptHost,
	registerSyrup,
	SYRUP_LANGUAGE_ID,
} from "@paplico/syrup";
import * as monaco from "monaco-editor";
import { useEffect, useRef } from "react";
import { registerPaplicoScriptingApi } from "@/scripting/api";
import { useEventCallback } from "@/utils/hooks";

// Serve Monaco from the bundle instead of the default CDN, which the Tauri CSP
// blocks and which is unreachable offline.
self.MonacoEnvironment = {
	getWorker: () =>
		new Worker(
			new URL("monaco-editor/esm/vs/editor/editor.worker", import.meta.url),
			{ type: "module" },
		),
};
loader.config({ monaco });

// lint-unused-ignore: loaded through next/dynamic, which the linter can't follow
export default function AutomationCodeEditor({
	value,
	readOnly,
	onChange,
	onMount,
}: {
	value: string;
	readOnly: boolean;
	onChange: (value: string) => void;
	onMount?: OnMount;
}) {
	const disposeLanguageRef = useRef<(() => void) | null>(null);
	const handleChange = useEventCallback((nextValue: string | undefined) => {
		onChange(nextValue ?? "");
	});
	const handleBeforeMount: BeforeMount = useEventCallback((monaco) => {
		disposeLanguageRef.current?.();
		const host = createScriptHost();
		registerPaplicoScriptingApi(host);
		disposeLanguageRef.current = registerSyrup(monaco, host);
	});

	useEffect(
		() => () => {
			disposeLanguageRef.current?.();
			disposeLanguageRef.current = null;
		},
		[],
	);

	return (
		<Editor
			height="100%"
			defaultLanguage={SYRUP_LANGUAGE_ID}
			theme="vs-dark"
			value={value}
			beforeMount={handleBeforeMount}
			onChange={handleChange}
			onMount={onMount}
			options={{
				automaticLayout: true,
				fontSize: 13,
				minimap: { enabled: false },
				padding: { top: 12 },
				readOnly,
				scrollBeyondLastLine: false,
				tabSize: 4,
			}}
		/>
	);
}
