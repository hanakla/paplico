import path from "node:path";
import createMDX from "@next/mdx";
import { withSentryConfig } from "@sentry/nextjs";
import type { NextConfig } from "next";

const isTauriBuild = process.env.TAURI_BUILD === "1";

const nextConfig = {
	pageExtensions: ["js", "jsx", "md", "mdx", "ts", "tsx"],
	allowedDevOrigins: ["*.*.*.*"],
	reactCompiler: true,
	typescript: {
		ignoreBuildErrors: true,
	},
	env: {
		IS_TAURI_ENV: isTauriBuild ? "1" : "",
	},
	// jscolorengine requires `http` in its Node-only code paths; stub it out
	// of client bundles (`fs` is already excluded via its browser field).
	// `three` → the WebGPU build: three-vrm and three/addons import "three", so
	// without the alias the WebGPU build and the core build would both load.
	turbopack: {
		resolveAlias: {
			http: { browser: "./src/stubs/empty.ts" },
			three: "./src/stubs/three-webgpu-compat.ts",
		},
	},
	webpack: (config, { isServer }) => {
		if (!isServer) {
			config.resolve.fallback = { ...config.resolve.fallback, http: false };
		}
		config.resolve.alias = {
			...config.resolve.alias,
			three$: path.resolve(__dirname, "src/stubs/three-webgpu-compat.ts"),
		};
		return config;
	},
	...(isTauriBuild && {
		output: "export" as const,
		images: { unoptimized: true },
	}),
} satisfies NextConfig;

const withMDX = createMDX({
	options: {
		remarkPlugins: ["remark-gfm", "remark-cjk-friendly"],
		rehypePlugins: ["rehype-slug"],
	},
});

export default isTauriBuild
	? withMDX(nextConfig)
	: withSentryConfig(withMDX(nextConfig), {
			org: process.env.SENTRY_ORG,
			project: process.env.SENTRY_PROJECT,
			authToken: process.env.SENTRY_AUTH_TOKEN,
			silent: !process.env.CI,
			tunnelRoute: "/monitoring",
			sourcemaps: {
				deleteSourcemapsAfterUpload: true,
			},
		});
