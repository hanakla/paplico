import type { Paplico } from "@paplico/core";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	AUTO_SAVE_INTERVAL_MS,
	AUTO_SAVE_SLOW_INTERVAL_MS,
	AUTO_SAVE_SLOW_THRESHOLD_MS,
} from "@/configs";
import { useAutoSave } from "@/hooks/useAutoSave";
import { autoSaveState } from "@/stores/autoSave";
import {
	setInternalDocumentSession,
	setRoomDocumentSession,
} from "@/stores/documentSessionStore";
import { documentManagerState, saveDocument } from "@/stores/documentStore";

vi.mock("@/stores/documentStore", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/stores/documentStore")>()),
	saveDocument: vi.fn(async () => {}),
	saveRevision: vi.fn(async () => {}),
}));

vi.mock("@/utils/generateDocumentThumbnail", () => ({
	generateDocumentThumbnail: vi.fn(async () => null),
}));

describe("useAutoSave", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.mocked(saveDocument).mockClear();
		autoSaveState.intervalMs = AUTO_SAVE_INTERVAL_MS;
		autoSaveState.isSlowDocument = false;
		documentManagerState.currentDocumentId = "doc-a";
		setInternalDocumentSession("doc-a");
	});

	afterEach(() => {
		vi.useRealTimers();
		documentManagerState.currentDocumentId = null;
	});

	it("should save the edited document under its id when the save interval passes", async () => {
		const engine = createEngine("content-a");
		const onSaveEnd = vi.fn();
		const onSaveStart = vi.fn();
		renderHook(() => useAutoSave(engine.paplico, { onSaveEnd, onSaveStart }));

		engine.edit();
		await act(() => vi.advanceTimersByTimeAsync(AUTO_SAVE_INTERVAL_MS));

		expect(onSaveStart).toHaveBeenCalledOnce();
		expect(onSaveEnd).toHaveBeenCalledOnce();
		const calls = vi.mocked(saveDocument).mock.calls;
		expect(calls).toHaveLength(1);
		expect(calls[0][0]).toBe("doc-a");
		expect(await calls[0][1].text()).toBe("content-a");
	});

	it("should not report a save start when there are no changes", async () => {
		const engine = createEngine("content-a");
		const onSaveStart = vi.fn();
		renderHook(() => useAutoSave(engine.paplico, { onSaveStart }));

		await act(() => vi.advanceTimersByTimeAsync(AUTO_SAVE_INTERVAL_MS));

		expect(onSaveStart).not.toHaveBeenCalled();
	});

	it("should use the extended interval after a slow save", async () => {
		const engine = createEngine("content-a");
		const performanceNow = vi
			.spyOn(performance, "now")
			.mockReturnValueOnce(0)
			.mockReturnValueOnce(AUTO_SAVE_SLOW_THRESHOLD_MS + 1);
		renderHook(() => useAutoSave(engine.paplico));

		engine.edit();
		await act(() => vi.advanceTimersByTimeAsync(AUTO_SAVE_INTERVAL_MS));
		engine.edit();
		await act(() => vi.advanceTimersByTimeAsync(AUTO_SAVE_INTERVAL_MS));

		expect(saveDocument).toHaveBeenCalledOnce();

		await act(() =>
			vi.advanceTimersByTimeAsync(
				AUTO_SAVE_SLOW_INTERVAL_MS - AUTO_SAVE_INTERVAL_MS,
			),
		);

		expect(saveDocument).toHaveBeenCalledTimes(2);
		performanceNow.mockRestore();
	});

	it("should not write the next document under the previous id when the document changes", async () => {
		const engine = createEngine("content-a");
		renderHook(() => useAutoSave(engine.paplico));

		// A switch imports the next document before it moves the current id.
		engine.content = "content-b";
		await act(async () => {
			documentManagerState.currentDocumentId = "doc-b";
		});
		await act(() => vi.advanceTimersByTimeAsync(AUTO_SAVE_INTERVAL_MS));

		expect(vi.mocked(saveDocument).mock.calls).toEqual([]);
	});

	it("should not write an edit under the previous id when the document changes before the save runs", async () => {
		const engine = createEngine("content-a");
		renderHook(() => useAutoSave(engine.paplico));

		engine.edit();
		engine.content = "content-b";
		await act(async () => {
			documentManagerState.currentDocumentId = "doc-b";
		});
		await act(() => vi.advanceTimersByTimeAsync(AUTO_SAVE_INTERVAL_MS));

		const ids = vi.mocked(saveDocument).mock.calls.map(([id]) => id);
		expect(ids).not.toContain("doc-a");
	});

	it("should not save a room's document under the current document's id", async () => {
		const engine = createEngine("content-a");
		renderHook(() => useAutoSave(engine.paplico));

		// Joining a room replaces the engine's document and keeps the current id.
		engine.content = "room-content";
		await act(async () => {
			setRoomDocumentSession();
		});
		engine.edit();
		await act(() => vi.advanceTimersByTimeAsync(AUTO_SAVE_INTERVAL_MS));

		expect(vi.mocked(saveDocument).mock.calls).toEqual([]);
	});

	it("should save again once another document is opened after a room", async () => {
		const engine = createEngine("content-a");
		renderHook(() => useAutoSave(engine.paplico));
		await act(async () => {
			setRoomDocumentSession();
		});

		engine.content = "content-b";
		await act(async () => {
			documentManagerState.currentDocumentId = "doc-b";
			setInternalDocumentSession("doc-b");
		});
		engine.edit();
		await act(() => vi.advanceTimersByTimeAsync(AUTO_SAVE_INTERVAL_MS));

		const calls = vi.mocked(saveDocument).mock.calls;
		expect(calls).toHaveLength(1);
		expect(calls[0][0]).toBe("doc-b");
		expect(await calls[0][1].text()).toBe("content-b");
	});
});

/** An engine stand-in that exports `content` and lets a test fire an edit. */
function createEngine(content: string) {
	const listeners = new Set<() => void>();
	const engine = {
		content,
		edit: () => {
			for (const listener of listeners) listener();
		},
		paplico: {
			exportDocument: async () => new Blob([engine.content]),
			getYjsProvider: () => ({
				on: (event: string, listener: () => void) => {
					if (event === "update") listeners.add(listener);
					return () => listeners.delete(listener);
				},
			}),
		} as unknown as Paplico,
	};
	return engine;
}
