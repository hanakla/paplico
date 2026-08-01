import { describe, expect, it, vi } from "vitest";
import { createMockToolContext } from "../testUtils/mockToolContext";

// ToolContext.duplicateElements is a thin gesture-side wrapper: the actual
// clone / id-numbering / container handling lives in PaplicoCommands and is
// shared with copy-paste (covered by PaplicoCommands.test). Here we only verify
// the delegation.
describe("ToolContext", () => {
	describe("duplicateElements", () => {
		it("delegates to duplicateElementsByIds with a per-axis offset and returns its result", () => {
			const ctx = createMockToolContext({
				duplicateElementsByIds: vi.fn(() => ["new-1", "new-2"]),
			});

			const result = ctx.duplicateElements(["a", "b"], 10);

			expect(result).toEqual(["new-1", "new-2"]);
			expect(ctx.duplicateElementsByIds).toHaveBeenCalledWith(["a", "b"], {
				x: 10,
				y: 10,
			});
		});

		it("defaults the offset to 10 on both axes", () => {
			const ctx = createMockToolContext({
				duplicateElementsByIds: vi.fn(() => []),
			});

			ctx.duplicateElements(["a"]);

			expect(ctx.duplicateElementsByIds).toHaveBeenCalledWith(["a"], {
				x: 10,
				y: 10,
			});
		});
	});
});
