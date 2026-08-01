import { FolderTree, List } from "lucide-react";
import {
	type KeyboardEvent,
	memo,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { IconButton } from "@/components/IconButton";
import { Input } from "@/components/Input";
import { Menu } from "@/components/Menu";
import { Tooltip } from "@/components/Tooltip";
import { setFilterMenuView, useAppConfig } from "@/hooks/useAppConfig";
import { type LocalizeKeys, useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";
import { FILTER_TEXT_KEYS, getFilterIcon } from "./constants";
import { queryFilterCatalog } from "./filterCatalogQuery";

export const AddFilterMenu = memo(function AddFilterMenu({
	isSubFilter,
	onAdd,
}: {
	isSubFilter: boolean;
	onAdd: (processor: string, asSubFilter: boolean) => void;
}) {
	const t = useTranslation();
	const [query, setQuery] = useState("");
	const { filterMenuView } = useAppConfig();
	const rootRef = useRef<HTMLDivElement>(null);

	// Freeze the natural width on open and re-measure it when the view
	// toggles or the query starts/clears, so only typing within a non-empty
	// query keeps the frozen width.
	const hasQuery = query.trim() !== "";
	// biome-ignore lint/correctness/useExhaustiveDependencies: filterMenuView/hasQuery are re-measure triggers, not read in the body
	useLayoutEffect(() => {
		const root = rootRef.current;
		if (!root) return;
		root.style.width = "";
		root.style.width = `${root.offsetWidth}px`;
	}, [filterMenuView, hasQuery]);

	const handleQueryChange = useEventCallback(
		(e: React.ChangeEvent<HTMLInputElement>) => {
			setQuery(e.target.value);
		},
	);

	const handleToggleView = useEventCallback(() => {
		setFilterMenuView(filterMenuView === "category" ? "list" : "category");
	});

	// The input lives inside the menu popup: swallow keystrokes so the menu
	// typeahead doesn't react to typing, but hand ArrowDown over to the item
	// list (focused items then get the menu's native ↑↓/Enter handling) and
	// let Escape bubble up to close the menu.
	const handleSearchKeyDown = useEventCallback(
		(e: KeyboardEvent<HTMLInputElement>) => {
			if (e.key === "Escape") return;
			if (e.key === "ArrowDown") {
				e.preventDefault();
				e.stopPropagation();
				e.currentTarget
					.closest('[role="menu"]')
					?.querySelector<HTMLElement>('[role="menuitem"]')
					?.focus();
				return;
			}
			e.stopPropagation();
		},
	);

	const { visibleEntries, matchedEntries } = queryFilterCatalog(
		isSubFilter,
		query,
	);

	const grouped = Object.groupBy(visibleEntries, (e) => e.category);
	const categories = [...new Set(visibleEntries.map((e) => e.category))];

	return (
		<div ref={rootRef}>
			<div className="flex items-center gap-1 mx-1 mt-1 mb-1.5">
				<div className="flex-1">
					<Input
						$size="xs"
						// biome-ignore lint/a11y/noAutofocus: the popup just opened by explicit user action; typing to narrow is its primary flow
						autoFocus
						value={query}
						onChange={handleQueryChange}
						onKeyDown={handleSearchKeyDown}
						placeholder={t("filterPanel.filterSearchPlaceholder")}
					/>
				</div>
				<Tooltip
					content={
						filterMenuView === "category"
							? t("filterPanel.filterViewList")
							: t("filterPanel.filterViewCategory")
					}
				>
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
							<List size={12} />
						) : (
							<FolderTree size={12} />
						)}
					</IconButton>
				</Tooltip>
			</div>
			{matchedEntries ? (
				matchedEntries.length > 0 ? (
					matchedEntries.map((entry) => (
						<FlatFilterItem
							key={entry.processor}
							processor={entry.processor}
							category={entry.category}
							asSubFilter={isSubFilter && entry.canBeSubFilter}
							onAdd={onAdd}
						/>
					))
				) : (
					<div className="px-2 py-1.5 text-muted-foreground text-xs">
						{t("filterPanel.filterSearchNoResults")}
					</div>
				)
			) : filterMenuView === "list" ? (
				<div className="max-h-80 overflow-y-auto">
					{visibleEntries.map((entry) => (
						<FlatFilterItem
							key={entry.processor}
							processor={entry.processor}
							category={entry.category}
							asSubFilter={isSubFilter && entry.canBeSubFilter}
							onAdd={onAdd}
						/>
					))}
				</div>
			) : (
				categories.map((cat) => {
					const entries = grouped[cat] ?? [];
					const hasSubCategories = entries.some((e) => e.subCategory);

					return (
						<Menu.SubmenuRoot key={cat}>
							<Menu.SubmenuTrigger>
								{t(`filterPanel.category.${cat}` as LocalizeKeys)}
							</Menu.SubmenuTrigger>
							<Menu.Portal>
								<Menu.Positioner sideOffset={4}>
									<Menu.Popup>
										{hasSubCategories
											? Object.entries(
													Object.groupBy(entries, (e) => e.subCategory ?? ""),
												).map(([subCat, subEntries]) => (
													<Menu.SubmenuRoot key={subCat}>
														<Menu.SubmenuTrigger>
															{t(
																`filterPanel.category.${subCat}` as LocalizeKeys,
															)}
														</Menu.SubmenuTrigger>
														<Menu.Portal>
															<Menu.Positioner sideOffset={4}>
																<Menu.Popup>
																	{subEntries?.map((entry) => (
																		<Menu.Item
																			key={entry.processor}
																			onClick={() =>
																				onAdd(
																					entry.processor,
																					isSubFilter && entry.canBeSubFilter,
																				)
																			}
																		>
																			{getFilterIcon(entry.processor)}
																			{t(
																				FILTER_TEXT_KEYS[
																					entry.processor as keyof typeof FILTER_TEXT_KEYS
																				],
																			)}
																		</Menu.Item>
																	))}
																</Menu.Popup>
															</Menu.Positioner>
														</Menu.Portal>
													</Menu.SubmenuRoot>
												))
											: entries.map((entry) => (
													<Menu.Item
														key={entry.processor}
														onClick={() =>
															onAdd(
																entry.processor,
																isSubFilter && entry.canBeSubFilter,
															)
														}
													>
														{getFilterIcon(entry.processor)}
														{t(
															FILTER_TEXT_KEYS[
																entry.processor as keyof typeof FILTER_TEXT_KEYS
															],
														)}
													</Menu.Item>
												))}
									</Menu.Popup>
								</Menu.Positioner>
							</Menu.Portal>
						</Menu.SubmenuRoot>
					);
				})
			)}
		</div>
	);
});

const FlatFilterItem = memo(function FlatFilterItem({
	processor,
	category,
	asSubFilter,
	onAdd,
}: {
	processor: string;
	category: string;
	asSubFilter: boolean;
	onAdd: (processor: string, asSubFilter: boolean) => void;
}) {
	const t = useTranslation();
	const handleClick = useEventCallback(() => {
		onAdd(processor, asSubFilter);
	});

	return (
		<Menu.Item onClick={handleClick}>
			{getFilterIcon(processor)}
			{t(FILTER_TEXT_KEYS[processor as keyof typeof FILTER_TEXT_KEYS])}
			<span className="ml-auto pl-4 text-muted-foreground text-xs">
				{t(`filterPanel.category.${category}` as LocalizeKeys)}
			</span>
		</Menu.Item>
	);
});
