import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Guard: three.js must never enter the core static module graph.
 *
 * The Reference3D subsystem loads three.js through the single dynamic import in
 * reference3d/index.ts. If any module reachable from the Paplico facade (or the
 * public barrel) gains a static `import ... from "three"`, the ~170KB+ lazy
 * chunk would silently fold into the main bundle. This test walks the static
 * import graph from both entry points and fails on any "three" edge.
 *
 * Type-only imports (`import type` / `export type`) are erased at build time
 * and dynamic `import("...")` expressions are intentionally not graph edges.
 */

const CORE_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const SRC_ROOT = path.resolve(CORE_ROOT, "..");
const ENTRY_POINTS = [
	path.join(CORE_ROOT, "Paplico.ts"),
	path.join(CORE_ROOT, "index.ts"),
];

describe("core three.js import boundary", () => {
	it("should keep three out of the static import graph of the core entry points", () => {
		const { visited, bareImports } = walkStaticImportGraph(ENTRY_POINTS);

		// Sanity: the walk must actually traverse the engine. A regression in
		// the resolver would otherwise pass vacuously with zero offenders.
		expect(visited.size).toBeGreaterThan(100);

		const offenders = [...bareImports.entries()]
			.filter(([spec]) => spec === "three" || spec.startsWith("three/"))
			.map(([spec, importers]) => ({ spec, importers }));

		expect(offenders).toEqual([]);
	});

	it("should detect a static three import when one exists (detector self-check)", () => {
		const { bareImports } = walkStaticImportGraph([
			path.join(CORE_ROOT, "reference3d/Reference3DService.ts"),
		]);

		expect(bareImports.has("three")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Static import graph walker
// ---------------------------------------------------------------------------

/**
 * Matches static import/export statements and captures:
 *  - group 1: the `type` keyword when the statement is type-only
 *  - group 2: the module specifier
 * The clause character class cannot cross statement boundaries (no quotes /
 * parens / semicolons), so dynamic `import("...")` is never matched.
 */
const STATIC_IMPORT_RE =
	/(?:^|[\s;])(?:import|export)\s+(type\s+)?(?:[\w*{}\s,$]*?from\s+)?["']([^"']+)["']/g;

function walkStaticImportGraph(entryPoints: string[]): {
	visited: Set<string>;
	/** Bare (package) specifier → importing files. */
	bareImports: Map<string, string[]>;
} {
	const visited = new Set<string>();
	const bareImports = new Map<string, string[]>();
	const queue = [...entryPoints];

	while (queue.length > 0) {
		const file = queue.pop()!;
		if (visited.has(file)) continue;
		visited.add(file);

		for (const spec of collectStaticImportSpecifiers(file)) {
			if (!spec.startsWith(".") && !spec.startsWith("@/")) {
				const importers = bareImports.get(spec) ?? [];
				importers.push(path.relative(SRC_ROOT, file));
				bareImports.set(spec, importers);
				continue;
			}
			const resolved = resolveModule(file, spec);
			if (resolved) queue.push(resolved);
		}
	}

	return { visited, bareImports };
}

function collectStaticImportSpecifiers(file: string): string[] {
	const source = readFileSync(file, "utf8")
		// Strip block and line comments so commented-out imports don't count.
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/^[ \t]*\/\/.*$/gm, "");

	const specifiers: string[] = [];
	for (const match of source.matchAll(STATIC_IMPORT_RE)) {
		const isTypeOnly = match[1] !== undefined;
		if (!isTypeOnly) specifiers.push(match[2]);
	}
	return specifiers;
}

/** Resolve a relative or `@/` alias specifier to a TS file, or null for assets. */
function resolveModule(fromFile: string, spec: string): string | null {
	const base = spec.startsWith("@/")
		? path.join(SRC_ROOT, spec.slice(2))
		: path.resolve(path.dirname(fromFile), spec);

	for (const candidate of [
		`${base}.ts`,
		`${base}.tsx`,
		path.join(base, "index.ts"),
	]) {
		if (existsSync(candidate)) return candidate;
	}
	return null;
}
