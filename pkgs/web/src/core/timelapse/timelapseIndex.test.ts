import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { objectToStoredFields } from "../collaboration/YjsProvider";
import { createIdentityTransform } from "../document/factory";
import type { AnyArtObject, BoundingBox, Path } from "../schema";
import { buildTimelapseIndex, TimelapseBoundsLedger } from "./timelapseIndex";
import type { TimelapseEntry } from "./types";

describe("TimelapseBoundsLedger", () => {
	describe("track", () => {
		it("should report the union of the bounds before and after a move", () => {
			const ledger = new TimelapseBoundsLedger();
			ledger.seed(["a"], () => bbox(0, 0, 10, 10));

			const rect = ledger.track(
				{ upserted: new Set(["a"]), deleted: new Set() },
				() => bbox(100, 100, 110, 110),
			);

			expect(rect).toEqual([0, 0, 110, 110]);
		});

		it("should cover the old position when an object leaves the tracked area", () => {
			const ledger = new TimelapseBoundsLedger();
			ledger.seed(["a"], () => bbox(0, 0, 10, 10));

			const rect = ledger.track(
				{ upserted: new Set(["a"]), deleted: new Set() },
				() => bbox(500, 500, 510, 510),
			);

			expect(rect).toEqual([0, 0, 510, 510]);
		});

		it("should report only the new bounds for a newly created object", () => {
			const ledger = new TimelapseBoundsLedger();

			const rect = ledger.track(
				{ upserted: new Set(["a"]), deleted: new Set() },
				() => bbox(20, 20, 30, 30),
			);

			expect(rect).toEqual([20, 20, 30, 30]);
		});

		it("should report the vanished area when an object is deleted", () => {
			const ledger = new TimelapseBoundsLedger();
			ledger.seed(["a"], () => bbox(0, 0, 10, 10));

			const rect = ledger.track(
				{ upserted: new Set(), deleted: new Set(["a"]) },
				() => null,
			);

			expect(rect).toEqual([0, 0, 10, 10]);
		});

		it("should merge the bounds of every object in one update", () => {
			const ledger = new TimelapseBoundsLedger();
			const bounds: Record<string, BoundingBox> = {
				a: bbox(0, 0, 10, 10),
				b: bbox(-20, 5, -10, 15),
			};

			const rect = ledger.track(
				{ upserted: new Set(["a", "b"]), deleted: new Set() },
				(id) => bounds[id],
			);

			expect(rect).toEqual([-20, 0, 10, 15]);
		});

		it("should report unknown when the update carries no change set", () => {
			const ledger = new TimelapseBoundsLedger();

			expect(ledger.track(null, () => bbox(0, 0, 10, 10))).toBeNull();
		});

		it("should report unknown when the new bounds cannot be resolved", () => {
			const ledger = new TimelapseBoundsLedger();
			ledger.seed(["a"], () => bbox(0, 0, 10, 10));

			const rect = ledger.track(
				{ upserted: new Set(["a"]), deleted: new Set() },
				() => null,
			);

			expect(rect).toBeNull();
		});

		it("should keep reporting unknown once an object's bounds were lost", () => {
			const ledger = new TimelapseBoundsLedger();
			ledger.seed(["a"], () => bbox(0, 0, 10, 10));
			ledger.track(
				{ upserted: new Set(["a"]), deleted: new Set() },
				() => null,
			);

			// The stale 0..10 box must not silently stand in for the real one.
			const rect = ledger.track(
				{ upserted: new Set(["a"]), deleted: new Set() },
				() => bbox(500, 500, 510, 510),
			);

			expect(rect).toEqual([500, 500, 510, 510]);
		});

		it("should forget an object's bounds after it is deleted", () => {
			const ledger = new TimelapseBoundsLedger();
			ledger.seed(["a"], () => bbox(0, 0, 10, 10));
			ledger.track(
				{ upserted: new Set(), deleted: new Set(["a"]) },
				() => null,
			);

			const rect = ledger.track(
				{ upserted: new Set(), deleted: new Set(["a"]) },
				() => null,
			);

			expect(rect).toBeNull();
		});

		it("should replace the whole ledger when seeded again", () => {
			const ledger = new TimelapseBoundsLedger();
			ledger.seed(["a"], () => bbox(0, 0, 10, 10));
			ledger.seed(["b"], () => bbox(60, 60, 70, 70));

			const rect = ledger.track(
				{ upserted: new Set(["a"]), deleted: new Set() },
				() => bbox(0, 0, 10, 10),
			);

			expect(rect).toEqual([0, 0, 10, 10]);
		});
	});
});

describe("buildTimelapseIndex", () => {
	it("should derive a rect for each recorded update", () => {
		const doc = new Y.Doc();
		const entries = recordEntries(doc, [
			() => setObject(doc, squarePath("a", 0, 0)),
			() => setObject(doc, squarePath("b", 200, 200)),
		]);

		const { rects } = buildTimelapseIndex(entries);

		expect(rects).toHaveLength(2);
		expect(rects[0]).toEqual([0, 0, 10, 10]);
		expect(rects[1]).toEqual([200, 200, 210, 210]);
		doc.destroy();
	});

	it("should span both positions when an object moves", () => {
		const doc = new Y.Doc();
		const entries = recordEntries(doc, [
			() => setObject(doc, squarePath("a", 0, 0)),
			() => setObject(doc, squarePath("a", 300, 300)),
		]);

		const { rects } = buildTimelapseIndex(entries);

		expect(rects[1]).toEqual([0, 0, 310, 310]);
		doc.destroy();
	});

	it("should report the vanished area when an object is removed", () => {
		const doc = new Y.Doc();
		const entries = recordEntries(doc, [
			() => setObject(doc, squarePath("a", 0, 0)),
			() => doc.getMap("objects").delete("a"),
		]);

		const { rects } = buildTimelapseIndex(entries);

		expect(rects[1]).toEqual([0, 0, 10, 10]);
		doc.destroy();
	});

	it("should report unknown for updates that touch no object", () => {
		const doc = new Y.Doc();
		const entries = recordEntries(doc, [
			() => doc.getMap("meta").set("rasterizationDpi", 300),
		]);

		expect(buildTimelapseIndex(entries).rects).toEqual([null]);
		doc.destroy();
	});

	it("should resolve a grouped child through its top-level ancestor", () => {
		const doc = new Y.Doc();
		const entries = recordEntries(doc, [
			() => {
				setObject(doc, squarePath("child", 0, 0));
				setObject(doc, {
					id: "group",
					type: "group",
					childIds: ["child"],
					opacity: 1,
					blendMode: "normal",
					transform: { ...createIdentityTransform(), x: 100, y: 100 },
				});
			},
			() => setObject(doc, squarePath("child", 20, 20)),
		]);

		const { rects } = buildTimelapseIndex(entries);

		// The child's rect is reported through the group, so the group's own
		// offset is already folded in.
		expect(rects[1]).not.toBeNull();
		expect(rects[1]![0]).toBeGreaterThan(50);
		doc.destroy();
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

/** A 10x10 axis-aligned square whose top-left sits at (x, y). */
function squarePath(id: string, x: number, y: number): Path {
	const corners = [
		{ x, y },
		{ x: x + 10, y },
		{ x: x + 10, y: y + 10 },
		{ x, y: y + 10 },
	];

	return {
		id,
		type: "path",
		segments: corners.map((_, i) => ({
			start: i === 0 ? corners[0] : undefined,
			end: corners[(i + 1) % corners.length],
			cp1: { x: 0, y: 0 },
			cp2: { x: 0, y: 0 },
			startTiltX: 0,
			startTiltY: 0,
			endTiltX: 0,
			endTiltY: 0,
			startDeltaTime: 0,
			endDeltaTime: 0,
			isMoved: i === 0,
		})),
		opacity: 1,
		blendMode: "normal",
		transform: createIdentityTransform(),
	};
}

function setObject(doc: Y.Doc, element: AnyArtObject): void {
	const yMap = new Y.Map<unknown>();
	for (const [key, value] of Object.entries(objectToStoredFields(element))) {
		yMap.set(key, value);
	}
	doc.getMap("objects").set(element.id, yMap);
}

/** Run each mutation in its own transaction and capture the resulting update. */
function recordEntries(
	doc: Y.Doc,
	mutations: (() => void)[],
): TimelapseEntry[] {
	const entries: TimelapseEntry[] = [];
	doc.on("update", (update: Uint8Array) => {
		entries.push({ t: entries.length * 100, u: update });
	});

	for (const mutate of mutations) doc.transact(mutate);

	return entries;
}
