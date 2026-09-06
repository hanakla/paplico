import { useDndContext, useDroppable } from "@dnd-kit/core";
import {
	SortableContext,
	useSortable,
	verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Eye, EyeOff, Trash2 } from "lucide-react";
import { type CSSProperties, memo, type ReactNode } from "react";
import { ColorSwatch } from "@/components/ColorSwatch";
import { IconButton } from "@/components/IconButton";
import type {
	BlurFilter,
	DropShadowFilter,
	FrostGlassFilter,
	PathOffsetFilter,
	PathUnionFilter,
	PixelateFilter,
	PuckerBloatFilter,
	Rotate3DFilter,
	ZigzagFilter,
} from "@/core/renderer/filters";
import type {
	Extrude3DAppearance,
	FillAppearance,
	Filter as FilterType,
	Revolve3DAppearance,
	StrokeAppearance,
} from "@/core/schema";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";
import { twm } from "@/utils/tailwind";
import { AddFilterButton } from "./AddFilterButton";
import {
	AppearanceBaseControls,
	FillAppearanceControls,
	StrokeAppearanceControls,
} from "./AppearanceControls";
import { FilterInlineControls } from "./AppearanceInlineControls";
import { AppearanceSurface } from "./AppearanceSurface";
import { BlurFilterControls } from "./ControlsBlur";
import { DropShadowFilterControls } from "./ControlsDropShadow";
import { Extrude3DFilterControls } from "./ControlsExtrude3D";
import { FrostGlassFilterControls } from "./ControlsFrostGlass";
import { PathOffsetFilterControls } from "./ControlsPathOffset";
import { PathUnionFilterControls } from "./ControlsPathUnion";
import { PixelateFilterControls } from "./ControlsPixelate";
import { PuckerBloatFilterControls } from "./ControlsPuckerBloat";
import { Revolve3DFilterControls } from "./ControlsRevolve3D";
import { Rotate3DFilterControls } from "./ControlsRotate3D";
import { ZigzagFilterControls } from "./ControlsZigzag";
import {
	FILTER_TEXT_KEYS,
	getAppearanceColor,
	getFilterIcon,
} from "./constants";
import { FilterBackdropToggle } from "./FilterBackdropToggle";
import { FilterEffectControls } from "./FilterEffectControls";
import { useFilterStack } from "./FilterStackContext";
import type { FilterDropIndicator } from "./types";

export const FilterItem = memo(function FilterItem({
	filter,
	index,
	sortableId,
	isSelected,
	onSelect,
	onDeselect,
	onAddSubFilter,
	dropIndicator,
}: {
	filter: FilterType;
	index: number;
	sortableId: string;
	isSelected: boolean;
	onSelect: (index: number) => void;
	onDeselect: () => void;
	onAddSubFilter: (processor: string, asSubFilter: boolean) => void;
	dropIndicator: FilterDropIndicator;
}) {
	const stack = useFilterStack();
	const t = useTranslation();
	const {
		attributes,
		listeners,
		setNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({ id: sortableId });

	const handleSelect = useEventCallback((e: React.MouseEvent) => {
		if (
			e.target instanceof Node &&
			e.currentTarget instanceof Node &&
			!e.currentTarget.contains(e.target)
		) {
			return;
		}
		onSelect(index);
	});

	const filterTextKey =
		FILTER_TEXT_KEYS[filter.processor as keyof typeof FILTER_TEXT_KEYS];
	const filterLabel = filterTextKey ? t(filterTextKey) : filter.processor;

	const dragStyle = {
		transform: CSS.Transform.toString(transform),
		transition,
		zIndex: isDragging ? 1 : undefined,
		opacity: isDragging ? 0.5 : undefined,
	} satisfies CSSProperties;

	const showIndicatorBefore =
		dropIndicator != null &&
		dropIndicator.overId === sortableId &&
		dropIndicator.position === "before";
	const showIndicatorAfter =
		dropIndicator != null &&
		dropIndicator.overId === sortableId &&
		dropIndicator.position === "after";

	const isAppearance =
		filter.processor === "fill" || filter.processor === "stroke";
	const appearanceColor = isAppearance
		? getAppearanceColor(filter as FillAppearance | StrokeAppearance)
		: null;
	const showsInlineControls = isAppearance || filter.processor === "content";

	const updateFilter = useEventCallback((params: Record<string, unknown>) =>
		stack.updateFilter(index, { params }),
	);

	const paramsContent = (
		// Stop pointer events from bubbling to dnd-kit listeners on FilterItem
		// to prevent drag activation when interacting with sliders/inputs in the popover
		<div className="space-y-2" onPointerDown={(e) => e.stopPropagation()}>
			<FilterBackdropToggle filter={filter} filterIndex={index} />

			{filter.processor === "fill" && (
				<FillAppearanceControls
					filter={filter as FillAppearance}
					index={index}
				/>
			)}

			{filter.processor === "stroke" && (
				<StrokeAppearanceControls
					filter={filter as StrokeAppearance}
					index={index}
				/>
			)}

			{filter.processor === "content" && (
				<AppearanceBaseControls filter={filter} index={index} />
			)}

			{filter.processor === "blur" && (
				<BlurFilterControls
					filter={filter as BlurFilter}
					onUpdate={updateFilter}
				/>
			)}

			{filter.processor === "frost-glass" && (
				<FrostGlassFilterControls
					filter={filter as FrostGlassFilter}
					onUpdate={updateFilter}
				/>
			)}

			{filter.processor === "zigzag" && (
				<ZigzagFilterControls
					filter={filter as ZigzagFilter}
					onUpdate={updateFilter}
				/>
			)}

			{filter.processor === "drop-shadow" && (
				<DropShadowFilterControls
					filter={filter as DropShadowFilter}
					onUpdate={updateFilter}
				/>
			)}

			{filter.processor === "pixelate" && (
				<PixelateFilterControls
					filter={filter as PixelateFilter}
					onUpdate={updateFilter}
				/>
			)}

			{filter.processor === "path-offset" && (
				<PathOffsetFilterControls
					filter={filter as PathOffsetFilter}
					onUpdate={updateFilter}
				/>
			)}

			{filter.processor === "path-union" && (
				<PathUnionFilterControls
					filter={filter as PathUnionFilter}
					onUpdate={updateFilter}
				/>
			)}

			{filter.processor === "pucker-bloat" && (
				<PuckerBloatFilterControls
					filter={filter as PuckerBloatFilter}
					onUpdate={updateFilter}
				/>
			)}

			{filter.processor.startsWith("hk:") && (
				<FilterEffectControls filter={filter} onUpdate={updateFilter} />
			)}

			{/* Sub-filters for appearances: expanded flat (no indent) in Popover */}
			{filter.processor === "3d-rotate" && (
				<Rotate3DFilterControls
					filter={filter as Rotate3DFilter}
					onUpdate={updateFilter}
				/>
			)}

			{filter.processor === "extrude3d" && (
				<Extrude3DFilterControls
					filter={filter as Extrude3DAppearance}
					onUpdate={updateFilter}
				/>
			)}

			{filter.processor === "revolve3d" && (
				<Revolve3DFilterControls
					filter={filter as Revolve3DAppearance}
					onUpdate={updateFilter}
				/>
			)}

			{isAppearance && (
				<div className="space-y-3">
					<div className="border-t border-border/50" />
					<div className="flex items-center justify-between">
						<div className="text-muted-foreground text-[10px] font-medium uppercase tracking-wider">
							{t("filterPanel.effects")}
						</div>
						<AddFilterButton
							isSubFilter
							onAdd={onAddSubFilter}
							side="left"
							iconSize={12}
						/>
					</div>

					{filter.subFilters &&
						(filter.subFilters as FilterType[]).map((sub, si) => (
							<div key={si} className="space-y-1.5">
								<div className="flex items-center gap-1 text-foreground text-[11px] font-medium">
									{getFilterIcon(sub.processor)}
									{FILTER_TEXT_KEYS[
										sub.processor as keyof typeof FILTER_TEXT_KEYS
									]
										? t(
												FILTER_TEXT_KEYS[
													sub.processor as keyof typeof FILTER_TEXT_KEYS
												],
											)
										: sub.processor}
									<div className="flex-1" />
									<IconButton
										$size="xs"
										$variant="ghost"
										onClick={() => stack.removeSubFilter(index, si)}
									>
										<Trash2 size={10} />
									</IconButton>
								</div>
								<FilterEffectControls
									filter={sub}
									onUpdate={(params) =>
										stack.updateSubFilterParams(index, si, params)
									}
								/>
							</div>
						))}
				</div>
			)}
		</div>
	);

	return (
		<>
			{showIndicatorBefore && (
				<div className="h-0.5 bg-accent rounded-full mx-1" />
			)}
			<div style={dragStyle}>
				{/* biome-ignore lint/a11y/useKeyWithClickEvents: dnd-kit sortable item */}
				{/* biome-ignore lint/a11y/noStaticElementInteractions: dnd-kit sortable item */}
				<div
					ref={setNodeRef}
					{...attributes}
					{...listeners}
					onClick={handleSelect}
					className="rounded"
				>
					<AppearanceSurface.Root
						open={isSelected && !isDragging}
						onSheetDismiss={onDeselect}
					>
						<AppearanceSurface.Trigger>
							<div
								className={`flex items-center justify-between rounded px-2 py-1 transition-colors ${
									isSelected
										? "bg-accent/30 ring-1 ring-accent/30"
										: "hover:bg-accent/10"
								}`}
							>
								<div className="flex min-w-0 items-center gap-1.5">
									{getFilterIcon(filter.processor)}

									<span className="truncate text-foreground text-xs font-medium">
										{filterLabel}
									</span>

									{appearanceColor && (
										<ColorSwatch
											color={appearanceColor.color}
											variant={appearanceColor.variant}
											size={14}
											className="ml-0.5"
										/>
									)}
								</div>

								<div
									className="flex shrink-0 items-center gap-0.5"
									onPointerDown={(e) => e.stopPropagation()}
								>
									<IconButton
										$size="xs"
										$variant="ghost"
										onClick={() =>
											stack.updateFilter(index, {
												enabled: filter.enabled === false,
											})
										}
									>
										{filter.enabled === false ? (
											<EyeOff size={12} />
										) : (
											<Eye size={12} />
										)}
									</IconButton>
									{filter.processor !== "content" && (
										<IconButton
											$size="xs"
											$variant="ghost"
											onClick={() => stack.removeFilter(index)}
										>
											<Trash2 size={12} />
										</IconButton>
									)}
								</div>
							</div>
						</AppearanceSurface.Trigger>
						{showsInlineControls && (
							<div className="px-2 pb-1 pl-4">
								<FilterInlineControls filter={filter} index={index} />
							</div>
						)}
						<AppearanceSurface.Content
							title={
								<>
									{getFilterIcon(filter.processor)}
									<span className="truncate">{filterLabel}</span>
								</>
							}
						>
							{paramsContent}
						</AppearanceSurface.Content>
					</AppearanceSurface.Root>
				</div>

				{/* Sub-filter rows: sortable within appearance, droppable across appearances */}
				{isAppearance && (
					<SubFilterDropZone
						filterUid={filter.uid}
						hasSubFilters={!!filter.subFilters?.length}
					>
						<SortableContext
							items={((filter.subFilters ?? []) as FilterType[]).map(
								(sf) => `sf:${sf.uid}`,
							)}
							strategy={verticalListSortingStrategy}
						>
							{((filter.subFilters ?? []) as FilterType[]).map((sub, si) => (
								<SubFilterRow
									key={sub.uid}
									subFilter={sub}
									parentFilterIndex={index}
									subFilterIndex={si}
									dropIndicator={dropIndicator}
								/>
							))}
						</SortableContext>
					</SubFilterDropZone>
				)}
			</div>
			{showIndicatorAfter && (
				<div className="h-0.5 bg-accent rounded-full mx-1" />
			)}
		</>
	);
});

export function SubFilterDropZone({
	filterUid,
	hasSubFilters,
	children,
}: {
	filterUid: string;
	hasSubFilters: boolean;
	children: ReactNode;
}) {
	const { setNodeRef, isOver } = useDroppable({ id: `drop:${filterUid}` });
	const { active } = useDndContext();
	const isSubDrag = active && String(active.id).startsWith("sf:");

	return (
		<div
			ref={setNodeRef}
			className={twm(
				"space-y-0.5 rounded transition-colors",
				hasSubFilters || isSubDrag ? "pl-4 py-1 min-h-4" : "",
				isSubDrag && isOver ? "bg-accent/20 ring-1 ring-accent/30" : "",
			)}
			onPointerDown={(e) => {
				if (isSubDrag) e.stopPropagation();
			}}
		>
			{children}
		</div>
	);
}

export const SubFilterRow = memo(function SubFilterRow({
	subFilter,
	parentFilterIndex,
	subFilterIndex,
	dropIndicator,
}: {
	subFilter: FilterType;
	parentFilterIndex: number;
	subFilterIndex: number;
	dropIndicator: FilterDropIndicator;
}) {
	const stack = useFilterStack();
	const t = useTranslation();
	const uid = subFilter.uid;
	const sortableId = `sf:${uid}`;
	const {
		attributes,
		listeners,
		setNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({ id: sortableId });

	const style = {
		transform: CSS.Transform.toString(transform),
		transition,
		opacity: isDragging ? 0.5 : undefined,
	} satisfies CSSProperties;

	const showIndicatorBefore =
		dropIndicator != null &&
		dropIndicator.overId === sortableId &&
		dropIndicator.position === "before";
	const showIndicatorAfter =
		dropIndicator != null &&
		dropIndicator.overId === sortableId &&
		dropIndicator.position === "after";

	return (
		<div ref={setNodeRef} style={style}>
			{showIndicatorBefore && (
				<div className="h-0.5 bg-accent rounded-full mx-1" />
			)}
			<div
				{...attributes}
				{...listeners}
				className={twm(
					"flex items-center justify-between px-2 rounded",
					subFilter.enabled === false ? "opacity-50" : "",
				)}
			>
				<div className="flex min-w-0 items-center gap-1">
					{getFilterIcon(subFilter.processor)}
					<span className="truncate text-foreground text-xs">
						{FILTER_TEXT_KEYS[
							subFilter.processor as keyof typeof FILTER_TEXT_KEYS
						]
							? t(
									FILTER_TEXT_KEYS[
										subFilter.processor as keyof typeof FILTER_TEXT_KEYS
									],
								)
							: subFilter.processor}
					</span>
				</div>
				<div
					className="flex shrink-0 items-center gap-0.5"
					onPointerDown={(e) => e.stopPropagation()}
				>
					<IconButton
						$size="xs"
						$variant="ghost"
						onClick={() =>
							stack.updateSubFilter(parentFilterIndex, subFilterIndex, {
								enabled: subFilter.enabled === false,
							})
						}
					>
						{subFilter.enabled === false ? (
							<EyeOff size={12} />
						) : (
							<Eye size={12} />
						)}
					</IconButton>
					<IconButton
						$size="xs"
						$variant="ghost"
						onClick={() =>
							stack.removeSubFilter(parentFilterIndex, subFilterIndex)
						}
					>
						<Trash2 size={12} />
					</IconButton>
				</div>
			</div>
			{showIndicatorAfter && (
				<div className="h-0.5 bg-accent rounded-full mx-1" />
			)}
		</div>
	);
});
