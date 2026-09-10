import { Emitter } from "./utils/emitter";
import { matchKey } from "./utils/keyboard";

// --- Types ---

export interface KeySpec {
	/** Physical key code (e.g. "KeyA", "Digit0", "Delete", "Space") */
	code: string;
	/** Platform-agnostic Ctrl(Win)/Cmd(Mac) modifier */
	ctrlOrMeta?: boolean;
	ctrl?: boolean;
	shift?: boolean;
	alt?: boolean;
	meta?: boolean;
}

type ShortcutContext = {
	canvasFocused: boolean;
};

export interface Keybinding {
	commandId: string;
	key: KeySpec;
	when?: Partial<ShortcutContext>;
	source: "default" | "user";
}

export interface ShortcutsConfig {
	version: 1;
	keybindings: Array<{
		commandId: string;
		key: KeySpec;
		when?: Partial<ShortcutContext>;
	}>;
}

export const defaultShortcutCommands = {
	"paplico.deleteElements": "paplico.deleteElements",
	"paplico.copy": "paplico.copy",
	"paplico.cut": "paplico.cut",
	"paplico.paste": "paplico.paste",
	"paplico.pasteToFront": "paplico.pasteToFront",
	"paplico.pasteToBack": "paplico.pasteToBack",
	"paplico.undo": "paplico.undo",
	"paplico.redo": "paplico.redo",
	"paplico.group": "paplico.group",
	"paplico.ungroup": "paplico.ungroup",
	"paplico.clipGroup": "paplico.clipGroup",
	"paplico.arrangeBackward": "paplico.arrangeBackward",
	"paplico.arrangeForward": "paplico.arrangeForward",
	"paplico.exitEditingScope": "paplico.exitEditingScope",
	"paplico.exitEditingScopeAll": "paplico.exitEditingScopeAll",
	"paplico.clearSelection": "paplico.clearSelection",
	"paplico.selectAll": "paplico.selectAll",
	"paplico.deselectAll": "paplico.deselectAll",
	"paplico.resetZoom": "paplico.resetZoom",
	"paplico.tool.select": "paplico.tool.select",
	"paplico.tool.path": "paplico.tool.path",
	"paplico.tool.pen": "paplico.tool.pen",
	"paplico.tool.eraser": "paplico.tool.eraser",
	"paplico.tool.pathEdit": "paplico.tool.pathEdit",
	"paplico.tool.text": "paplico.tool.text",
	"paplico.tool.gradient": "paplico.tool.gradient",
	"paplico.tool.eyedropper": "paplico.tool.eyedropper",
	"paplico.tool.strokeWidthEdit": "paplico.tool.strokeWidthEdit",
	"paplico.tool.shapeRect": "paplico.tool.shapeRect",
	"paplico.tool.shapeEllipse": "paplico.tool.shapeEllipse",
	"paplico.tool.meshDeform": "paplico.tool.meshDeform",
	"paplico.tool.skew": "paplico.tool.skew",
	"paplico.tool.freeTransform": "paplico.tool.freeTransform",
	"paplico.tool.transformCycle": "paplico.tool.transformCycle",
	"paplico.toggleColorTarget": "paplico.toggleColorTarget",
	"paplico.swapColors": "paplico.swapColors",
	"paplico.clearActiveColor": "paplico.clearActiveColor",
	"paplico.toggleSplitView": "paplico.toggleSplitView",
} as const;

export interface ShortcutCommand {
	id: string;
	category: string;
	handler: () => boolean;
}

type ShortcutEvents = {
	change: undefined;
};

// --- Helpers ---

function matchKeySpec(
	event: {
		code: string;
		metaKey: boolean;
		ctrlKey: boolean;
		altKey: boolean;
		shiftKey: boolean;
	},
	spec: KeySpec,
): boolean {
	return matchKey(event, spec.code, {
		ctrlOrMeta: spec.ctrlOrMeta,
		ctrl: spec.ctrl,
		alt: spec.alt,
		shift: spec.shift,
		meta: spec.meta,
	});
}

function matchesWhenClause(
	when: Partial<ShortcutContext> | undefined,
	contextValues: Map<keyof ShortcutContext, boolean>,
): boolean {
	if (!when) return true;
	for (const key of Object.keys(when) as Array<keyof ShortcutContext>) {
		if ((contextValues.get(key) ?? false) !== when[key]) return false;
	}
	return true;
}

function keySpecEquals(a: KeySpec, b: KeySpec): boolean {
	return (
		a.code === b.code &&
		!!a.ctrlOrMeta === !!b.ctrlOrMeta &&
		!!a.ctrl === !!b.ctrl &&
		!!a.shift === !!b.shift &&
		!!a.alt === !!b.alt &&
		!!a.meta === !!b.meta
	);
}

// --- Main class ---

/**
 * Keyboard shortcut registry and dispatcher for Paplico.
 *
 * ## Overview
 * `PaplicoShortcuts` manages three independent tables and combines them at
 * dispatch time:
 *
 * 1. **Command registry** — maps a command ID (e.g. `"paplico.copy"`) to a
 *    handler `() => boolean`.  Returning `true` signals that the command
 *    consumed the key event; returning `false` lets dispatch continue to the
 *    next candidate.
 *
 * 2. **Keybinding registry** — associates a `KeySpec` (physical key + modifier
 *    flags) with a command ID.  Bindings come from two sources:
 *    - *default* — registered by the engine via `registerDefaultKeybinding`.
 *    - *user* — overrides loaded from persisted config via `setUserKeybinding`.
 *    User bindings shadow default bindings for the same command + `when` pair.
 *
 * 3. **Context values** — a set of boolean flags (typed as `ShortcutContext`)
 *    that represent the current UI state (e.g. `canvasFocused`).  Each
 *    keybinding may carry an optional `when` clause; the binding is skipped
 *    unless every key in the clause matches the current context value.
 *
 * ## Dispatch flow (`handleKeyEvent`)
 * ```
 * KeyboardEvent
 *   → getEffectiveBindings()          // merge default + user, user wins
 *   → matchKeySpec(event, binding.key) // physical key + modifiers match?
 *   → matchesWhenClause(binding.when)  // context predicate satisfied?
 *   → commands.get(binding.commandId)  // command registered?
 *   → command.handler()                // true → consumed, false → next
 * ```
 *
 * ## Context management
 * Call `setContext("canvasFocused", true/false)` from `PaplicoUI` on
 * `pointerenter`/`pointerleave` so that canvas-only bindings (tool keys,
 * Delete, Escape, etc.) are suppressed when a UI panel has interaction focus.
 *
 * ## Persistence
 * `exportConfig()` / `importConfig()` serialise only user-defined bindings.
 * Default bindings are re-registered on every engine init and are never stored.
 */
export class PaplicoShortcuts extends Emitter<ShortcutEvents> {
	private commands = new Map<string, ShortcutCommand>();
	private defaultBindings: Keybinding[] = [];
	private userBindings: Keybinding[] = [];
	private contextValues = new Map<keyof ShortcutContext, boolean>();

	// -- Command registry --

	public registerCommand(
		id: string,
		category: string,
		handler: () => boolean,
	): void {
		this.commands.set(id, { id, category, handler });
	}

	public unregisterCommand(id: string): void {
		this.commands.delete(id);
	}

	// -- Keybinding registry --

	public registerDefaultKeybinding(
		commandId: string,
		key: KeySpec,
		when?: Partial<ShortcutContext>,
	): void {
		this.defaultBindings.push({ commandId, key, when, source: "default" });
	}

	public setUserKeybinding(
		commandId: string,
		key: KeySpec,
		when?: Partial<ShortcutContext>,
	): void {
		// Remove existing user binding for the same command+when combination
		this.userBindings = this.userBindings.filter(
			(b) =>
				!(
					b.commandId === commandId &&
					JSON.stringify(b.when) === JSON.stringify(when)
				),
		);
		this.userBindings.push({ commandId, key, when, source: "user" });
		this.emit("change", undefined);
	}

	public removeUserKeybinding(
		commandId: string,
		when?: Partial<ShortcutContext>,
	): void {
		this.userBindings = this.userBindings.filter(
			(b) =>
				!(
					b.commandId === commandId &&
					JSON.stringify(b.when) === JSON.stringify(when)
				),
		);
		this.emit("change", undefined);
	}

	// -- Context --

	public setContext<K extends keyof ShortcutContext>(
		key: K,
		value: ShortcutContext[K],
	): void {
		this.contextValues.set(key, value);
	}

	// -- Core dispatch --

	public handleKeyEvent(event: KeyboardEvent): boolean {
		const effective = this.getEffectiveBindings();

		for (const binding of effective) {
			if (!matchKeySpec(event, binding.key)) continue;
			if (!matchesWhenClause(binding.when, this.contextValues)) continue;

			const command = this.commands.get(binding.commandId);
			if (!command) continue;

			if (command.handler()) return true;
		}

		return false;
	}

	/**
	 * Invoke a registered command by id without going through a key event.
	 * Returns the command's boolean result, or `false` if no command is
	 * registered for the given id (after emitting a console warning).
	 */
	public executeCommand(id: string): boolean {
		const command = this.commands.get(id);
		if (!command) {
			console.warn(`PaplicoShortcuts: command "${id}" is not registered`);
			return false;
		}
		return command.handler();
	}

	// -- Serialization --

	public exportConfig(): ShortcutsConfig {
		return {
			version: 1,
			keybindings: this.userBindings.map((b) => ({
				commandId: b.commandId,
				key: { ...b.key },
				...(b.when ? { when: { ...b.when } } : {}),
			})),
		};
	}

	public importConfig(config: ShortcutsConfig): void {
		this.userBindings = config.keybindings.map((b) => ({
			commandId: b.commandId,
			key: { ...b.key },
			when: b.when ? { ...b.when } : undefined,
			source: "user" as const,
		}));
		this.emit("change", undefined);
	}

	public resetToDefaults(): void {
		this.userBindings = [];
		this.emit("change", undefined);
	}

	/** Check if a keyboard event matches any binding for the given command IDs */
	public matchesCommands(event: KeyboardEvent, commandIds: string[]): boolean {
		const effective = this.getEffectiveBindings();
		for (const binding of effective) {
			if (!commandIds.includes(binding.commandId)) continue;
			if (!matchKeySpec(event, binding.key)) continue;
			return true;
		}
		return false;
	}

	// -- Query --

	public getCommands(): ShortcutCommand[] {
		return Array.from(this.commands.values());
	}

	/**
	 * Returns effective bindings with when-specific user overrides applied.
	 * For bindings with when clauses, user overrides shadow defaults only
	 * when they match the same commandId+when combination.
	 * When-clause bindings are returned before whenless bindings for the same key.
	 */
	public getEffectiveBindings(): Keybinding[] {
		const result: Keybinding[] = [];

		// Start with all user bindings
		for (const ub of this.userBindings) {
			result.push(ub);
		}

		// Add default bindings that are not overridden by user bindings
		for (const db of this.defaultBindings) {
			const overridden = this.userBindings.some(
				(ub) =>
					ub.commandId === db.commandId &&
					JSON.stringify(ub.when) === JSON.stringify(db.when),
			);
			if (!overridden) {
				result.push(db);
			}
		}

		// Sort: when-clause bindings first (more specific), then whenless
		result.sort((a, b) => {
			const aHasWhen = a.when && Object.keys(a.when).length > 0 ? 1 : 0;
			const bHasWhen = b.when && Object.keys(b.when).length > 0 ? 1 : 0;
			return bHasWhen - aHasWhen;
		});

		return result;
	}

	public getBindingsForCommand(commandId: string): Keybinding[] {
		return this.getEffectiveBindings().filter((b) => b.commandId === commandId);
	}

	/**
	 * Find the binding that conflicts with the given key spec.
	 * Returns the conflicting binding, or null if no conflict.
	 */
	public findConflict(
		key: KeySpec,
		when?: Record<string, boolean>,
		excludeCommandId?: string,
	): Keybinding | null {
		for (const binding of this.getEffectiveBindings()) {
			if (excludeCommandId && binding.commandId === excludeCommandId) continue;
			if (
				keySpecEquals(binding.key, key) &&
				JSON.stringify(binding.when) === JSON.stringify(when)
			) {
				return binding;
			}
		}
		return null;
	}
}

// --- Key display helpers ---

export const IS_MAC =
	typeof navigator !== "undefined" &&
	/Mac|iPhone|iPad/.test(navigator.platform);

export const CODE_DISPLAY_MAP: Record<string, string> = {
	BracketLeft: "[",
	BracketRight: "]",
	Backslash: "\\",
	Semicolon: ";",
	Quote: "'",
	Comma: ",",
	Period: ".",
	Slash: "/",
	Minus: "-",
	Equal: "=",
	Backquote: "`",
	Space: "Space",
	Enter: "Enter",
	Backspace: "Backspace",
	Tab: "Tab",
	Escape: "Esc",
	Delete: "Delete",
	ArrowUp: "↑",
	ArrowDown: "↓",
	ArrowLeft: "←",
	ArrowRight: "→",
	Home: "Home",
	End: "End",
	PageUp: "PgUp",
	PageDown: "PgDn",
};

function codeToDisplayName(code: string): string {
	if (CODE_DISPLAY_MAP[code]) return CODE_DISPLAY_MAP[code];
	if (code.startsWith("Key")) return code.slice(3);
	if (code.startsWith("Digit")) return code.slice(5);
	if (code.startsWith("Numpad")) return `Num${code.slice(6)}`;
	if (code.startsWith("F") && /^F\d+$/.test(code)) return code;
	return code;
}

export function formatKeySpec(spec: KeySpec): string {
	const parts: string[] = [];

	if (spec.ctrlOrMeta) parts.push(IS_MAC ? "⌘" : "Ctrl");
	if (spec.ctrl) parts.push("Ctrl");
	if (spec.meta) parts.push(IS_MAC ? "⌘" : "Win");
	if (spec.shift) parts.push("⇧");
	if (spec.alt) parts.push(IS_MAC ? "⌥" : "Alt");

	parts.push(codeToDisplayName(spec.code));
	return parts.join(IS_MAC ? "" : "+");
}
