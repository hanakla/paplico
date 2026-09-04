import { saveDevRecord } from "../saveDevRecord";

export async function POST(req: Request) {
	const record = (await req.json()) as { points?: unknown[] };
	const saved = saveDevRecord("stroke-records", "stroke", record);
	if (!saved) return new Response("Not found", { status: 404 });
	console.log(
		`[stroke] recorded ${record.points?.length ?? 0} points: ${saved}`,
	);
	return Response.json({ saved });
}
