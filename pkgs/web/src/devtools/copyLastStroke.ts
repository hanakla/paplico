import { Clipboard, PAPLICO_ELEMENTS_MIME } from "@/core/infra/Clipboard";
import type { Paplico } from "@/core/Paplico";

/**
 * Dev-only stroke capture: puts the last pen stroke on the clipboard twice
 * over. The Paplico element payload pastes back into the canvas like a normal
 * copy, and the text payload carries the raw pointer record (position,
 * pressure, tilt, twist, time) plus the settings it was drawn under, so a
 * stroke that misbehaved can be replayed outside the app.
 */
export async function copyLastStrokeToClipboard(
	paplico: Paplico,
): Promise<boolean> {
	const stroke = paplico.getLastPenStroke();
	if (!stroke) return false;

	const record = {
		format: "paplico.pen-stroke",
		version: 1,
		stabilization: stroke.stabilization,
		smoothingMethod: stroke.smoothingMethod,
		zoom: stroke.zoom,
		points: stroke.points,
		path: stroke.path,
	};

	await Clipboard.write([
		new ClipboardItem({
			[PAPLICO_ELEMENTS_MIME]: new Blob([JSON.stringify([stroke.path])], {
				type: PAPLICO_ELEMENTS_MIME,
			}),
			"text/plain": new Blob([JSON.stringify(record)], {
				type: "text/plain",
			}),
		}),
	]);

	return true;
}
