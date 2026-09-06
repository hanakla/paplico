import { Combobox as BUICombobox } from "@base-ui/react/combobox";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Check } from "lucide-react";
import { memo, useEffect, useMemo, useState } from "react";
import { Combobox2 } from "@/components/Combobox2";
import { Spinner } from "@/components/Spinner";
import {
	FONT_SCRIPT_ORDER,
	type FontMetadata,
	type FontScript,
	getFontManager,
} from "@/core/index";
import { useAppConfig } from "@/hooks/useAppConfig";
import { isFontEqual, useFontList } from "@/hooks/useCurrentFontSetting";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";
import { twm } from "@/utils/tailwind";
import { buildFontSource } from "./utils";

type FontTab = "all" | "google" | "local";

const emptyArray: FontMetadata[] = [];

export const FontCombobox = memo(function FontCombobox({
	fonts,
	currentFont,
	isLoading,
	isMixed,
	onFontChange,
	previewReady,
	previewRef,
	placeholder,
}: {
	fonts: FontMetadata[];
	currentFont: FontMetadata | undefined;
	isLoading: boolean;
	isMixed?: boolean;
	onFontChange: (font: FontMetadata | null) => void;
	previewReady: Set<string>;
	previewRef: (
		family: string,
		source: string,
	) => (el: HTMLElement | null) => void;
	placeholder?: string;
}) {
	const t = useTranslation();
	const { language } = useAppConfig();
	const [activeTab, setActiveTab] = useState<FontTab>("all");
	const [query, setQuery] = useState("");
	const [open, setOpen] = useState(false);
	const [listReady, setListReady] = useState(false);

	// Re-render this component when a font finishes loading so newly available
	// localized names propagate into the list. The fonts array itself is
	// unchanged; loadedVersion is the trigger.
	const { loadedVersion } = useFontList();

	// Defer list rendering to next frame after popup opens
	useEffect(() => {
		if (open && !isLoading) {
			const id = requestAnimationFrame(() => setListReady(true));
			return () => cancelAnimationFrame(id);
		}
		setListReady(false);
	}, [open, isLoading]);

	const handleInputValueChange = useEventCallback(
		(value: string, { reason }: { reason: string }) => {
			if (reason === "input-change" || reason === "input-clear") {
				setQuery(value);
			} else {
				setQuery("");
			}
		},
	);

	const handleOpenChange = useEventCallback((isOpen: boolean) => {
		setOpen(isOpen);
	});

	const itemToString = useEventCallback((font: FontMetadata | null) => {
		if (!font) return "";
		if (font.localizedFullName) return font.localizedFullName;
		const source = buildFontSource(font);
		const localized = source
			? getFontManager().getLocalizedNames(source)
			: null;
		return localized?.localizedFullName ?? font.fullName;
	});

	// Merge any localized names and detected scripts that have become
	// available since the font catalog was first queried. `loadedVersion` is
	// included so the memo re-runs whenever a font is parsed via fontkit or a
	// batch of local font headers has been read.
	// biome-ignore lint/correctness/useExhaustiveDependencies: loadedVersion is the explicit re-derivation trigger
	const enrichedFonts = useMemo(() => {
		const fontManager = getFontManager();
		let changed = false;
		const result = fonts.map((f) => {
			const source = buildFontSource(f);
			if (!source) return f;
			const localized = fontManager.getLocalizedNames(source);
			const scripts = fontManager.getFontScripts(source);
			if (!localized && !scripts) return f;
			changed = true;
			return { ...f, ...localized, ...(scripts ? { scripts } : {}) };
		});
		return changed ? result : fonts;
	}, [fonts, loadedVersion]);

	const hasLocalFonts = useMemo(
		() => enrichedFonts.some((f) => f.source === "local"),
		[enrichedFonts],
	);

	const filteredFonts = useMemo(() => {
		let list = enrichedFonts;
		if (activeTab === "google")
			list = list.filter((f) => f.source === "google");
		else if (activeTab === "local")
			list = list.filter((f) => f.source === "local");

		if (query) {
			const q = query.toLowerCase();
			list = list.filter(
				(f) =>
					f.family.toLowerCase().includes(q) ||
					f.fullName.toLowerCase().includes(q) ||
					(f.localizedFamily?.toLowerCase().includes(q) ?? false) ||
					(f.localizedFullName?.toLowerCase().includes(q) ?? false),
			);
		}
		return sortFontsByScript(list, language === "ja" ? "japanese" : "latin");
	}, [enrichedFonts, activeTab, query, language]);

	return (
		<BUICombobox.Root
			items={enrichedFonts}
			filteredItems={listReady ? filteredFonts : emptyArray}
			virtualized
			open={open}
			value={currentFont ?? null}
			onValueChange={onFontChange}
			isItemEqualToValue={isFontEqual}
			itemToStringLabel={itemToString}
			filter={null}
			onInputValueChange={handleInputValueChange}
			onOpenChange={handleOpenChange}
		>
			<div className="relative">
				<Combobox2.Input
					$size="sm"
					clearable={false}
					placeholder={placeholder ?? t("actionsPanel.selectFont")}
				/>
			</div>

			<Combobox2.Popup className="min-w-72">
				{!listReady ? (
					<div className="flex items-center justify-center py-4">
						<Spinner $size="sm" />
					</div>
				) : (
					<>
						<div
							className={twm(
								"grid overflow-hidden max-h-[inherit]",
								hasLocalFonts ? "grid-rows-[auto_1fr]" : "grid-rows-[1fr]",
							)}
						>
							{hasLocalFonts && (
								<FontTabBar activeTab={activeTab} onTabChange={setActiveTab} />
							)}
							<BUICombobox.List className="p-0 min-h-0 overflow-hidden">
								<VirtualizedFontList
									fonts={filteredFonts}
									currentFont={currentFont}
									open={open}
									previewReady={previewReady}
									previewRef={previewRef}
								/>
							</BUICombobox.List>
						</div>
						<BUICombobox.Empty className="px-3 py-2 text-xs text-muted-foreground">
							{t("actionsPanel.noFontsFound")}
						</BUICombobox.Empty>
					</>
				)}
			</Combobox2.Popup>
		</BUICombobox.Root>
	);
});

// ---------------------------------------------------------------------------
// Tab bar
// ---------------------------------------------------------------------------

const FontTabBar = memo(function FontTabBar({
	activeTab,
	onTabChange,
}: {
	activeTab: FontTab;
	onTabChange: (tab: FontTab) => void;
}) {
	return (
		<div className="flex gap-0.5 px-2 py-1.5 border-b border-border/30">
			<TabButton
				active={activeTab === "all"}
				onClick={() => onTabChange("all")}
			>
				All
			</TabButton>
			<TabButton
				active={activeTab === "google"}
				onClick={() => onTabChange("google")}
			>
				Google
			</TabButton>
			<TabButton
				active={activeTab === "local"}
				onClick={() => onTabChange("local")}
			>
				Local
			</TabButton>
		</div>
	);
});

const TabButton = memo(function TabButton({
	active,
	onClick,
	children,
}: {
	active: boolean;
	onClick: () => void;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			className={twm(
				"px-2 py-0.5 text-xs rounded transition-colors select-none",
				active
					? "bg-accent/15 text-foreground font-medium"
					: "text-muted-foreground hover:text-foreground hover:bg-muted",
			)}
			onPointerDown={(e) => {
				e.preventDefault();
				onClick();
			}}
		>
			{children}
		</button>
	);
});

// ---------------------------------------------------------------------------
// Virtualized font list
// ---------------------------------------------------------------------------

const ITEM_HEIGHT = 28;

const VirtualizedFontList = memo(function VirtualizedFontList({
	fonts,
	currentFont,
	open,
	previewReady,
	previewRef,
}: {
	fonts: FontMetadata[];
	currentFont: FontMetadata | undefined;
	open: boolean;
	previewReady: Set<string>;
	previewRef: (
		family: string,
		source: string,
	) => (el: HTMLElement | null) => void;
}) {
	// A ref alone doesn't work here: useVirtualizer reads getScrollElement()
	// during render, but a plain ref callback fires after commit with no
	// re-render of its own, so the virtualizer's first render permanently
	// captures a null scroll element and never re-checks it (measure() only
	// invalidates size caches, it doesn't refetch the element). State makes
	// the attach itself trigger the re-render the virtualizer needs.
	const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(
		null,
	);

	const virtualizer = useVirtualizer({
		count: fonts.length,
		getScrollElement: () => scrollElement,
		estimateSize: () => ITEM_HEIGHT,
		overscan: 8,
	});

	// Scroll to selected font when popup opens
	useEffect(() => {
		if (!open || !currentFont) return;

		const index = fonts.findIndex(
			(f) => f.family === currentFont.family && f.source === currentFont.source,
		);
		if (index >= 0) {
			virtualizer.scrollToIndex(index, { align: "center" });
		}
	}, [open, currentFont, fonts, virtualizer]);

	const totalSize = virtualizer.getTotalSize();

	if (!fonts.length) return null;

	return (
		<div
			role="presentation"
			ref={setScrollElement}
			className="overflow-auto overscroll-contain outline-none h-full"
		>
			<div
				role="presentation"
				style={{ position: "relative", width: "100%", height: totalSize }}
			>
				{virtualizer.getVirtualItems().map((virtualItem) => {
					const font = fonts[virtualItem.index];
					if (!font) return null;

					return (
						<FontPreviewItem
							key={`${font.source}-${font.family}`}
							font={font}
							index={virtualItem.index}
							totalCount={fonts.length}
							previewReady={previewReady}
							previewRef={previewRef}
							style={{
								position: "absolute",
								top: 0,
								left: 0,
								width: "100%",
								height: virtualItem.size,
								transform: `translateY(${virtualItem.start}px)`,
							}}
						/>
					);
				})}
			</div>
		</div>
	);
});

// ---------------------------------------------------------------------------
// Font item
// ---------------------------------------------------------------------------

const FontPreviewItem = memo(function FontPreviewItem({
	font,
	index,
	totalCount,
	previewReady,
	previewRef,
	style,
}: {
	font: FontMetadata;
	index: number;
	totalCount: number;
	previewReady: Set<string>;
	previewRef: (
		family: string,
		source: string,
	) => (el: HTMLElement | null) => void;
	style?: React.CSSProperties;
}) {
	const isReady = previewReady.has(font.family) || font.source === "local";

	return (
		<BUICombobox.Item
			value={font}
			index={index}
			aria-setsize={totalCount}
			aria-posinset={index + 1}
			className="grid cursor-default grid-cols-[1rem_1fr] items-center gap-2 py-1.5 px-2 text-xs outline-none select-none data-highlighted:bg-accent/10 data-highlighted:text-foreground"
			style={style}
		>
			<BUICombobox.ItemIndicator className="col-start-1 text-accent">
				<Check size={12} />
			</BUICombobox.ItemIndicator>
			<span
				ref={previewRef(font.family, font.source)}
				className="col-start-2 flex items-center gap-1"
				style={
					isReady ? { fontFamily: `"${font.family}", sans-serif` } : undefined
				}
			>
				<span className="flex-1 truncate">
					{font.localizedFullName ?? font.fullName}
				</span>
				{font.source === "google" && <GoogleFontsIcon />}
			</span>
		</BUICombobox.Item>
	);
});

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

const GoogleFontsIcon = memo(function GoogleFontsIcon() {
	return (
		<svg
			width="14"
			height="14"
			viewBox="0 0 24 24"
			className="shrink-0 opacity-50"
			aria-hidden="true"
		>
			<path
				d="M12.545 10.239v3.821h5.445c-.712 2.315-2.647 3.972-5.445 3.972a6.033 6.033 0 110-12.064c1.498 0 2.866.549 3.921 1.453l2.814-2.814A9.969 9.969 0 0012.545 2C7.021 2 2.543 6.477 2.543 12s4.478 10 10.002 10c8.396 0 10.249-7.85 9.426-11.748l-9.426-.013z"
				fill="#4285F4"
			/>
		</svg>
	);
});

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

type FontGroup = FontScript | "other";

/**
 * Order fonts by writing system, keeping the catalog order within each
 * group. The UI language's script leads, then the fixed script order, then
 * fonts whose scripts are unknown. Fonts still awaiting header detection
 * are treated as Latin for now.
 */
function sortFontsByScript(
	fonts: FontMetadata[],
	primary: FontScript,
): FontMetadata[] {
	const order: FontGroup[] = [
		primary,
		...FONT_SCRIPT_ORDER.filter((s) => s !== primary),
		"other",
	];
	const grouped = Object.groupBy(fonts, (font) => fontGroupOf(font, primary));
	return order.flatMap((group) => grouped[group] ?? []);
}

function fontGroupOf(font: FontMetadata, primary: FontScript): FontGroup {
	const scripts = font.scripts;
	if (!scripts) return "latin";
	if (scripts.includes(primary)) return primary;
	return (
		FONT_SCRIPT_ORDER.find((s) => s !== "latin" && scripts.includes(s)) ??
		(scripts.includes("latin") ? "latin" : "other")
	);
}
