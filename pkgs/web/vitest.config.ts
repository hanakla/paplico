import { existsSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "vitest/config";

// Same choice as next.config.ts: the importer list this checkout carries.
const privateDocumentImporters = path.resolve(
	__dirname,
	"./src/documentImport/importers.private.ts",
);
const documentImporters = existsSync(privateDocumentImporters)
	? privateDocumentImporters
	: path.resolve(__dirname, "./src/documentImport/importers.none.ts");

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
			{ find: "#document-importers", replacement: documentImporters },
		],
	},
});
