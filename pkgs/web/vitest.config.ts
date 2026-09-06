import path from "node:path";
import { defineConfig } from "vitest/config";

const BASE_EXCLUDE = ["**/node_modules/**", "**/dist/**"];
// WebGPU-dependent suites: real Dawn (node-webgpu) device creation and GPU
// dispatch/render work. Isolated into their own serialized (maxWorkers: 1)
// project so they don't fight the "unit" project's parallel worker pool for
// CPU — that contention caused intermittent timeouts in unrelated, cheap
// CPU-bound tests. Also excluded entirely on CI, where Dawn triggers a V8
// hash table assertion failure under Linux/Lavapipe and no WebGPU adapter is
// exposed.
const GPU_TEST_PATTERNS = ["**/*.wgsl.test.ts", "**/*.visual.test.ts"];

export default defineConfig({
	test: {
		environment: "happy-dom",
		globals: true,
		setupFiles: ["./vitest.setup.ts"],
		exclude: BASE_EXCLUDE,
		coverage: {
			provider: "v8",
			reporter: ["text", "json", "html"],
			exclude: ["node_modules/", "**/*.config.ts", "**/*.d.ts"],
		},
		projects: [
			{
				extends: true as const,
				test: {
					name: "unit",
					exclude: [...BASE_EXCLUDE, ...GPU_TEST_PATTERNS],
					// Run before the "gpu" group (see below) — required whenever
					// sibling projects differ in `maxWorkers`.
					sequence: { groupOrder: 0 },
				},
			},
			...(process.env.CI
				? []
				: [
						{
							extends: true as const,
							test: {
								name: "gpu",
								include: GPU_TEST_PATTERNS,
								exclude: BASE_EXCLUDE,
								// Vitest 4: singleFork's equivalent is maxWorkers: 1 + isolate: false.
								maxWorkers: 1,
								isolate: false,
								testTimeout: 30_000,
								// Runs after the "unit" group so it never shares CPU with
								// that project's parallel worker pool.
								sequence: { groupOrder: 1 },
							},
						},
					]),
		],
	},
	resolve: {
		alias: [
			{ find: "@", replacement: path.resolve(__dirname, "./src") },
			// Same dedupe as next.config.ts: one three.js build for everything.
			{
				find: /^three$/,
				replacement: path.resolve(
					__dirname,
					"./src/stubs/three-webgpu-compat.ts",
				),
			},
		],
	},
});
