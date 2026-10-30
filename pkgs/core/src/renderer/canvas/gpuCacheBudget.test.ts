import {
	filteredElementBudgetBytes,
	splitGpuCacheBudget,
} from "./gpuCacheBudget";

describe("filteredElementBudgetBytes", () => {
	it("should give the filtered bakes the room the other caches leave", () => {
		expect(filteredElementBudgetBytes(1000, 300)).toBe(700);
	});

	it("should keep the filtered bakes' own share when the others fill the budget", () => {
		expect(filteredElementBudgetBytes(1000, 1000)).toBe(
			splitGpuCacheBudget(1000).filteredElements,
		);
	});
});
