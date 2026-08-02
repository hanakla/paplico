import { defineConfig } from "tsdown";

export default defineConfig({
	entry: ["src/index.ts", "src/runner/workerEntry.ts"],
	format: "esm",
	dts: true,
	clean: true,
	// monaco-editor is type-only here, and chevrotain stays a runtime dependency.
	deps: { neverBundle: ["monaco-editor", "chevrotain"] },
});
