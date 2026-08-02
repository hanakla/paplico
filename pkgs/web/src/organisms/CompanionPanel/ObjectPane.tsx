import { closestCenter, DndContext, type DragEndEvent } from "@dnd-kit/core";
import {
	SortableContext,
	useSortable,
	verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
	ChevronDown,
	ChevronRight,
	ChevronUp,
	GripVertical,
	Plus,
	Trash2,
} from "lucide-react";
import { memo, useState } from "react";
import type {
	CompanionCommand,
	CompanionFilter,
	CompanionState,
} from "@/companion/companionProtocol";
import { Drawer } from "@/components/Drawer";
import { SimpleSelect } from "@/components/SimpleSelect";
import { Switch } from "@/components/Switch";
import type { BlendMode, CompositionMode, Filter } from "@/core/schema";
import { useBlendModeItems } from "@/hooks/useBlendModeItems";
import { useCompositionModeItems } from "@/hooks/useCompositionModeItems";
import { type LocalizeKeys, useTranslation } from "@/locales";
import { AddFilterSheet } from "@/organisms/FilterPanel/AddFilterSheet";
import { FILTER_TEXT_KEYS } from "@/organisms/FilterPanel/constants";
import { FilterEffectControls } from "@/organisms/FilterPanel/FilterEffectControls";
import { useEventCallback } from "@/utils/hooks";
import { twm } from "@/utils/tailwind";
import { SliderRow } from "./SliderRow";
import { DND_MODIFIERS, useCompanionSortSensors } from "./sortable";

/**
 * The appearance of whatever is selected on the host — the three blend settings
 * its own appearance panel offers, and the list of appearances stacked on it,
 * since those are the ones worth reaching for without the object in front of
 * you.
 */
export const ObjectPane = memo(function ObjectPane({
	state,
	onCommand,
}: {
	state: CompanionState;
	onCommand: (command: CompanionCommand) => void;
}) {
	const t = useTranslation();
	const blendModeItems = useBlendModeItems();
	const compositionModeItems = useCompositionModeItems();
	const [addSheetOpen, setAddSheetOpen] = useState(false);
	const sensors = useCompanionSortSensors();

	const handleOpacityChange = useEventCallback((value: number) => {
		onCommand({ type: "setElementOpacity", value });
	});

	const handleBlendModeChange = useEventCallback((value: string) => {
		onCommand({ type: "setElementBlendMode", blendMode: value as BlendMode });
	});

	const handleCompositionModeChange = useEventCallback((value: string) => {
		onCommand({
			type: "setElementCompositionMode",
			compositionMode: value as CompositionMode,
		});
	});

	const handleOpenAddSheet = useEventCallback(() => {
		setAddSheetOpen(true);
	});

	const handleAddFilter = useEventCallback((processor: string) => {
		setAddSheetOpen(false);
		onCommand({ type: "addFilter", processor });
	});

	const handleDragEnd = useEventCallback((event: DragEndEvent) => {
		const { active, over } = event;
		if (!over || active.id === over.id) return;

		const filters = state.selection?.filters;
		if (!filters) return;

		// Display index IS the array index here: the list is drawn in array order,
		// so the position dropped on needs no conversion.
		const toIndex = filters.findIndex((filter) => filter.uid === over.id);
		if (toIndex === -1) return;

		onCommand({ type: "moveFilter", filterUid: String(active.id), toIndex });
	});

	const { selection } = state;
	if (!selection) {
		return (
			<p className="p-4 text-xs text-muted-foreground text-center">
				{t("companion.nothingSelected")}
			</p>
		);
	}

	// The host's appearance panel draws these in array order — first applied at
	// the top (FilterPanel/index.tsx, "Display in array order"). A remote that
	// disagreed with the screen next to it would move the wrong row.
	const displayedFilters = selection.filters;

	return (
		<div className="flex flex-col gap-4 p-3">
			<p className="text-xs text-muted-foreground">
				{t("companion.selectedCount", { count: selection.count })}
			</p>

			<SliderRow
				label={t("filterPanel.opacity")}
				value={selection.opacity}
				display={`${Math.round(selection.opacity * 100)}%`}
				min={0}
				max={1}
				step={0.01}
				onValueChange={handleOpacityChange}
			/>

			<div className="flex flex-col gap-1">
				<span className="text-xs text-muted-foreground">
					{t("filterPanel.blendMode")}
				</span>
				<SimpleSelect
					items={blendModeItems}
					value={selection.blendMode}
					onValueChange={handleBlendModeChange}
					className="h-11"
				/>
			</div>

			<div className="flex flex-col gap-1">
				<span className="text-xs text-muted-foreground">
					{t("filterPanel.compositionMode")}
				</span>
				<SimpleSelect
					items={compositionModeItems}
					value={selection.compositionMode}
					onValueChange={handleCompositionModeChange}
					className="h-11"
				/>
			</div>

			<section className="flex flex-col gap-2">
				<h2 className="text-xs text-muted-foreground">
					{t("companion.appearances")}
				</h2>

				{selection.filters.length === 0 ? (
					<p className="text-xs text-muted-foreground py-2">
						{t("companion.noAppearances")}
					</p>
				) : (
					<DndContext
						sensors={sensors}
						collisionDetection={closestCenter}
						modifiers={DND_MODIFIERS}
						onDragEnd={handleDragEnd}
					>
						<SortableContext
							items={displayedFilters.map((filter) => filter.uid)}
							strategy={verticalListSortingStrategy}
						>
							<ul className="flex flex-col gap-2">
								{displayedFilters.map((filter, index) => (
									<FilterRow
										key={filter.uid}
										filter={filter}
										displayIndex={index}
										displayCount={displayedFilters.length}
										onCommand={onCommand}
									/>
								))}
							</ul>
						</SortableContext>
					</DndContext>
				)}

				<button
					type="button"
					onClick={handleOpenAddSheet}
					className="flex items-center gap-2 min-h-11 px-3 rounded-lg border border-border bg-muted/30 text-sm"
				>
					<Plus size={16} />
					{t("companion.addAppearance")}
				</button>

				{/* The host's own catalog sheet, in the bottom drawer the host uses for
				    it on a phone. The remote edits appearances on an element, never on
				    another appearance, hence isSubFilter={false}. */}
				<Drawer.Root
					open={addSheetOpen}
					swipeDirection="down"
					onOpenChange={setAddSheetOpen}
				>
					<Drawer.Content mode="bottom">
						{/* The catalog scrolls within the drawer; the pane behind it
						    must not grow to fit the list. */}
						<div className="flex flex-1 min-h-0 flex-col overflow-y-auto overscroll-contain">
							<AddFilterSheet isSubFilter={false} onAdd={handleAddFilter} />
						</div>
					</Drawer.Content>
				</Drawer.Root>
			</section>
		</div>
	);
});

const FilterRow = memo(function FilterRow({
	filter,
	displayIndex,
	displayCount,
	onCommand,
}: {
	filter: CompanionFilter;
	displayIndex: number;
	displayCount: number;
	onCommand: (command: CompanionCommand) => void;
}) {
	const t = useTranslation();
	const [expanded, setExpanded] = useState(false);
	const {
		attributes,
		listeners,
		setNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({ id: filter.uid });

	const canMoveUp = displayIndex > 0;
	const canMoveDown = displayIndex < displayCount - 1;

	const handleToggleExpanded = useEventCallback(() => {
		setExpanded((prev) => !prev);
	});

	const handleEnabledChange = useEventCallback((enabled: boolean) => {
		onCommand({ type: "updateFilter", filterUid: filter.uid, enabled });
	});

	const handleRemove = useEventCallback(() => {
		onCommand({ type: "removeFilter", filterUid: filter.uid });
	});

	// Display index IS the array index: the list is drawn in array order, so a
	// step up the screen is a step back through the array and a step down is a
	// step forward.
	const handleMoveUp = useEventCallback(() => {
		onCommand({
			type: "moveFilter",
			filterUid: filter.uid,
			toIndex: displayIndex - 1,
		});
	});

	const handleMoveDown = useEventCallback(() => {
		onCommand({
			type: "moveFilter",
			filterUid: filter.uid,
			toIndex: displayIndex + 1,
		});
	});

	const handleParamsUpdate = useEventCallback(
		(params: Record<string, unknown>) => {
			onCommand({ type: "updateFilter", filterUid: filter.uid, params });
		},
	);

	const nameKey = getFilterNameKey(filter.processor);

	// The controls read the host's own filter shape, and paramData crossed the
	// wire whole precisely so it still is one. Only its static type was widened
	// on the way, because the protocol cannot name every processor's params.
	const schemaFilter = filter as unknown as Filter;

	return (
		<li
			ref={setNodeRef}
			style={{
				transform: CSS.Transform.toString(transform),
				transition,
				opacity: isDragging ? 0.5 : 1,
			}}
			className="rounded-lg border border-border bg-muted/30"
		>
			<div className="flex items-center">
				{/* The row itself opens the appearance's controls, so dragging starts
				    from a grip of its own rather than from the row surface. */}
				<button
					type="button"
					aria-label={t("companion.dragToReorder")}
					{...attributes}
					{...listeners}
					className="size-11 flex items-center justify-center shrink-0 text-muted-foreground touch-none cursor-grab active:cursor-grabbing"
				>
					<GripVertical size={16} />
				</button>
				<button
					type="button"
					onClick={handleToggleExpanded}
					className="flex-1 min-w-0 min-h-11 flex items-center gap-2 px-3 text-sm text-left"
				>
					{expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
					<span className="truncate">
						{nameKey ? t(nameKey) : filter.processor}
					</span>
				</button>
				<div className="size-11 flex items-center justify-center shrink-0">
					<Switch
						aria-label={t("companion.toggleAppearance")}
						checked={filter.enabled}
						onCheckedChange={handleEnabledChange}
					/>
				</div>
				<button
					type="button"
					aria-label={t("companion.removeAppearance")}
					onClick={handleRemove}
					className="size-11 flex items-center justify-center shrink-0 text-muted-foreground"
				>
					<Trash2 size={16} />
				</button>
			</div>

			{expanded && (
				<div className="flex items-center px-3">
					<button
						type="button"
						aria-label={t("companion.moveUp")}
						onClick={handleMoveUp}
						disabled={!canMoveUp}
						className="size-11 flex items-center justify-center shrink-0 text-muted-foreground disabled:opacity-30"
					>
						<ChevronUp size={16} />
					</button>
					<button
						type="button"
						aria-label={t("companion.moveDown")}
						onClick={handleMoveDown}
						disabled={!canMoveDown}
						className="size-11 flex items-center justify-center shrink-0 text-muted-foreground disabled:opacity-30"
					>
						<ChevronDown size={16} />
					</button>
				</div>
			)}

			{expanded && (
				<div
					className={twm(
						"px-3 pb-3 space-y-2 overflow-x-auto",
						!filter.enabled && "opacity-50",
					)}
				>
					<FilterEffectControls
						filter={schemaFilter}
						onUpdate={handleParamsUpdate}
					/>
				</div>
			)}
		</li>
	);
});

/** The same processor→name mapping the host's filter panel labels its rows
 *  with; null for a processor this build has no name for. */
function getFilterNameKey(processor: string): LocalizeKeys | null {
	return FILTER_TEXT_KEYS[processor as keyof typeof FILTER_TEXT_KEYS] ?? null;
}
