import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { BoundingBox } from "../schema";
import { TimelapseRecorder } from "./TimelapseRecorder";

describe("TimelapseRecorder", () => {
	describe("onYjsUpdate", () => {
		afterEach(() => {
			vi.useRealTimers();
		});

		it("should fold a burst of updates to the same object into one entry", () => {
			vi.useFakeTimers();
			const recorder = newRecorder();
			const doc = new Y.Doc();
			const updates: Uint8Array[] = [];
			doc.on("update", (u: Uint8Array) => updates.push(u));
			const obj = new Y.Map<number>();
			doc.getMap("objects").set("a", obj);

			recorder.onYjsUpdate(updates.at(-1)!, changesFor("a"));
			for (let i = 0; i < 5; i++) {
				vi.advanceTimersByTime(16);
				obj.set("x", i + 1);
				recorder.onYjsUpdate(updates.at(-1)!, changesFor("a"));
			}

			const data = recorder.getTimelapseData();
			expect(data?.entries).toHaveLength(1);

			const replay = new Y.Doc();
			Y.applyUpdate(replay, data!.entries[0].u);
			expect(replay.getMap("objects").get("a")).toBeInstanceOf(Y.Map);
			expect(
				(replay.getMap("objects").get("a") as Y.Map<number>).get("x"),
			).toBe(5);
		});

		it("should start a new entry once the window has elapsed", () => {
			vi.useFakeTimers();
			const recorder = newRecorder();
			const doc = new Y.Doc();
			const updates: Uint8Array[] = [];
			doc.on("update", (u: Uint8Array) => updates.push(u));
			const obj = new Y.Map<number>();
			doc.getMap("objects").set("a", obj);
			recorder.onYjsUpdate(updates.at(-1)!, changesFor("a"));

			vi.advanceTimersByTime(300);
			obj.set("x", 1);
			recorder.onYjsUpdate(updates.at(-1)!, changesFor("a"));

			expect(recorder.getTimelapseData()?.entries).toHaveLength(2);
		});

		it("should start a new entry when a different object is touched", () => {
			const recorder = newRecorder();
			recorder.onYjsUpdate(new Uint8Array([1]), changesFor("a"));
			recorder.onYjsUpdate(new Uint8Array([2]), changesFor("b"));
			recorder.onYjsUpdate(new Uint8Array([3]), changesFor("a"));

			expect(recorder.getTimelapseData()?.entries).toHaveLength(3);
		});

		it("should never fold deletions or updates of unknown scope", () => {
			const recorder = newRecorder();
			recorder.onYjsUpdate(new Uint8Array([1]), changesFor("a"));
			recorder.onYjsUpdate(new Uint8Array([2]), {
				upserted: new Set(["a"]),
				deleted: new Set(["a"]),
			});
			recorder.onYjsUpdate(new Uint8Array([3]), null);
			recorder.onYjsUpdate(new Uint8Array([4]), null);

			expect(recorder.getTimelapseData()?.entries).toHaveLength(4);
		});

		it("should keep the union of the folded rects", () => {
			vi.useFakeTimers();
			const bounds = [bbox(0, 0, 10, 10), bbox(20, 20, 30, 30)];
			const recorder = new TimelapseRecorder(() => bounds.shift() ?? null);
			const doc = new Y.Doc();
			const updates: Uint8Array[] = [];
			doc.on("update", (u: Uint8Array) => updates.push(u));
			const obj = new Y.Map<number>();
			doc.getMap("objects").set("a", obj);
			obj.set("x", 1);
			for (const u of updates) recorder.onYjsUpdate(u, changesFor("a"));

			expect(recorder.getTimelapseData()?.index?.rects).toEqual([
				[0, 0, 30, 30],
			]);
		});
	});

	describe("appendBaseline", () => {
		it("should record the baseline as an entry", () => {
			const recorder = newRecorder();
			recorder.appendBaseline(new Uint8Array([1, 2, 3]));

			const data = recorder.getTimelapseData();
			expect(data?.entries).toHaveLength(1);
			expect(data?.entries[0].u).toEqual(new Uint8Array([1, 2, 3]));
		});

		it("should leave the baseline's affected area unknown", () => {
			const recorder = newRecorder();
			recorder.appendBaseline(new Uint8Array([1]));

			expect(recorder.getTimelapseData()?.index?.rects).toEqual([null]);
		});

		it("should keep what was recorded for the previous document", () => {
			const recorder = newRecorder();
			recorder.onYjsUpdate(new Uint8Array([9]), {
				upserted: new Set(["a"]),
				deleted: new Set(),
			});

			recorder.appendBaseline(new Uint8Array([1]));

			// Dropping them would destroy the recording on the next save. The
			// baseline's position tells playback to start the state over there.
			const data = recorder.getTimelapseData();
			expect(data?.entries.map((entry) => entry.u)).toEqual([
				new Uint8Array([9]),
				new Uint8Array([1]),
			]);
			expect(data?.baselines).toEqual([1]);
		});

		it("should adopt a carried recording before the baseline", () => {
			const recorder = newRecorder();
			recorder.restoreFrom({
				version: 2,
				entries: [{ t: 0, u: new Uint8Array([7]) }],
				index: { rects: [[0, 0, 1, 1]] },
			});

			recorder.appendBaseline(new Uint8Array([1]));

			const data = recorder.getTimelapseData();
			expect(data?.entries).toHaveLength(2);
			expect(data?.index?.rects).toEqual([[0, 0, 1, 1], null]);
			expect(data?.baselines).toEqual([1]);
		});

		it("should drop the previous document's recording when none is carried", () => {
			const recorder = newRecorder();
			recorder.onYjsUpdate(new Uint8Array([9]), null);

			recorder.restoreFrom(undefined);
			recorder.appendBaseline(new Uint8Array([1]));

			expect(recorder.getTimelapseData()?.entries).toHaveLength(1);
		});

		it("should keep recording after the restart", () => {
			const recorder = newRecorder();
			recorder.appendBaseline(new Uint8Array([1]));
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
			recorder.appendBaseline(new Uint8Array([1]));
			recorder.onYjsUpdate(new Uint8Array([2]), null);

			const data = recorder.getTimelapseData();
			expect(data?.index?.rects).toHaveLength(data?.entries.length ?? 0);
		});
	});

	describe("adoptRebuiltIndex", () => {
		it("should fill only the rects that were still unknown", () => {
			const recorder = newRecorder();
			recorder.appendBaseline(new Uint8Array([1]));
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

function changesFor(id: string) {
	return { upserted: new Set([id]), deleted: new Set<string>() };
}
