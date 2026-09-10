/**
 * What a companion device and its host say to each other.
 *
 * The companion holds no document — it only reads back what the host's tools
 * are set to and asks for changes. That keeps the traffic to a few hundred
 * bytes a message, which is what makes running this over a phone connection
 * reasonable at all.
 *
 * Messages are JSON rather than the packed binary the document protocol uses:
 * nothing here is sent per frame, and being able to read a payload while
 * debugging is worth more than the bytes saved.
 */

import type {
	BlendMode,
	Color,
	CompositionMode,
	FillColor,
	StrokeColor,
} from "@/core/schema";
import type { ToolType } from "@/core/tools/toolSettings";

/** What the companion shows. Pushed by the host whenever its tools change. */
export type CompanionState = {
	currentTool: ToolType;
	/**
	 * Carried whole rather than reduced to a plain colour: "none" and "a
	 * gradient" are things the host can be set to, and a remote that could only
	 * report a plain colour could never put either back.
	 */
	strokeColor: StrokeColor | null;
	fillColor: FillColor | null;
	brushSize: number;
	opacity: number;
	stabilization: number;
	presets: CompanionBrushPreset[];
	selectedPresetUid: string | null;
	canUndo: boolean;
	canRedo: boolean;
	/** The host's own language, so the remote reads as the app it is driving. */
	language: CompanionLanguage;
	/** Null when nothing is selected, so the panel can say so rather than lie. */
	selection: CompanionSelection | null;
	layers: CompanionLayer[];
	currentLayerId: string | null;
};

/**
 * The selection as far as a remote needs it. Only the first object's appearance
 * is reported: with several selected the panel writes to all of them, and the
 * first is what the host's own appearance panel shows too.
 */
type CompanionSelection = {
	count: number;
	opacity: number;
	blendMode: BlendMode;
	compositionMode: CompositionMode;
	filters: CompanionFilter[];
};

/**
 * A filter on the selected object, as far as a remote needs it.
 *
 * paramData is carried whole and never looked into: what belongs in it is
 * decided by the processor, and only the host knows the shape. A validator that
 * guessed at it would reject a filter it simply does not know about, and with
 * it the whole state the panel was about to draw.
 */
export type CompanionFilter = {
	uid: string;
	processor: string;
	enabled: boolean;
	opacity: number;
	blendMode: BlendMode;
	paramData: Record<string, unknown>;
};

type CompanionLanguage = "ja" | "en";

export type CompanionLayer = {
	id: string;
	name: string;
	visible: boolean;
	locked: boolean;
	opacity: number;
	blendMode: BlendMode;
	/** Top-level elements of the layer, in display order. */
	elements: CompanionElement[];
};

/** One entry in the layer's element list. */
export type CompanionElement = {
	id: string;
	/** Null when the user has not named it; the panel shows the type instead. */
	name: string | null;
	type: string;
	visible: boolean;
	selected: boolean;
};

/**
 * Only what a chip needs to render. Preview images stay on the host — they are
 * megabytes, and the companion has nothing to draw them into.
 */
type CompanionBrushPreset = {
	uid: string;
	name: string;
	/** Ships with the app, as opposed to one the user saved. The panel shelves
	 *  the two apart, the same way the host's own brush panel does. */
	builtin: boolean;
};

export type CompanionCommand =
	| { type: "setTool"; tool: ToolType }
	| { type: "applyBrushPreset"; presetUid: string }
	| { type: "setBrushSize"; size: number }
	| { type: "setOpacity"; value: number }
	| { type: "setStabilization"; value: number }
	| { type: "setStrokeColor"; color: StrokeColor | null }
	| { type: "setFillColor"; color: FillColor | null }
	| { type: "swapColors" }
	| { type: "setElementOpacity"; value: number }
	| { type: "setElementBlendMode"; blendMode: BlendMode }
	| { type: "setElementCompositionMode"; compositionMode: CompositionMode }
	| { type: "selectLayer"; layerId: string }
	| { type: "selectElement"; elementId: string }
	| {
			type: "setElementVisible";
			layerId: string;
			elementId: string;
			visible: boolean;
	  }
	| { type: "addFilter"; processor: string }
	| {
			type: "updateFilter";
			filterUid: string;
			enabled?: boolean;
			params?: Record<string, unknown>;
	  }
	| { type: "removeFilter"; filterUid: string }
	/**
	 * A destination, not a step: a row dropped after a drag lands an arbitrary
	 * distance from where it was picked up.
	 *
	 * toIndex is a position in the ARRAY the host holds — the order the filters
	 * are applied in — not the reversed order a panel displays. The panel that
	 * reverses for display converts before sending, so the two ends never argue
	 * about which way "up" points.
	 */
	| { type: "moveFilter"; filterUid: string; toIndex: number }
	/**
	 * toIndex is a position in `CompanionState.layers` — document order with the
	 * session's transient layers left out — and NOT a document layer index. The
	 * host maps it back before reordering; a mismatch here would move the wrong
	 * layer with nothing on either end looking wrong.
	 */
	| { type: "moveLayer"; layerId: string; toIndex: number }
	| { type: "setLayerVisible"; layerId: string; visible: boolean }
	| { type: "setLayerLocked"; layerId: string; locked: boolean }
	| { type: "setLayerOpacity"; layerId: string; value: number }
	| { type: "setLayerBlendMode"; layerId: string; blendMode: BlendMode }
	| { type: "undo" }
	| { type: "redo" };

export type CompanionMessage =
	/** Companion → host. Announces arrival and asks for the current state. */
	| { type: "hello" }
	/** Host → companion. */
	| { type: "state"; state: CompanionState }
	/** Companion → host. */
	| { type: "command"; command: CompanionCommand }
	/** Host → companion. The host is done; nothing more will arrive. */
	| { type: "ended" };

const BLEND_MODES: ReadonlySet<string> = new Set(
	Object.keys({
		normal: true,
		multiply: true,
		screen: true,
		overlay: true,
		darken: true,
		lighten: true,
		"color-dodge": true,
		"color-burn": true,
		"hard-light": true,
		"soft-light": true,
		difference: true,
		exclusion: true,
	} satisfies Record<BlendMode, true>),
);

const COMPOSITION_MODES: ReadonlySet<string> = new Set(
	Object.keys({
		normal: true,
		"alpha-lock": true,
	} satisfies Record<CompositionMode, true>),
);

/**
 * Written as a record so that adding a tool to ToolType fails to compile here
 * rather than at a companion's screen: a tool this does not know turns the
 * host's whole state into something the companion drops, and it freezes with
 * no sign of why.
 */
const TOOL_TYPES: ReadonlySet<string> = new Set(
	Object.keys({
		pen: true,
		eraser: true,
		select: true,
		"path-edit": true,
		path: true,
		artboard: true,
		shape: true,
		text: true,
		gradient: true,
		"mesh-deform": true,
		skew: true,
		"free-transform": true,
		"bucket-fill": true,
		"stroke-width-edit": true,
		eyedropper: true,
		reference3d: true,
	} satisfies Record<ToolType, true>),
);

/**
 * The relay room companion traffic runs in.
 *
 * A device already in an encrypted session reuses that session's room key, so
 * without a separate room its commands would land in the same stream as the
 * document and every peer would have to sift them apart. Deriving the room
 * keeps the two apart at the relay, before either side sees a byte.
 */
export function companionRelayRoom(roomId: string): string {
	return `${roomId}~c`;
}

export function encodeCompanionMessage(
	message: CompanionMessage,
): Uint8Array<ArrayBuffer> {
	return new TextEncoder().encode(JSON.stringify(message));
}

/**
 * Returns null for anything that is not a message we recognise. The relay is
 * open to whoever knows the room, so a payload that fails to parse is an
 * expected outcome rather than an error worth throwing over.
 *
 * The body is checked, not just the kind. A message that names itself a command
 * and carries nothing would otherwise reach the code that acts on it and throw
 * there, which is far from here and much harder to recover from — a peer
 * running a different version of Paplico is enough to produce one.
 */
export function decodeCompanionMessage(
	payload: Uint8Array,
): CompanionMessage | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder().decode(payload));
	} catch {
		return null;
	}

	if (!isRecord(parsed)) return null;

	switch (parsed.type) {
		case "hello":
		case "ended":
			return { type: parsed.type };
		case "command":
			return isCompanionCommand(parsed.command)
				? { type: "command", command: parsed.command }
				: null;
		case "state":
			return isCompanionState(parsed.state)
				? { type: "state", state: parsed.state }
				: null;
		default:
			return null;
	}
}

function isCompanionCommand(value: unknown): value is CompanionCommand {
	if (!isRecord(value)) return false;

	switch (value.type) {
		case "setTool":
			return typeof value.tool === "string" && TOOL_TYPES.has(value.tool);
		case "applyBrushPreset":
			return typeof value.presetUid === "string";
		case "setBrushSize":
			return isFiniteNumber(value.size);
		case "setOpacity":
		case "setStabilization":
			return isFiniteNumber(value.value);
		case "setStrokeColor":
		case "setFillColor":
			return value.color === null || isPaint(value.color);
		case "setElementOpacity":
		case "setLayerOpacity":
			return isFiniteNumber(value.value) && isLayerTarget(value);
		case "setElementBlendMode":
		case "setLayerBlendMode":
			return (
				typeof value.blendMode === "string" &&
				BLEND_MODES.has(value.blendMode) &&
				isLayerTarget(value)
			);
		case "setElementCompositionMode":
			return (
				typeof value.compositionMode === "string" &&
				COMPOSITION_MODES.has(value.compositionMode)
			);
		case "selectLayer":
			return typeof value.layerId === "string";
		case "selectElement":
			return typeof value.elementId === "string";
		// Names both the layer and the element, so isLayerTarget — which only asks
		// after a layerId for the setLayer* family — cannot speak for it.
		case "setElementVisible":
			return (
				typeof value.layerId === "string" &&
				typeof value.elementId === "string" &&
				typeof value.visible === "boolean"
			);
		case "addFilter":
			return typeof value.processor === "string";
		case "updateFilter":
			return (
				typeof value.filterUid === "string" &&
				(value.enabled === undefined || typeof value.enabled === "boolean") &&
				(value.params === undefined || isRecord(value.params))
			);
		case "removeFilter":
			return typeof value.filterUid === "string";
		case "moveFilter":
			return typeof value.filterUid === "string" && isListIndex(value.toIndex);
		case "moveLayer":
			return typeof value.layerId === "string" && isListIndex(value.toIndex);
		case "setLayerVisible":
		case "setLayerLocked":
			return (
				typeof value.layerId === "string" &&
				typeof (value.visible ?? value.locked) === "boolean"
			);
		case "swapColors":
		case "undo":
		case "redo":
			return true;
		default:
			return false;
	}
}

function isCompanionState(value: unknown): value is CompanionState {
	if (!isRecord(value)) return false;

	return (
		typeof value.currentTool === "string" &&
		TOOL_TYPES.has(value.currentTool) &&
		(value.strokeColor === null || isPaint(value.strokeColor)) &&
		(value.fillColor === null || isPaint(value.fillColor)) &&
		isFiniteNumber(value.brushSize) &&
		isFiniteNumber(value.opacity) &&
		isFiniteNumber(value.stabilization) &&
		Array.isArray(value.presets) &&
		value.presets.every(isCompanionBrushPreset) &&
		(value.selectedPresetUid === null ||
			typeof value.selectedPresetUid === "string") &&
		typeof value.canUndo === "boolean" &&
		typeof value.canRedo === "boolean" &&
		(value.language === "ja" || value.language === "en") &&
		(value.selection === null || isCompanionSelection(value.selection)) &&
		Array.isArray(value.layers) &&
		value.layers.every(isCompanionLayer) &&
		(value.currentLayerId === null || typeof value.currentLayerId === "string")
	);
}

function isCompanionSelection(value: unknown): value is CompanionSelection {
	return (
		isRecord(value) &&
		isFiniteNumber(value.count) &&
		isFiniteNumber(value.opacity) &&
		typeof value.blendMode === "string" &&
		BLEND_MODES.has(value.blendMode) &&
		typeof value.compositionMode === "string" &&
		COMPOSITION_MODES.has(value.compositionMode) &&
		Array.isArray(value.filters) &&
		value.filters.every(isCompanionFilter)
	);
}

function isCompanionFilter(value: unknown): value is CompanionFilter {
	return (
		isRecord(value) &&
		typeof value.uid === "string" &&
		typeof value.processor === "string" &&
		typeof value.enabled === "boolean" &&
		isFiniteNumber(value.opacity) &&
		typeof value.blendMode === "string" &&
		BLEND_MODES.has(value.blendMode) &&
		// Only that it is a record: see CompanionFilter on why the inside of
		// paramData is left alone.
		isRecord(value.paramData)
	);
}

function isCompanionLayer(value: unknown): value is CompanionLayer {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		typeof value.name === "string" &&
		typeof value.visible === "boolean" &&
		typeof value.locked === "boolean" &&
		isFiniteNumber(value.opacity) &&
		typeof value.blendMode === "string" &&
		BLEND_MODES.has(value.blendMode) &&
		Array.isArray(value.elements) &&
		value.elements.every(isCompanionElement)
	);
}

function isCompanionElement(value: unknown): value is CompanionElement {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		(value.name === null || typeof value.name === "string") &&
		typeof value.type === "string" &&
		typeof value.visible === "boolean" &&
		typeof value.selected === "boolean"
	);
}

/** Layer commands name their target; the element ones act on the selection. */
function isLayerTarget(value: Record<string, unknown>): boolean {
	return (
		typeof value.type === "string" &&
		(!value.type.startsWith("setLayer") || typeof value.layerId === "string")
	);
}

function isCompanionBrushPreset(value: unknown): value is CompanionBrushPreset {
	return (
		isRecord(value) &&
		typeof value.uid === "string" &&
		typeof value.name === "string" &&
		typeof value.builtin === "boolean"
	);
}

/**
 * Anything the host can have in a stroke or fill slot.
 *
 * Only the kinds this panel can edit are looked into. The rest — patterns,
 * free and mesh gradients — are still carried and still shown as "not from
 * here", and rejecting them would drop the whole state along with them.
 */
function isPaint(value: unknown): value is StrokeColor | FillColor {
	if (!isRecord(value)) return false;

	switch (value.type) {
		case "solid":
			return isColor(value.color);
		case "linear":
		case "radial":
			return Array.isArray(value.stops) && value.stops.every(isColorStop);
		case "stroke-gradient":
			return isPaint(value.gradient);
		case "free":
		case "mesh":
		case "pattern":
		case "stroke-pattern":
			return true;
		default:
			return false;
	}
}

function isColorStop(value: unknown): boolean {
	return (
		isRecord(value) && isFiniteNumber(value.offset) && isColor(value.color)
	);
}

function isColor(value: unknown): value is Color {
	if (!isRecord(value)) return false;
	if (!isFiniteNumber(value.a)) return false;

	return value.type === "rgb"
		? isFiniteNumber(value.r) &&
				isFiniteNumber(value.g) &&
				isFiniteNumber(value.b)
		: value.type === "hsv" &&
				isFiniteNumber(value.h) &&
				isFiniteNumber(value.s) &&
				isFiniteNumber(value.v);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * A place in a list: whole and not before the start. The far end is left to the
 * host, which is the only side that knows how long the list is by the time the
 * command lands.
 */
function isListIndex(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}
