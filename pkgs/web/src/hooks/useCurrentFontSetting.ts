import type { Paplico } from "@paplico/core";
import type { FontSource, TextElement, TextStyle } from "@paplico/core/schema";
import type { FontMetadata } from "@paplico/core/typography";
import { useEffect, useMemo } from "react";
import { proxy, useSnapshot } from "valtio";
import { usePaplico } from "@/contexts/PaplicoContext";
import { useSelectedElements } from "@/hooks/paplico/useSelectedElements";
import { uiState } from "@/stores/uiStore";
import { buildFontSource } from "@/utils/font";
import { useEventCallback } from "@/utils/hooks";

// ---------------------------------------------------------------------------
// Main hook: useActiveFontSettings
// ---------------------------------------------------------------------------

interface ActiveFontSettings {
	fonts: FontMetadata[];
	isLoading: boolean;
	currentFont: FontMetadata | undefined;
	currentFontSize: number;
	currentFontWeight: number | undefined;
	fontFaces: FontMetadata[];
	isMixed: boolean;
	isMixedSize: boolean;
	handleFontChange: (font: FontMetadata | null) => void;
	handleFontSizeChange: (size: number) => void;
	handleFontWeightChange: (weight: number, face?: FontMetadata) => void;
}

export function useActiveFontSettings(): ActiveFontSettings {
	const paplico = usePaplico();
	const { tools, commands, uiState: store } = paplico;
	const toolSnap = useSnapshot(tools.state);
	const uiSnap = useSnapshot(uiState);
	const selectedElements = useSelectedElements(store);
	const { fonts, isLoading } = useFontList(paplico.fonts);

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

	const currentFontWeight = useMemo(() => {
		if (isTextEditing) {
			return uiSnap.textEditState.selectionStyle?.fontWeight;
		}
		if (textElements.length === 0) return toolSnap.textDefaultStyle.fontWeight;
		const weight = textElements[0].defaultStyle.fontWeight;
		return textElements.every((el) => el.defaultStyle.fontWeight === weight)
			? weight
			: undefined;
	}, [
		isTextEditing,
		uiSnap.textEditState.selectionStyle,
		textElements,
		toolSnap.textDefaultStyle,
	]);
	const fontFaces = useMemo(
		() =>
			fonts.filter(
				(font) =>
					font.family === currentFont?.family &&
					font.loaderId === currentFont.loaderId &&
					/italic|oblique/i.test(font.style) ===
						/italic|oblique/i.test(currentFont.style),
			),
		[fonts, currentFont],
	);

	// Sync selected TextElement settings to tool defaults
	useEffect(() => {
		if (textElements.length === 0 || isMixed) return;
		const el = textElements[0];
		Object.assign(tools.state.textDefaultStyle, el.defaultStyle);
		tools.state.textDefaultAlignment =
			el.content.paragraphs[0]?.alignment ?? "left";
		tools.state.textDefaultWritingMode = el.layout.writingMode;
	}, [textElements, isMixed, tools.state]);

	const applyTextStyle = useEventCallback((updates: Partial<TextStyle>) => {
		Object.assign(tools.state.textDefaultStyle, updates);
		if (isTextEditing) {
			paplico.textToolController?.getTextTool()?.applyStyleToSelection(updates);
			return;
		}
		const layerId = store.currentLayerId;
		if (!layerId) return;
		for (const el of textElements) {
			commands.updateElement(layerId, el.id, {
				defaultStyle: { ...el.defaultStyle, ...updates },
				content: {
					...el.content,
					paragraphs: el.content.paragraphs.map((para) => ({
						...para,
						runs: para.runs.map((run) => ({
							...run,
							style: { ...run.style, ...updates },
						})),
					})),
				},
			});
		}
	});

	const handleFontChange = useEventCallback((font: FontMetadata | null) => {
		if (!font) return;
		applyTextStyle({
			fontFamily: font.family,
			fontSource: buildFontSource(font),
			fontVariationSettings: {},
		});
	});

	const handleFontSizeChange = useEventCallback((size: number) => {
		if (!Number.isFinite(size) || size <= 0) return;
		applyTextStyle({ fontSize: roundFontSize(size) });
	});

	const handleFontWeightChange = useEventCallback(
		(weight: number, face?: FontMetadata) => {
			if (!Number.isFinite(weight) || weight <= 0) return;
			applyTextStyle({
				fontWeight: weight,
				...(face
					? {
							fontFamily: face.family,
							fontSource: buildFontSource(face),
							fontVariationSettings: {},
						}
					: {}),
			});
		},
	);

	return {
		fonts,
		isLoading,
		currentFont,
		currentFontSize,
		currentFontWeight,
		fontFaces,
		isMixed,
		isMixedSize,
		handleFontChange,
		handleFontSizeChange,
		handleFontWeightChange,
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

/** The FontManager fontListState was built from and is subscribed to. */
let listedFontManager: Paplico["fonts"] | null = null;

/**
 * Query the font list once per FontManager and keep `fontListState` in sync
 * with its events. `fontListState` is a shared, app-wide store, so the
 * subscription lives as long as the manager, not any one component.
 *
 * - `fontLoaded`: bumps `loadedVersion` whenever a new font is parsed via
 *   fontkit, so localized names propagate into the list.
 * - `fontScriptsResolved`: bumps `loadedVersion` as font scripts are
 *   detected, so the list can regroup by writing system.
 */
function ensureFontList(fontManager: Paplico["fonts"]): void {
	if (listedFontManager === fontManager) return;
	listedFontManager = fontManager;

	const bumpLoadedVersion = () => {
		fontListState.loadedVersion += 1;
	};
	fontManager.on("fontLoaded", bumpLoadedVersion);
	fontManager.on("fontScriptsResolved", bumpLoadedVersion);

	fontListState.isLoading = true;
	void (async () => {
		try {
			fontListState.fonts = await fontManager.queryAllFonts();
		} catch (err) {
			console.error("Failed to load fonts:", err);
		} finally {
			fontListState.isLoading = false;
		}
	})();
}

export function useFontList(fontManager: Paplico["fonts"]): {
	fonts: FontMetadata[];
	isLoading: boolean;
	loadedVersion: number;
} {
	useEffect(() => {
		ensureFontList(fontManager);
	}, [fontManager]);
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
 * Imported text can store a PostScript name as its family, so resolve its
 * source before trying family-name matching.
 */
function findMatchingFont(
	fonts: FontMetadata[],
	fontFamily: string | undefined,
	fontSource: FontSource | undefined,
): FontMetadata | undefined {
	if (!fontFamily) return undefined;

	const exact = fonts.find(
		(f) =>
			f.loaderId === fontSource?.loaderId && f.fontId === fontSource.fontId,
	);
	if (exact) return exact;

	// Fall back to family name match (case-insensitive)
	const lower = fontFamily.toLowerCase();
	return fonts.find((f) => f.family.toLowerCase() === lower);
}

/**
 * Equality comparator for base-ui Combobox value matching.
 * Compares by family name so that reference identity is not required.
 */
export function isFontEqual(a: FontMetadata, b: FontMetadata): boolean {
	return a.family === b.family && a.loaderId === b.loaderId;
}

/** Font sizes display and persist with at most 3 decimal places */
function roundFontSize(size: number): number {
	return Math.round(size * 1000) / 1000;
}
