import { DndContext, useDroppable } from "@dnd-kit/core";
import {
	SortableContext,
	verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import {
	Bookmark,
	Check,
	PaintBucket,
	Pen,
	Plus,
	Sparkles,
	Squircle,
	X,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useSnapshot } from "valtio";
import { FakeInput } from "@/components/FakeInput";
import { IconButton } from "@/components/IconButton";
import { Separator } from "@/components/Separator";
import { toastManager } from "@/components/Toast";
import { Tooltip } from "@/components/Tooltip";
import { usePaplico } from "@/contexts/PaplicoContext";
import { type AppearancePreset, isAppearancePresetRef } from "@/core/schema";
import { deepClone } from "@/core/utils/lang";
import { AppearancePresetsDialog } from "@/dialogs/AppearancePresetsDialog";
import { useFirstSelectedElement } from "@/hooks/paplico/useFirstSelectedElement";
import { useAppearancePresets } from "@/hooks/useAppearancePresets";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";
import { twm } from "@/utils/tailwind";
import { AddFilterButton } from "./AddFilterButton";
import { ElementInlineControls } from "./AppearanceInlineControls";
import { AppearancePresetList } from "./AppearancePresetList";
import { AppearancePresetMenu } from "./AppearancePresetMenu";
import { AppearanceSurface } from "./AppearanceSurface";
import { getElementTypeIcon, getElementTypeLabelKey } from "./constants";
import { createDefaultFilter } from "./createDefaultFilter";
import { ElementAppearanceControls } from "./ElementAppearanceControls";
import { FilterItem } from "./FilterItem";
import { FilterStackProvider } from "./FilterStackContext";
import { PresetRefItem } from "./PresetRefItem";
import {
	FILTER_DND_MODIFIERS,
	STACK_DROP_ID,
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
	// Whether the selected row's settings surface is showing. Kept apart from
	// the selection so closing the surface leaves the row highlighted.
	const [surfaceOpen, setSurfaceOpen] = useState(false);
	const [presetsDialogOpen, setPresetsDialogOpen] = useState(false);
	const library = useAppearancePresets();
	// Snapshots are deeply readonly; presets are only read here.
	const documentPresets = (useSnapshot(store).document.appearancePresets ??
		[]) as readonly AppearancePreset[];
	// While a preset is being edited the stack shows its filters and every
	// stack operation writes to the preset instead of the element.
	const [editingPresetUid, setEditingPresetUid] = useState<string | null>(null);
	const editingPreset =
		documentPresets.find((p) => p.uid === editingPresetUid) ?? null;
	// What the preset looked like when the edit began, for "discard".
	const editStartPresetRef = useRef<AppearancePreset | null>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: captured once per edit session
	useEffect(() => {
		editStartPresetRef.current = editingPreset
			? deepClone(editingPreset)
			: null;
	}, [editingPreset?.uid]);
	const stack = useMemo(
		() =>
			editingPreset
				? commands.appearancePresetFilterStack(editingPreset.uid)
				: commands.selectedElementFilterStack(),
		[commands, editingPreset],
	);

	// Close popovers when the edited stack changes
	const selectedElementId = selectedElement?.id ?? null;
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset on element change
	useEffect(() => {
		setSelectedFilterIndex(null);
		setSurfaceOpen(false);
	}, [selectedElementId, editingPreset?.uid]);

	const sensors = useFilterPanelSensors();

	const filters = editingPreset
		? editingPreset.filters
		: (selectedElement?.filters ?? []);

	// Determine if the selected filter is an appearance (fill/stroke)
	const selectedFilter =
		selectedFilterIndex !== null && selectedFilterIndex < filters.length
			? filters[selectedFilterIndex]
			: null;
	const isAppearanceSelected =
		selectedFilter != null &&
		!isAppearancePresetRef(selectedFilter) &&
		(selectedFilter.processor === "fill" ||
			selectedFilter.processor === "stroke");

	const handleAddFilter = useEventCallback(
		(processor: string, asSubFilter: boolean) => {
			const newFilter = createDefaultFilter(processor);
			if (!newFilter) return;

			if (asSubFilter && isAppearanceSelected && selectedFilterIndex !== null) {
				stack.addSubFilter(selectedFilterIndex, newFilter);
			} else {
				stack.addFilter(newFilter);
			}
		},
	);

	const handleSelectElementHeader = useEventCallback(() => {
		setSelectedFilterIndex(null);
		setSurfaceOpen(true);
	});

	const handleEditMask = useEventCallback(() => {
		if (!selectedElement?.mask) return;
		maskEdit.enter(selectedElement.id);
	});

	const handleSelectFilter = useEventCallback((index: number) => {
		setSurfaceOpen(selectedFilterIndex !== index || !surfaceOpen);
		setSelectedFilterIndex(index);
	});

	// Library presets live outside the document, so editing one means editing
	// the copy that lands in the document, the same way applying one does.
	const handleEditLibraryPreset = useEventCallback((libraryUid: string) => {
		const uid = library.addToDocument(libraryUid);
		if (uid) setEditingPresetUid(uid);
	});

	const handleRenameEditingPreset = useEventCallback((name: string) => {
		if (!editingPreset || !name) return;
		commands.renameAppearancePreset(editingPreset.uid, name);
	});

	const handleCloseSurface = useEventCallback(() => {
		setSurfaceOpen(false);
	});

	const handleApplyDocumentPreset = useEventCallback((uid: string) => {
		commands.insertAppearancePresetRefToSelectedElements(uid);
	});

	const handleApplyLibraryPreset = useEventCallback((libraryUid: string) => {
		const uid = library.addToDocument(libraryUid);
		if (uid) commands.insertAppearancePresetRefToSelectedElements(uid);
	});

	const handleOpenPresetsDialog = useEventCallback(() => {
		setPresetsDialogOpen(true);
	});

	const handleSaveToLibrary = useEventCallback(
		async (preset: AppearancePreset) => {
			if (!(await library.saveToLibrary(preset))) {
				toastManager.add({ title: t("filterPanel.presetLocalRefsError") });
			}
		},
	);

	const handleExportJson = useEventCallback(
		async (preset: AppearancePreset) => {
			if (!(await library.exportPresetJson(preset))) {
				toastManager.add({ title: t("filterPanel.presetLocalRefsError") });
			}
		},
	);

	// A preset opened from the library edits the library entry, so finishing
	// the edit is when the document copy goes back to the library.
	const handleEndPresetEdit = useEventCallback(() => {
		if (editingPreset) void library.updateInLibrary(editingPreset);
		setEditingPresetUid(null);
	});

	const handleCancelPresetEdit = useEventCallback(() => {
		if (editStartPresetRef.current) {
			commands.restoreAppearancePreset(editStartPresetRef.current);
		}
		setEditingPresetUid(null);
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
			if (isAppearancePresetRef(f)) continue;
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
		commands: {
			reorderFilter: (from, to) => stack.reorderFilter(from, to),
			reorderSubFilter: (i, from, to) => stack.reorderSubFilter(i, from, to),
			moveSubFilter: (from, si, to) => stack.moveSubFilter(from, si, to),
			insertAppearancePresetRef: (presetUid, index) =>
				commands.insertAppearancePresetRefToSelectedElements(presetUid, index),
		},
		addLibraryPresetToDocument: library.addToDocument,
		uidToIndex,
		subFilterParent,
		selectedFilterIndex,
		setSelectedFilterIndex,
	});

	if (!selectedElement && !editingPreset) {
		return (
			<div className="w-52 bg-background/80 backdrop-liquid rounded-lg shadow-lg overflow-hidden">
				<div className="px-3 py-1 border-b border-border flex items-center gap-1.5">
					<span className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground uppercase tracking-wide">
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
		<FilterStackProvider value={stack}>
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

						<span className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground uppercase tracking-wide">
							{t("filterPanel.appearance")}
						</span>

						{!editingPreset && (
							<>
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
							</>
						)}

						<AddFilterButton
							isSubFilter={isAppearanceSelected}
							onAdd={handleAddFilter}
							side="right"
							iconSize={14}
						/>

						{editingPreset && (
							<>
								<Tooltip content={t("filterPanel.presetEditCancel")}>
									<IconButton
										$size="xs"
										$variant="ghost"
										aria-label={t("filterPanel.presetEditCancel")}
										onClick={handleCancelPresetEdit}
									>
										<X size={14} />
									</IconButton>
								</Tooltip>
								<Tooltip content={t("filterPanel.presetEditDone")}>
									<IconButton
										$size="xs"
										$variant="ghost"
										className="text-accent"
										aria-label={t("filterPanel.presetEditDone")}
										onClick={handleEndPresetEdit}
									>
										<Check size={14} />
									</IconButton>
								</Tooltip>
							</>
						)}
					</div>

					<div className="flex-1 overflow-y-auto p-2 space-y-1">
						{editingPreset && (
							<div
								className="flex items-center gap-1.5 px-2"
								title={t("filterPanel.presetEditing")}
							>
								<Bookmark className="shrink-0 text-accent" size={14} />
								<FakeInput
									value={editingPreset.name}
									onChange={handleRenameEditingPreset}
									$behaviour="click"
									$size="xs"
									$side="start"
									className="min-w-0 flex-1"
								/>
							</div>
						)}

						{/* Element type header (non-sortable, always first) */}
						{selectedElement && !editingPreset && (
							<AppearanceSurface.Root
								open={surfaceOpen && selectedFilterIndex === null}
								onOpenChange={setSurfaceOpen}
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
						)}

						{selectedElement && !editingPreset && (
							<Separator className="my-1" />
						)}

						<StackDropZone>
							{filters.length === 0 && (
								<p className="text-muted-foreground text-xs">
									{t("filterPanel.noFiltersApplied")}
								</p>
							)}
							<SortableContext
								items={sortableIds}
								strategy={verticalListSortingStrategy}
							>
								{reversedFilters.map(({ filter, originalIndex }, i) =>
									isAppearancePresetRef(filter) ? (
										<PresetRefItem
											key={filter.uid}
											entry={filter}
											preset={
												documentPresets.find(
													(p) => p.uid === filter.presetUid,
												) ?? null
											}
											index={originalIndex}
											elementId={selectedElement?.id ?? ""}
											sortableId={sortableIds[i]}
											dropIndicator={dropIndicator}
											onEdit={setEditingPresetUid}
										/>
									) : (
										<FilterItem
											key={filter.uid}
											filter={filter}
											index={originalIndex}
											sortableId={sortableIds[i]}
											isSelected={selectedFilterIndex === originalIndex}
											isOpen={
												surfaceOpen && selectedFilterIndex === originalIndex
											}
											onSelect={handleSelectFilter}
											onCloseSurface={handleCloseSurface}
											onAddSubFilter={handleAddFilter}
											dropIndicator={dropIndicator}
										/>
									),
								)}
							</SortableContext>
						</StackDropZone>

						{!editingPreset && selectedElement && (
							<>
								<Separator className="my-1" />

								<AppearancePresetList
									documentPresets={documentPresets}
									libraryPresets={library.persistedPresets}
									onApplyDocumentPreset={handleApplyDocumentPreset}
									onApplyLibraryPreset={handleApplyLibraryPreset}
									onEditDocumentPreset={setEditingPresetUid}
									onEditLibraryPreset={handleEditLibraryPreset}
									onSaveToLibrary={handleSaveToLibrary}
									onExportJson={handleExportJson}
									menu={
										<AppearancePresetMenu
											element={selectedElement}
											library={library}
											onManage={handleOpenPresetsDialog}
											iconSize={12}
										/>
									}
								/>
							</>
						)}
					</div>
				</div>
				<AppearancePresetsDialog
					open={presetsDialogOpen}
					onOpenChange={setPresetsDialogOpen}
					library={library}
					onEditPreset={setEditingPresetUid}
				/>
			</DndContext>
		</FilterStackProvider>
	);
}

/** Catches preset drops that miss every row, so an empty stack still accepts one. */
function StackDropZone({ children }: { children: ReactNode }) {
	const { setNodeRef, isOver } = useDroppable({ id: STACK_DROP_ID });

	return (
		<div
			ref={setNodeRef}
			className={twm(
				"space-y-1 rounded transition-colors",
				isOver ? "bg-accent/20 ring-1 ring-accent/30" : "",
			)}
		>
			{children}
		</div>
	);
}
