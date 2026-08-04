import { describe, expect, it } from "vitest";
import type { BoundingBox } from "../schema";
import { TimelapseRecorder } from "./TimelapseRecorder";

describe("TimelapseRecorder", () => {
	describe("restartFrom", () => {
		it("should make the baseline the only entry", () => {
			const recorder = newRecorder();
			recorder.restartFrom(new Uint8Array([1, 2, 3]));

			const data = recorder.getTimelapseData();
			expect(data?.entries).toHaveLength(1);
			expect(data?.entries[0].u).toEqual(new Uint8Array([1, 2, 3]));
		});

		it("should leave the baseline's affected area unknown", () => {
			const recorder = newRecorder();
			recorder.restartFrom(new Uint8Array([1]));

			expect(recorder.getTimelapseData()?.index?.rects).toEqual([null]);
		});

		it("should drop what was recorded for the previous document", () => {
			const recorder = newRecorder();
			recorder.onYjsUpdate(new Uint8Array([9]), {
				upserted: new Set(["a"]),
				deleted: new Set(),
			});

			recorder.restartFrom(new Uint8Array([1]));

			// The old entries reference items the baseline does not create, so
			// replaying them alongside it would not reconstruct anything.
			expect(recorder.getTimelapseData()?.entries).toHaveLength(1);
		});

		it("should keep recording after the restart", () => {
			const recorder = newRecorder();
			recorder.restartFrom(new Uint8Array([1]));
			recorder.onYjsUpdate(new Uint8Array([2]), {
				upserted: new Set(["a"]),
				deleted: new Set(),
			});

			const data = recorder.getTimelapseData();
			expect(data?.entries).toHaveLength(2);
			expect(data?.index?.rects).toEqual([null, [0, 0, 10, 10]]);
		});
	});

	describe("getTimelapseData", () => {
		it("should report nothing before anything is recorded", () => {
			expect(newRecorder().getTimelapseData()).toBeNull();
		});

		it("should keep one rect per entry", () => {
			const recorder = newRecorder();
			recorder.restartFrom(new Uint8Array([1]));
			recorder.onYjsUpdate(new Uint8Array([2]), null);

			const data = recorder.getTimelapseData();
			expect(data?.index?.rects).toHaveLength(data?.entries.length ?? 0);
		});
	});

	describe("adoptRebuiltIndex", () => {
		it("should fill only the rects that were still unknown", () => {
			const recorder = newRecorder();
			recorder.restartFrom(new Uint8Array([1]));
			recorder.onYjsUpdate(new Uint8Array([2]), {
				upserted: new Set(["a"]),
				deleted: new Set(),
			});

			recorder.adoptRebuiltIndex({
				rects: [
					[5, 5, 6, 6],
					[7, 7, 8, 8],
				],
			});

			expect(recorder.getTimelapseData()?.index?.rects).toEqual([
				[5, 5, 6, 6],
				[0, 0, 10, 10],
			]);
		});
	});
});

function newRecorder(): TimelapseRecorder {
	return new TimelapseRecorder(() => bbox(0, 0, 10, 10));
}

function bbox(
	minX: number,
	minY: number,
	maxX: number,
	maxY: number,
): BoundingBox {
	return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}
