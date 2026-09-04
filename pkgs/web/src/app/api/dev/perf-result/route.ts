import { saveDevRecord } from "../saveDevRecord";

export async function POST(req: Request) {
	const saved = saveDevRecord("perf-results", "perf", await req.json());
	if (!saved) return new Response("Not found", { status: 404 });
	console.log(`[perf] result saved: ${saved}`);
	return Response.json({ saved });
}
