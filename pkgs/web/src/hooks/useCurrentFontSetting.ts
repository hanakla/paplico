import { useEffect, useMemo } from "react";
import { proxy, useSnapshot } from "valtio";
import { usePaplico } from "@/contexts/PaplicoContext";
import { type FontMetadata, getFontManager } from "@/core/index";
import type {
	FontSource,
	TextContent,
	TextElement,
	TextStyle,
} from "@/core/schema";
import { useSelectedElements } from "@/hooks/paplico/useSelectedElements";
import { buildFontSource } from "@/organisms/ActionsPanel/utils";
import { uiState } from "@/stores/uiStore";
import { useEventCallback } from "@/utils/hooks";

// ---------------------------------------------------------------------------
// Main hook: useActiveFontSettings
// ---------------------------------------------------------------------------

interface ActiveFontSettings {
	fonts: FontMetadata[];
	isLoading: boolean;
	currentFont: FontMetadata | undefined;
	currentFontSize: number;
	isMixed: boolean;
	isMixedSize: boolean;
	handleFontChange: (font: FontMetadata | null) => void;
	handleFontSizeChange: (size: number) => void;
}

export function useActiveFontSettings(): ActiveFontSettings {
	const paplico = usePaplico();
	const { tools, commands, uiState: store } = paplico;
	const toolSnap = useSnapshot(tools.state);
	const uiSnap = useSnapshot(uiState);
	const selectedElements = useSelectedElements(store);
	const { fonts, isLoading } = useFontList();

	const isTextEditing = uiSnap.textEditState.isEditing;

	// Get text elements from selection. Flow targets resolve to their chain
	// head — the head owns the rendered content and styles, so display and
	// writes must go through it (deduped when head + targets are co-selected)
	const textElements = useMemo(() => {
		const sources = selectedElements
			.filter((el): el is TextElement => el.type === "text")
			.map((el) => paplico.getTextStyleSource(el));
		return [...new Map(sources.map((el) => [el.id, el])).values()];
	}, [selectedElements, paplico]);

	// Resolve current font
	const currentFont = useMemo(() => {
		if (isTextEditing) {
			const ss = uiSnap.textEditState
				.selectionStyle as Partial<TextStyle> | null;
			return findMatchingFont(fonts, ss?.fontFamily, ss?.fontSource);
		}

		if (textElements.length > 0) {
			const families = textElements.map((el) => el.defaultStyle.fontFamily);
			if (new Set(families).size > 1) return undefined; // mixed
			const style = textElements[0].defaultStyle;
			return findMatchingFont(fonts, style.fontFamily, style.fontSource);
		}

		// Fallback to textDefaultStyle
		return findMatchingFont(
			fonts,
			toolSnap.textDefaultStyle.fontFamily,
			toolSnap.textDefaultStyle.fontSource as FontSource,
		);
	}, [
		fonts,
		textElements,
		isTextEditing,
		uiSnap.textEditState.selectionStyle,
		toolSnap.textDefaultStyle,
	]);

	// Resolve mixed state for font family
	const isMixed = useMemo(() => {
		if (isTextEditing) {
			const ss = uiSnap.textEditState
				.selectionStyle as Partial<TextStyle> | null;
			return (
				uiSnap.textEditState.hasSelection && ss != null && !("fontFamily" in ss)
			);
		}
		if (textElements.length <= 1) return false;
		const families = textElements.map((el) => el.defaultStyle.fontFamily);
		return new Set(families).size > 1;
	}, [
		textElements,
		isTextEditing,
		uiSnap.textEditState.selectionStyle,
		uiSnap.textEditState.hasSelection,
	]);

	// Resolve current font size (display/write both round to 3 decimals)
	const currentFontSize = useMemo(() => {
		if (isTextEditing) {
			const ss = uiSnap.textEditState
				.selectionStyle as Partial<TextStyle> | null;
			return roundFontSize(ss?.fontSize ?? toolSnap.textDefaultStyle.fontSize);
		}

		if (textElements.length > 0) {
			return roundFontSize(textElements[0].defaultStyle.fontSize);
		}

		return roundFontSize(toolSnap.textDefaultStyle.fontSize);
	}, [
		textElements,
		isTextEditing,
		uiSnap.textEditState.selectionStyle,
		toolSnap.textDefaultStyle,
	]);

	// Mixed state for font size
	const isMixedSize = useMemo(() => {
		if (isTextEditing) {
			const ss = uiSnap.textEditState
				.selectionStyle as Partial<TextStyle> | null;
			return (
				uiSnap.textEditState.hasSelection && ss != null && !("fontSize" in ss)
			);
		}
		if (textElements.length <= 1) return false;
		const sizes = textElements.map((el) => el.defaultStyle.fontSize);
		return new Set(sizes).size > 1;
	}, [
		textElements,
		isTextEditing,
		uiSnap.textEditState.selectionStyle,
		uiSnap.textEditState.hasSelection,
	]);

	// Sync selected TextElement settings to tool defaults
	useEffect(() => {
		if (textElements.length === 0 || isMixed) return;
		const el = textElements[0];
		Object.assign(tools.state.textDefaultStyle, el.defaultStyle);
		tools.state.textDefaultAlignment =
			el.content.paragraphs[0]?.alignment ?? "left";
		tools.state.textDefaultWritingMode = el.layout.writingMode;
		// biome-ignore lint/correctness/useExhaustiveDependencies: tools.state is a stable Valtio proxy ref; write targets would cause infinite loop
	}, [textElements, isMixed, tools.state]);

	// Handle font change
	const handleFontChange = useEventCallback(
		(selectedFont: FontMetadata | null) => {
			if (!selectedFont) return;

			const fontSource = buildFontSource(selectedFont);
			if (!fontSource) return;

			// Always update textDefaultStyle
			tools.state.textDefaultStyle.fontFamily = selectedFont.family;
			tools.state.textDefaultStyle.fontSource = fontSource;
			tools.state.textDefaultStyle.fontVariationSettings = {};

			if (isTextEditing) {
				const textTool = paplico.textToolController?.getTextTool();
				textTool?.changeSelectionFontFamily(selectedFont.family, fontSource);
				return;
			}

			const layerId = store.currentLayerId;
			if (!layerId) return;

			for (const el of textElements) {
				const updatedContent: TextContent = {
					...el.content,
					paragraphs: el.content.paragraphs.map((para) => ({
						...para,
						runs: para.runs.map((run) => ({
							...run,
							style: {
								...run.style,
								fontFamily: selectedFont.family,
								fontSource,
								fontVariationSettings: {},
							},
						})),
					})),
				};

				commands.updateElement(layerId, el.id, {
					defaultStyle: {
						...el.defaultStyle,
						fontFamily: selectedFont.family,
						fontSource,
						fontVariationSettings: {},
					},
					content: updatedContent,
				});
			}
		},
	);

	// Handle font size change
	const handleFontSizeChange = useEventCallback((rawSize: number) => {
		if (Number.isNaN(rawSize) || rawSize <= 0) return;
		const newSize = roundFontSize(rawSize);

		// Always update textDefaultStyle
		tools.state.textDefaultStyle.fontSize = newSize;

		if (isTextEditing) {
			const textTool = paplico.textToolController?.getTextTool();
			textTool?.changeSelectionFontSize(newSize);
			return;
		}

		const layerId = store.currentLayerId;
		if (!layerId) return;

		for (const el of textElements) {
			const updatedContent: TextContent = {
				...el.content,
				paragraphs: el.content.paragraphs.map((para) => ({
					...para,
					runs: para.runs.map((run) => ({
						...run,
						style: { ...run.style, fontSize: newSize },
					})),
				})),
			};

			commands.updateElement(layerId, el.id, {
				defaultStyle: {
					...el.defaultStyle,
					fontSize: newSize,
				},
				content: updatedContent,
			});
		}
	});

	return {
		fonts,
		isLoading,
		currentFont,
		currentFontSize,
		isMixed,
		isMixedSize,
		handleFontChange,
		handleFontSizeChange,
	};
}

// ---------------------------------------------------------------------------
// Font list cache (shared across all components, Valtio-backed like the
// rest of this app's cross-component state — see useUserSession's authState)
// ---------------------------------------------------------------------------

const fontListState = proxy<{
	fonts: FontMetadata[];
	isLoading: boolean;
	/**
	 * Bumped whenever a font finishes loading via fontkit so that downstream
	 * consumers (e.g. FontCombobox) can re-derive memos that depend on
	 * `FontManager.getLocalizedNames`.
	 */
	loadedVersion: number;
}>({
	fonts: [],
	isLoading: true,
	loadedVersion: 0,
});

let fontListPromise: Promise<void> | null = null;

function ensureFontListLoaded(): void {
	if (fontListPromise) return;

	fontListState.isLoading = true;
	fontListPromise = (async () => {
		try {
			const fontManager = getFontManager();
			const allFonts = await fontManager.queryAllFonts();

			const uniqueFamilies = new Map<string, FontMetadata>();
			for (const font of allFonts) {
				if (!uniqueFamilies.has(font.family)) {
					uniqueFamilies.set(font.family, font);
				}
			}
			fontListState.fonts = Array.from(uniqueFamilies.values());
		} catch (err) {
			console.error("Failed to load fonts:", err);
		} finally {
			fontListState.isLoading = false;
		}
	})();
}

/**
 * Subscribes to `FontManager`'s events exactly once for the app's lifetime —
 * `fontListState` is a shared, app-wide store, so its subscription lifecycle
 * is tied to that, not to any one component's mount/unmount.
 *
 * Handles three events:
 * - `fontLoaded`: bumps `loadedVersion` whenever a new font is parsed via
 *   fontkit, so localized names propagate into the list.
 * - `fontScriptsResolved`: bumps `loadedVersion` as local font scripts are
 *   detected, so the list can regroup by writing system.
 * - `fontListInvalidated`: the list can be queried (e.g. by an early-mounting
 *   FontCombobox) before Paplico.create() finishes injecting the Google Fonts
 *   API key, which permanently caches an incomplete (Google-fonts-less) list
 *   since `ensureFontListLoaded` never re-runs on its own. Re-querying on
 *   this event fixes that race.
 */
let fontManagerSubscribed = false;

function ensureFontManagerSubscription(): void {
	if (fontManagerSubscribed) return;
	fontManagerSubscribed = true;

	const fontManager = getFontManager();
	const bumpLoadedVersion = () => {
		fontListState.loadedVersion += 1;
	};
	fontManager.on("fontLoaded", bumpLoadedVersion);
	fontManager.on("fontScriptsResolved", bumpLoadedVersion);
	fontManager.on("fontListInvalidated", () => {
		fontListPromise = null;
		ensureFontListLoaded();
	});
}

export function useFontList(): {
	fonts: FontMetadata[];
	isLoading: boolean;
	loadedVersion: number;
} {
	useEffect(() => {
		ensureFontListLoaded();
		ensureFontManagerSubscription();
	}, []);
	const snap = useSnapshot(fontListState);
	// Nothing downstream mutates the font list; the cast just drops the
	// deep-readonly wrapper useSnapshot adds around plain read access.
	return snap as unknown as {
		fonts: FontMetadata[];
		isLoading: boolean;
		loadedVersion: number;
	};
}

// ---------------------------------------------------------------------------
// Font matching
// ---------------------------------------------------------------------------

/**
 * Find a FontMetadata entry that matches the given fontFamily + fontSource.
 *
 * For local fonts, prefer matching by postScriptName (exact variant match)
 * before falling back to family-name matching. For Google/embedded fonts,
 * family-name matching is sufficient since the font list is de-duplicated
 * by family.
 */
function findMatchingFont(
	fonts: FontMetadata[],
	fontFamily: string | undefined,
	fontSource: FontSource | undefined,
): FontMetadata | undefined {
	if (!fontFamily) return undefined;

	// Local font: try postScriptName match first for exact variant
	if (fontSource?.type === "local") {
		const byPSName = fonts.find(
			(f) =>
				f.source === "local" && f.postScriptName === fontSource.postScriptName,
		);
		if (byPSName) return byPSName;
	}

	// Fall back to family name match (case-insensitive)
	const lower = fontFamily.toLowerCase();
	return fonts.find((f) => f.family.toLowerCase() === lower);
}

/**
 * Equality comparator for base-ui Combobox value matching.
 * Compares by family name so that reference identity is not required.
 */
export function isFontEqual(a: FontMetadata, b: FontMetadata): boolean {
	return a.family === b.family && a.source === b.source;
}

/** Font sizes display and persist with at most 3 decimal places */
function roundFontSize(size: number): number {
	return Math.round(size * 1000) / 1000;
}
