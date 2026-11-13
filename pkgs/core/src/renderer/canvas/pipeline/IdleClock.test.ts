import { describe, expect, it } from "vitest";
import { evictIdleOverBudget } from "./IdleClock";

describe("evictIdleOverBudget", () => {
	it("should free the entries used longest ago until the rest fits the budget", () => {
		const { entries, destroyed, evict } = cacheOf([
			["a", 40, 1],
			["b", 40, 3],
			["c", 40, 2],
		]);

		evict(80, 10);

		expect(destroyed).toEqual(["a"]);
		expect([...entries.keys()]).toEqual(["b", "c"]);
	});

	it("should keep an entry used within the last two frames even over the budget", () => {
		const { entries, destroyed, evict } = cacheOf([
			["old", 40, 1],
			["last", 40, 9],
			["current", 40, 10],
		]);

		evict(10, 10);

		expect(destroyed).toEqual(["old"]);
		expect([...entries.keys()]).toEqual(["last", "current"]);
	});

	it("should free nothing while the entries fit the budget", () => {
		const { entries, destroyed, evict } = cacheOf([
			["a", 40, 1],
			["b", 40, 2],
		]);

		evict(80, 10);

		expect(destroyed).toEqual([]);
		expect(entries.size).toBe(2);
	});
});

/** A cache of [key, bytes, last used frame] entries and what was destroyed. */
function cacheOf(rows: [key: string, bytes: number, lastUsedFrame: number][]) {
	const entries = new Map(
		rows.map(([key, bytes, lastUsedFrame]) => [
			key,
			{ key, bytes, lastUsedFrame },
		]),
	);
	const destroyed: string[] = [];
	return {
		entries,
		destroyed,
		evict: (maxBytes: number, currentFrame: number) =>
			evictIdleOverBudget(entries, maxBytes, currentFrame, {
				bytesOf: (entry) => entry.bytes,
				lastUsedFrameOf: (entry) => entry.lastUsedFrame,
				destroy: (entry) => destroyed.push(entry.key),
			}),
	};
}
