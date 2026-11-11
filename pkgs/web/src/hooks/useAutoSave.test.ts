import type { Paplico } from "@paplico/core";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoSave } from "@/hooks/useAutoSave";
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

describe("useAutoSave", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.mocked(saveDocument).mockClear();
		documentManagerState.currentDocumentId = "doc-a";
		setInternalDocumentSession("doc-a");
	});

	afterEach(() => {
		vi.useRealTimers();
		documentManagerState.currentDocumentId = null;
	});

	it("should save the edited document under its id two seconds after an edit", async () => {
		const engine = createEngine("content-a");
		renderHook(() => useAutoSave(engine.paplico));

		engine.edit();
		await act(() => vi.advanceTimersByTimeAsync(2_000));

		const calls = vi.mocked(saveDocument).mock.calls;
		expect(calls).toHaveLength(1);
		expect(calls[0][0]).toBe("doc-a");
		expect(await calls[0][1].text()).toBe("content-a");
	});

	it("should not write the next document under the previous id when the document changes", async () => {
		const engine = createEngine("content-a");
		renderHook(() => useAutoSave(engine.paplico));

		// A switch imports the next document before it moves the current id.
		engine.content = "content-b";
		await act(async () => {
			documentManagerState.currentDocumentId = "doc-b";
		});
		await act(() => vi.advanceTimersByTimeAsync(2_000));

		expect(vi.mocked(saveDocument).mock.calls).toEqual([]);
	});

	it("should drop a pending save when the document changes before it runs", async () => {
		const engine = createEngine("content-a");
		renderHook(() => useAutoSave(engine.paplico));

		engine.edit();
		engine.content = "content-b";
		await act(async () => {
			documentManagerState.currentDocumentId = "doc-b";
		});
		await act(() => vi.advanceTimersByTimeAsync(2_000));

		expect(vi.mocked(saveDocument).mock.calls).toEqual([]);
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
		await act(() => vi.advanceTimersByTimeAsync(2_000));

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
		await act(() => vi.advanceTimersByTimeAsync(2_000));

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
