import { describe, expect, it } from "vitest";
import type { BoundingBox } from "../schema";
import { TimelapseRecorder } from "./TimelapseRecorder";
import type { TimelapseData } from "./types";

describe("TimelapseRecorder", () => {
	describe("restoreFrom", () => {
		it("should adopt the incoming document's entries", () => {
			const recorder = new TimelapseRecorder(() => bbox(0, 0, 10, 10));
			recorder.restoreFrom(recordingOf(3));

			expect(recorder.getTimelapseData()?.entries).toHaveLength(3);
		});

		it("should carry the incoming document's dirty rects", () => {
			const recording = recordingOf(2);
			recording.index = { rects: [[0, 0, 10, 10], null] };
			const recorder = new TimelapseRecorder(() => bbox(0, 0, 10, 10));

			recorder.restoreFrom(recording);

			expect(recorder.getTimelapseData()?.index?.rects).toEqual([
				[0, 0, 10, 10],
				null,
			]);
		});

		it("should leave the rects unknown when the recording has no index", () => {
			const recorder = new TimelapseRecorder(() => bbox(0, 0, 10, 10));
			recorder.restoreFrom(recordingOf(2));

			expect(recorder.getTimelapseData()?.index?.rects).toEqual([null, null]);
		});

		it("should drop the previous document's recording when the new one has none", () => {
			const recorder = new TimelapseRecorder(() => bbox(0, 0, 10, 10));
			recorder.restoreFrom(recordingOf(3));

			recorder.restoreFrom(undefined);

			expect(recorder.getTimelapseData()).toBeNull();
		});

		it("should record the new document's updates from scratch after a switch", () => {
			const recorder = new TimelapseRecorder(() => bbox(0, 0, 10, 10));
			recorder.restoreFrom(recordingOf(3));
			recorder.restoreFrom(undefined);

			recorder.onYjsUpdate(new Uint8Array([1]), {
				upserted: new Set(["a"]),
				deleted: new Set(),
			});

			expect(recorder.getTimelapseData()?.entries).toHaveLength(1);
		});
	});

	describe("adoptRebuiltIndex", () => {
		it("should fill only the rects that were still unknown", () => {
			const recorder = new TimelapseRecorder(() => bbox(0, 0, 10, 10));
			recorder.restoreFrom(recordingOf(2));
			recorder.onYjsUpdate(new Uint8Array([9]), {
				upserted: new Set(["a"]),
				deleted: new Set(),
			});

			recorder.adoptRebuiltIndex({
				rects: [
					[0, 0, 1, 1],
					[2, 2, 3, 3],
				],
			});

			expect(recorder.getTimelapseData()?.index?.rects).toEqual([
				[0, 0, 1, 1],
				[2, 2, 3, 3],
				[0, 0, 10, 10],
			]);
		});
	});
});

function bbox(
	minX: number,
	minY: number,
	maxX: number,
	maxY: number,
): BoundingBox {
	return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

function recordingOf(count: number): TimelapseData {
	return {
		version: 2,
		entries: Array.from({ length: count }, (_, i) => ({
			t: i * 100,
			u: new Uint8Array([i]),
		})),
	};
}
