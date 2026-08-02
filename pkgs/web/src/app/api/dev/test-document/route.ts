import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Revalidate } from "next/dist/server/lib/cache-control";

const PAPF_PATH = resolve(process.cwd(), "src/tests/test-document.papf");

export const revalidate: Revalidate = false;

export async function GET() {
	if (process.env.NODE_ENV !== "development") {
		return new Response("Not found", { status: 404 });
	}

	const buf = readFileSync(PAPF_PATH);
	return new Response(buf, {
		headers: { "Content-Type": "application/octet-stream" },
	});
}
