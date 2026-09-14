import type { PenTool } from "../tools/PenTool";
import {
	ev,
	testCanvasHeight,
	testCanvasWidth,
	testViewport,
} from "./pointerEvent";

/** A recorded stroke fixture: raw samples relative to the pen-down point. */
interface RecordedStroke {
	points: { x: number; y: number; deltaTime: number; pressure: number }[];
}

/**
 * Feed a recorded stroke to a pen tool as pen-down followed by moves, with
 * the recording's own distances and timing, translated onto the test canvas.
 * `onSample` runs after each sample so a caller can observe the preview.
 */
export async function replayRecordedStroke(
	pen: PenTool,
	recording: RecordedStroke,
	onSample?: (index: number) => Promise<void> | void,
): Promise<void> {
	for (const [i, point] of recording.points.entries()) {
		const event = ev(200 + point.x, 500 - point.y, {
			pressure: point.pressure,
			timeStamp: point.deltaTime,
			pointerType: "pen",
		});
		if (i === 0) {
			pen.onPointerDown(event, testViewport, testCanvasWidth, testCanvasHeight);
		} else {
			pen.onPointerMove(event, testViewport, testCanvasWidth, testCanvasHeight);
		}
		await onSample?.(i);
	}
}
