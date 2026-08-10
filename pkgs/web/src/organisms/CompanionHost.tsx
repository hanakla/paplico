"use client";

import { throttle } from "es-toolkit";
import { memo, useEffect, useMemo, useRef } from "react";
import { proxy, useSnapshot } from "valtio";
import { CompanionChannel } from "@/companion/CompanionChannel";
import type {
	CompanionCommand,
	CompanionState,
} from "@/companion/companionProtocol";
import { usePaplico, usePaplicoMaybe } from "@/contexts/PaplicoContext";
import { readStoredBrushSize } from "@/core/brush/access";
import { buildCompanionUrl } from "@/core/collaboration/inviteUrl";
import {
	exportRoomKey,
	generateRoomId,
	generateRoomKey,
} from "@/core/collaboration/roomCrypto";
import type { Paplico } from "@/core/Paplico";
import {
	DEFAULT_COMPOSITION_MODE,
	type FillColor,
	type StrokeColor,
} from "@/core/schema";
import { useFirstSelectedElement } from "@/hooks/paplico/useFirstSelectedElement";
import { useAppConfig } from "@/hooks/useAppConfig";
import { useBrushEdits } from "@/hooks/useBrushEdits";
import { useBrushPresets } from "@/hooks/useBrushPresets";
import { getEncryptedRoomCredentials, inviteOrigin } from "@/hooks/useCollab";
import { createDefaultFilter } from "@/organisms/FilterPanel/createDefaultFilter";
import { useUIState } from "@/stores/uiStore";
import { useEventCallback } from "@/utils/hooks";

/**
 * The ad-hoc session shown as a QR code, and how many companions are talking
 * to us. The dialog only reads and flips these; opening and closing the actual
 * channel is this component's job, so the dialog can be dismissed without
 * taking the session with it.
 */
export const companionHostState = proxy({
	/** True while a code should be on offer. */
	adhocRequested: false,
	/**
	 * The session as a link, which is both what the QR carries and what there is
	 * to pass along by hand. Set once the channel is up, so the dialog knows the
	 * code is real.
	 */
	adhocUrl: null as string | null,
	/**
	 * A companion has said hello and has not gone yet. The relay names nobody,
	 * so this cannot count them — with two companions and one leaving it reads
	 * as none until the other speaks again.
	 */
	companionPresent: false,
});

export function startCompanionSession(): void {
	companionHostState.adhocRequested = true;
}

export function stopCompanionSession(): void {
	companionHostState.adhocRequested = false;
}

/**
 * Answers companions on behalf of this device. Renders nothing.
 *
 * Two ways in are served alike: a code handed out from the menu, which gets a
 * room and key of its own, and — when this device is hosting an encrypted
 * session — the room that session already agreed on, so a tablet in it can
 * open the remote without scanning anything.
 */
export const CompanionHost = memo(function CompanionHost({
	isEncryptedRoom,
	isRoomOwner,
}: {
	isEncryptedRoom: boolean;
	isRoomOwner: boolean;
}) {
	const paplico = usePaplicoMaybe();
	const hostSnap = useSnapshot(companionHostState);

	// Only the owner is controllable: it is the device the others are drawing
	// on, and pointing a remote back at a guest would leave both ends waiting
	// for the other to be in charge.
	const serveEncryptedRoom = isEncryptedRoom && isRoomOwner;

	// Nothing is mounted until a companion could actually turn up. Reading the
	// brush presets pulls in effects that touch stored presets, and that has no
	// business running on a device nobody is remote-controlling.
	if (!paplico || (!hostSnap.adhocRequested && !serveEncryptedRoom)) {
		return null;
	}

	return (
		<CompanionHostInner
			paplico={paplico}
			serveEncryptedRoom={serveEncryptedRoom}
		/>
	);
});

const CompanionHostInner = memo(function CompanionHostInner({
	paplico,
	serveEncryptedRoom,
}: {
	paplico: Paplico;
	serveEncryptedRoom: boolean;
}) {
	const hostSnap = useSnapshot(companionHostState);
	const brushPresets = useBrushPresets();
	const state = useHostState(paplico, brushPresets);
	const applyCommand = useCommandApplier(brushPresets.applyBrushPreset);

	const channelsRef = useRef<CompanionChannel[]>([]);
	// Read when a hello arrives, which can be at any moment between renders.
	const stateRef = useRef(state);
	stateRef.current = state;

	const openChannel = useEventCallback(
		(roomId: string, roomKey: CryptoKey): CompanionChannel => {
			const channel = new CompanionChannel({ roomId, roomKey });

			channel.on("message", (message) => {
				if (message.type === "hello") {
					companionHostState.companionPresent = true;
					channel.send({ type: "state", state: stateRef.current });
				} else if (message.type === "command") {
					applyCommand(message.command);
				}
			});

			channel.on("peerLeft", () => {
				companionHostState.companionPresent = false;
			});

			channelsRef.current.push(channel);
			return channel;
		},
	);

	const closeChannel = useEventCallback((channel: CompanionChannel) => {
		channel.send({ type: "ended" });
		channelsRef.current = channelsRef.current.filter(
			(item) => item !== channel,
		);
		if (channelsRef.current.length === 0) {
			companionHostState.companionPresent = false;
		}
		void channel.destroyAfterFlush();
	});

	// The code handed out from the menu.
	// biome-ignore lint/correctness/useExhaustiveDependencies: useEventCallback keeps a stable reference
	useEffect(() => {
		if (!hostSnap.adhocRequested) return;

		let channel: CompanionChannel | null = null;
		let cancelled = false;

		const start = async () => {
			const roomId = generateRoomId();
			const roomKey = await generateRoomKey();
			if (cancelled) return;

			channel = openChannel(roomId, roomKey);
			const encodedKey = await exportRoomKey(roomKey);
			companionHostState.adhocUrl = buildCompanionUrl(inviteOrigin(), {
				roomId,
				encodedKey,
			});
		};
		void start();

		return () => {
			cancelled = true;
			companionHostState.adhocUrl = null;
			if (channel) closeChannel(channel);
		};
	}, [hostSnap.adhocRequested]);

	// The room an encrypted session already established. Kept open for as long
	// as the session lasts: a guest may open its remote at any time, and there
	// is no way to be told in advance.
	// biome-ignore lint/correctness/useExhaustiveDependencies: useEventCallback keeps a stable reference
	useEffect(() => {
		if (!serveEncryptedRoom) return;

		const credentials = getEncryptedRoomCredentials();
		if (!credentials) return;

		const channel = openChannel(credentials.roomId, credentials.roomKey);
		return () => closeChannel(channel);
	}, [serveEncryptedRoom]);

	// Every change on this device is pushed out, so the remote shows what is
	// actually set rather than what it last asked for — but dragging a slider
	// here changes it on every frame, and a remote has no use for sixty whole
	// states a second.
	//
	// Throttled rather than debounced: a debounce waits for the changes to stop,
	// so a slider held down here would leave the remote frozen for as long as
	// the drag lasted. The leading edge keeps it moving, the trailing one
	// carries where the drag ended.
	const pushState = useMemo(
		() =>
			throttle(
				(next: CompanionState) => {
					for (const channel of channelsRef.current) {
						channel.send({ type: "state", state: next });
					}
				},
				STATE_PUSH_INTERVAL_MS,
				{ edges: ["leading", "trailing"] },
			),
		[],
	);

	useEffect(() => {
		pushState(state);
	}, [state, pushState]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: the sender is created once
	useEffect(() => () => pushState.flush(), []);

	return null;
});

/** Quietest a stream of changes is worth reporting to a remote. */
const STATE_PUSH_INTERVAL_MS = 80;

type BrushPresetsApi = ReturnType<typeof useBrushPresets>;

/** What this device would tell a companion if asked right now. */
function useHostState(
	paplico: Paplico,
	{ builtinPresets, persistedPresets }: BrushPresetsApi,
): CompanionState {
	const toolSnap = useSnapshot(paplico.tools.state);
	const uiSnap = useSnapshot(paplico.uiState);
	const appUiSnap = useUIState();
	const selectedElement = useFirstSelectedElement(paplico.uiState);

	const selection = useMemo(
		() =>
			selectedElement
				? {
						count: uiSnap.selectedElementIds.length,
						opacity: selectedElement.opacity,
						blendMode: selectedElement.blendMode ?? "normal",
						compositionMode:
							selectedElement.compositionMode ?? DEFAULT_COMPOSITION_MODE,
						filters: (selectedElement.filters ?? []).map((filter) => ({
							uid: filter.uid,
							processor: filter.processor,
							// Absent means on, which is the host's own reading of it.
							enabled: filter.enabled !== false,
							opacity: filter.opacity,
							blendMode: filter.blendMode,
							// ParamData is `{ version, params }` — a record in all but name,
							// which is why the structural conversion needs spelling out.
							// The wire carries it whole because only the processor knows
							// what is inside.
							paramData: filter.paramData as unknown as Record<string, unknown>,
						})),
					}
				: null,
		[selectedElement, uiSnap.selectedElementIds.length],
	);

	const selectedElementIds = uiSnap.selectedElementIds;
	const objects = uiSnap.document.objects;

	const layers = useMemo(() => {
		const selectedIds = new Set(selectedElementIds);

		return (
			uiSnap.document.layers
				// Working surfaces of an editing session are not the user's layers.
				.filter((layer) => layer.transientKind == null)
				.map((layer) => ({
					id: layer.id,
					name: layer.name,
					visible: layer.visible,
					locked: layer.locked,
					opacity: layer.opacity,
					blendMode: layer.blendMode ?? "normal",
					elements: layer.elementIds.flatMap((elementId) => {
						const element = objects[elementId];
						// An id with nothing behind it is mid-edit bookkeeping, not
						// something a remote can be shown or asked to act on.
						if (!element) return [];

						return [
							{
								id: element.id,
								name: element.name ?? null,
								type: element.type,
								// Absent means visible, as everywhere else the flag is read.
								visible: element.visible !== false,
								selected: selectedIds.has(element.id),
							},
						];
					}),
				}))
		);
	}, [uiSnap.document.layers, objects, selectedElementIds]);

	const presets = useMemo(
		() => [
			...builtinPresets.map(({ uid, name }) => ({ uid, name, builtin: true })),
			...persistedPresets.map(({ uid, name }) => ({
				uid,
				name,
				builtin: false,
			})),
		],
		[builtinPresets, persistedPresets],
	);

	const strokeColor = toolSnap.strokeAppearance?.paramData.params.strokeColor;
	const fillColor = toolSnap.fillAppearance?.paramData.params.fill;
	const language = useAppConfig().language;
	const brushSize =
		readStoredBrushSize(
			toolSnap.strokeAppearance?.paramData.params.brushSettings,
		) ?? 2;

	return useMemo(
		() => ({
			currentTool: toolSnap.currentTool,
			strokeColor: (strokeColor as StrokeColor | undefined) ?? null,
			fillColor: (fillColor as FillColor | undefined) ?? null,
			brushSize,
			opacity: toolSnap.opacity,
			stabilization: toolSnap.stabilization,
			presets,
			selectedPresetUid: appUiSnap.selectedBrushPresetUid,
			canUndo: uiSnap.canUndo,
			canRedo: uiSnap.canRedo,
			language,
			selection,
			layers,
			currentLayerId: uiSnap.currentLayerId,
		}),
		[
			toolSnap.currentTool,
			toolSnap.opacity,
			toolSnap.stabilization,
			brushSize,
			strokeColor,
			fillColor,
			presets,
			appUiSnap.selectedBrushPresetUid,
			uiSnap.canUndo,
			uiSnap.canRedo,
			language,
			uiSnap.currentLayerId,
			selection,
			layers,
		],
	);
}

/**
 * Routes a command through the same calls the local UI makes, so a change made
 * from a phone lands exactly where the same change made by hand would.
 */
function useCommandApplier(
	applyBrushPreset: BrushPresetsApi["applyBrushPreset"],
): (command: CompanionCommand) => void {
	const { tools, commands, uiState, selection } = usePaplico();
	const brushEdits = useBrushEdits();

	return useEventCallback((command: CompanionCommand) => {
		switch (command.type) {
			case "setTool":
				tools.setCurrentTool(command.tool);
				break;

			case "applyBrushPreset":
				void applyBrushPreset(command.presetUid);
				break;

			case "setBrushSize":
				brushEdits.setBrushSize(command.size);
				break;

			case "setOpacity":
				brushEdits.setOpacity(command.value);
				break;

			case "setStabilization":
				tools.setStabilization(command.value);
				break;

			// Colours carry onto the selection the same way they do when picked
			// here, which is what the local picker does in useActiveColors.
			case "setStrokeColor":
				tools.setStrokeColor(command.color);
				if (uiState.selectedElementIds.length > 0) {
					commands.updateSelectedElementsStrokeColor(command.color);
				}
				break;

			case "setFillColor":
				tools.setFillColor(command.color);
				if (uiState.selectedElementIds.length > 0) {
					commands.updateSelectedElementsFill(command.color);
				}
				break;

			case "swapColors":
				tools.swapColors();
				break;

			// The whole selection follows, where the state only reports the first:
			// several objects selected is still one gesture on the remote.
			case "setElementOpacity":
				commands.batchUpdateElements(
					uiState.selectedElementIds.map((elementId) => ({
						elementId,
						updates: { opacity: command.value },
					})),
				);
				break;

			case "setElementBlendMode":
				commands.batchUpdateElements(
					uiState.selectedElementIds.map((elementId) => ({
						elementId,
						updates: { blendMode: command.blendMode },
					})),
				);
				break;

			case "setElementCompositionMode":
				commands.batchUpdateElements(
					uiState.selectedElementIds.map((elementId) => ({
						elementId,
						updates: { compositionMode: command.compositionMode },
					})),
				);
				break;

			case "selectLayer":
				selection.setCurrentLayer(command.layerId);
				break;

			case "selectElement":
				selection.selectElement(command.elementId);
				break;

			// The remote's checkbox states where it should end up, so the absolute
			// value is written rather than a toggle: a toggle sent twice by a flaky
			// link would land the element back where it started.
			case "setElementVisible":
				commands.updateElement(command.layerId, command.elementId, {
					visible: command.visible,
				});
				break;

			// Built from the same defaults the local Add Filter menu uses, so a
			// filter added from a phone is the filter added by hand.
			case "addFilter": {
				const filter = createDefaultFilter(command.processor);
				if (filter) commands.addFilterToSelectedElement(filter);
				break;
			}

			// Filters are named by uid on the wire because an index goes stale the
			// moment anything is added or reordered here, and the commands below
			// take an index — so it is resolved against the document as it is now.
			case "updateFilter": {
				const index = findFilterIndex(uiState, command.filterUid);
				if (index < 0) break;

				commands.updateFilterForSelectedElement(index, {
					// Only what the remote actually said: spelling out an absent
					// `enabled` would switch the filter off on a params-only change.
					...(command.enabled !== undefined
						? { enabled: command.enabled }
						: null),
					...(command.params ? { params: command.params } : null),
				});
				break;
			}

			case "removeFilter": {
				const index = findFilterIndex(uiState, command.filterUid);
				if (index >= 0) commands.removeFilterFromSelectedElement(index);
				break;
			}

			case "moveFilter": {
				const fromIndex = findFilterIndex(uiState, command.filterUid);
				if (fromIndex < 0) break;

				// The remote drew its destination against the list it last saw, which
				// may have lost filters since. Clamped rather than dropped: the end of
				// the list is where a drop past the end was aiming.
				const toIndex = clamp(
					command.toIndex,
					selectedElementFilters(uiState).length - 1,
				);
				if (fromIndex === toIndex) break;

				commands.reorderFilter(fromIndex, toIndex);
				break;
			}

			case "moveLayer": {
				// Companion indices count only the layers the remote was shown, and
				// that list leaves the session's transient layers out. Both ends of
				// the move are worked out in that space and then mapped back, so a
				// transient layer between them cannot shift the destination.
				const visibleLayers = uiState.document.layers.filter(
					(layer) => layer.transientKind == null,
				);
				const fromVisibleIndex = visibleLayers.findIndex(
					(layer) => layer.id === command.layerId,
				);
				if (fromVisibleIndex < 0) break;

				const toVisibleIndex = clamp(command.toIndex, visibleLayers.length - 1);
				if (fromVisibleIndex === toVisibleIndex) break;

				const documentIndexOf = (visibleIndex: number) =>
					uiState.document.layers.indexOf(visibleLayers[visibleIndex]);

				commands.reorderLayers(
					documentIndexOf(fromVisibleIndex),
					documentIndexOf(toVisibleIndex),
				);
				break;
			}

			case "setLayerVisible":
				commands.updateLayer(command.layerId, { visible: command.visible });
				break;

			case "setLayerLocked":
				commands.updateLayer(command.layerId, { locked: command.locked });
				break;

			case "setLayerOpacity":
				commands.updateLayerOpacity(command.layerId, command.value);
				break;

			case "setLayerBlendMode":
				commands.updateLayerBlendMode(command.layerId, command.blendMode);
				break;

			case "undo":
				commands.undo();
				break;

			case "redo":
				commands.redo();
				break;
		}
	});
}

/** A destination the remote drew against an older list, brought back in range. */
function clamp(index: number, maxIndex: number): number {
	return Math.min(Math.max(index, 0), maxIndex);
}

/**
 * Where the named filter sits on the first selected object, or -1 if it is not
 * there any more. The same object the filter commands write to, so the index
 * they are handed cannot point at a different one.
 */
function findFilterIndex(
	uiState: Paplico["uiState"],
	filterUid: string,
): number {
	return selectedElementFilters(uiState).findIndex((f) => f.uid === filterUid);
}

/** The filters the commands above write to, or none when nothing is selected. */
function selectedElementFilters(uiState: Paplico["uiState"]) {
	const elementId = uiState.selectedElementIds[0];
	if (!elementId) return [];

	return uiState.document.objects[elementId]?.filters ?? [];
}
