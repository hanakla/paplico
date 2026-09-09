import type { DragEndEvent, DragOverEvent } from "@dnd-kit/core";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
	STACK_DROP_ID,
	useFilterPanelDragDrop,
} from "./useFilterPanelDragDrop";

function setup() {
	const commands = {
		reorderFilter: vi.fn(),
		reorderSubFilter: vi.fn(),
		moveSubFilter: vi.fn(),
		insertAppearancePresetRef: vi.fn(),
	};
	const addLibraryPresetToDocument = vi.fn(() => "doc-uid");
	const hook = renderHook(() =>
		useFilterPanelDragDrop({
			commands,
			addLibraryPresetToDocument,
			uidToIndex: new Map([
				["f-a", 0],
				["f-b", 1],
			]),
			subFilterParent: new Map(),
			selectedFilterIndex: null,
			setSelectedFilterIndex: vi.fn(),
		}),
	);
	return { commands, addLibraryPresetToDocument, hook };
}

function dragOver(activeId: string, overId: string, activeTop: number) {
	return {
		active: {
			id: activeId,
			rect: { current: { translated: { top: activeTop, height: 20 } } },
		},
		over: { id: overId, rect: { top: 100, height: 20 } },
	} as unknown as DragOverEvent;
}

function dragEnd(activeId: string, overId: string | null) {
	return {
		active: { id: activeId },
		over: overId ? { id: overId } : null,
	} as unknown as DragEndEvent;
}

describe("useFilterPanelDragDrop preset drags", () => {
	it("should insert a document preset ref before the row when dropped above its center", () => {
		const { commands, hook } = setup();

		act(() =>
			hook.result.current.handleDragOver(dragOver("preset:ap-1", "f-b", 80)),
		);
		act(() => hook.result.current.handleDragEnd(dragEnd("preset:ap-1", "f-b")));

		expect(commands.insertAppearancePresetRef.mock.calls[0]).toEqual([
			"ap-1",
			1,
		]);
	});

	it("should insert after the row when dropped below its center", () => {
		const { commands, hook } = setup();

		act(() =>
			hook.result.current.handleDragOver(dragOver("preset:ap-1", "f-a", 120)),
		);
		act(() => hook.result.current.handleDragEnd(dragEnd("preset:ap-1", "f-a")));

		expect(commands.insertAppearancePresetRef.mock.calls[0]).toEqual([
			"ap-1",
			1,
		]);
	});

	it("should copy a library preset into the document before inserting it", () => {
		const { commands, addLibraryPresetToDocument, hook } = setup();

		act(() =>
			hook.result.current.handleDragOver(
				dragOver("libpreset:lib-1", "f-a", 80),
			),
		);
		act(() =>
			hook.result.current.handleDragEnd(dragEnd("libpreset:lib-1", "f-a")),
		);

		expect(addLibraryPresetToDocument.mock.calls[0]).toEqual(["lib-1"]);
		expect(commands.insertAppearancePresetRef.mock.calls[0]).toEqual([
			"doc-uid",
			0,
		]);
	});

	it("should append the preset when dropped on the stack itself", () => {
		const { commands, hook } = setup();

		act(() =>
			hook.result.current.handleDragEnd(dragEnd("preset:ap-1", STACK_DROP_ID)),
		);

		expect(commands.insertAppearancePresetRef.mock.calls[0]).toEqual([
			"ap-1",
			2,
		]);
	});

	it("should do nothing when a preset is dropped outside the stack", () => {
		const { commands, hook } = setup();

		act(() => hook.result.current.handleDragEnd(dragEnd("preset:ap-1", null)));
		act(() =>
			hook.result.current.handleDragEnd(dragEnd("preset:ap-1", "preset:ap-2")),
		);

		expect(commands.insertAppearancePresetRef).not.toHaveBeenCalled();
		expect(commands.reorderFilter).not.toHaveBeenCalled();
	});
});
