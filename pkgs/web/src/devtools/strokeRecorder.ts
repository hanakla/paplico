import type { Paplico } from "@/core/Paplico";

/**
 * Dev-only capture of the last committed pen stroke. The pointer record goes
 * to the dev server and lands in `stroke-records/`, so a stroke that
 * misbehaved on a tablet can be replayed through the fitter on the machine
 * running the server — the device itself has no way to hand the data over.
 */
export async function sendLastStrokeToServer(
	paplico: Paplico,
): Promise<string | null> {
	const record = paplico.getLastPenStroke();
	if (!record) return null;

	const res = await fetch("/api/dev/stroke-record", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(record),
	});
	const { saved } = await res.json();
	return saved ?? null;
}
