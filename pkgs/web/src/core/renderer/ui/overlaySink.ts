import { ref } from "valtio";
import type { UIOverlayState } from "../types";
import { buildArtboardOverlay } from "./builders/artboard";
import { buildSelectionOverlay } from "./builders/selection";
import {
	buildFontMissingOutlines,
	buildTextOverflowBadges,
	type TextOverflowBadgeData,
	type WorldBounds,
} from "./builders/text";
import { OVERLAY_KEYS, type OverlayKey } from "./overlayKeys";
import type { UIOverlay } from "./primitives";
import { OVERLAY_Z, UI_THEME } from "./theme";
import type { ArtboardSelectionUIData, SelectionUIData } from "./types";

/**
 * Producer-side sink for the generic overlay channel
 * (`UIOverlayState.overlays`). Engine-level producers spread across several
 * classes (Paplico, PaplicoSelection, PaplicoCommands, DocumentChangeSubscriber,
 * PaplicoPatternEdit) share these module functions instead of each wiring a
 * callback back to the Paplico facade.
 */

/** Set or remove (null) a generic overlay channel entry (`overlays[key]`). */
export function setOverlayEntry(
	uiState: UIOverlayState,
	key: OverlayKey,
	overlay: UIOverlay | null,
): void {
	uiState.overlays ??= {};
	const overlays = uiState.overlays;
	if (!overlay) {
		delete overlays[key];
		return;
	}
	// ref(): the overlay is an immutable snapshot, not reactive state.
	// Dev builds freeze it so in-place mutation throws immediately.
	overlays[key] = ref(
		process.env.NODE_ENV !== "production"
			? deepFreezeOverlay(overlay)
			: overlay,
	);
}

/** Element-selection overlay (selection box, handles, path outlines). */
export function setSelectionOverlay(
	uiState: UIOverlayState,
	ui: SelectionUIData | null,
): void {
	setOverlayEntry(
		uiState,
		OVERLAY_KEYS.sysSelection,
		ui
			? {
					zIndex: OVERLAY_Z.selection,
					primitives: buildSelectionOverlay(ui, UI_THEME),
				}
			: null,
	);
}

/**
 * Selected-artboard overlay (bounds + resize handles only). The per-artboard
 * frames in edit mode are system-driven inside UILayer (document artboards +
 * `isArtboardEditMode`), not part of this overlay.
 */
export function setArtboardSelectionOverlay(
	uiState: UIOverlayState,
	ui: ArtboardSelectionUIData | null,
): void {
	setOverlayEntry(
		uiState,
		OVERLAY_KEYS.sysArtboardSelection,
		ui
			? {
					zIndex: OVERLAY_Z.artboard,
					primitives: buildArtboardOverlay([], ui, UI_THEME),
				}
			: null,
	);
}

/**
 * Red "…" overflow badges for text regions whose content does not fit.
 * Pass null (or an empty list) to clear.
 */
export function setTextOverflowOverlay(
	uiState: UIOverlayState,
	badges: readonly TextOverflowBadgeData[] | null,
): void {
	setOverlayEntry(
		uiState,
		OVERLAY_KEYS.sysTextOverflow,
		badges && badges.length > 0
			? {
					zIndex: OVERLAY_Z.textOverflow,
					primitives: buildTextOverflowBadges(badges, UI_THEME),
				}
			: null,
	);
}

/**
 * Red outlines around text elements whose font could not be resolved (shown
 * only while the text tool is active). Pass null (or an empty list) to clear.
 */
export function setFontMissingOverlay(
	uiState: UIOverlayState,
	bounds: readonly WorldBounds[] | null,
): void {
	setOverlayEntry(
		uiState,
		OVERLAY_KEYS.sysFontMissing,
		bounds && bounds.length > 0
			? {
					zIndex: OVERLAY_Z.textOverflow,
					primitives: buildFontMissingOutlines(bounds, UI_THEME),
				}
			: null,
	);
}

/**
 * Dev-only guard for the generic overlay channel contract: stored overlays
 * are immutable snapshots, so freeze them (recursively) to make in-place
 * mutation throw instead of silently skipping re-renders.
 */
function deepFreezeOverlay(overlay: UIOverlay): UIOverlay {
	deepFreeze(overlay);
	return overlay;
}

function deepFreeze(value: unknown): void {
	if (value == null || typeof value !== "object") return;
	if (!Object.isFrozen(value)) Object.freeze(value);
	for (const child of Object.values(value)) {
		deepFreeze(child);
	}
}
