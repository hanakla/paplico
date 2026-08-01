import { DndContext } from "@dnd-kit/core";
import {
	SortableContext,
	verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { PaintBucket, Pen, Plus, Sparkles, Squircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { IconButton } from "@/components/IconButton";
import { Separator } from "@/components/Separator";
import { Tooltip } from "@/components/Tooltip";
import { usePaplico } from "@/contexts/PaplicoContext";
import { useFirstSelectedElement } from "@/hooks/paplico/useFirstSelectedElement";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";
import { AddFilterButton } from "./AddFilterButton";
import { ElementInlineControls } from "./AppearanceInlineControls";
import { AppearanceSurface } from "./AppearanceSurface";
import { getElementTypeIcon, getElementTypeLabelKey } from "./constants";
import { createDefaultFilter } from "./createDefaultFilter";
import { ElementAppearanceControls } from "./ElementAppearanceControls";
import { FilterItem } from "./FilterItem";
import {
	FILTER_DND_MODIFIERS,
	useFilterPanelDragDrop,
	useFilterPanelSensors,
} from "./useFilterPanelDragDrop";

export function FilterPanel() {
	const { uiState: store, commands, maskEdit } = usePaplico();
	const selectedElement = useFirstSelectedElement(store);
	const t = useTranslation();
	const [selectedFilterIndex, setSelectedFilterIndex] = useState<number | null>(
		null,
	);
	const [elementPopoverOpen, setElementPopoverOpen] = useState(false);

	// Close popovers when selected element changes
	const selectedElementId = selectedElement?.id ?? null;
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset on element change
	useEffect(() => {
		setSelectedFilterIndex(null);
		setElementPopoverOpen(false);
	}, [selectedElementId]);

	const sensors = useFilterPanelSensors();

	const filters = selectedElement?.filters ?? [];

	// Determine if the selected filter is an appearance (fill/stroke)
	const selectedFilter =
		selectedFilterIndex !== null && selectedFilterIndex < filters.length
			? filters[selectedFilterIndex]
			: null;
	const isAppearanceSelected =
		selectedFilter?.processor === "fill" ||
		selectedFilter?.processor === "stroke";

	const handleAddFilter = useEventCallback(
		(processor: string, asSubFilter: boolean) => {
			const newFilter = createDefaultFilter(processor);
			if (!newFilter) return;

			if (asSubFilter && isAppearanceSelected && selectedFilterIndex !== null) {
				commands.addSubFilterToAppearance(selectedFilterIndex, newFilter);
			} else {
				commands.addFilterToSelectedElement(newFilter);
			}
		},
	);

	const handleSelectElementHeader = useEventCallback(() => {
		setSelectedFilterIndex(null);
		setElementPopoverOpen(true);
	});

	const handleEditMask = useEventCallback(() => {
		if (!selectedElement?.mask) return;
		maskEdit.enter(selectedElement.id);
	});

	const handleSelectFilter = useEventCallback((index: number) => {
		setSelectedFilterIndex((prev) => (prev === index ? null : index));
		setElementPopoverOpen(false);
	});

	const handleDeselectFilter = useEventCallback(() => {
		setSelectedFilterIndex(null);
	});

	// Original index order for uid-to-index lookups
	const uidToIndex = useMemo(() => {
		const map = new Map<string, number>();
		filters.forEach((f, i) => {
			map.set(f.uid, i);
		});
		return map;
	}, [filters]);

	// Display in array order (top = first applied)
	const reversedFilters = useMemo(
		() => filters.map((f, i) => ({ filter: f, originalIndex: i })),
		[filters],
	);

	const sortableIds = useMemo(
		() => reversedFilters.map(({ filter }) => filter.uid),
		[reversedFilters],
	);

	// Lookup: sub-filter uid → { filterIndex, subIndex }
	const subFilterParent = useMemo(() => {
		const map = new Map<string, { filterIndex: number; subIndex: number }>();
		for (const [fi, f] of filters.entries()) {
			for (const [si, sf] of (f.subFilters ?? []).entries()) {
				map.set(sf.uid, {
					filterIndex: fi,
					subIndex: si,
				});
			}
		}
		return map;
	}, [filters]);

	const {
		handleDragOver,
		handleDragEnd,
		dropIndicator,
		customCollision,
		clearDropIndicator,
	} = useFilterPanelDragDrop({
		commands,
		uidToIndex,
		subFilterParent,
		selectedFilterIndex,
		setSelectedFilterIndex,
	});

	if (!selectedElement) {
		return (
			<div className="w-52 bg-background/80 backdrop-liquid rounded-lg shadow-lg overflow-hidden">
				<div className="px-3 py-1 border-b border-border flex items-center gap-1.5">
					<span className="text-xs font-medium text-muted-foreground uppercase tracking-wide flex-1">
						{t("filterPanel.appearance")}
					</span>
					<IconButton $size="xs" $variant="ghost" disabled>
						<PaintBucket size={14} />
					</IconButton>
					<IconButton $size="xs" $variant="ghost" disabled>
						<Pen size={14} />
					</IconButton>
					<IconButton $size="xs" $variant="ghost" disabled>
						<Plus size={14} />
					</IconButton>
				</div>
				<p className="text-muted-foreground text-xs p-3">
					{t("filterPanel.selectElementToApplyFilters")}
				</p>
			</div>
		);
	}

	return (
		<DndContext
			sensors={sensors}
			collisionDetection={customCollision}
			modifiers={FILTER_DND_MODIFIERS}
			onDragOver={handleDragOver}
			onDragEnd={handleDragEnd}
			onDragCancel={clearDropIndicator}
		>
			<div className="w-52 bg-background/80 backdrop-liquid rounded-lg shadow-lg flex flex-col overflow-hidden">
				<div className="px-3 py-1 border-b border-border flex items-center gap-1.5">
					<Sparkles className="text-accent" size={14} />

					<span className="text-xs font-medium text-muted-foreground uppercase tracking-wide flex-1">
						{t("filterPanel.appearance")}
					</span>

					<IconButton
						$size="xs"
						$variant="ghost"
						title={t("filterPanel.fill")}
						onClick={() => handleAddFilter("fill", false)}
					>
						<PaintBucket size={14} />
					</IconButton>

					<IconButton
						$size="xs"
						$variant="ghost"
						title={t("filterPanel.stroke")}
						onClick={() => handleAddFilter("stroke", false)}
					>
						<Pen size={14} />
					</IconButton>

					<AddFilterButton
						isSubFilter={isAppearanceSelected}
						onAdd={handleAddFilter}
						side="right"
						iconSize={14}
					/>
				</div>

				<div className="flex-1 overflow-y-auto p-2 space-y-1">
					{/* Element type header (non-sortable, always first) */}
					<AppearanceSurface.Root
						open={elementPopoverOpen}
						onOpenChange={setElementPopoverOpen}
					>
						<div className="w-full">
							<div
								className={`w-full rounded flex items-center transition-colors ${
									selectedFilterIndex === null
										? "bg-accent/30 ring-1 ring-accent/30"
										: "bg-muted/30 hover:bg-accent/20"
								}`}
							>
								<AppearanceSurface.Trigger>
									<button
										type="button"
										className="min-w-0 flex-1 px-2 py-1 flex items-center gap-1.5 text-left"
										onClick={handleSelectElementHeader}
									>
										{getElementTypeIcon(selectedElement.type)}
										<span className="truncate text-xs font-medium">
											{t(getElementTypeLabelKey(selectedElement.type))}
										</span>
									</button>
								</AppearanceSurface.Trigger>
								{/* Kept outside the trigger: a button inside a button is
								    invalid, and opening the appearance popover is not what
								    clicking the mask badge should do. */}
								{selectedElement.mask && (
									<Tooltip content={t("filterPanel.maskEditFromBadge")}>
										<IconButton
											$size="xs"
											$variant="ghost"
											className="mr-1 shrink-0"
											aria-label={t("filterPanel.maskEditFromBadge")}
											onClick={handleEditMask}
										>
											<Squircle size={12} />
										</IconButton>
									</Tooltip>
								)}
							</div>
							<div className="px-2 pb-1 pl-4">
								<ElementInlineControls
									element={selectedElement}
									layerId={store.currentLayerId ?? ""}
								/>
							</div>
						</div>
						<AppearanceSurface.Content
							title={
								<>
									{getElementTypeIcon(selectedElement.type)}
									<span className="truncate">
										{t(getElementTypeLabelKey(selectedElement.type))}
									</span>
								</>
							}
						>
							<ElementAppearanceControls
								element={selectedElement}
								layerId={store.currentLayerId ?? ""}
							/>
						</AppearanceSurface.Content>
					</AppearanceSurface.Root>

					<Separator className="my-1" />

					{filters.length === 0 && (
						<p className="text-muted-foreground text-xs">
							{t("filterPanel.noFiltersApplied")}
						</p>
					)}
					<SortableContext
						items={sortableIds}
						strategy={verticalListSortingStrategy}
					>
						{reversedFilters.map(({ filter, originalIndex }, i) => (
							<FilterItem
								key={filter.uid}
								filter={filter}
								index={originalIndex}
								sortableId={sortableIds[i]}
								isSelected={selectedFilterIndex === originalIndex}
								onSelect={handleSelectFilter}
								onDeselect={handleDeselectFilter}
								onAddSubFilter={handleAddFilter}
								dropIndicator={dropIndicator}
							/>
						))}
					</SortableContext>
				</div>
			</div>
		</DndContext>
	);
}
