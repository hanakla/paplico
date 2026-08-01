import {
	type CollisionDetection,
	closestCenter,
	type DragEndEvent,
	type DragOverEvent,
	KeyboardSensor,
	type Modifier,
	MouseSensor,
	pointerWithin,
	TouchSensor,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { useMemo, useState } from "react";
import { useEventCallback } from "@/utils/hooks";
import type { FilterDropIndicator } from "./types";

export function useFilterPanelDragDrop(deps: {
	commands: {
		reorderFilter: (fromIndex: number, toIndex: number) => void;
		reorderSubFilter: (
			filterIndex: number,
			fromSubIndex: number,
			toSubIndex: number,
		) => void;
		moveSubFilter: (
			sourceFilterIndex: number,
			sourceSubIndex: number,
			targetFilterIndex: number,
		) => void;
	};
	uidToIndex: Map<string, number>;
	subFilterParent: Map<string, { filterIndex: number; subIndex: number }>;
	selectedFilterIndex: number | null;
	setSelectedFilterIndex: (i: number | null) => void;
}) {
	const [dropIndicator, setDropIndicator] =
		useState<FilterDropIndicator | null>(null);

	const customCollision = useMemo<CollisionDetection>(
		() => (args) => {
			const activeId = String(args.active.id);

			if (activeId.startsWith("sf:")) return pointerWithin(args);

			return closestCenter({
				...args,
				droppableContainers: args.droppableContainers.filter(
					(c) =>
						!String(c.id).startsWith("sf:") &&
						!String(c.id).startsWith("drop:"),
				),
			});
		},
		[],
	);

	const handleDragOver = useEventCallback((event: DragOverEvent) => {
		const { over, active } = event;
		if (!over || active.id === over.id) {
			setDropIndicator(null);
			return;
		}

		if (String(over.id).startsWith("drop:")) {
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

		const { active, over } = event;
		if (!over || active.id === over.id) return;

		const activeId = String(active.id);
		const overId = String(over.id);

		// Sub-filter drag
		if (activeId.startsWith("sf:")) {
			const activeUid = activeId.slice(3);
			const source = deps.subFilterParent.get(activeUid);
			if (!source) return;

			if (overId.startsWith("sf:")) {
				const targetUid = overId.slice(3);
				const target = deps.subFilterParent.get(targetUid);
				if (!target) return;

				if (source.filterIndex === target.filterIndex) {
					deps.commands.reorderSubFilter(
						source.filterIndex,
						source.subIndex,
						target.subIndex,
					);
				} else {
					deps.commands.moveSubFilter(
						source.filterIndex,
						source.subIndex,
						target.filterIndex,
					);
				}
			} else if (overId.startsWith("drop:")) {
				const targetUid = overId.slice(5);
				const targetIndex = deps.uidToIndex.get(targetUid);
				if (targetIndex == null || targetIndex === source.filterIndex) return;
				deps.commands.moveSubFilter(
					source.filterIndex,
					source.subIndex,
					targetIndex,
				);
			}
			return;
		}

		// Top-level filter drag
		const fromIndex = deps.uidToIndex.get(activeId);
		const toIndex = deps.uidToIndex.get(overId);
		if (fromIndex == null || toIndex == null) return;

		deps.commands.reorderFilter(fromIndex, toIndex);

		if (deps.selectedFilterIndex === fromIndex) {
			deps.setSelectedFilterIndex(toIndex);
		} else if (deps.selectedFilterIndex !== null) {
			if (
				fromIndex < deps.selectedFilterIndex &&
				toIndex >= deps.selectedFilterIndex
			) {
				deps.setSelectedFilterIndex(deps.selectedFilterIndex - 1);
			} else if (
				fromIndex > deps.selectedFilterIndex &&
				toIndex <= deps.selectedFilterIndex
			) {
				deps.setSelectedFilterIndex(deps.selectedFilterIndex + 1);
			}
		}
	});

	const clearDropIndicator = useEventCallback(() => setDropIndicator(null));

	return {
		handleDragOver,
		handleDragEnd,
		dropIndicator,
		customCollision,
		clearDropIndicator,
	};
}

export const restrictFilterDragToVertical: Modifier = ({
	active,
	transform,
}) => {
	if (String(active?.id).startsWith("sf:")) return transform;
	return { ...transform, x: 0 };
};

export const FILTER_DND_MODIFIERS = [restrictFilterDragToVertical];

export function useFilterPanelSensors() {
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
