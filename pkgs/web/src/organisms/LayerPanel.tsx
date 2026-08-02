import {
	closestCenter,
	DndContext,
	type DragEndEvent,
	type DragOverEvent,
	KeyboardSensor,
	type Modifier,
	MouseSensor,
	TouchSensor,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import {
	SortableContext,
	sortableKeyboardCoordinates,
	useSortable,
	verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
	ArrowLeft,
	ChevronDown,
	ChevronRight,
	Eclipse,
	Eye,
	EyeOff,
	List,
	ListTree,
	Lock,
	LockOpen,
	Plus,
	Spline,
	Squircle,
	Trash2,
	X,
} from "lucide-react";
import {
	memo,
	type ReactNode,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useSnapshot } from "valtio";
import { FakeInput } from "@/components/FakeInput";
import { IconButton } from "@/components/IconButton";
import { SimpleSelect } from "@/components/SimpleSelect";
import { Slider } from "@/components/Slider";
import { Tooltip } from "@/components/Tooltip";
import { usePaplico } from "@/contexts/PaplicoContext";
import { createDefaultLayer } from "@/core/document/factory";
import type { PaplicoSelection } from "@/core/PaplicoSelection";
import {
	type AnyArtObject,
	type BlendMode,
	type Group,
	isBlend,
	isCompoundPath,
	isGroup,
	isMesh,
	TRANSIENT_LAYER_KIND,
} from "@/core/schema";
import { calculateElementBounds } from "@/core/utils/geometry/bounds";
import { setLayerPanelMode, useAppConfig } from "@/hooks/useAppConfig";
import { useBlendModeItems } from "@/hooks/useBlendModeItems";
import { type LocalizeKeys, useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";
import { twm } from "@/utils/tailwind";

export function LayerPanel() {
	const paplico = usePaplico();
	const { uiState: store, commands } = paplico;
	const isReadonly = paplico.isReadonly;

	const snap = useSnapshot(store);
	const t = useTranslation();
	const appSnap = useAppConfig();
	const isSimpleMode = appSnap.layerPanelMode === "simple";

	const { handleDragOver, handleDragEnd, dropIndicator, clearDropIndicator } =
		useLayerPanelDragDrop({
			commands,
			document: {
				layers: snap.document.layers,
				objects: snap.document.objects as Record<string, AnyArtObject>,
			},
		});

	const {
		handleAddLayer,
		handleSelectLayer,
		handleSelectElement,
		handleRenameLayer,
		handleUpdateBlendMode,
		handleUpdateOpacity,
		blendTarget,
	} = useLayerPanelOperations({
		commands,
		selection: paplico.selection,
		document: {
			layers: snap.document.layers,
			objects: snap.document.objects as Record<string, AnyArtObject>,
		},
		selectedElementIds: snap.selectedElementIds,
		currentLayerId: snap.currentLayerId,
		t,
	});

	const [expandedLayerIds, setExpandedLayerIds] = useState<Set<string>>(
		() => new Set(snap.currentLayerId ? [snap.currentLayerId] : []),
	);
	const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

	const snappedObjects = snap.document.objects as Record<string, AnyArtObject>;

	const selectedIdsSet = useMemo(
		() => new Set(snap.selectedElementIds as string[]),
		[snap.selectedElementIds],
	);

	const scrollContainerRef = useRef<HTMLDivElement>(null);

	// Depend on the first selected id's VALUE, not the snapshot array: document
	// mutations (e.g. visibility toggles) recreate the array with identical
	// contents, and scrolling on those would yank the panel back to the
	// selection even though it didn't change.
	const firstSelectedId = snap.selectedElementIds[0] as string | undefined;
	useEffect(() => {
		if (!firstSelectedId || !scrollContainerRef.current) return;

		const container = scrollContainerRef.current;
		const raf = requestAnimationFrame(() => {
			const target = container.querySelector(
				`[data-element-id="${globalThis.CSS.escape(firstSelectedId)}"]`,
			);
			target?.scrollIntoView({ block: "nearest", behavior: "smooth" });
		});
		return () => cancelAnimationFrame(raf);
	}, [firstSelectedId]);

	const layerBlendModeItems = useBlendModeItems();

	const toggleGroup = useEventCallback((groupId: string) => {
		setExpandedGroups((prev) => {
			const next = new Set(prev);
			if (next.has(groupId)) {
				next.delete(groupId);
			} else {
				next.add(groupId);
			}
			return next;
		});
	});

	const sensors = useLayerPanelSensors();

	const handleDeleteLayer = useEventCallback((layerId: string) =>
		commands.deleteLayer(layerId),
	);
	const handleToggleLayerVisibility = useEventCallback((layerId: string) =>
		commands.toggleLayerVisibility(layerId),
	);
	const handleToggleLayerLock = useEventCallback((layerId: string) =>
		commands.toggleLayerLock(layerId),
	);
	const handleToggleElementVisibility = useEventCallback(
		(layerId: string, elementId: string) =>
			commands.toggleElementVisibility(layerId, elementId),
	);
	const handleToggleElementLock = useEventCallback(
		(layerId: string, elementId: string) =>
			commands.toggleElementLock(layerId, elementId),
	);
	const handleRenameElement = useEventCallback(
		(layerId: string, elementId: string, name: string | undefined) =>
			commands.updateElement(layerId, elementId, { name }),
	);
	const handleRenameLayerById = useEventCallback(
		(layerId: string, name: string | undefined) =>
			commands.renameLayer(layerId, name ?? ""),
	);

	const toggleLayerExpansion = useEventCallback((layerId: string) => {
		setExpandedLayerIds((prev) => {
			const next = new Set(prev);
			if (next.has(layerId)) {
				next.delete(layerId);
			} else {
				next.add(layerId);
			}
			return next;
		});
	});

	// While a mask is being edited the panel narrows to that mask's working
	// layer: everything else is dimmed out on the canvas and out of the tools'
	// reach, so listing it would only offer rows that do nothing.
	const maskEditOwnerId = snap.maskEditSession?.ownerId ?? null;
	const isMaskSession = maskEditOwnerId != null;
	const displayedLayers = useMemo(() => {
		const reversed = [...snap.document.layers].reverse();
		if (!maskEditOwnerId) return reversed;
		return reversed.filter(
			(layer) => layer.transientKind === TRANSIENT_LAYER_KIND.MASK_EDIT,
		);
	}, [snap.document.layers, maskEditOwnerId]);

	const layerSortIds = useMemo(
		() => displayedLayers.map((layer) => `layer-sort-${layer.id}`),
		[displayedLayers],
	);

	const editingScopeStack = snap.editingScopeStack;
	const editingScopeId =
		editingScopeStack.length > 0
			? (editingScopeStack[editingScopeStack.length - 1] as string)
			: null;
	const scopeElement = editingScopeId
		? (snap.document.objects[editingScopeId] as AnyArtObject | undefined)
		: null;

	const handleExitEditingScope = useEventCallback(() => {
		paplico.selection.exitEditingScopeOneLevel();
	});

	// Editing a group implies looking at its contents, so it starts expanded.
	// A plain state update (not disabling the toggle) keeps it foldable like
	// any other group.
	useEffect(() => {
		if (!editingScopeId) return;
		setExpandedGroups((prev) =>
			prev.has(editingScopeId) ? prev : new Set(prev).add(editingScopeId),
		);
	}, [editingScopeId]);

	return (
		<DndContext
			sensors={sensors}
			collisionDetection={closestCenter}
			modifiers={DND_MODIFIERS}
			onDragOver={handleDragOver}
			onDragEnd={handleDragEnd}
			onDragCancel={clearDropIndicator}
		>
			<div className="w-52 max-h-[30dvh] bg-background/80 backdrop-liquid rounded-lg shadow-lg flex flex-col overflow-hidden">
				<div className="px-3 py-1 border-b border-border flex items-center justify-between shrink-0">
					{scopeElement ? (
						<EditingScopeHeader
							scopeElement={scopeElement}
							onExit={handleExitEditingScope}
						/>
					) : (
						<>
							<div className="flex items-center gap-0.5">
								<span className="text-xs/none font-medium text-muted-foreground uppercase tracking-wide">
									{t("layerPanel.layers")}
								</span>
								<Tooltip
									content={
										isSimpleMode
											? t("layerPanel.detailedMode")
											: t("layerPanel.simpleMode")
									}
								>
									<IconButton
										$size="xs"
										$variant="ghost"
										onClick={() =>
											setLayerPanelMode(isSimpleMode ? "detailed" : "simple")
										}
									>
										{isSimpleMode ? <List size={14} /> : <ListTree size={14} />}
									</IconButton>
								</Tooltip>
							</div>
							{!isReadonly && (
								<IconButton
									$size="xs"
									$variant="ghost"
									onClick={handleAddLayer}
								>
									<Plus size={14} />
								</IconButton>
							)}
						</>
					)}
				</div>

				<div
					ref={scrollContainerRef}
					className="flex-1 overflow-y-auto p-1.5 space-y-0.5"
				>
					{scopeElement ? (
						// The scope element's own container row. Its children render
						// as a nested, indented list via SortableElementItem's own
						// expand machinery (same as expanding any other group in the
						// normal layer list) — no separate flat list needed here.
						<SortableElementItem
							key={scopeElement.id}
							element={scopeElement}
							index={0}
							layerId={snap.currentLayerId ?? ""}
							isSelected={selectedIdsSet.has(scopeElement.id)}
							onSelectFromList={handleSelectElement}
							onToggleVisibility={handleToggleElementVisibility}
							onToggleLock={handleToggleElementLock}
							depth={0}
							objects={snappedObjects}
							expandedGroups={expandedGroups}
							onToggleGroup={toggleGroup}
							selectedIdsSet={selectedIdsSet}
							dropIndicator={dropIndicator}
							onRenameElement={handleRenameElement}
							disableDrag
						/>
					) : (
						<SortableContext
							key="layers"
							items={layerSortIds}
							strategy={verticalListSortingStrategy}
						>
							{displayedLayers.map((layer) => {
								// In normalized model, elementIds contains top-level element IDs
								const topLevelElements = layer.elementIds
									.map((id) => snappedObjects[id])
									.filter((el): el is AnyArtObject => el != null);
								const reversedTopLevel = [...topLevelElements].reverse();

								return (
									<SortableLayerSection
										key={layer.id}
										layerId={layer.id}
										layerName={
											layer.transientKind === TRANSIENT_LAYER_KIND.MASK_EDIT
												? t("maskEdit.layerName")
												: layer.name
										}
										isActive={snap.currentLayerId === layer.id}
										isVisible={layer.visible}
										isLocked={layer.locked}
										isExpanded={expandedLayerIds.has(layer.id)}
										onToggleExpansion={toggleLayerExpansion}
										onSelect={handleSelectLayer}
										onDelete={handleDeleteLayer}
										onToggleVisibility={handleToggleLayerVisibility}
										onToggleLock={handleToggleLayerLock}
										onRename={handleRenameLayerById}
										canDelete={snap.document.layers.length > 1}
										dropIndicator={dropIndicator}
										isReadonly={isReadonly}
										hideExpansionToggle={isSimpleMode && !isMaskSession}
									>
										{/* A mask session overrides both the panel mode and the
										    expansion state: it narrows the panel to this one layer
										    precisely so its contents can be worked on, and simple mode
										    draws no element rows at all, so obeying either would leave
										    a header with nothing under it. */}
										{(!isSimpleMode || isMaskSession) &&
											(expandedLayerIds.has(layer.id) || isMaskSession) &&
											topLevelElements.length > 0 && (
												<div className="ml-6 space-y-0.5">
													<SortableContext
														items={reversedTopLevel.map((el) => el.id)}
														strategy={verticalListSortingStrategy}
													>
														{reversedTopLevel.map((element) => {
															const originalIndex = topLevelElements.findIndex(
																(el) => el.id === element.id,
															);
															return (
																<SortableElementItem
																	key={element.id}
																	element={element}
																	index={originalIndex}
																	layerId={layer.id}
																	isSelected={selectedIdsSet.has(element.id)}
																	onSelectFromList={handleSelectElement}
																	onToggleVisibility={
																		handleToggleElementVisibility
																	}
																	onToggleLock={handleToggleElementLock}
																	depth={0}
																	objects={snappedObjects}
																	expandedGroups={expandedGroups}
																	onToggleGroup={toggleGroup}
																	selectedIdsSet={selectedIdsSet}
																	dropIndicator={dropIndicator}
																	onRenameElement={handleRenameElement}
																/>
															);
														})}
													</SortableContext>
												</div>
											)}
									</SortableLayerSection>
								);
							})}
						</SortableContext>
					)}
				</div>

				{blendTarget && (
					<div className="border-t border-border p-2 space-y-1.5 shrink-0">
						<FakeInput
							value={blendTarget.name}
							onChange={(n) => handleRenameLayer(n ?? "")}
							$size="xs"
							className="text-foreground cursor-text"
						/>
						<SimpleSelect
							$size="sm"
							items={layerBlendModeItems}
							value={blendTarget.blendMode}
							onValueChange={(value) =>
								handleUpdateBlendMode(value as BlendMode)
							}
						/>
						<div className="flex items-center justify-between gap-2">
							<span className="text-[10px] text-muted-foreground">
								{t("layerPanel.opacity")}
							</span>
							<span className="text-[10px] text-foreground font-mono tabular-nums">
								{Math.round(blendTarget.opacity * 100)}%
							</span>
						</div>
						<Slider
							min={0}
							max={1}
							step={0.01}
							value={blendTarget.opacity}
							onValueChange={handleUpdateOpacity}
						/>
					</div>
				)}
			</div>
		</DndContext>
	);
}

interface SortableElementItemProps {
	element: AnyArtObject;
	index: number;
	layerId: string;
	isSelected: boolean;
	onSelectFromList: (
		element: AnyArtObject,
		layerId: string,
		event: MouseEvent,
	) => void;
	onToggleVisibility: (layerId: string, elementId: string) => void;
	onToggleLock: (layerId: string, elementId: string) => void;
	depth?: number;
	objects: Readonly<Record<string, AnyArtObject>>;
	expandedGroups: Set<string>;
	onToggleGroup: (groupId: string) => void;
	selectedIdsSet: Set<string>;
	isClipPath?: boolean;
	isSpine?: boolean;
	parentContainerId?: string;
	dropIndicator: DropIndicator;
	onRenameElement: (
		layerId: string,
		elementId: string,
		name: string | undefined,
	) => void;
	/** Disables drag-and-drop reordering (used for the editing group's own container row) */
	disableDrag?: boolean;
}

type DropIndicator = {
	overId: string;
	position: "before" | "after";
} | null;

export type DragEndAction =
	| { type: "reorderLayers"; oldIndex: number; newIndex: number }
	| {
			type: "reorderElements";
			layerId: string;
			oldIndex: number;
			newIndex: number;
	  }
	| {
			type: "moveElementToLayer";
			sourceLayerId: string;
			elementIndex: number;
			targetLayerId: string;
			targetIndex?: number;
	  }
	| {
			type: "extractSourceFromCompoundPath";
			compoundPathId: string;
			sourceId: string;
			targetLayerId: string;
			targetIndex?: number;
	  }
	| {
			type: "reorderCompoundPathSource";
			compoundPathId: string;
			fromIndex: number;
			toIndex: number;
	  }
	| {
			type: "extractChildFromGroup";
			groupId: string;
			childId: string;
			targetLayerId: string;
			targetIndex?: number;
	  }
	| {
			type: "reorderGroupChildren";
			groupId: string;
			fromIndex: number;
			toIndex: number;
	  }
	| {
			type: "extractChildFromBlend";
			blendId: string;
			childId: string;
			targetLayerId: string;
			targetIndex?: number;
	  }
	| {
			type: "reorderBlendChildren";
			blendId: string;
			fromIndex: number;
			toIndex: number;
	  };

type LayerSortData = { type: "layer"; layerId: string };
type ElementSortData = {
	type: "element";
	layerId: string;
	index: number;
	parentContainerId?: string;
};
type SortData = LayerSortData | ElementSortData;

export function resolveDragEndAction(
	event: DragEndEvent,
	document: {
		layers: readonly {
			readonly id: string;
			readonly elementIds: readonly string[];
		}[];
		objects: Readonly<Record<string, AnyArtObject>>;
	},
): DragEndAction | null {
	const { active, over } = event;
	if (!over || active.id === over.id) return null;

	const activeData = active.data.current as SortData | undefined;
	const overData = over.data.current as SortData | undefined;
	if (!activeData) return null;

	// Layer reorder
	if (activeData.type === "layer") {
		const sourceLayerId = activeData.layerId;
		const targetLayerId =
			overData?.type === "layer" || overData?.type === "element"
				? overData.layerId
				: null;
		if (!targetLayerId || sourceLayerId === targetLayerId) return null;

		const oldIndex = document.layers.findIndex((l) => l.id === sourceLayerId);
		const newIndex = document.layers.findIndex((l) => l.id === targetLayerId);
		if (oldIndex === -1 || newIndex === -1) return null;

		return { type: "reorderLayers", oldIndex, newIndex };
	}

	if (activeData.type !== "element") return null;

	const sourceLayerId = activeData.layerId;
	const elementIndex = activeData.index;

	const activeParent = activeData.parentContainerId
		? document.objects[activeData.parentContainerId]
		: undefined;
	const overParent =
		overData?.type === "element" && overData.parentContainerId
			? document.objects[overData.parentContainerId]
			: undefined;

	// Blend child: a key can be reordered within its blend (draw order) or
	// extracted out to a layer. The spine is display-only (not a reorderable
	// key), so it is never draggable.
	if (activeParent && isBlend(activeParent)) {
		const blendId = activeData.parentContainerId;
		if (!blendId) return null;
		if (String(active.id) === activeParent.spineSourceId) return null;

		// → Layer header: extract to the end of the layer.
		if (overData?.type === "layer") {
			return {
				type: "extractChildFromBlend",
				blendId,
				childId: String(active.id),
				targetLayerId: overData.layerId,
			};
		}

		if (overData?.type === "element") {
			// Same blend → reorder paint order (renderOrder, defaults to objectIds).
			if (overData.parentContainerId === blendId) {
				const order = activeParent.renderOrder ?? activeParent.objectIds;
				const fromIndex = order.indexOf(String(active.id));
				const toIndex = order.indexOf(String(over.id));
				if (fromIndex !== -1 && toIndex !== -1) {
					return { type: "reorderBlendChildren", blendId, fromIndex, toIndex };
				}
				return null;
			}
			// Out to a top-level element → extract at that position.
			if (!overData.parentContainerId) {
				const layer = document.layers.find((l) => l.id === overData.layerId);
				if (!layer) return null;
				const overIdx = layer.elementIds.indexOf(String(over.id));
				return {
					type: "extractChildFromBlend",
					blendId,
					childId: String(active.id),
					targetLayerId: overData.layerId,
					targetIndex: overIdx !== -1 ? overIdx : undefined,
				};
			}
		}
		// Onto another container's child, or anything else → no-op.
		return null;
	}

	// Dropping a foreign element onto a blend child is not supported.
	if (overParent && isBlend(overParent)) return null;

	// Element → Layer header
	if (overData?.type === "layer") {
		const targetLayerId = overData.layerId;
		const activeContainerId = activeData.parentContainerId;

		if (activeContainerId) {
			const container = document.objects[activeContainerId];
			if (container && isCompoundPath(container)) {
				return {
					type: "extractSourceFromCompoundPath",
					compoundPathId: activeContainerId,
					sourceId: String(active.id),
					targetLayerId,
				};
			}
			if (container && (isGroup(container) || isMesh(container))) {
				// A mesh container stores its children in childIds exactly like a
				// group, and the group commands operate on childIds generically.
				return {
					type: "extractChildFromGroup",
					groupId: activeContainerId,
					childId: String(active.id),
					targetLayerId,
				};
			}
		}

		if (sourceLayerId !== targetLayerId) {
			return {
				type: "moveElementToLayer",
				sourceLayerId,
				elementIndex,
				targetLayerId,
			};
		}
		return null;
	}

	// Element → Element
	if (overData?.type === "element") {
		const targetLayerId = overData.layerId;
		const activeContainerId = activeData.parentContainerId;
		const overContainerId = overData.parentContainerId;

		// Same container → reorder children
		if (activeContainerId && activeContainerId === overContainerId) {
			const container = document.objects[activeContainerId];
			if (container && isCompoundPath(container)) {
				const cp = container;
				const fromIndex = cp.sources.findIndex(
					(s) => s.id === String(active.id),
				);
				const toIndex = cp.sources.findIndex((s) => s.id === String(over.id));
				if (fromIndex !== -1 && toIndex !== -1) {
					return {
						type: "reorderCompoundPathSource",
						compoundPathId: activeContainerId,
						fromIndex,
						toIndex,
					};
				}
			}
			if (container && (isGroup(container) || isMesh(container))) {
				const g = container;
				const fromIndex = g.childIds.indexOf(String(active.id));
				const toIndex = g.childIds.indexOf(String(over.id));
				if (fromIndex !== -1 && toIndex !== -1) {
					return {
						type: "reorderGroupChildren",
						groupId: activeContainerId,
						fromIndex,
						toIndex,
					};
				}
			}
			return null;
		}

		// Drag out of container to top-level
		if (activeContainerId && !overContainerId) {
			const container = document.objects[activeContainerId];
			if (container && isCompoundPath(container)) {
				const layer = document.layers.find((l) => l.id === targetLayerId);
				if (!layer) return null;

				const overIdx = layer.elementIds.indexOf(String(over.id));
				return {
					type: "extractSourceFromCompoundPath",
					compoundPathId: activeContainerId,
					sourceId: String(active.id),
					targetLayerId,
					targetIndex: overIdx !== -1 ? overIdx : undefined,
				};
			}
			if (container && (isGroup(container) || isMesh(container))) {
				const layer = document.layers.find((l) => l.id === targetLayerId);
				if (!layer) return null;

				const overIdx = layer.elementIds.indexOf(String(over.id));
				return {
					type: "extractChildFromGroup",
					groupId: activeContainerId,
					childId: String(active.id),
					targetLayerId,
					targetIndex: overIdx !== -1 ? overIdx : undefined,
				};
			}
			return null;
		}

		// Same layer → reorder elements
		if (sourceLayerId === targetLayerId) {
			const layer = document.layers.find((l) => l.id === sourceLayerId);
			if (!layer) return null;

			const oldIndex = layer.elementIds.indexOf(String(active.id));
			const newIndex = layer.elementIds.indexOf(String(over.id));
			if (oldIndex !== -1 && newIndex !== -1) {
				return {
					type: "reorderElements",
					layerId: sourceLayerId,
					oldIndex,
					newIndex,
				};
			}
			return null;
		}

		// Cross-layer move
		const targetLayer = document.layers.find((l) => l.id === targetLayerId);
		if (!targetLayer) return null;

		const targetIndex = targetLayer.elementIds.indexOf(String(over.id));
		if (targetIndex !== -1) {
			return {
				type: "moveElementToLayer",
				sourceLayerId,
				elementIndex,
				targetLayerId,
				targetIndex,
			};
		}
	}

	return null;
}

type ConfirmDeleteButtonProps = {
	onConfirm: () => void;
	confirmLabel?: string;
	timeoutMs?: number;
	icon: ReactNode;
	disabled?: boolean;
	className?: string;
	isActive: boolean;
};

const ConfirmDeleteButton = memo(function ConfirmDeleteButton({
	onConfirm,
	confirmLabel = "削除する",
	timeoutMs = 2500,
	icon,
	disabled,
	className,
	isActive,
}: ConfirmDeleteButtonProps) {
	const [state, setState] = useState<"idle" | "confirming">("idle");
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const buttonRef = useRef<HTMLButtonElement | null>(null);

	const clearTimer = () => {
		if (timerRef.current != null) {
			clearTimeout(timerRef.current);
			timerRef.current = null;
		}
	};

	const resetToIdle = useEventCallback(() => {
		clearTimer();
		setState("idle");
	});

	const handleClick = useEventCallback((e: React.MouseEvent) => {
		e.stopPropagation();
		if (state === "idle") {
			setState("confirming");
			timerRef.current = setTimeout(resetToIdle, timeoutMs);
		} else {
			clearTimer();
			setState("idle");
			onConfirm();
		}
	});

	useEffect(() => {
		if (state !== "confirming") return;
		const handlePointerDown = (e: PointerEvent) => {
			if (!buttonRef.current?.contains(e.target as Node)) resetToIdle();
		};
		document.addEventListener("pointerdown", handlePointerDown);
		return () => document.removeEventListener("pointerdown", handlePointerDown);
	}, [state, resetToIdle]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: clearTimer is stable (only uses a ref)
	useEffect(() => () => clearTimer(), []);

	const isConfirming = state === "confirming";

	return (
		<div className="relative inline-grid place-items-center size-5 align-bottom">
			<button
				ref={buttonRef}
				type="button"
				disabled={disabled}
				onClick={handleClick}
				className={twm(
					"absolute right-0 inline-flex items-center size-5 px-1 py-1 justify-center gap-1 rounded-sm shrink-0",
					"transition-[width,background-color,color,padding] duration-150",
					"disabled:pointer-events-none disabled:opacity-50 whitespace-nowrap",
					isActive
						? "text-accent-foreground hover:bg-accent"
						: "text-accent hover:text-accent-foreground hover:bg-accent",
					isConfirming &&
						"flex-row-reverse bg-danger text-danger-foreground hover:bg-danger-hover w-fit",
					className,
				)}
			>
				{icon}
				{isConfirming && (
					<span className="text-[11px] leading-none font-semibold">
						{confirmLabel}
					</span>
				)}
			</button>
		</div>
	);
});

const SortableElementItem = memo(function SortableElementItem({
	element,
	index,
	layerId,
	isSelected,
	onSelectFromList,
	onToggleVisibility,
	onToggleLock,
	depth = 0,
	objects,
	expandedGroups,
	onToggleGroup,
	selectedIdsSet,
	isClipPath,
	isSpine,
	parentContainerId,
	dropIndicator,
	onRenameElement,
	disableDrag,
}: SortableElementItemProps) {
	const paplico = usePaplico();
	const { commands } = paplico;
	const isReadonly = paplico.isReadonly;
	const t = useTranslation();
	const {
		attributes,
		listeners,
		setNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({
		id: element.id,
		disabled: disableDrag,
		data: {
			type: "element",
			layerId,
			index,
			parentContainerId,
		},
	});

	const style = {
		transform: CSS.Transform.toString(transform),
		transition,
		opacity: isDragging ? 0.5 : 1,
	};

	const handleToggleVisibility = useEventCallback((e: React.MouseEvent) => {
		e.stopPropagation();
		onToggleVisibility(layerId, element.id);
	});

	const handleToggleLock = useEventCallback((e: React.MouseEvent) => {
		e.stopPropagation();
		onToggleLock(layerId, element.id);
	});

	const isGroupElement = isGroup(element);
	const isCompoundPathElement = isCompoundPath(element);
	const isBlendElement = isBlend(element);
	const isMeshElement = isMesh(element);
	const isExpandable =
		isGroupElement || isCompoundPathElement || isBlendElement || isMeshElement;
	const isExpanded = isExpandable && expandedGroups.has(element.id);
	const ownClipPathId = isGroup(element) ? element.clipPathId : null;
	const ownSpineId = isBlend(element) ? element.spineSourceId : null;

	// Get child elements only when expanded to avoid unnecessary object lookups
	const childElements = isExpanded
		? isGroup(element) || isMesh(element)
			? element.childIds
					.map((id) => objects[id])
					.filter((el): el is AnyArtObject => el != null)
			: isCompoundPath(element)
				? [...element.sources]
						.reverse()
						.map((s) => objects[s.id])
						.filter((el): el is AnyArtObject => el != null)
				: isBlend(element)
					? [
							// Reverse so the front-most (last-painted) key sits at the top of
							// the panel, matching the top-level list (reversedTopLevel) and the
							// canvas z-order. renderOrder/objectIds index 0 is the back-most,
							// painted first. The spine guide stays at the bottom.
							...[...(element.renderOrder ?? element.objectIds)].reverse(),
							...(element.spineSourceId ? [element.spineSourceId] : []),
						]
							.map((id) => objects[id])
							.filter((el): el is AnyArtObject => el != null)
					: []
		: [];

	const showIndicatorBefore =
		dropIndicator?.overId === element.id && dropIndicator.position === "before";
	const showIndicatorAfter =
		dropIndicator?.overId === element.id && dropIndicator.position === "after";

	return (
		<>
			{showIndicatorBefore && (
				<div className="h-0.5 bg-accent rounded-full mx-1" />
			)}
			{/* biome-ignore lint/a11y/noStaticElementInteractions: TODO */}
			{/* biome-ignore lint/a11y/useKeyWithClickEvents: TODO */}
			<div
				ref={setNodeRef}
				data-element-id={element.id}
				style={{ ...style, paddingLeft: `${depth * 12 + 8}px` }}
				{...attributes}
				{...listeners}
				className={`w-full text-left rounded py-1 pr-2 text-xs transition-colors ${
					disableDrag ? "cursor-pointer" : "cursor-grab active:cursor-grabbing"
				} ${
					isSelected
						? "bg-accent/30 text-accent-foreground"
						: "bg-muted/30 text-muted-foreground hover:bg-accent/20"
				}`}
				onClick={(e) => onSelectFromList(element, layerId, e.nativeEvent)}
			>
				<div className="flex items-center justify-between gap-2">
					<div className="flex-1 truncate">
						<div className="flex items-center gap-1">
							{isExpandable && (
								<button
									type="button"
									className="p-0.5 -ml-1 hover:bg-muted rounded"
									onClick={(e) => {
										e.stopPropagation();
										onToggleGroup(element.id);
									}}
								>
									{isExpanded ? (
										<ChevronDown size={10} />
									) : (
										<ChevronRight size={10} />
									)}
								</button>
							)}

							{isClipPath && <Eclipse size={10} />}
							{isSpine && <Spline size={10} />}
							{element.mask && (
								<Tooltip content={t("layerPanel.hasMask")}>
									<Squircle size={10} />
								</Tooltip>
							)}

							<FakeInput
								value={element.name}
								placeholder={getElementTypeLabel(element, t)}
								onChange={(n) => onRenameElement(layerId, element.id, n)}
								disabled={isDragging}
								$size="xs"
								className={twm(
									"flex-1 cursor-text",
									isSelected && "font-medium",
								)}
							/>

							{isExpandable && (
								<span className="text-[9px] opacity-50">
									(
									{isGroup(element)
										? element.childIds.length
										: isCompoundPath(element)
											? element.sources.length
											: isBlend(element)
												? element.objectIds.length
												: 0}
									)
								</span>
							)}
						</div>
					</div>
					<div className="flex gap-0">
						{!isReadonly && (
							<IconButton
								$size="xs"
								$variant="ghost"
								onClick={handleToggleLock}
							>
								{element.locked ? (
									<Lock size={10} className="opacity-60" />
								) : (
									<LockOpen size={10} className="opacity-30" />
								)}
							</IconButton>
						)}
						<IconButton
							$size="xs"
							$variant="ghost"
							onClick={handleToggleVisibility}
						>
							{element.visible !== false ? (
								<Eye size={10} className="opacity-60" />
							) : (
								<EyeOff size={10} className="opacity-40" />
							)}
						</IconButton>
						{!isReadonly && (
							<ConfirmDeleteButton
								icon={<X size={10} />}
								onConfirm={() => commands.deleteElements([element.id])}
								isActive={isSelected}
							/>
						)}
					</div>
				</div>
			</div>
			{/* Render children if expanded */}
			{isExpandable && isExpanded && (
				<SortableContext
					items={childElements.map((el) => el.id)}
					strategy={verticalListSortingStrategy}
				>
					<div className="space-y-0.5">
						{childElements.map((child, childIndex) => (
							<SortableElementItem
								key={child.id}
								element={child}
								index={childIndex}
								layerId={layerId}
								isSelected={selectedIdsSet.has(child.id)}
								onSelectFromList={onSelectFromList}
								onToggleVisibility={onToggleVisibility}
								onToggleLock={onToggleLock}
								depth={depth + 1}
								objects={objects}
								expandedGroups={expandedGroups}
								onToggleGroup={onToggleGroup}
								selectedIdsSet={selectedIdsSet}
								isClipPath={ownClipPathId === child.id}
								isSpine={ownSpineId === child.id}
								parentContainerId={element.id}
								dropIndicator={dropIndicator}
								onRenameElement={onRenameElement}
							/>
						))}
					</div>
				</SortableContext>
			)}
			{showIndicatorAfter && (
				<div className="h-0.5 bg-accent rounded-xl mx-1" />
			)}
		</>
	);
});

interface DroppableLayerHeaderProps {
	layerName: string;
	isActive: boolean;
	isVisible: boolean;
	isExpanded: boolean;
	onToggleExpansion: () => void;
	onSelect: () => void;
	onDelete: () => void;
	onToggleVisibility: () => void;
	onToggleLock: () => void;
	isLocked: boolean;
	onRename: (name: string | undefined) => void;
	canDelete: boolean;
	isOver: boolean;
	isReadonly?: boolean;
	hideExpansionToggle?: boolean;
	disableRename?: boolean;
}

const DroppableLayerHeader = memo(function DroppableLayerHeader({
	layerName,
	isActive,
	isVisible,
	isExpanded,
	onToggleExpansion,
	onSelect,
	onDelete,
	onToggleVisibility,
	onToggleLock,
	isLocked,
	onRename,
	canDelete,
	isOver,
	isReadonly,
	hideExpansionToggle,
	disableRename,
}: DroppableLayerHeaderProps) {
	return (
		<div className="flex items-center gap-0.5">
			{!hideExpansionToggle && (
				<IconButton
					$size="xs"
					$variant="ghost"
					onClick={onToggleExpansion}
					className="shrink-0"
				>
					{isExpanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
				</IconButton>
			)}
			{/* biome-ignore lint/a11y/noStaticElementInteractions: layer row with click/dblclick */}
			{/* biome-ignore lint/a11y/useKeyWithClickEvents: TODO */}
			<div
				onClick={onSelect}
				onDoubleClick={onToggleExpansion}
				className={twm(
					"flex-1 py-1 pr-2 rounded text-left text-xs transition-colors cursor-pointer text-accent-foreground",
					isActive
						? "bg-accent/80"
						: "text-muted-foreground hover:bg-accent/20",
					isOver ? "ring-1 ring-accent" : "",
				)}
			>
				<div className="flex items-center justify-between gap-2">
					<FakeInput
						value={layerName}
						onChange={(n) => onRename(n)}
						disabled={disableRename}
						$size="xs"
						className={twm(
							"flex-1 truncate pl-2 cursor-text",
							isActive ? "font-medium text-accent-foreground" : "",
						)}
					/>
					<div className="flex gap-0.5">
						{!isReadonly && (
							<IconButton
								$size="xs"
								$variant="ghost"
								className={twm(
									"rounded",
									isActive
										? "text-accent-foreground hover:bg-accent"
										: "text-accent hover:text-accent-foreground hover:bg-accent",
								)}
								onClick={onToggleLock}
							>
								{isLocked ? (
									<Lock size={10} />
								) : (
									<LockOpen size={10} className="opacity-60" />
								)}
							</IconButton>
						)}
						<IconButton
							$size="xs"
							$variant="ghost"
							className={twm(
								"rounded",
								isActive
									? "text-accent-foreground hover:bg-accent"
									: "text-accent hover:text-accent-foreground hover:bg-accent",
							)}
							onClick={onToggleVisibility}
						>
							{isVisible ? (
								<Eye size={10} />
							) : (
								<EyeOff size={10} className="opacity-60" />
							)}
						</IconButton>
						{!isReadonly && (
							<ConfirmDeleteButton
								icon={<Trash2 size={10} />}
								isActive={isActive}
								onConfirm={onDelete}
								disabled={!canDelete}
							/>
						)}
					</div>
				</div>
			</div>
		</div>
	);
});

interface SortableLayerSectionProps
	extends Omit<
		DroppableLayerHeaderProps,
		| "isOver"
		| "onToggleExpansion"
		| "onSelect"
		| "onDelete"
		| "onToggleVisibility"
		| "onToggleLock"
		| "onRename"
	> {
	layerId: string;
	children?: ReactNode;
	dropIndicator: DropIndicator;
	onToggleExpansion: (layerId: string) => void;
	onSelect: (layerId: string) => void;
	onDelete: (layerId: string) => void;
	onToggleVisibility: (layerId: string) => void;
	onToggleLock: (layerId: string) => void;
	onRename: (layerId: string, name: string | undefined) => void;
}

const SortableLayerSection = memo(function SortableLayerSection({
	layerId,
	children,
	dropIndicator,
	onToggleExpansion,
	onSelect,
	onDelete,
	onToggleVisibility,
	onToggleLock,
	onRename,
	...headerProps
}: SortableLayerSectionProps) {
	const {
		attributes,
		listeners,
		setNodeRef,
		transform,
		transition,
		isDragging,
		isOver,
	} = useSortable({
		id: `layer-sort-${layerId}`,
		data: {
			type: "layer",
			layerId,
		},
	});

	const style = {
		transform: CSS.Transform.toString(transform),
		transition,
		opacity: isDragging ? 0.5 : 1,
	};

	const sortId = `layer-sort-${layerId}`;
	const showIndicatorBefore =
		dropIndicator?.overId === sortId && dropIndicator.position === "before";
	const showIndicatorAfter =
		dropIndicator?.overId === sortId && dropIndicator.position === "after";

	const handleToggleExpansion = useEventCallback(() =>
		onToggleExpansion(layerId),
	);
	const handleSelect = useEventCallback(() => onSelect(layerId));
	const handleDelete = useEventCallback(() => onDelete(layerId));
	const handleToggleVisibility = useEventCallback(() =>
		onToggleVisibility(layerId),
	);
	const handleToggleLock = useEventCallback(() => onToggleLock(layerId));
	const handleRename = useEventCallback((name: string | undefined) =>
		onRename(layerId, name),
	);

	return (
		<>
			{showIndicatorBefore && (
				<div className="h-0.5 bg-accent rounded-full mx-1" />
			)}
			<div ref={setNodeRef} style={style} className="space-y-0.5">
				<div {...attributes} {...listeners}>
					<DroppableLayerHeader
						{...headerProps}
						onToggleExpansion={handleToggleExpansion}
						onSelect={handleSelect}
						onDelete={handleDelete}
						onToggleVisibility={handleToggleVisibility}
						onToggleLock={handleToggleLock}
						onRename={handleRename}
						isOver={isOver}
						disableRename={isDragging}
					/>
				</div>
				{!isDragging && children}
			</div>
			{showIndicatorAfter && (
				<div className="h-0.5 bg-accent rounded-full mx-1" />
			)}
		</>
	);
});

interface EditingScopeHeaderProps {
	scopeElement: AnyArtObject;
	onExit: () => void;
}

const EditingScopeHeader = memo(function EditingScopeHeader({
	scopeElement,
	onExit,
}: EditingScopeHeaderProps) {
	const t = useTranslation();

	const scopeName = scopeElement.name || getElementTypeLabel(scopeElement, t);

	return (
		<>
			<IconButton $size="xs" $variant="ghost" onClick={onExit}>
				<ArrowLeft size={14} />
			</IconButton>
			<span className="text-xs/none font-medium text-foreground truncate flex-1 ml-1">
				{scopeName}
			</span>
		</>
	);
});

function useLayerPanelDragDrop(deps: {
	commands: {
		reorderLayers: (oldIndex: number, newIndex: number) => void;
		reorderElements: (
			layerId: string,
			oldIndex: number,
			newIndex: number,
		) => void;
		moveElementToLayer: (
			sourceLayerId: string,
			elementIndex: number,
			targetLayerId: string,
			targetIndex?: number,
		) => void;
		extractSourceFromCompoundPath: (
			compoundPathId: string,
			sourceId: string,
			targetLayerId: string,
			targetIndex?: number,
		) => void;
		reorderCompoundPathSource: (
			compoundPathId: string,
			fromIndex: number,
			toIndex: number,
		) => void;
		extractChildFromGroup: (
			groupId: string,
			childId: string,
			layerId: string,
			insertIndex?: number,
		) => void;
		reorderGroupChildren: (
			groupId: string,
			fromIndex: number,
			toIndex: number,
		) => void;
		extractChildFromBlend: (
			blendId: string,
			childId: string,
			layerId: string,
			insertIndex?: number,
		) => void;
		reorderBlendChildren: (
			blendId: string,
			fromIndex: number,
			toIndex: number,
		) => void;
	};
	document: {
		layers: readonly {
			readonly id: string;
			readonly elementIds: readonly string[];
		}[];
		objects: Readonly<Record<string, AnyArtObject>>;
	};
}) {
	const [dropIndicator, setDropIndicator] = useState<DropIndicator>(null);

	const handleDragOver = useEventCallback((event: DragOverEvent) => {
		const { over, active } = event;
		if (!over || active.id === over.id) {
			setDropIndicator(null);
			return;
		}

		const activeRect = active.rect.current.translated;
		const overRect = over.rect;
		if (!activeRect || !overRect) {
			setDropIndicator(null);
			return;
		}

		const activeCenterY = activeRect.top + activeRect.height / 2;
		const overCenterY = overRect.top + overRect.height / 2;
		setDropIndicator({
			overId: String(over.id),
			position: activeCenterY < overCenterY ? "before" : "after",
		});
	});

	const handleDragEnd = useEventCallback((event: DragEndEvent) => {
		setDropIndicator(null);

		const action = resolveDragEndAction(event, deps.document);
		if (!action) return;

		const { commands } = deps;
		switch (action.type) {
			case "reorderLayers":
				commands.reorderLayers(action.oldIndex, action.newIndex);
				break;
			case "reorderElements":
				commands.reorderElements(
					action.layerId,
					action.oldIndex,
					action.newIndex,
				);
				break;
			case "moveElementToLayer":
				commands.moveElementToLayer(
					action.sourceLayerId,
					action.elementIndex,
					action.targetLayerId,
					action.targetIndex,
				);
				break;
			case "extractSourceFromCompoundPath":
				commands.extractSourceFromCompoundPath(
					action.compoundPathId,
					action.sourceId,
					action.targetLayerId,
					action.targetIndex,
				);
				break;
			case "reorderCompoundPathSource":
				commands.reorderCompoundPathSource(
					action.compoundPathId,
					action.fromIndex,
					action.toIndex,
				);
				break;
			case "extractChildFromGroup":
				commands.extractChildFromGroup(
					action.groupId,
					action.childId,
					action.targetLayerId,
					action.targetIndex,
				);
				break;
			case "reorderGroupChildren":
				commands.reorderGroupChildren(
					action.groupId,
					action.fromIndex,
					action.toIndex,
				);
				break;
			case "extractChildFromBlend":
				commands.extractChildFromBlend(
					action.blendId,
					action.childId,
					action.targetLayerId,
					action.targetIndex,
				);
				break;
			case "reorderBlendChildren":
				commands.reorderBlendChildren(
					action.blendId,
					action.fromIndex,
					action.toIndex,
				);
				break;
		}
	});

	const clearDropIndicator = useEventCallback(() => setDropIndicator(null));

	return { handleDragOver, handleDragEnd, dropIndicator, clearDropIndicator };
}

function useLayerPanelOperations(deps: {
	commands: {
		addLayer: (layer: ReturnType<typeof createDefaultLayer>) => void;
		renameLayer: (layerId: string, name: string) => void;
		updateLayerBlendMode: (layerId: string, blendMode: BlendMode) => void;
		updateLayerOpacity: (layerId: string, opacity: number) => void;
	};
	selection: Pick<
		PaplicoSelection,
		"setCurrentLayer" | "selectElement" | "toggleElement" | "selectMultiple"
	>;
	document: {
		layers: readonly {
			readonly id: string;
			readonly name: string;
			readonly elementIds: readonly string[];
			readonly blendMode?: BlendMode;
			readonly opacity: number;
		}[];
		objects: Readonly<Record<string, AnyArtObject>>;
	};
	selectedElementIds: readonly string[];
	currentLayerId: string | null;
	t: (key: string) => string;
}) {
	const selectedLayer = deps.currentLayerId
		? deps.document.layers.find((layer) => layer.id === deps.currentLayerId)
		: null;

	const blendTarget = selectedLayer
		? {
				id: selectedLayer.id,
				name: selectedLayer.name,
				label: `${deps.t("common.layer")}: ${selectedLayer.name}`,
				blendMode: selectedLayer.blendMode ?? ("normal" as BlendMode),
				opacity: selectedLayer.opacity,
			}
		: null;

	const handleAddLayer = useEventCallback(() => {
		const layerCount = deps.document.layers.length;
		const newLayerId = `layer-${Date.now()}`;
		const newLayerName = `Layer ${layerCount + 1}`;
		const newLayer = createDefaultLayer(newLayerId, newLayerName);
		deps.commands.addLayer(newLayer);
		deps.selection.setCurrentLayer(newLayerId);
	});

	const handleSelectLayer = useEventCallback((layerId: string) => {
		deps.selection.setCurrentLayer(layerId);
	});

	const handleSelectElement = useEventCallback(
		(element: AnyArtObject, layerId: string, event: MouseEvent) => {
			const isMetaOrCtrl = event.metaKey || event.ctrlKey;
			const isShift = event.shiftKey;

			if (isMetaOrCtrl) {
				const bounds = calculateElementBounds(element);
				deps.selection.toggleElement(element.id, bounds);
			} else if (isShift && deps.selectedElementIds.length > 0) {
				const layer = deps.document.layers.find((l) => l.id === layerId);
				if (!layer) return;
				// Reverse to match display order (last = top)
				const displayIds = [...layer.elementIds].reverse();
				const lastSelectedId = deps.selectedElementIds.at(-1);
				if (!lastSelectedId) return;
				const anchorIdx = displayIds.indexOf(lastSelectedId);
				const targetIdx = displayIds.indexOf(element.id);
				if (anchorIdx < 0 || targetIdx < 0) return;
				const [from, to] =
					anchorIdx < targetIdx
						? [anchorIdx, targetIdx]
						: [targetIdx, anchorIdx];
				const rangeIds = displayIds.slice(from, to + 1);
				deps.selection.selectMultiple(rangeIds);
			} else {
				const bounds = calculateElementBounds(element);
				deps.selection.selectElement(element.id, bounds);
			}
		},
	);

	const handleRenameLayer = useEventCallback((name: string) => {
		if (!blendTarget) return;
		deps.commands.renameLayer(blendTarget.id, name);
	});

	const handleUpdateBlendMode = useEventCallback((value: BlendMode) => {
		if (!blendTarget) return;
		deps.commands.updateLayerBlendMode(blendTarget.id, value);
	});

	const handleUpdateOpacity = useEventCallback((value: number) => {
		if (!blendTarget) return;
		deps.commands.updateLayerOpacity(blendTarget.id, value);
	});

	return {
		handleAddLayer,
		handleSelectLayer,
		handleSelectElement,
		handleRenameLayer,
		handleUpdateBlendMode,
		handleUpdateOpacity,
		blendTarget,
	};
}

// --- Helper functions ---

const restrictLayerDragToVertical: Modifier = ({ active, transform }) => {
	if (active?.data?.current?.type !== "layer") return transform;
	return {
		...transform,
		x: 0,
	};
};

function useLayerPanelSensors() {
	return useSensors(
		useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
		useSensor(TouchSensor, {
			activationConstraint: { delay: 200, tolerance: 8 },
		}),
		useSensor(KeyboardSensor, {
			coordinateGetter: sortableKeyboardCoordinates,
		}),
	);
}
const DND_MODIFIERS = [restrictLayerDragToVertical];

export function getElementTypeLabel(
	element: Pick<AnyArtObject, "type">,
	t: (key: LocalizeKeys) => string,
): string {
	switch (element.type) {
		case "path":
			return t("common.path");
		case "image":
			return t("common.image");
		case "group":
			if ((element as Group).clipPathId) return t("common.clipGroup");
			return t("common.group");
		case "text":
			return t("common.text");
		case "compound-path":
			return t("common.compoundPath");
		case "blend":
			return t("common.blend");
		case "mesh":
			return t("common.meshWarp");
		default:
			return t("common.element");
	}
}
