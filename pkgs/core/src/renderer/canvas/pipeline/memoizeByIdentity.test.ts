import { describe, expect, it, vi } from "vitest";
import { memoizeByIdentity } from "./memoizeByIdentity";

describe("memoizeByIdentity", () => {
	it("should scan once while frames reuse the same object", () => {
		const scan = vi.fn(() => ["element-1"]);
		const scanOf = memoizeByIdentity(scan);
		const elementsMap = new Map<string, string>();

		const first = scanOf(elementsMap);
		const second = scanOf(elementsMap);

		expect(second).toBe(first);
		expect(scan).toHaveBeenCalledOnce();
	});

	it("should scan again when a frame brings another object", () => {
		const scan = vi.fn(() => ["element-1"]);
		const scanOf = memoizeByIdentity(scan);

		scanOf(new Map<string, string>());
		scanOf(new Map<string, string>());

		expect(scan).toHaveBeenCalledTimes(2);
	});
});
