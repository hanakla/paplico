import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const OUT_DIR = resolve(process.cwd(), "perf-results");

export async function POST(req: Request) {
	if (process.env.NODE_ENV !== "development") {
		return new Response("Not found", { status: 404 });
	}

	const result = await req.json();
	mkdirSync(OUT_DIR, { recursive: true });
	const stamp = new Date().toISOString().replaceAll(":", "-").slice(0, 19);
	const path = resolve(OUT_DIR, `perf-${stamp}.json`);
	writeFileSync(path, JSON.stringify(result, null, 2));
	console.log(`[perf] result saved: ${path}`);
	return Response.json({ saved: path });
}
