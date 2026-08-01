/// <reference types="vite/client" />

import {
	createScriptHost,
	type Diagnostic,
	registerSyrup,
	type TestResult,
	type WorkerRunner,
} from "@paplico/syrup";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import { createMockPaplicoRuntime, PAPLICO_DECLARATIONS } from "./paplicoMock";
import { BRUSHES_MODULE_SOURCE, SAMPLES } from "./samples";
import SyrupWorker from "./syrupWorker?worker";

(self as { MonacoEnvironment?: monaco.Environment }).MonacoEnvironment = {
	getWorker: () => new editorWorker(),
};

// The compiled-JS pane only needs Monarch highlighting. Disable the
// TypeScript language service for "javascript" models so Monaco never
// requests its dedicated ts.worker (we only ship the base editor worker).
monaco.languages.typescript.javascriptDefaults.setModeConfiguration({
	completionItems: false,
	hovers: false,
	documentSymbols: false,
	definitions: false,
	references: false,
	documentHighlights: false,
	rename: false,
	diagnostics: false,
	documentRangeFormattingEdits: false,
	signatureHelp: false,
	onTypeFormattingEdits: false,
	codeActions: false,
	inlayHints: false,
});

type ThemePreference = "light" | "dark" | "system";

const INITIAL_SAMPLE_ID = "basics";
const THEME_STORAGE_KEY = "syrup-playground-theme";

const outputEl = document.getElementById("output") as HTMLPreElement;
const runButton = document.getElementById("run-button") as HTMLButtonElement;
const testButton = document.getElementById("test-button") as HTMLButtonElement;
const clearButton = document.getElementById(
	"clear-button",
) as HTMLButtonElement;
const runModeSelect = document.getElementById("run-mode") as HTMLSelectElement;
const sampleSelect = document.getElementById(
	"sample-select",
) as HTMLSelectElement;
const themeSelect = document.getElementById(
	"theme-select",
) as HTMLSelectElement;

const darkSchemeQuery = window.matchMedia("(prefers-color-scheme: dark)");

const initialThemePreference = loadThemePreference();
themeSelect.value = initialThemePreference;
applyTheme(initialThemePreference);

themeSelect.addEventListener("change", () => {
	const preference = normalizeThemePreference(themeSelect.value);
	localStorage.setItem(THEME_STORAGE_KEY, preference);
	applyTheme(preference);
});

darkSchemeQuery.addEventListener("change", () => {
	if (loadThemePreference() === "system") applyTheme("system");
});

const host = createScriptHost({
	stdout: (text: string) => appendOutput(text),
});

host.registerPackage({
	name: "paplico",
	declarations: PAPLICO_DECLARATIONS,
	runtime: createMockPaplicoRuntime((text) => appendOutput(text)),
});

const moduleEditor = monaco.editor.create(
	document.getElementById("module-editor") as HTMLElement,
	{
		value: BRUSHES_MODULE_SOURCE,
		language: "syrup",
		minimap: { enabled: false },
		automaticLayout: true,
		fontSize: 13,
	},
);

host.setModuleResolver(
	(specifier: string) => {
		if (specifier === "brushes") return moduleEditor.getValue();
		return null;
	},
	{ knownSpecifiers: ["brushes"] },
);

registerSyrup(monaco, host);

const initialSample =
	SAMPLES.find((sample) => sample.id === INITIAL_SAMPLE_ID) ?? SAMPLES[0];

const mainEditor = monaco.editor.create(
	document.getElementById("main-editor") as HTMLElement,
	{
		value: initialSample.source,
		language: "syrup",
		minimap: { enabled: false },
		automaticLayout: true,
		fontSize: 13,
	},
);

const compiledEditor = monaco.editor.create(
	document.getElementById("compiled-js") as HTMLElement,
	{
		value: "",
		language: "javascript",
		readOnly: true,
		minimap: { enabled: false },
		automaticLayout: true,
		fontSize: 13,
	},
);

let compilePreviewTimer: number | undefined;
mainEditor.onDidChangeModelContent(scheduleCompilePreview);
moduleEditor.onDidChangeModelContent(scheduleCompilePreview);
// The pane is always visible, so show the initial sample's compiled JS on load
void refreshCompiledPreview();

for (const sample of SAMPLES) {
	const option = document.createElement("option");
	option.value = sample.id;
	option.textContent = sample.title;
	sampleSelect.append(option);
}
sampleSelect.value = initialSample.id;

sampleSelect.addEventListener("change", () => {
	const sample = SAMPLES.find((entry) => entry.id === sampleSelect.value);
	if (sample) mainEditor.setValue(sample.source);
});

let workerRunner: WorkerRunner | null = null;

runButton.addEventListener("click", () => {
	void runCurrentSource();
});

testButton.addEventListener("click", () => {
	void runCurrentTests();
});

clearButton.addEventListener("click", () => {
	outputEl.textContent = "";
});

async function runCurrentSource(): Promise<void> {
	runButton.disabled = true;
	try {
		const { code, diagnostics } = await host.compile(mainEditor.getValue());

		for (const diagnostic of diagnostics) {
			appendOutput(formatDiagnostic(diagnostic), "error");
		}
		if (code == null) {
			appendOutput("Compilation failed.", "error");
			return;
		}
		compiledEditor.setValue(code);

		if (runModeSelect.value === "worker") {
			workerRunner ??= host.createWorkerRunner(new SyrupWorker());
			await workerRunner.run(code);
		} else {
			await host.run(code);
		}
	} catch (error) {
		appendOutput(
			error instanceof Error ? error.message : String(error),
			"error",
		);
	} finally {
		runButton.disabled = false;
	}
}

async function runCurrentTests(): Promise<void> {
	testButton.disabled = true;
	try {
		const source = mainEditor.getValue();
		const { code, diagnostics } = await host.compile(source, { mode: "test" });

		for (const diagnostic of diagnostics) {
			appendOutput(formatDiagnostic(diagnostic), "error");
		}
		if (code == null) {
			appendOutput("Compilation failed.", "error");
			return;
		}
		compiledEditor.setValue(code);

		let results: TestResult[];
		if (runModeSelect.value === "worker") {
			workerRunner ??= host.createWorkerRunner(new SyrupWorker());
			results = await workerRunner.runTests(code);
		} else {
			results = await host.runTests(source);
		}
		renderTestResults(results);
	} catch (error) {
		appendOutput(
			error instanceof Error ? error.message : String(error),
			"error",
		);
	} finally {
		testButton.disabled = false;
	}
}

function renderTestResults(results: TestResult[]): void {
	if (results.length === 0) {
		appendOutput("No @test functions in main.syrup.");
		return;
	}
	for (const result of results) {
		if (result.passed) {
			appendOutput(`✓ ${result.name}`);
		} else {
			appendOutput(`✗ ${result.name} — ${result.error}`, "error");
		}
	}
	const failed = results.filter((result) => !result.passed).length;
	appendOutput(
		failed === 0
			? `${results.length} test(s) passed`
			: `${failed} of ${results.length} test(s) failed`,
		failed === 0 ? "log" : "error",
	);
}

function appendOutput(text: string, kind: "log" | "error" = "log"): void {
	const line = document.createElement("span");
	line.className =
		kind === "error" ? "output-line output-error" : "output-line";
	line.textContent = text;
	outputEl.append(line, "\n");
	outputEl.scrollTop = outputEl.scrollHeight;
}

function scheduleCompilePreview(): void {
	clearTimeout(compilePreviewTimer);
	compilePreviewTimer = window.setTimeout(() => {
		void refreshCompiledPreview();
	}, 500);
}

async function refreshCompiledPreview(): Promise<void> {
	try {
		const { code } = await host.compile(mainEditor.getValue());
		// Keep the previous preview when diagnostics prevent code generation
		if (code != null) compiledEditor.setValue(code);
	} catch {
		// Keep the previous preview when compilation throws
	}
}

function formatDiagnostic(diagnostic: Diagnostic): string {
	return `${diagnostic.severity}: ${diagnostic.message}`;
}

function normalizeThemePreference(value: string | null): ThemePreference {
	return value === "light" || value === "dark" || value === "system"
		? value
		: "system";
}

function loadThemePreference(): ThemePreference {
	return normalizeThemePreference(localStorage.getItem(THEME_STORAGE_KEY));
}

function applyTheme(preference: ThemePreference): void {
	const theme =
		preference === "system"
			? darkSchemeQuery.matches
				? "dark"
				: "light"
			: preference;
	document.documentElement.dataset.theme = theme;
	monaco.editor.setTheme(theme === "dark" ? "vs-dark" : "vs");
}
