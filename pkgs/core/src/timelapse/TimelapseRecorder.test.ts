import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { createDefaultDocument } from "../document/factory";
import { LATEST_SCHEMA_VERSION } from "../io/migrations";
import { openPapfContainer } from "../io/papf/pdfContainer";
import { Codec } from "../io/papf/types";
import { serializeDocument } from "../io/papf/writer";
import type { BoundingBox } from "../schema";
import { expandTimelapseEntries } from "../testUtils/timelapse";
import { mulberry32 } from "../utils/math";
import { TimelapseRecorder } from "./TimelapseRecorder";
import type {
	TimelapseData,
	TimelapseEntry,
	TimelapsePackedBlock,
} from "./types";

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

		it("should fold rects into the entry after a packed recording", () => {
			vi.useFakeTimers();
			const bounds = [bbox(0, 0, 10, 10), bbox(20, 20, 30, 30)];
			const recorder = new TimelapseRecorder(() => bounds.shift() ?? null);
			recorder.restoreFrom({
				version: 2,
				packedBlocks: [packedBlock(2)],
				entries: [],
			});
			const doc = new Y.Doc();
			const updates: Uint8Array[] = [];
			doc.on("update", (u: Uint8Array) => updates.push(u));
			const obj = new Y.Map<number>();
			doc.getMap("objects").set("a", obj);
			obj.set("x", 1);
			for (const u of updates) recorder.onYjsUpdate(u, changesFor("a"));

			expect(recorder.getTimelapseData()?.index?.rects).toEqual([
				null,
				null,
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

		it("should count packed entries of a carried recording before the baseline", () => {
			const recorder = newRecorder();
			const packed = packedBlock(3);
			recorder.restoreFrom({
				version: 2,
				packedBlocks: [packed],
				entries: [{ t: 0, u: new Uint8Array([7]) }],
			});

			recorder.appendBaseline(new Uint8Array([1]));

			const data = recorder.getTimelapseData();
			expect(data?.packedBlocks).toEqual([packed]);
			expect(data?.index?.rects).toEqual([null, null, null, null, null]);
			expect(data?.baselines).toEqual([4]);
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

		it("should date what it records with this build's schema version", () => {
			const recorder = newRecorder();
			recorder.onYjsUpdate(new Uint8Array([2]), null);
			recorder.onYjsUpdate(new Uint8Array([3]), null);

			expect(recorder.getTimelapseData()?.schemaVersions).toEqual([
				{ at: 0, version: LATEST_SCHEMA_VERSION },
			]);
		});

		it("should date a carried older recording apart from what follows it", () => {
			const recorder = newRecorder();
			recorder.restoreFrom({
				version: 2,
				entries: [{ t: 0, u: new Uint8Array([7]) }],
				schemaVersions: [{ at: 0, version: 1 }],
			});

			recorder.appendBaseline(new Uint8Array([1]));

			expect(recorder.getTimelapseData()?.schemaVersions).toEqual([
				{ at: 0, version: 1 },
				{ at: 1, version: LATEST_SCHEMA_VERSION },
			]);
		});
	});

	describe("getPackedTimelapseData", () => {
		afterEach(() => {
			vi.useRealTimers();
		});

		it("should pack a large closed entry once", async () => {
			const recorder = newRecorder();
			recorder.appendBaseline(largeUpdate());
			const entriesBefore = [...recorder.getTimelapseData()!.entries];

			const packed = (await recorder.getPackedTimelapseData())!;
			const packedAgain = (await recorder.getPackedTimelapseData())!;

			expect(packed.entries).toHaveLength(0);
			expect(packed.packedBlocks).toHaveLength(1);
			expect(packedAgain.packedBlocks).toHaveLength(1);
			expect(packedAgain.packedBlocks![0]).toBe(packed.packedBlocks![0]);
			expectSameEntries(
				await expandTimelapseEntries(packedAgain),
				entriesBefore,
			);
		});

		it("should pack once for saves that start while a pack is running", async () => {
			const recorder = newRecorder();
			recorder.appendBaseline(largeUpdate());

			const [first, second] = await Promise.all([
				recorder.getPackedTimelapseData(),
				recorder.getPackedTimelapseData(),
			]);

			expect(recorder.getTimelapseData()!.packedBlocks).toHaveLength(1);
			expect(second!.packedBlocks![0]).toBe(first!.packedBlocks![0]);
			expect(second!.entries).toHaveLength(0);
		});

		it("should leave a few small entries unpacked", async () => {
			const recorder = newRecorder();
			recorder.onYjsUpdate(new Uint8Array([1]), null);
			recorder.onYjsUpdate(new Uint8Array([2]), null);

			const data = (await recorder.getPackedTimelapseData())!;

			expect(data.packedBlocks).toHaveLength(0);
			expect(data.entries).toHaveLength(2);
		});

		it("should pack small entries once a full block of them has gathered", async () => {
			const recorder = newRecorder();
			for (let i = 0; i < 1_000; i++) {
				recorder.onYjsUpdate(new Uint8Array([i & 0xff]), null);
			}

			const data = (await recorder.getPackedTimelapseData())!;

			expect(data.packedBlocks?.map((block) => block.count)).toEqual([1_000]);
			expect(data.entries).toHaveLength(0);
		});

		it("should keep recording at the same positions after entries move into a block", async () => {
			const recorder = newRecorder();
			recorder.onYjsUpdate(new Uint8Array([9]), changesFor("a"));
			recorder.appendBaseline(largeUpdate());

			await recorder.getPackedTimelapseData();
			recorder.onYjsUpdate(new Uint8Array([3]), changesFor("b"));
			recorder.appendBaseline(new Uint8Array([4]));

			const data = recorder.getTimelapseData()!;
			expect(data.packedBlocks?.map((block) => block.count)).toEqual([2]);
			expect(data.entries.map((entry) => entry.u)).toEqual([
				new Uint8Array([3]),
				new Uint8Array([4]),
			]);
			expect(data.baselines).toEqual([1, 3]);
			expect(data.index?.rects).toEqual([
				[0, 0, 10, 10],
				null,
				[0, 0, 10, 10],
				null,
			]);
		});

		it("should leave the entry still accepting updates unpacked and save what is folded into it later", async () => {
			vi.useFakeTimers({ toFake: ["Date"] });
			const bounds = [bbox(0, 0, 10, 10), bbox(20, 20, 30, 30)];
			const recorder = new TimelapseRecorder(() => bounds.shift() ?? null);
			recorder.appendBaseline(largeUpdate());
			const doc = new Y.Doc();
			const updates: Uint8Array[] = [];
			doc.on("update", (u: Uint8Array) => updates.push(u));
			const obj = new Y.Map<number>();
			doc.getMap("objects").set("a", obj);
			recorder.onYjsUpdate(updates.at(-1)!, changesFor("a"));

			expect((await recorder.getPackedTimelapseData())!.entries).toHaveLength(
				1,
			);

			vi.advanceTimersByTime(16);
			obj.set("x", 5);
			recorder.onYjsUpdate(updates.at(-1)!, changesFor("a"));

			const saved = await saveAndReopen(recorder);
			expect(saved.index?.rects).toEqual([null, [0, 0, 30, 30]]);
			const entries = await expandTimelapseEntries(saved);
			expect(entries).toHaveLength(2);
			const replay = new Y.Doc();
			Y.applyUpdate(replay, entries[1].u);
			expect(
				(replay.getMap("objects").get("a") as Y.Map<number>).get("x"),
			).toBe(5);
		});

		it("should fold updates into an entry opened while the pack was running", async () => {
			vi.useFakeTimers({ toFake: ["Date"] });
			const recorder = newRecorder();
			recorder.appendBaseline(largeUpdate());
			const doc = new Y.Doc();
			const updates: Uint8Array[] = [];
			doc.on("update", (u: Uint8Array) => updates.push(u));
			const obj = new Y.Map<number>();

			const packing = recorder.getPackedTimelapseData();
			doc.getMap("objects").set("a", obj);
			recorder.onYjsUpdate(updates.at(-1)!, changesFor("a"));
			await packing;
			vi.advanceTimersByTime(16);
			obj.set("x", 5);
			recorder.onYjsUpdate(updates.at(-1)!, changesFor("a"));

			const data = recorder.getTimelapseData()!;
			expect(data.entries).toHaveLength(1);
			const replay = new Y.Doc();
			Y.applyUpdate(replay, data.entries[0].u);
			expect(
				(replay.getMap("objects").get("a") as Y.Map<number>).get("x"),
			).toBe(5);
		});

		it("should leave out what is recorded after the call", async () => {
			const recorder = newRecorder();
			recorder.appendBaseline(largeUpdate());

			const packing = recorder.getPackedTimelapseData();
			recorder.onYjsUpdate(new Uint8Array([4]), null);
			const data = (await packing)!;

			expect(data.packedBlocks?.map((block) => block.count)).toEqual([1]);
			expect(data.entries).toHaveLength(0);
			expect(data.index?.rects).toEqual([null]);
			expect(
				recorder.getTimelapseData()!.entries.map((entry) => entry.u),
			).toEqual([new Uint8Array([4])]);
		});

		it("should leave out an update folded into the open entry after the call", async () => {
			vi.useFakeTimers({ toFake: ["Date"] });
			const recorder = newRecorder();
			const doc = new Y.Doc();
			const updates: Uint8Array[] = [];
			doc.on("update", (u: Uint8Array) => updates.push(u));
			const obj = new Y.Map<number>();
			doc.getMap("objects").set("a", obj);
			recorder.onYjsUpdate(updates.at(-1)!, changesFor("a"));

			const packing = recorder.getPackedTimelapseData();
			vi.advanceTimersByTime(16);
			obj.set("x", 5);
			recorder.onYjsUpdate(updates.at(-1)!, changesFor("a"));

			const replay = new Y.Doc();
			Y.applyUpdate(replay, (await packing)!.entries[0].u);
			expect(
				(replay.getMap("objects").get("a") as Y.Map<number>).get("x"),
			).toBeUndefined();
		});

		it("should hand out the recording of the call when another one is restored meanwhile", async () => {
			const recorder = newRecorder();
			const baseline = largeUpdate();
			recorder.appendBaseline(baseline);

			const packing = recorder.getPackedTimelapseData();
			recorder.onYjsUpdate(new Uint8Array([5]), null);
			recorder.restoreFrom({
				version: 2,
				entries: [{ t: 0, u: new Uint8Array([7]) }],
			});
			const data = (await packing)!;

			expect(data.packedBlocks).toHaveLength(0);
			expect(data.entries).toHaveLength(1);
			expect(data.entries[0].u).toBe(baseline);
			const restored = recorder.getTimelapseData()!;
			expect(restored.packedBlocks).toHaveLength(0);
			expect(restored.entries.map((entry) => entry.u)).toEqual([
				new Uint8Array([7]),
			]);
		});

		it("should not disturb the recording handed out before the pack", async () => {
			const recorder = newRecorder();
			const baseline = largeUpdate();
			recorder.appendBaseline(baseline);
			const handedOut = recorder.getTimelapseData()!;

			await recorder.getPackedTimelapseData();

			expect(handedOut.packedBlocks).toHaveLength(0);
			expect(handedOut.entries).toHaveLength(1);
			expect(handedOut.entries[0].u).toBe(baseline);
		});

		it("should read back the same recording from a file saved after packing", async () => {
			const recorder = newRecorder();
			recorder.onYjsUpdate(new Uint8Array([9]), changesFor("a"));
			recorder.appendBaseline(largeUpdate());
			recorder.onYjsUpdate(new Uint8Array([3]), null);
			const before = recorder.getTimelapseData()!;
			const entriesBefore = [...before.entries];
			const rectsBefore = [...before.index!.rects];

			await recorder.getPackedTimelapseData();
			const saved = await saveAndReopen(recorder);

			expectSameEntries(await expandTimelapseEntries(saved), entriesBefore);
			expect(saved.baselines).toEqual(before.baselines);
			expect(saved.index?.rects).toEqual(rectsBefore);
			expect(saved.schemaVersions).toEqual(before.schemaVersions);
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

/** An update large enough to be packed on its own, which deflate cannot shrink. */
function largeUpdate(): Uint8Array {
	const random = mulberry32(1);
	return Uint8Array.from({ length: 1_500_000 }, () => random() * 256);
}

/** toEqual walks a large update byte by byte through its matchers, which takes seconds. */
function expectSameEntries(
	actual: TimelapseEntry[],
	expected: TimelapseEntry[],
): void {
	expect(actual.map((entry) => entry.t)).toEqual(
		expected.map((entry) => entry.t),
	);
	for (const [i, entry] of actual.entries()) {
		expect(Buffer.from(entry.u).equals(expected[i].u)).toBe(true);
	}
}

/** The recording as a file saved from the recorder gives it back. */
async function saveAndReopen(
	recorder: TimelapseRecorder,
): Promise<TimelapseData> {
	const blob = await serializeDocument({
		...createDefaultDocument("doc"),
		timelapse: (await recorder.getPackedTimelapseData()) ?? undefined,
	});
	return (await (await openPapfContainer(blob)).toDocument()).timelapse!;
}

function packedBlock(count: number): TimelapsePackedBlock {
	return {
		count,
		payload: new Uint8Array([0]),
		codec: Codec.Deflate,
		rawBytes: null,
	};
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
