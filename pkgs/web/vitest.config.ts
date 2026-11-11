import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "happy-dom",
		globals: true,
		setupFiles: ["./vitest.setup.ts"],
		exclude: ["**/node_modules/**", "**/dist/**"],
		// The ESM build imports JSON without an import attribute, which Node
		// rejects when the package is loaded externally; let Vite transform it.
		server: { deps: { inline: ["@cantoo/pdf-lib"] } },
		coverage: {
			provider: "v8",
			reporter: ["text", "json", "html"],
			exclude: ["node_modules/", "**/*.config.ts", "**/*.d.ts"],
		},
	},
	resolve: {
		alias: [
			{ find: "@", replacement: path.resolve(__dirname, "./src") },
			// Same dedupe as next.config.ts: one three.js build for everything.
			{ find: /^three$/, replacement: "@paplico/core/three-webgpu-compat" },
		],
	},
});
