import { describe, expect, it } from "vitest";
import { matchKey } from "./keyboard";

function kb(
	code: string,
	mods?: {
		metaKey?: boolean;
		ctrlKey?: boolean;
		altKey?: boolean;
		shiftKey?: boolean;
	},
): KeyboardEvent {
	return new KeyboardEvent("keydown", {
		code,
		metaKey: mods?.metaKey,
		ctrlKey: mods?.ctrlKey,
		altKey: mods?.altKey,
		shiftKey: mods?.shiftKey,
	});
}

describe("matchKey", () => {
	it("matches bare key with no modifiers", () => {
		expect(matchKey(kb("KeyA"), "KeyA")).toBe(true);
	});

	it("rejects wrong code", () => {
		expect(matchKey(kb("KeyB"), "KeyA")).toBe(false);
	});

	it("rejects when unexpected modifier is pressed", () => {
		expect(matchKey(kb("KeyA", { shiftKey: true }), "KeyA")).toBe(false);
		expect(matchKey(kb("KeyA", { metaKey: true }), "KeyA")).toBe(false);
		expect(matchKey(kb("KeyA", { ctrlKey: true }), "KeyA")).toBe(false);
		expect(matchKey(kb("KeyA", { altKey: true }), "KeyA")).toBe(false);
	});

	it("matches explicit metaKey", () => {
		expect(
			matchKey(kb("KeyA", { metaKey: true }), "KeyA", { meta: true }),
		).toBe(true);
	});

	it("rejects metaKey when not specified", () => {
		expect(
			matchKey(kb("KeyA", { metaKey: true }), "KeyA", { ctrl: true }),
		).toBe(false);
	});

	it("matches Ctrl+Shift combo", () => {
		expect(
			matchKey(kb("KeyS", { ctrlKey: true, shiftKey: true }), "KeyS", {
				ctrl: true,
				shift: true,
			}),
		).toBe(true);
	});

	it("rejects Ctrl+Shift+Alt when only Ctrl+Shift specified", () => {
		expect(
			matchKey(
				kb("KeyS", { ctrlKey: true, shiftKey: true, altKey: true }),
				"KeyS",
				{ ctrl: true, shift: true },
			),
		).toBe(false);
	});

	it("rejects when required modifier is missing", () => {
		expect(matchKey(kb("KeyA"), "KeyA", { ctrl: true })).toBe(false);
	});

	describe("ctrlOrMetaKey", () => {
		// isMac is determined at module load time from navigator.platform.
		// In Node/vitest, navigator.platform is typically "linux" or similar (non-Mac).
		// So ctrlOrMetaKey maps to ctrlKey in this test environment.

		it("matches ctrlKey in non-Mac environment", () => {
			expect(
				matchKey(kb("KeyA", { ctrlKey: true }), "KeyA", {
					ctrlOrMeta: true,
				}),
			).toBe(true);
		});

		it("rejects metaKey in non-Mac environment", () => {
			expect(
				matchKey(kb("KeyA", { metaKey: true }), "KeyA", {
					ctrlOrMeta: true,
				}),
			).toBe(false);
		});

		it("rejects extra modifiers with ctrlOrMetaKey", () => {
			expect(
				matchKey(kb("KeyA", { ctrlKey: true, altKey: true }), "KeyA", {
					ctrlOrMeta: true,
				}),
			).toBe(false);
		});
	});

	it("spec omitted works same as empty spec", () => {
		expect(matchKey(kb("Space"), "Space")).toBe(true);
		expect(matchKey(kb("Space"), "Space", {})).toBe(true);
	});
});
