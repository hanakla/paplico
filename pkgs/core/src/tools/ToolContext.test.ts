import { describe, expect, it, vi } from "vitest";
import { createMockToolContext } from "../testUtils/mockToolContext";

// ToolContext.duplicateElements is a thin gesture-side wrapper: the actual
// clone / id-numbering / container handling lives in PaplicoCommands and is
// shared with copy-paste (covered by PaplicoCommands.test). Here we only verify
// the delegation.
describe("ToolContext", () => {
	describe("duplicateElements", () => {
		it("duplicates in place and returns the new ids", () => {
			const ctx = createMockToolContext({
				duplicateElementsByIds: vi.fn(() => ["new-1", "new-2"]),
			});

			const result = ctx.duplicateElements(["a", "b"]);

			expect(result).toEqual(["new-1", "new-2"]);
			expect(ctx.duplicateElementsByIds).toHaveBeenCalledWith(["a", "b"], {
				x: 0,
				y: 0,
			});
		});
	});
});
