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
	Eye,
	EyeOff,
	GripVertical,
	Lock,
	LockOpen,
	MoreHorizontal,
} from "lucide-react";
import { memo, useState } from "react";
import type {
	CompanionCommand,
	CompanionElement,
	CompanionLayer,
	CompanionState,
} from "@/companion/companionProtocol";
import { SimpleSelect } from "@/components/SimpleSelect";
import { ToggleGroup } from "@/components/ToggleGroup";
import type { AnyArtObject, BlendMode } from "@/core/schema";
import { useBlendModeItems } from "@/hooks/useBlendModeItems";
import { useTranslation } from "@/locales";
import { getElementTypeLabel } from "@/organisms/LayerPanel";
import { useEventCallback } from "@/utils/hooks";
import { twm } from "@/utils/tailwind";
import { SliderRow } from "./SliderRow";
import { DND_MODIFIERS, useCompanionSortSensors } from "./sortable";

type LayerPaneMode = "simple" | "detailed";

/**
 * The layer list as a remote can use it.
 *
 * The two modes mean the same thing they mean in the host's own layer panel:
 * simple draws the layers alone, detailed lets a layer open up to the objects
 * inside it. Everything a row can do is available in both — the mode decides
 * how far down the list goes, not how much of a row you get.
 */
export const LayerPane = memo(function LayerPane({
	state,
	onCommand,
}: {
	state: CompanionState;
	onCommand: (command: CompanionCommand) => void;
}) {
	const t = useTranslation();
	const [mode, setMode] = useState<LayerPaneMode>("simple");
	const sensors = useCompanionSortSensors();

	const handleModeChange = useEventCallback((value: string[]) => {
		const next = value[0];
		if (next === "simple" || next === "detailed") setMode(next);
	});

	// state.layers arrives bottom-first, the order the document stores. The host's
	// own layer panel draws the topmost layer first, and a remote that disagreed
	// with the screen next to it would point at the wrong row.
	const displayedLayers = [...state.layers].reverse();
	const layerIds = displayedLayers.map((layer) => layer.id);

	const handleDragEnd = useEventCallback((event: DragEndEvent) => {
		const { active, over } = event;
		if (!over || active.id === over.id) return;

		const toDisplayIndex = layerIds.indexOf(String(over.id));
		if (toDisplayIndex === -1) return;

		// Display index → array index: the list is drawn topmost-first while
		// state.layers runs bottom-first, so display position d counts back from
		// the end of the array.
		onCommand({
			type: "moveLayer",
			layerId: String(active.id),
			toIndex: layerIds.length - 1 - toDisplayIndex,
		});
	});

	return (
		<div className="flex flex-col gap-3 p-3">
			<ToggleGroup.Root
				className="w-full"
				value={[mode]}
				onValueChange={handleModeChange}
			>
				<ToggleGroup.Item
					className="flex-1 min-w-0 size-auto h-11"
					value="simple"
				>
					{t("companion.layerModeSimple")}
				</ToggleGroup.Item>
				<ToggleGroup.Item
					className="flex-1 min-w-0 size-auto h-11"
					value="detailed"
				>
					{t("companion.layerModeDetailed")}
				</ToggleGroup.Item>
			</ToggleGroup.Root>

			{state.layers.length === 0 ? (
				<p className="text-xs text-muted-foreground text-center py-4">
					{t("companion.noLayers")}
				</p>
			) : (
				<DndContext
					sensors={sensors}
					collisionDetection={closestCenter}
					modifiers={DND_MODIFIERS}
					onDragEnd={handleDragEnd}
				>
					<SortableContext
						items={layerIds}
						strategy={verticalListSortingStrategy}
					>
						<ul className="flex flex-col gap-2">
							{displayedLayers.map((layer, index) => (
								<LayerRow
									key={layer.id}
									layer={layer}
									current={layer.id === state.currentLayerId}
									expandable={mode === "detailed"}
									displayIndex={index}
									displayCount={displayedLayers.length}
									onCommand={onCommand}
								/>
							))}
						</ul>
					</SortableContext>
				</DndContext>
			)}
		</div>
	);
});

const LayerRow = memo(function LayerRow({
	layer,
	current,
	expandable,
	displayIndex,
	displayCount,
	onCommand,
}: {
	layer: CompanionLayer;
	current: boolean;
	expandable: boolean;
	displayIndex: number;
	displayCount: number;
	onCommand: (command: CompanionCommand) => void;
}) {
	const t = useTranslation();
	const blendModeItems = useBlendModeItems();
	const [expanded, setExpanded] = useState(false);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const {
		attributes,
		listeners,
		setNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({ id: layer.id });

	const canMoveUp = displayIndex > 0;
	const canMoveDown = displayIndex < displayCount - 1;

	const handleToggleExpanded = useEventCallback(() => {
		setExpanded((prev) => !prev);
	});

	const handleToggleSettings = useEventCallback(() => {
		setSettingsOpen((prev) => !prev);
	});

	const handleSelect = useEventCallback(() => {
		onCommand({ type: "selectLayer", layerId: layer.id });
	});

	const handleToggleVisible = useEventCallback(() => {
		onCommand({
			type: "setLayerVisible",
			layerId: layer.id,
			visible: !layer.visible,
		});
	});

	const handleToggleLocked = useEventCallback(() => {
		onCommand({
			type: "setLayerLocked",
			layerId: layer.id,
			locked: !layer.locked,
		});
	});

	// Display index → array index: the list is drawn topmost-first while
	// state.layers runs bottom-first, so display position d sits at array index
	// displayCount - 1 - d. A step up the screen is therefore a step forward
	// through the document array, and a step down the screen a step back.
	const arrayIndex = displayCount - 1 - displayIndex;

	const handleMoveUp = useEventCallback(() => {
		onCommand({
			type: "moveLayer",
			layerId: layer.id,
			toIndex: arrayIndex + 1,
		});
	});

	const handleMoveDown = useEventCallback(() => {
		onCommand({
			type: "moveLayer",
			layerId: layer.id,
			toIndex: arrayIndex - 1,
		});
	});

	const handleOpacityChange = useEventCallback((value: number) => {
		onCommand({ type: "setLayerOpacity", layerId: layer.id, value });
	});

	const handleBlendModeChange = useEventCallback((value: string) => {
		onCommand({
			type: "setLayerBlendMode",
			layerId: layer.id,
			blendMode: value as BlendMode,
		});
	});

	const handleSelectElement = useEventCallback(
		(e: React.MouseEvent<HTMLButtonElement>) => {
			const elementId = e.currentTarget.dataset.elementId;
			if (elementId) onCommand({ type: "selectElement", elementId });
		},
	);

	const handleToggleElementVisible = useEventCallback(
		(e: React.MouseEvent<HTMLButtonElement>) => {
			const { elementId, visible } = e.currentTarget.dataset;
			if (!elementId) return;
			onCommand({
				type: "setElementVisible",
				layerId: layer.id,
				elementId,
				visible: visible !== "true",
			});
		},
	);

	// The host paints the last element on top and lists it first; the same list
	// read in the opposite order would point at the wrong object on the canvas.
	const displayedElements = [...layer.elements].reverse();

	return (
		<li
			ref={setNodeRef}
			style={{
				transform: CSS.Transform.toString(transform),
				transition,
				opacity: isDragging ? 0.5 : 1,
			}}
			className={twm(
				"rounded-lg border",
				current ? "border-accent bg-accent/10" : "border-border bg-muted/30",
			)}
		>
			<div className="relative flex items-center">
				{/* Selecting the layer is the row's main gesture, so it gets the whole
				    row surface. The toggles cannot live inside that button — a button
				    may not nest one — so it is laid underneath them instead, and the
				    name rides on top without taking clicks of its own. */}
				<button
					type="button"
					aria-label={layer.name}
					onClick={handleSelect}
					className="absolute inset-0 rounded-lg"
				/>
				{/* The whole row is a tap target for selecting the layer, so dragging
				    has to start somewhere that taking the gesture costs nothing. */}
				<button
					type="button"
					aria-label={t("companion.dragToReorder")}
					{...attributes}
					{...listeners}
					className="relative size-11 flex items-center justify-center shrink-0 text-muted-foreground touch-none cursor-grab active:cursor-grabbing"
				>
					<GripVertical size={16} />
				</button>
				{expandable && (
					<button
						type="button"
						aria-label={t("companion.toggleLayerElements")}
						onClick={handleToggleExpanded}
						className="relative size-11 flex items-center justify-center shrink-0 text-muted-foreground"
					>
						{expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
					</button>
				)}
				<span className="flex-1 min-w-0 min-h-11 flex items-center px-3 text-sm truncate pointer-events-none">
					{layer.name}
				</span>
				<button
					type="button"
					aria-label={t("companion.toggleLayerVisibility")}
					onClick={handleToggleVisible}
					className="relative size-11 flex items-center justify-center shrink-0 text-muted-foreground"
				>
					{layer.visible ? <Eye size={16} /> : <EyeOff size={16} />}
				</button>
				<button
					type="button"
					aria-label={t("companion.toggleLayerLock")}
					onClick={handleToggleLocked}
					className="relative size-11 flex items-center justify-center shrink-0 text-muted-foreground"
				>
					{layer.locked ? <Lock size={16} /> : <LockOpen size={16} />}
				</button>
				<button
					type="button"
					aria-label={t("companion.layerSettings")}
					onClick={handleToggleSettings}
					className={twm(
						"relative size-11 flex items-center justify-center shrink-0",
						settingsOpen ? "text-foreground" : "text-muted-foreground",
					)}
				>
					<MoreHorizontal size={16} />
				</button>
			</div>

			{settingsOpen && (
				<div className="flex flex-col gap-2 px-3 pb-3">
					<div className="flex items-center">
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
					<SliderRow
						label={t("filterPanel.opacity")}
						value={layer.opacity}
						display={`${Math.round(layer.opacity * 100)}%`}
						min={0}
						max={1}
						step={0.01}
						onValueChange={handleOpacityChange}
					/>
					<SimpleSelect
						items={blendModeItems}
						value={layer.blendMode}
						onValueChange={handleBlendModeChange}
						className="h-11"
					/>
				</div>
			)}

			{expandable && expanded && displayedElements.length > 0 && (
				<ul className="flex flex-col border-t border-border/60">
					{displayedElements.map((element) => (
						<ElementRow
							key={element.id}
							element={element}
							onSelect={handleSelectElement}
							onToggleVisible={handleToggleElementVisible}
						/>
					))}
				</ul>
			)}
		</li>
	);
});

const ElementRow = memo(function ElementRow({
	element,
	onSelect,
	onToggleVisible,
}: {
	element: CompanionElement;
	onSelect: (e: React.MouseEvent<HTMLButtonElement>) => void;
	onToggleVisible: (e: React.MouseEvent<HTMLButtonElement>) => void;
}) {
	const t = useTranslation();

	// The same names the host's layer panel gives its rows. The wire carries the
	// type as a plain string, and the label function's default arm answers for
	// anything it does not know, so widening it here costs nothing at runtime.
	// A clip group is told apart by its clipPathId, which the protocol does not
	// carry, so clip groups read as plain groups here.
	const typeLabel = getElementTypeLabel(
		{ type: element.type as AnyArtObject["type"] },
		t,
	);

	return (
		<li className="flex items-center pl-3">
			<button
				type="button"
				data-element-id={element.id}
				onClick={onSelect}
				className={twm(
					"flex-1 min-w-0 min-h-11 px-2 text-xs text-left truncate",
					element.selected
						? "text-accent font-medium"
						: "text-muted-foreground",
				)}
			>
				{element.name ?? typeLabel}
			</button>
			<button
				type="button"
				aria-label={t("companion.toggleElementVisibility")}
				data-element-id={element.id}
				data-visible={element.visible}
				onClick={onToggleVisible}
				className="size-11 flex items-center justify-center shrink-0 text-muted-foreground"
			>
				{element.visible ? <Eye size={14} /> : <EyeOff size={14} />}
			</button>
		</li>
	);
});
