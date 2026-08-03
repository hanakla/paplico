import { normalizeBrushSettingsV2 } from "../../../../brush/migrate";
import type { BrushSettingsV2, CubicBezierSegment } from "../../../../schema";
import { evaluateDabs } from "./DabEvaluator";
import { DAB_FIELD_OFFSETS, DAB_INSTANCE_FLOATS } from "./DabInstanceLayout";
import { LiveDabAccumulator } from "./LiveDabAccumulator";

function seg(
	startX: number,
	endX: number,
	t0: number,
	t1: number,
	first = false,
): CubicBezierSegment {
	return {
		start: first ? { x: startX, y: 0 } : undefined,
		cp1: { x: 10, y: 5 },
		cp2: { x: -10, y: -5 },
		end: { x: endX, y: 0 },
		startPressure: 0.4,
		endPressure: 0.8,
		startTiltX: 0,
		startTiltY: 0,
		endTiltX: 0,
		endTiltY: 0,
		startDeltaTime: t0,
		endDeltaTime: t1,
		isMoved: first,
	} as CubicBezierSegment;
}

function settingsNoStrokeT(): BrushSettingsV2 {
	return normalizeBrushSettingsV2({
		version: 2,
		engine: "dab",
		strokeOpacity: 1,
		paintMode: "buildup",
		properties: {
			size: {
				base: 10,
				curves: [
					{
						input: "pressure",
						points: [
							[0, -0.5],
							[1, 0],
						],
					},
				],
			},
			spacing: { base: 0.2 },
			flow: { base: 0.8 },
			scatterOffset: { base: 0.2 },
		},
		tip: { kind: "procedural", hardness: 1, angleMode: "fixed" },
		randomSeed: 5,
	});
}

function concatFrame(frame: {
	committedData: Float32Array;
	committedCount: number;
	tailData: Float32Array;
	tailCount: number;
}): Float32Array {
	const out = new Float32Array(
		(frame.committedCount + frame.tailCount) * DAB_INSTANCE_FLOATS,
	);
	out.set(
		frame.committedData.subarray(0, frame.committedCount * DAB_INSTANCE_FLOATS),
		0,
	);
	out.set(
		frame.tailData.subarray(0, frame.tailCount * DAB_INSTANCE_FLOATS),
		frame.committedCount * DAB_INSTANCE_FLOATS,
	);
	return out;
}

/**
 * pathT is normalized by the stroke's total length, which keeps growing
 * during a live stroke — committed dabs keep the ratio from their own frame
 * (accepted live approximation; the committed stroke re-evaluates in full).
 * Everything else must match a full evaluation bit for bit.
 */
function maskPathT(data: Float32Array): Float32Array {
	const out = data.slice();
	for (let i = 0; i < out.length; i += DAB_INSTANCE_FLOATS) {
		out[i + DAB_FIELD_OFFSETS.pathT] = 0;
	}
	return out;
}

describe("LiveDabAccumulator", () => {
	it("should match a full evaluation on every frame while the prefix grows", () => {
		const settings = settingsNoStrokeT();
		const acc = new LiveDabAccumulator();

		const s0 = seg(0, 80, 0, 90, true);
		const s1 = seg(80, 150, 90, 200);
		const s2 = seg(150, 230, 200, 320);
		// Frame k sees [frozen..., freshTail]: the tail object is replaced
		// every frame (re-fit), frozen entries keep their identity.
		const frames = [
			[s0, seg(80, 120, 90, 140)],
			[s0, s1, seg(150, 190, 200, 250)],
			[s0, s1, s2],
		];

		for (const segments of frames) {
			const frame = acc.update(segments, settings, {});
			const full = evaluateDabs(segments, settings);
			expect(frame.committedCount + frame.tailCount).toBe(full.count);
			expect(Array.from(maskPathT(concatFrame(frame)))).toEqual(
				Array.from(
					maskPathT(full.data.subarray(0, full.count * DAB_INSTANCE_FLOATS)),
				),
			);
		}
	});

	it("should keep already-committed dabs byte-stable across frames", () => {
		const settings = settingsNoStrokeT();
		const acc = new LiveDabAccumulator();

		const s0 = seg(0, 80, 0, 90, true);
		const s1 = seg(80, 150, 90, 200);
		const frame1 = acc.update([s0, seg(80, 120, 90, 140)], settings, {});
		const frame1Committed = frame1.committedData.slice(
			0,
			frame1.committedCount * DAB_INSTANCE_FLOATS,
		);

		const frame2 = acc.update([s0, s1, seg(150, 190, 200, 250)], settings, {});
		expect(frame2.committedCount).toBeGreaterThanOrEqual(frame1.committedCount);
		expect(
			Array.from(
				frame2.committedData.subarray(
					0,
					frame1.committedCount * DAB_INSTANCE_FLOATS,
				),
			),
		).toEqual(Array.from(frame1Committed));
	});

	it("should reset when the segment prefix no longer matches (new stroke)", () => {
		const settings = settingsNoStrokeT();
		const acc = new LiveDabAccumulator();

		const first = acc.update([seg(0, 80, 0, 90, true)], settings, {});
		expect(first.reset).toBe(true);

		const grown = acc.update([seg(0, 80, 0, 90, true)], settings, {});
		// Different object identity for the first segment = a new stroke.
		expect(grown.reset).toBe(true);

		const other = [seg(0, 40, 0, 50, true)];
		const frame = acc.update(other, settings, {});
		expect(frame.reset).toBe(true);
		const full = evaluateDabs(other, settings);
		expect(frame.committedCount + frame.tailCount).toBe(full.count);
	});

	it("should reset when the settings change", () => {
		const acc = new LiveDabAccumulator();
		const s0 = seg(0, 80, 0, 90, true);
		acc.update([s0, seg(80, 120, 90, 140)], settingsNoStrokeT(), {});

		const changed = normalizeBrushSettingsV2({
			...settingsNoStrokeT(),
			randomSeed: 99,
		});
		const frame = acc.update([s0, seg(80, 120, 90, 140)], changed, {});
		expect(frame.reset).toBe(true);
		const full = evaluateDabs([s0, seg(80, 120, 90, 140)], changed);
		expect(Array.from(maskPathT(concatFrame(frame)))).toEqual(
			Array.from(
				maskPathT(full.data.subarray(0, full.count * DAB_INSTANCE_FLOATS)),
			),
		);
	});

	it("should report appended committed dabs consistently", () => {
		const settings = settingsNoStrokeT();
		const acc = new LiveDabAccumulator();

		const s0 = seg(0, 80, 0, 90, true);
		const s1 = seg(80, 150, 90, 200);
		const s2 = seg(150, 230, 200, 320);
		let appendedTotal = 0;
		for (const segments of [
			[s0, seg(80, 120, 90, 140)],
			[s0, s1, seg(150, 190, 200, 250)],
			[s0, s1, s2, seg(230, 260, 320, 360)],
		]) {
			const frame = acc.update(segments, settings, {});
			appendedTotal = frame.reset
				? frame.appendedCommitted
				: appendedTotal + frame.appendedCommitted;
			expect(frame.committedCount).toBe(appendedTotal);
		}
	});
});
