import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Write a JSON record from a dev-only capture route to `<cwd>/<dir>/`, named
 * by `prefix` and the current time. Returns the path written, or null outside
 * development — the routes answer 404 then, so a capture never lands in a
 * deployed environment.
 */
export function saveDevRecord(
	dir: string,
	prefix: string,
	record: unknown,
): string | null {
	if (process.env.NODE_ENV !== "development") return null;

	const outDir = resolve(process.cwd(), dir);
	mkdirSync(outDir, { recursive: true });
	const stamp = new Date().toISOString().replaceAll(":", "-").slice(0, 23);
	const path = resolve(outDir, `${prefix}-${stamp}.json`);
	writeFileSync(path, JSON.stringify(record, null, 2));
	return path;
}
