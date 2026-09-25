import { defineConfig } from "tsdown";

export default defineConfig({
	entry: [
		"src/index.ts",
		"src/schema.ts",
		"src/document/index.ts",
		"src/brush/index.ts",
		"src/collaboration/index.ts",
		"src/color/index.ts",
		"src/io/index.ts",
		"src/tools/index.ts",
		"src/timelapse/index.ts",
		"src/typography/index.ts",
		"src/renderer/filters/index.ts",
		"src/utils/index.ts",
		"src/infra/index.ts",
		"src/infra/localfonts.tauri.ts",
		"src/stubs/three-webgpu-compat.ts",
	],
	format: "esm",
	dts: true,
	clean: true,
	// pngjs only backs the PNG decode fallback for Node WebGPU; it stays an
	// optional peer so browser bundles never pull in its Node built-ins.
	deps: { neverBundle: ["pngjs"] },
});
