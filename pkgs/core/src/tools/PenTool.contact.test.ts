import { describe, expect, it } from "vitest";
import { interpolateStrokeWidths } from "../renderer/geometry/strokeTessellator";
import type { StrokeAppearance } from "../schema";
import recording from "../testUtils/fixtures/slowContactStroke.json";
import { createMockToolContext } from "../testUtils/mockToolContext";
import {
	ev,
	testCanvasHeight,
	testCanvasWidth,
	testViewport,
} from "../testUtils/pointerEvent";
import { replayRecordedStroke } from "../testUtils/strokeReplay";
import { PenTool } from "./PenTool";

describe("Pen contact width", () => {
	it("should start a recorded slow contact at the width the stroke reaches", async () => {
		// A recorded stroke whose stylus lingers for about 100ms before the
		// hand gets going.
		const appearance = recording.appearance as StrokeAppearance;
		const settings = appearance.paramData.params.brushSettings;
		if (!settings?.properties.size) throw new Error("Missing brush settings");
		const base = settings.properties.size.base;
		const context = createMockToolContext({
			getActiveStrokeAppearance: () => appearance,
		});
		const pen = new PenTool(context, {
			stabilization: 0.5,
			perspectiveSnap: false,
		});
		try {
			await replayRecordedStroke(pen, recording);
			const preview = context.previewUpdate.mock.calls.at(-1)?.[0];
			const previewWidths = preview?.strokeWidths;
			if (!previewWidths) throw new Error("Missing preview");
			const width = (t: number) =>
				interpolateStrokeWidths(previewWidths, t).side1 * base;

			// The contact phase draws no wider than the stroke that follows.
			const cruising = width(0.5);
			for (let i = 0; i <= 20; i++) {
				expect(width(i / 100)).toBeLessThanOrEqual(cruising * 1.05);
			}
			expect(cruising).toBeGreaterThan(base * 0.15);

			pen.onPointerUp(
				ev(580, 237, { pressure: 0, timeStamp: 320 }),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			const committed = context.strokeComplete.mock.calls[0][0];
			const committedWidths = committed.strokeWidths;
			if (!committedWidths) throw new Error("Missing committed widths");
			// The committed path keeps the preview's width and drops the
			// preview's input knots.
			for (const t of [0, 0.1, 0.5, 0.75, 1]) {
				expect(interpolateStrokeWidths(committedWidths, t).side1).toBeCloseTo(
					interpolateStrokeWidths(previewWidths, t).side1,
					2,
				);
			}
			expect(committed.segments.length).toBeLessThan(preview.segments.length);
			expect(committed.filters).toBe(preview.filters);
		} finally {
			pen.dispose();
		}
	});
});
