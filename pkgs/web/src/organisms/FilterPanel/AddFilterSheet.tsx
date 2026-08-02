import { ChevronLeft, ChevronRight, FolderTree, List } from "lucide-react";
import { memo, type ReactNode, useState } from "react";
import { IconButton } from "@/components/IconButton";
import { Input } from "@/components/Input";
import { setFilterMenuView, useAppConfig } from "@/hooks/useAppConfig";
import { type LocalizeKeys, useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";
import { twm } from "@/utils/tailwind";
import { FILTER_TEXT_KEYS, getFilterIcon } from "./constants";
import {
	type FilterCatalogEntry,
	queryFilterCatalog,
} from "./filterCatalogQuery";

/**
 * The filter catalog as a phone sheet. Category view drills in the way an iOS
 * navigation stack does — one screen per level, sliding in from the right —
 * because the menu's submenus open sideways into space a phone doesn't have.
 */
export const AddFilterSheet = memo(function AddFilterSheet({
	isSubFilter,
	onAdd,
}: {
	isSubFilter: boolean;
	onAdd: (processor: string, asSubFilter: boolean) => void;
}) {
	const t = useTranslation();
	const { filterMenuView } = useAppConfig();
	const [query, setQuery] = useState("");

	// The navigation stack. A popped screen keeps its name until it has slid
	// off, so `depth` — not the names — says which screen is the current one.
	const [depth, setDepth] = useState(0);
	const [category, setCategory] = useState<string | null>(null);
	const [subCategory, setSubCategory] = useState<string | null>(null);

	// Searching and switching views replace the whole stack rather than pop it,
	// so the screens go at once instead of sliding away.
	const resetStack = useEventCallback(() => {
		setDepth(0);
		setCategory(null);
		setSubCategory(null);
	});

	const handleQueryChange = useEventCallback(
		(e: React.ChangeEvent<HTMLInputElement>) => {
			setQuery(e.target.value);
			resetStack();
		},
	);

	const handleToggleView = useEventCallback(() => {
		setFilterMenuView(filterMenuView === "category" ? "list" : "category");
		resetStack();
	});

	const handleOpenCategory = useEventCallback((next: string) => {
		setCategory(next);
		setSubCategory(null);
		setDepth(1);
	});

	const handleOpenSubCategory = useEventCallback((next: string) => {
		setSubCategory(next);
		setDepth(2);
	});

	const handleBack = useEventCallback(() => {
		setDepth((current) => Math.max(0, current - 1));
	});

	// Unmount the screens the stack has left, but only once they are off-screen.
	const handleScreenSettled = useEventCallback(
		(e: React.TransitionEvent<HTMLDivElement>) => {
			// Rows inside the screen bubble their own transitions up here.
			if (e.target !== e.currentTarget) return;
			if (depth < 2) setSubCategory(null);
			if (depth < 1) setCategory(null);
		},
	);

	const { visibleEntries, matchedEntries } = queryFilterCatalog(
		isSubFilter,
		query,
	);

	const grouped = Object.groupBy(visibleEntries, (e) => e.category);
	const categories = [...new Set(visibleEntries.map((e) => e.category))];

	const categoryEntries = category ? (grouped[category] ?? []) : [];
	const subGroups = Object.groupBy(categoryEntries, (e) => e.subCategory ?? "");
	const subCategoryNames = categoryEntries.some((e) => e.subCategory)
		? Object.keys(subGroups)
		: null;

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex shrink-0 items-center gap-1 px-2 pb-2">
				<div className="flex-1">
					<Input
						$size="xs"
						value={query}
						onChange={handleQueryChange}
						placeholder={t("filterPanel.filterSearchPlaceholder")}
					/>
				</div>
				<IconButton
					$size="xs"
					$variant="ghost"
					className="shrink-0"
					aria-label={
						filterMenuView === "category"
							? t("filterPanel.filterViewList")
							: t("filterPanel.filterViewCategory")
					}
					onClick={handleToggleView}
				>
					{filterMenuView === "category" ? (
						<List size={14} />
					) : (
						<FolderTree size={14} />
					)}
				</IconButton>
			</div>

			{matchedEntries ? (
				<div className="min-h-0 flex-1 overflow-y-auto">
					{matchedEntries.length > 0 ? (
						matchedEntries.map((entry) => (
							<FilterRow
								key={entry.processor}
								entry={entry}
								isSubFilter={isSubFilter}
								showCategory
								onAdd={onAdd}
							/>
						))
					) : (
						<p className="px-3 py-2 text-muted-foreground text-xs">
							{t("filterPanel.filterSearchNoResults")}
						</p>
					)}
				</div>
			) : filterMenuView === "list" ? (
				<div className="min-h-0 flex-1 overflow-y-auto">
					{visibleEntries.map((entry) => (
						<FilterRow
							key={entry.processor}
							entry={entry}
							isSubFilter={isSubFilter}
							showCategory
							onAdd={onAdd}
						/>
					))}
				</div>
			) : (
				<div className="grid min-h-0 flex-1 overflow-hidden">
					<NavScreen
						depth={0}
						currentDepth={depth}
						onSettled={handleScreenSettled}
					>
						{categories.map((cat) => (
							<CategoryRow
								key={cat}
								category={cat}
								onOpen={handleOpenCategory}
							/>
						))}
					</NavScreen>

					{/* The pushed screens stay mounted while empty. One that appeared
					    only on push would enter already at its destination, with no
					    off-screen position to travel from, and so would not animate. */}
					<NavScreen
						depth={1}
						currentDepth={depth}
						onSettled={handleScreenSettled}
					>
						{category && (
							<>
								<NavBar
									title={t(`filterPanel.category.${category}` as LocalizeKeys)}
									onBack={handleBack}
								/>
								{subCategoryNames
									? subCategoryNames.map((sub) => (
											<CategoryRow
												key={sub}
												category={sub}
												onOpen={handleOpenSubCategory}
											/>
										))
									: categoryEntries.map((entry) => (
											<FilterRow
												key={entry.processor}
												entry={entry}
												isSubFilter={isSubFilter}
												onAdd={onAdd}
											/>
										))}
							</>
						)}
					</NavScreen>

					<NavScreen
						depth={2}
						currentDepth={depth}
						onSettled={handleScreenSettled}
					>
						{subCategory && (
							<>
								<NavBar
									title={t(
										`filterPanel.category.${subCategory}` as LocalizeKeys,
									)}
									onBack={handleBack}
								/>
								{(subGroups[subCategory] ?? []).map((entry) => (
									<FilterRow
										key={entry.processor}
										entry={entry}
										isSubFilter={isSubFilter}
										onAdd={onAdd}
									/>
								))}
							</>
						)}
					</NavScreen>
				</div>
			)}
		</div>
	);
});

/** One level of the stack. Screens left behind rest slightly to the left, the
 *  way a pushed-over iOS screen does; screens not yet reached wait off-screen. */
function NavScreen({
	depth,
	currentDepth,
	onSettled,
	children,
}: {
	depth: number;
	currentDepth: number;
	onSettled: (e: React.TransitionEvent<HTMLDivElement>) => void;
	children: ReactNode;
}) {
	const isCurrent = depth === currentDepth;

	return (
		<div
			className={twm(
				"col-start-1 row-start-1 min-h-0 overflow-y-auto bg-background",
				"transition-[translate,opacity] duration-(--duration-beat) ease-[cubic-bezier(0.32,0.72,0,1)]",
				isCurrent
					? "translate-x-0 opacity-100"
					: depth < currentDepth
						? // iOS push: the screen left behind parallaxes 1/3 left and dims
							"-translate-x-1/3 opacity-50 pointer-events-none"
						: "translate-x-full pointer-events-none",
			)}
			aria-hidden={!isCurrent}
			onTransitionEnd={onSettled}
		>
			{children}
		</div>
	);
}

function NavBar({ title, onBack }: { title: string; onBack: () => void }) {
	const t = useTranslation();

	return (
		<div className="sticky top-0 z-10 flex min-h-10 shrink-0 items-center border-b border-border bg-background">
			<button
				type="button"
				className="z-10 flex min-h-10 shrink-0 items-center gap-0.5 pr-3 pl-1 text-accent text-sm"
				onClick={onBack}
			>
				<ChevronLeft size={18} />
				{t("filterPanel.filterCategoryBack")}
			</button>
			<span className="pointer-events-none absolute inset-x-16 truncate text-center text-sm font-medium">
				{title}
			</span>
		</div>
	);
}

const CategoryRow = memo(function CategoryRow({
	category,
	onOpen,
}: {
	category: string;
	onOpen: (category: string) => void;
}) {
	const t = useTranslation();
	const handleClick = useEventCallback(() => {
		onOpen(category);
	});

	return (
		<button
			type="button"
			className="flex min-h-11 w-full items-center gap-2 px-3 text-foreground text-sm hover:bg-muted-hover"
			onClick={handleClick}
		>
			<span className="truncate">
				{t(`filterPanel.category.${category}` as LocalizeKeys)}
			</span>
			<ChevronRight
				size={16}
				className="ml-auto shrink-0 text-muted-foreground"
			/>
		</button>
	);
});

const FilterRow = memo(function FilterRow({
	entry,
	isSubFilter,
	showCategory,
	onAdd,
}: {
	entry: FilterCatalogEntry;
	isSubFilter: boolean;
	/** The flat lists mix categories together, so their rows name theirs. */
	showCategory?: boolean;
	onAdd: (processor: string, asSubFilter: boolean) => void;
}) {
	const t = useTranslation();
	const handleClick = useEventCallback(() => {
		onAdd(entry.processor, isSubFilter && entry.canBeSubFilter);
	});

	return (
		<button
			type="button"
			className="flex min-h-11 w-full items-center gap-2 px-3 text-foreground text-sm hover:bg-muted-hover"
			onClick={handleClick}
		>
			{getFilterIcon(entry.processor)}
			<span className="truncate">
				{t(FILTER_TEXT_KEYS[entry.processor as keyof typeof FILTER_TEXT_KEYS])}
			</span>
			{showCategory && (
				<span className="ml-auto shrink-0 pl-4 text-muted-foreground text-xs">
					{t(`filterPanel.category.${entry.category}` as LocalizeKeys)}
				</span>
			)}
		</button>
	);
});
