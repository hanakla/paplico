import { throttle } from "es-toolkit";
import { useEffect, useMemo, useRef, useState } from "react";
import { CompanionChannel } from "@/companion/CompanionChannel";
import type {
	CompanionCommand,
	CompanionFilter,
	CompanionState,
} from "@/companion/companionProtocol";
import { useEventCallback } from "@/utils/hooks";

/**
 * "connected" means the host answered, not that the socket opened. A relay
 * accepts a connection whether or not anyone is on the other end, so treating
 * an open socket as a working session would show "connected" to someone
 * holding a code for a session that ended hours ago.
 */
export type CompanionConnectionStatus =
	| "connecting"
	| "connected"
	| "disconnected"
	| "ended";

export type CompanionCredentials = {
	roomId: string;
	roomKey: CryptoKey;
};

/**
 * The companion end of the link: holds the channel, mirrors what the host
 * reports, and sends commands back. Both the `/companion` page and the panel
 * opened inside the app use this.
 */
export function useCompanionClient(credentials: CompanionCredentials | null): {
	state: CompanionState | null;
	status: CompanionConnectionStatus;
	sendCommand: (command: CompanionCommand) => void;
} {
	const [state, setState] = useState<CompanionState | null>(null);
	const [status, setStatus] = useState<CompanionConnectionStatus>("connecting");
	const channelRef = useRef<CompanionChannel | null>(null);
	/** When each field was last changed here, so a stale echo cannot undo it. */
	const changedAtRef = useRef<Partial<Record<keyof CompanionState, number>>>(
		{},
	);

	const { roomId, roomKey } = credentials ?? {};

	useEffect(() => {
		if (!roomId || !roomKey) return;

		setState(null);
		setStatus("connecting");

		const channel = new CompanionChannel({ roomId, roomKey });
		channelRef.current = channel;

		channel.on("status", (socketStatus) => {
			if (socketStatus === "connected") {
				channel.send({ type: "hello" });
			} else {
				setStatus("disconnected");
			}
		});

		channel.on("message", (message) => {
			if (message.type === "state") {
				setState((current) => reconcile(current, message.state, changedAtRef));
				setStatus("connected");
			} else if (message.type === "ended") {
				setStatus("ended");
			}
		});

		// The relay says only that someone left, and the only peer that matters
		// here is the host. Asking again costs one message and settles it: an
		// answer means it was somebody else, silence means the session is over.
		channel.on("peerLeft", () => {
			setStatus("connecting");
			channel.send({ type: "hello" });
		});

		// The socket reconnects on its own after the screen was off, but the host
		// only speaks when spoken to, so the state has to be asked for again.
		const handleVisibilityChange = () => {
			if (document.visibilityState !== "visible") return;
			channel.send({ type: "hello" });
		};
		document.addEventListener("visibilitychange", handleVisibilityChange);

		return () => {
			document.removeEventListener("visibilitychange", handleVisibilityChange);
			channel.destroy();
			channelRef.current = null;
		};
	}, [roomId, roomKey]);

	useScreenWakeLock(status === "connected");

	const sendOverWire = useMemo(
		() => createCommandSender(() => channelRef.current),
		[],
	);

	// biome-ignore lint/correctness/useExhaustiveDependencies: the sender is created once
	useEffect(() => () => sendOverWire.dispose(), []);

	const sendCommand = useEventCallback((command: CompanionCommand) => {
		// Shown as done before the host says so. A slider that waits for the round
		// trip fights the finger dragging it.
		const now = Date.now();
		for (const field of FIELDS_BY_COMMAND[command.type]) {
			changedAtRef.current[field] = now;
		}
		setState((current) => (current ? applyLocally(current, command) : current));

		sendOverWire(command);
	});

	return { state, status, sendCommand };
}

/** Fastest a drag of the same thing is worth reporting. */
const COMMAND_INTERVAL_MS = 60;

/**
 * Commands a finger produces a stream of. Everything else happens once per
 * tap and has to arrive exactly once.
 */
const CONTINUOUS_COMMANDS: ReadonlySet<CompanionCommand["type"]> = new Set([
	"setBrushSize",
	"setOpacity",
	"setStabilization",
	"setStrokeColor",
	"setFillColor",
	"setElementOpacity",
	"setLayerOpacity",
	"updateFilter",
]);

/**
 * Sends commands, thinning out the streams a drag produces without touching
 * anything else.
 *
 * The thinning is per command type, and per layer or filter for the ones that
 * name one: a throttle only remembers the last thing it was asked to send, so a
 * shared one would let a colour drag eat the size the finger set a moment
 * earlier.
 *
 * A tap flushes whatever a drag left pending before it goes. Otherwise an undo
 * landing between a drag's last two frames would be undoing a value the host
 * has not been told about yet.
 */
function createCommandSender(getChannel: () => CompanionChannel | null): {
	(command: CompanionCommand): void;
	dispose(): void;
} {
	const send = (command: CompanionCommand) => {
		getChannel()?.send({ type: "command", command });
	};
	const pending = new Map<string, ReturnType<typeof throttle<typeof send>>>();

	const sender = (command: CompanionCommand) => {
		if (!CONTINUOUS_COMMANDS.has(command.type)) {
			for (const throttled of pending.values()) throttled.flush();
			send(command);
			return;
		}

		const key = [
			command.type,
			...("layerId" in command ? [command.layerId] : []),
			// Each filter's sliders get their own throttle, or dragging one
			// would swallow the value a neighbouring filter set a frame earlier.
			...("filterUid" in command ? [command.filterUid] : []),
		].join(":");
		let throttled = pending.get(key);
		if (!throttled) {
			throttled = throttle(send, COMMAND_INTERVAL_MS, {
				edges: ["leading", "trailing"],
			});
			pending.set(key, throttled);
		}
		throttled(command);
	};

	sender.dispose = () => {
		// What a drag last set still matters once the panel is closing; what it
		// was passing through on the way there does not.
		for (const throttled of pending.values()) throttled.flush();
		pending.clear();
	};

	return sender;
}

/**
 * How long a field stays the companion's to decide after it changed one.
 *
 * The host answers a command with its whole state, and the answers to the
 * commands before it are still on their way — applied as they land, the slider
 * would be dragged back to where it was a moment ago on every frame.
 */
const LOCAL_CHANGE_HOLD_MS = 700;

/** Fields each command claims, so an echo cannot walk them back. */
const FIELDS_BY_COMMAND: Record<
	CompanionCommand["type"],
	readonly (keyof CompanionState)[]
> = {
	setTool: ["currentTool"],
	applyBrushPreset: ["selectedPresetUid"],
	setBrushSize: ["brushSize"],
	setOpacity: ["opacity"],
	setStabilization: ["stabilization"],
	setStrokeColor: ["strokeColor"],
	setFillColor: ["fillColor"],
	swapColors: ["strokeColor", "fillColor"],
	setElementOpacity: ["selection"],
	setElementBlendMode: ["selection"],
	setElementCompositionMode: ["selection"],
	selectLayer: ["currentLayerId"],
	selectElement: ["layers", "selection"],
	setElementVisible: ["layers"],
	// Nothing is claimed: the new filter's uid is the host's to invent, so
	// there is no local guess for an echo to walk back.
	addFilter: [],
	updateFilter: ["selection"],
	removeFilter: ["selection"],
	moveFilter: ["selection"],
	moveLayer: ["layers"],
	setLayerVisible: ["layers"],
	setLayerLocked: ["layers"],
	setLayerOpacity: ["layers"],
	setLayerBlendMode: ["layers"],
	undo: [],
	redo: [],
};

/**
 * Takes the host's state, but leaves whatever this device has just changed
 * alone until the host has had time to catch up with it.
 */
function reconcile(
	current: CompanionState | null,
	incoming: CompanionState,
	changedAtRef: React.RefObject<Partial<Record<keyof CompanionState, number>>>,
): CompanionState {
	if (!current) return incoming;

	const now = Date.now();
	const merged = { ...incoming };
	for (const [field, changedAt] of Object.entries(changedAtRef.current)) {
		if (now - changedAt > LOCAL_CHANGE_HOLD_MS) continue;
		Object.assign(merged, { [field]: current[field as keyof CompanionState] });
	}
	return merged;
}

/**
 * The companion's guess at what the command will do. The host's next state
 * overwrites it, so a wrong guess corrects itself rather than sticking.
 */
function applyLocally(
	state: CompanionState,
	command: CompanionCommand,
): CompanionState {
	switch (command.type) {
		case "setTool":
			return { ...state, currentTool: command.tool };
		case "applyBrushPreset":
			return { ...state, selectedPresetUid: command.presetUid };
		case "setBrushSize":
			return { ...state, brushSize: command.size };
		case "setOpacity":
			return { ...state, opacity: command.value };
		case "setStabilization":
			return { ...state, stabilization: command.value };
		case "setStrokeColor":
			return { ...state, strokeColor: command.color };
		case "setFillColor":
			return { ...state, fillColor: command.color };
		case "swapColors":
			// The two slots do not hold the same kinds of paint, so what the host
			// makes of the swap is its own business. The next state says.
			return state;
		case "setElementOpacity":
			return patchSelection(state, { opacity: command.value });
		case "setElementBlendMode":
			return patchSelection(state, { blendMode: command.blendMode });
		case "setElementCompositionMode":
			return patchSelection(state, {
				compositionMode: command.compositionMode,
			});
		case "selectLayer":
			return { ...state, currentLayerId: command.layerId };
		// Only the highlight moves. What the new selection's appearance and
		// filters are cannot be worked out from a list entry, so `selection` is
		// left showing the old object until the host's next state replaces it.
		case "selectElement":
			return {
				...state,
				layers: state.layers.map((layer) => ({
					...layer,
					elements: layer.elements.map((element) => ({
						...element,
						selected: element.id === command.elementId,
					})),
				})),
			};
		case "setElementVisible":
			return patchElement(state, command.layerId, command.elementId, {
				visible: command.visible,
			});
		// The uid the host will give it is unknowable here, and a filter row
		// without one cannot be updated or removed. Wait for the real thing.
		case "addFilter":
			return state;
		case "updateFilter":
			return patchFilter(state, command.filterUid, (filter) => ({
				...filter,
				...(command.enabled !== undefined
					? { enabled: command.enabled }
					: null),
				paramData: command.params
					? mergeParams(filter.paramData, command.params)
					: filter.paramData,
			}));
		case "removeFilter":
			if (!state.selection) return state;
			return {
				...state,
				selection: {
					...state.selection,
					filters: state.selection.filters.filter(
						(filter) => filter.uid !== command.filterUid,
					),
				},
			};
		case "moveFilter": {
			if (!state.selection) return state;

			const filters = moveItem(
				state.selection.filters,
				state.selection.filters.findIndex(
					(filter) => filter.uid === command.filterUid,
				),
				command.toIndex,
			);
			return { ...state, selection: { ...state.selection, filters } };
		}
		// `state.layers` is exactly the index space the command speaks in: the
		// host leaves its transient layers out of the list it sends, and maps the
		// destination back to a document index on its own side.
		case "moveLayer":
			return {
				...state,
				layers: moveItem(
					state.layers,
					state.layers.findIndex((layer) => layer.id === command.layerId),
					command.toIndex,
				),
			};
		case "setLayerVisible":
			return patchLayer(state, command.layerId, { visible: command.visible });
		case "setLayerLocked":
			return patchLayer(state, command.layerId, { locked: command.locked });
		case "setLayerOpacity":
			return patchLayer(state, command.layerId, { opacity: command.value });
		case "setLayerBlendMode":
			return patchLayer(state, command.layerId, {
				blendMode: command.blendMode,
			});
		case "undo":
		case "redo":
			// What these change is the document, which the companion never shows.
			return state;
	}
}

/**
 * The list with the item at `from` taken out and put back down at `to`, or the
 * same list when there is nothing to move. `to` is brought into range rather
 * than refused: a drop past the end of the list means the end of the list.
 */
function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
	const moved = [...items];
	if (from < 0 || from >= items.length) return moved;

	const target = Math.min(Math.max(to, 0), items.length - 1);
	if (from === target) return moved;

	const [item] = moved.splice(from, 1);
	moved.splice(target, 0, item);
	return moved;
}

function patchSelection(
	state: CompanionState,
	patch: Partial<NonNullable<CompanionState["selection"]>>,
): CompanionState {
	if (!state.selection) return state;
	return { ...state, selection: { ...state.selection, ...patch } };
}

function patchLayer(
	state: CompanionState,
	layerId: string,
	patch: Partial<CompanionState["layers"][number]>,
): CompanionState {
	return {
		...state,
		layers: state.layers.map((layer) =>
			layer.id === layerId ? { ...layer, ...patch } : layer,
		),
	};
}

function patchElement(
	state: CompanionState,
	layerId: string,
	elementId: string,
	patch: Partial<CompanionState["layers"][number]["elements"][number]>,
): CompanionState {
	return {
		...state,
		layers: state.layers.map((layer) =>
			layer.id === layerId
				? {
						...layer,
						elements: layer.elements.map((element) =>
							element.id === elementId ? { ...element, ...patch } : element,
						),
					}
				: layer,
		),
	};
}

function patchFilter(
	state: CompanionState,
	filterUid: string,
	patch: (filter: CompanionFilter) => CompanionFilter,
): CompanionState {
	if (!state.selection) return state;
	return {
		...state,
		selection: {
			...state.selection,
			filters: state.selection.filters.map((filter) =>
				filter.uid === filterUid ? patch(filter) : filter,
			),
		},
	};
}

/**
 * Puts the changed values where the processor's own parameters live, one level
 * inside paramData. Merged rather than replaced: a command carries only the
 * control that moved, and the rest of the filter's settings sit alongside it.
 */
function mergeParams(
	paramData: CompanionFilter["paramData"],
	params: Record<string, unknown>,
): CompanionFilter["paramData"] {
	const current = paramData.params;
	return {
		...paramData,
		params: {
			...(typeof current === "object" && current !== null ? current : null),
			...params,
		},
	};
}

/**
 * Keeps the screen on while the device is acting as a remote. A controller
 * that dims out after half a minute of watching the canvas is not one you can
 * reach for. Best effort: browsers without the API, and refusals, are ignored.
 */
function useScreenWakeLock(active: boolean): void {
	useEffect(() => {
		if (!active) return;
		if (!("wakeLock" in navigator)) return;

		let sentinel: WakeLockSentinel | null = null;
		let released = false;

		const acquire = async () => {
			try {
				sentinel = await navigator.wakeLock.request("screen");
				if (released) void sentinel.release();
			} catch {
				// Denied, or the tab was hidden when we asked. Nothing to recover.
			}
		};
		void acquire();

		// A wake lock is dropped whenever the tab goes to the background, so
		// coming back needs a fresh one.
		const handleVisibilityChange = () => {
			if (document.visibilityState !== "visible") return;
			void acquire();
		};
		document.addEventListener("visibilitychange", handleVisibilityChange);

		return () => {
			released = true;
			document.removeEventListener("visibilitychange", handleVisibilityChange);
			void sentinel?.release();
		};
	}, [active]);
}
