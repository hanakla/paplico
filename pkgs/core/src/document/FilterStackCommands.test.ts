import { beforeEach, describe, expect, it } from "vitest";
import type { Filter, FilterEntry } from "../schema";
import type { FilterCapabilities } from "./elementGeometry/filterCapabilities";
import { FilterStackCommands } from "./FilterStackCommands";

describe("FilterStackCommands.addSubFilter", () => {
	let filters: FilterEntry[];
	let stack: FilterStackCommands;

	beforeEach(() => {
		filters = [filter("fill")];
		stack = new FilterStackCommands(
			() => filters,
			(next) => {
				filters = next;
			},
			{ getHandler: (processor) => HANDLERS[processor] },
		);
	});

	it("should add a filter whose handler allows it under the fill", () => {
		const blur = filter("blur");
		stack.addSubFilter(0, blur);

		expect((filters[0] as Filter).subFilters).toEqual([blur]);
	});

	it("should not add a filter whose handler says it cannot be a sub-filter", () => {
		stack.addSubFilter(0, filter("svg:gaussian-blur"));

		expect((filters[0] as Filter).subFilters).toBeUndefined();
	});

	it("should not add a filter that has no registered handler", () => {
		stack.addSubFilter(0, filter("unknown"));

		expect((filters[0] as Filter).subFilters).toBeUndefined();
	});
});

const HANDLERS: Record<string, FilterCapabilities> = {
	blur: {},
	"svg:gaussian-blur": { usableAsSubFilter: false },
};

function filter(processor: string): Filter {
	return {
		uid: `filter-${processor}`,
		processor,
		opacity: 1,
		blendMode: "normal",
		paramData: { version: "1", params: {} },
	};
}
