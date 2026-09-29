import { describe, expect, it } from "vitest";
import { accumulateChanges, emptyChanges } from "./changedElements";

describe("accumulateChanges", () => {
	it("should keep the ids of both change sets", () => {
		const acc = emptyChanges();
		accumulateChanges(acc, { upserted: new Set(["a"]), deleted: new Set() });
		accumulateChanges(acc, {
			upserted: new Set(["b"]),
			deleted: new Set(["c"]),
		});

		expect([...acc.upserted].sort()).toEqual(["a", "b"]);
		expect([...acc.deleted]).toEqual(["c"]);
	});

	it("should report an element deleted after an upsert as deleted only", () => {
		const acc = emptyChanges();
		accumulateChanges(acc, { upserted: new Set(["a"]), deleted: new Set() });
		accumulateChanges(acc, { upserted: new Set(), deleted: new Set(["a"]) });

		expect(acc.upserted.has("a")).toBe(false);
		expect(acc.deleted.has("a")).toBe(true);
	});

	it("should report an element re-added after a delete as upserted only", () => {
		const acc = emptyChanges();
		accumulateChanges(acc, { upserted: new Set(), deleted: new Set(["a"]) });
		accumulateChanges(acc, { upserted: new Set(["a"]), deleted: new Set() });

		expect(acc.upserted.has("a")).toBe(true);
		expect(acc.deleted.has("a")).toBe(false);
	});
});
