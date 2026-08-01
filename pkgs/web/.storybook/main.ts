import path from "node:path";
import { fileURLToPath } from "node:url";
import type { StorybookConfig } from "@storybook/nextjs-vite";

// Resolve the framework package to an absolute path so Storybook's core
// (hoisted to the workspace root) can find it even when the package itself
// is nested under this workspace's node_modules.
// https://storybook.js.org/docs/faq#how-do-i-fix-module-resolution-in-special-environments
const getAbsolutePath = (packageName: string) =>
	path.dirname(
		fileURLToPath(import.meta.resolve(path.join(packageName, "package.json"))),
	);

const config: StorybookConfig = {
	stories: ["../src/**/*.stories.@(js|jsx|mjs|ts|tsx)"],
	framework: {
		name: getAbsolutePath("@storybook/nextjs-vite"),
		options: {},
	},
	staticDirs: ["../public"],
};

export default config;
