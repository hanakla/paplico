import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "wxt";

export default defineConfig({
	srcDir: "src",
	modules: ["@wxt-dev/module-react"],
	runner: { disabled: true },
	vite: () => ({
		plugins: [tailwindcss()],
		resolve: {
			alias: { "@": path.resolve(__dirname, "src") },
		},
	}),
	manifest: {
		name: "WebGPU DevTools Inspector",
		description:
			"Inspect and debug WebGPU resources, pipelines, shaders, and commands",
		permissions: ["devtools", "storage"],
		web_accessible_resources: [
			{
				resources: ["injected.js"],
				matches: ["<all_urls>"],
			},
		],
	},
});
