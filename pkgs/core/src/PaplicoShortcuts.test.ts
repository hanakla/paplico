import { beforeEach, describe, expect, it, vi } from "vitest";
import { PaplicoShortcuts } from "./PaplicoShortcuts";

function fakeKeyEvent(
	code: string,
	opts: {
		metaKey?: boolean;
		ctrlKey?: boolean;
		altKey?: boolean;
		shiftKey?: boolean;
	} = {},
): KeyboardEvent {
	return {
		code,
		metaKey: opts.metaKey ?? false,
		ctrlKey: opts.ctrlKey ?? false,
		altKey: opts.altKey ?? false,
		shiftKey: opts.shiftKey ?? false,
		preventDefault: vi.fn(),
	} as unknown as KeyboardEvent;
}

describe("PaplicoShortcuts", () => {
	let shortcuts: PaplicoShortcuts;

	beforeEach(() => {
		shortcuts = new PaplicoShortcuts();
	});

	describe("registerCommand / unregisterCommand", () => {
		it("registers and retrieves a command", () => {
			shortcuts.registerCommand("test.cmd", "General", () => true);
			const commands = shortcuts.getCommands();
			expect(commands).toHaveLength(1);
			expect(commands[0].id).toBe("test.cmd");
			expect(commands[0].category).toBe("General");
		});

		it("unregisters a command", () => {
			shortcuts.registerCommand("test.cmd", "General", () => true);
			shortcuts.unregisterCommand("test.cmd");
			expect(shortcuts.getCommands()).toHaveLength(0);
		});
	});

	describe("handleKeyEvent", () => {
		it("executes a matching command and returns true", () => {
			const handler = vi.fn(() => true);
			shortcuts.registerCommand("test.delete", "Edit", handler);
			shortcuts.registerDefaultKeybinding("test.delete", { code: "Delete" });

			const result = shortcuts.handleKeyEvent(fakeKeyEvent("Delete"));

			expect(result).toBe(true);
			expect(handler).toHaveBeenCalledOnce();
		});

		it("returns false when no binding matches", () => {
			shortcuts.registerCommand("test.cmd", "General", () => true);
			shortcuts.registerDefaultKeybinding("test.cmd", { code: "KeyA" });

			const result = shortcuts.handleKeyEvent(fakeKeyEvent("KeyB"));

			expect(result).toBe(false);
		});

		it("returns false when command is not registered", () => {
			shortcuts.registerDefaultKeybinding("nonexistent", { code: "KeyA" });

			const result = shortcuts.handleKeyEvent(fakeKeyEvent("KeyA"));

			expect(result).toBe(false);
		});

		it("matches modifier keys correctly", () => {
			const handler = vi.fn(() => true);
			shortcuts.registerCommand("test.save", "Edit", handler);
			shortcuts.registerDefaultKeybinding("test.save", {
				code: "KeyS",
				ctrlOrMeta: true,
			});

			// Without modifier — should not match
			expect(shortcuts.handleKeyEvent(fakeKeyEvent("KeyS"))).toBe(false);

			// With ctrl (non-Mac) — matchKey uses isMac from navigator,
			// happy-dom does not set Mac platform, so ctrlKey should match
			expect(
				shortcuts.handleKeyEvent(fakeKeyEvent("KeyS", { ctrlKey: true })),
			).toBe(true);
		});

		it("matches shift modifier", () => {
			const handler = vi.fn(() => true);
			shortcuts.registerCommand("test.redo", "Edit", handler);
			shortcuts.registerDefaultKeybinding("test.redo", {
				code: "KeyZ",
				ctrlOrMeta: true,
				shift: true,
			});

			// Without shift — should not match
			expect(
				shortcuts.handleKeyEvent(fakeKeyEvent("KeyZ", { ctrlKey: true })),
			).toBe(false);

			// With shift+ctrl — should match
			expect(
				shortcuts.handleKeyEvent(
					fakeKeyEvent("KeyZ", { ctrlKey: true, shiftKey: true }),
				),
			).toBe(true);
		});

		it("falls back to next binding when handler returns false", () => {
			const firstHandler = vi.fn(() => false);
			const secondHandler = vi.fn(() => true);

			shortcuts.registerCommand("test.first", "General", firstHandler);
			shortcuts.registerCommand("test.second", "General", secondHandler);
			shortcuts.registerDefaultKeybinding("test.first", { code: "Escape" });
			shortcuts.registerDefaultKeybinding("test.second", { code: "Escape" });

			const result = shortcuts.handleKeyEvent(fakeKeyEvent("Escape"));

			expect(result).toBe(true);
			expect(firstHandler).toHaveBeenCalledOnce();
			expect(secondHandler).toHaveBeenCalledOnce();
		});

		it("returns false when all handlers return false", () => {
			shortcuts.registerCommand("test.a", "General", () => false);
			shortcuts.registerCommand("test.b", "General", () => false);
			shortcuts.registerDefaultKeybinding("test.a", { code: "Escape" });
			shortcuts.registerDefaultKeybinding("test.b", { code: "Escape" });

			expect(shortcuts.handleKeyEvent(fakeKeyEvent("Escape"))).toBe(false);
		});
	});

	describe("when clause", () => {
		it("skips binding when context condition is not met", () => {
			const handler = vi.fn(() => true);
			shortcuts.registerCommand("test.exitGroup", "Nav", handler);
			shortcuts.registerDefaultKeybinding(
				"test.exitGroup",
				{ code: "Escape" },
				{ canvasFocused: true },
			);

			// No context set — should skip
			expect(shortcuts.handleKeyEvent(fakeKeyEvent("Escape"))).toBe(false);
			expect(handler).not.toHaveBeenCalled();
		});

		it("matches binding when context condition is met", () => {
			const handler = vi.fn(() => true);
			shortcuts.registerCommand("test.exitGroup", "Nav", handler);
			shortcuts.registerDefaultKeybinding(
				"test.exitGroup",
				{ code: "Escape" },
				{ canvasFocused: true },
			);

			shortcuts.setContext("canvasFocused", true);
			expect(shortcuts.handleKeyEvent(fakeKeyEvent("Escape"))).toBe(true);
			expect(handler).toHaveBeenCalledOnce();
		});

		it("prioritizes when-clause binding over whenless binding for same key", () => {
			const exitGroupHandler = vi.fn(() => true);
			const clearSelHandler = vi.fn(() => true);

			shortcuts.registerCommand("test.exitGroup", "Nav", exitGroupHandler);
			shortcuts.registerCommand("test.clearSel", "Selection", clearSelHandler);
			shortcuts.registerDefaultKeybinding(
				"test.exitGroup",
				{ code: "Escape" },
				{ canvasFocused: true },
			);
			shortcuts.registerDefaultKeybinding("test.clearSel", { code: "Escape" });

			// canvasFocused = true → exitGroup should fire first
			shortcuts.setContext("canvasFocused", true);
			shortcuts.handleKeyEvent(fakeKeyEvent("Escape"));

			expect(exitGroupHandler).toHaveBeenCalledOnce();
			expect(clearSelHandler).not.toHaveBeenCalled();
		});

		it("falls through to whenless binding when when-clause is not met", () => {
			const exitGroupHandler = vi.fn(() => true);
			const clearSelHandler = vi.fn(() => true);

			shortcuts.registerCommand("test.exitGroup", "Nav", exitGroupHandler);
			shortcuts.registerCommand("test.clearSel", "Selection", clearSelHandler);
			shortcuts.registerDefaultKeybinding(
				"test.exitGroup",
				{ code: "Escape" },
				{ canvasFocused: true },
			);
			shortcuts.registerDefaultKeybinding("test.clearSel", { code: "Escape" });

			// canvasFocused not set → exitGroup skipped, clearSel fires
			shortcuts.handleKeyEvent(fakeKeyEvent("Escape"));

			expect(exitGroupHandler).not.toHaveBeenCalled();
			expect(clearSelHandler).toHaveBeenCalledOnce();
		});

		it("re-evaluates when-clause conditions on context updates", () => {
			const handler = vi.fn(() => true);
			shortcuts.registerCommand("test.cmd", "General", handler);
			shortcuts.registerDefaultKeybinding(
				"test.cmd",
				{ code: "KeyA" },
				{ canvasFocused: true },
			);

			expect(shortcuts.handleKeyEvent(fakeKeyEvent("KeyA"))).toBe(false);

			shortcuts.setContext("canvasFocused", true);
			expect(shortcuts.handleKeyEvent(fakeKeyEvent("KeyA"))).toBe(true);
		});
	});

	describe("user bindings override defaults", () => {
		it("user binding shadows default with same commandId+when", () => {
			const handler = vi.fn(() => true);
			shortcuts.registerCommand("test.cmd", "General", handler);
			shortcuts.registerDefaultKeybinding("test.cmd", { code: "KeyA" });

			// Override to KeyB — shadows the default (same commandId, same when=undefined)
			shortcuts.setUserKeybinding("test.cmd", { code: "KeyB" });

			const bindings = shortcuts.getBindingsForCommand("test.cmd");
			expect(bindings).toHaveLength(1);
			expect(bindings[0].source).toBe("user");
			expect(bindings[0].key.code).toBe("KeyB");

			// Old default KeyA should not work
			expect(shortcuts.handleKeyEvent(fakeKeyEvent("KeyA"))).toBe(false);

			// New user KeyB should work
			expect(shortcuts.handleKeyEvent(fakeKeyEvent("KeyB"))).toBe(true);
		});

		it("user binding with when clause overrides default with same when", () => {
			const handler = vi.fn(() => true);
			shortcuts.registerCommand("test.cmd", "General", handler);
			shortcuts.registerDefaultKeybinding(
				"test.cmd",
				{ code: "KeyA" },
				{ canvasFocused: true },
			);

			shortcuts.setUserKeybinding(
				"test.cmd",
				{ code: "KeyB" },
				{ canvasFocused: true },
			);

			const bindings = shortcuts.getBindingsForCommand("test.cmd");
			// Only user binding (default was overridden since same when)
			expect(bindings).toHaveLength(1);
			expect(bindings[0].source).toBe("user");
			expect(bindings[0].key.code).toBe("KeyB");
		});

		it("removeUserKeybinding restores default", () => {
			const handler = vi.fn(() => true);
			shortcuts.registerCommand("test.cmd", "General", handler);
			shortcuts.registerDefaultKeybinding("test.cmd", { code: "KeyA" });
			shortcuts.setUserKeybinding("test.cmd", { code: "KeyB" });

			shortcuts.removeUserKeybinding("test.cmd");

			const bindings = shortcuts.getBindingsForCommand("test.cmd");
			expect(bindings).toHaveLength(1);
			expect(bindings[0].source).toBe("default");
			expect(bindings[0].key.code).toBe("KeyA");
		});
	});

	describe("exportConfig / importConfig", () => {
		it("round-trips user bindings", () => {
			shortcuts.registerCommand("test.cmd", "General", () => true);
			shortcuts.setUserKeybinding("test.cmd", { code: "KeyB", shift: true });
			shortcuts.setUserKeybinding(
				"test.cmd",
				{ code: "KeyC" },
				{ canvasFocused: true },
			);

			const config = shortcuts.exportConfig();

			expect(config.version).toBe(1);
			expect(config.keybindings).toHaveLength(2);
			expect(config.keybindings[0].key.code).toBe("KeyB");
			expect(config.keybindings[0].key.shift).toBe(true);
			expect(config.keybindings[1].when).toEqual({ canvasFocused: true });

			// Import into fresh instance
			const shortcuts2 = new PaplicoShortcuts();
			shortcuts2.registerCommand("test.cmd", "General", () => true);
			shortcuts2.importConfig(config);

			const bindings = shortcuts2.getEffectiveBindings();
			expect(bindings).toHaveLength(2);
			expect(bindings[0].source).toBe("user");
		});

		it("exports only user overrides, not defaults", () => {
			shortcuts.registerCommand("test.cmd", "General", () => true);
			shortcuts.registerDefaultKeybinding("test.cmd", { code: "KeyA" });

			const config = shortcuts.exportConfig();
			expect(config.keybindings).toHaveLength(0);
		});
	});

	describe("resetToDefaults", () => {
		it("clears all user bindings", () => {
			shortcuts.registerCommand("test.cmd", "General", () => true);
			shortcuts.registerDefaultKeybinding("test.cmd", { code: "KeyA" });
			shortcuts.setUserKeybinding("test.cmd", { code: "KeyB" });

			shortcuts.resetToDefaults();

			const bindings = shortcuts.getEffectiveBindings();
			expect(bindings).toHaveLength(1);
			expect(bindings[0].source).toBe("default");
			expect(bindings[0].key.code).toBe("KeyA");
		});

		it("emits change event", () => {
			const onChange = vi.fn();
			shortcuts.on("change", onChange);

			shortcuts.resetToDefaults();

			expect(onChange).toHaveBeenCalledOnce();
		});
	});

	describe("findConflict", () => {
		it("finds conflicting binding", () => {
			shortcuts.registerCommand("test.a", "General", () => true);
			shortcuts.registerDefaultKeybinding("test.a", { code: "KeyA" });

			const conflict = shortcuts.findConflict({ code: "KeyA" });
			expect(conflict).not.toBeNull();
			expect(conflict!.commandId).toBe("test.a");
		});

		it("excludes specified command from conflict check", () => {
			shortcuts.registerCommand("test.a", "General", () => true);
			shortcuts.registerDefaultKeybinding("test.a", { code: "KeyA" });

			const conflict = shortcuts.findConflict(
				{ code: "KeyA" },
				undefined,
				"test.a",
			);
			expect(conflict).toBeNull();
		});

		it("returns null when no conflict", () => {
			shortcuts.registerCommand("test.a", "General", () => true);
			shortcuts.registerDefaultKeybinding("test.a", { code: "KeyA" });

			const conflict = shortcuts.findConflict({ code: "KeyB" });
			expect(conflict).toBeNull();
		});
	});

	describe("change event", () => {
		it("emits on setUserKeybinding", () => {
			const onChange = vi.fn();
			shortcuts.on("change", onChange);

			shortcuts.setUserKeybinding("test.cmd", { code: "KeyA" });

			expect(onChange).toHaveBeenCalledOnce();
		});

		it("emits on removeUserKeybinding", () => {
			const onChange = vi.fn();
			shortcuts.setUserKeybinding("test.cmd", { code: "KeyA" });

			shortcuts.on("change", onChange);
			shortcuts.removeUserKeybinding("test.cmd");

			expect(onChange).toHaveBeenCalledOnce();
		});

		it("emits on importConfig", () => {
			const onChange = vi.fn();
			shortcuts.on("change", onChange);

			shortcuts.importConfig({ version: 1, keybindings: [] });

			expect(onChange).toHaveBeenCalledOnce();
		});
	});
});
