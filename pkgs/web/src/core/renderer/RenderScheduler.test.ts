import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RenderScheduler } from "./RenderScheduler";
import type { ChangedElements } from "./types";

// The scheduler defers to requestAnimationFrame. Queue the callbacks and let
// each test flush explicitly, so several markDirty calls can coalesce into
// one frame the way they do between real frames.
let rafQueue: FrameRequestCallback[] = [];

beforeEach(() => {
	rafQueue = [];
	vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback): number => {
		rafQueue.push(cb);
		return rafQueue.length;
	});
	vi.stubGlobal("cancelAnimationFrame", () => {});
});

afterEach(() => {
	vi.unstubAllGlobals();
});

function flushFrame(): void {
	const queue = rafQueue;
	rafQueue = [];
	for (const cb of queue) cb(0);
}

describe("RenderScheduler", () => {
	describe("changed-element tracking", () => {
		it("should hand the accumulated change set to the frame callback", () => {
			const callback = vi.fn();
			const scheduler = new RenderScheduler(callback);

			scheduler.markDirty("document", changes({ upserted: ["a"] }));
			scheduler.markDirty(
				"document",
				changes({ upserted: ["b"], deleted: ["c"] }),
			);
			flushFrame();

			const [, changedElements] = lastCall(callback);
			expect(changedElements).toEqual({
				upserted: new Set(["a", "b"]),
				deleted: new Set(["c"]),
			});
		});

		it("should void tracking when a content dirty arrives without ids", () => {
			const callback = vi.fn();
			const scheduler = new RenderScheduler(callback);

			scheduler.markDirty("document", changes({ upserted: ["a"] }));
			scheduler.markDirty("document");
			flushFrame();

			const [, changedElements] = lastCall(callback);
			expect(changedElements).toBeUndefined();
		});

		it("should keep tracking across non-content dirt without ids", () => {
			const callback = vi.fn();
			const scheduler = new RenderScheduler(callback);

			scheduler.markDirty("document", changes({ upserted: ["a"] }));
			scheduler.markDirty("viewport");
			scheduler.markDirty("selection");
			flushFrame();

			const [, changedElements] = lastCall(callback);
			expect(changedElements).toEqual({
				upserted: new Set(["a"]),
				deleted: new Set(),
			});
		});

		it("should let a later upsert revive an id deleted in the same frame", () => {
			const callback = vi.fn();
			const scheduler = new RenderScheduler(callback);

			scheduler.markDirty("document", changes({ deleted: ["a"] }));
			scheduler.markDirty("document", changes({ upserted: ["a"] }));
			flushFrame();

			const [, changedElements] = lastCall(callback);
			expect(changedElements).toEqual({
				upserted: new Set(["a"]),
				deleted: new Set(),
			});
		});

		it("should restart tracking after each dispatched frame", () => {
			const callback = vi.fn();
			const scheduler = new RenderScheduler(callback);

			scheduler.markDirty("document", changes({ upserted: ["a"] }));
			flushFrame();
			scheduler.markDirty("document", changes({ upserted: ["b"] }));
			flushFrame();

			const [, second] = lastCall(callback);
			expect(second).toEqual({
				upserted: new Set(["b"]),
				deleted: new Set(),
			});
		});

		it("should recover tracking on the frame after a voided one", () => {
			const callback = vi.fn();
			const scheduler = new RenderScheduler(callback);

			scheduler.markDirty("document");
			flushFrame();
			scheduler.markDirty("document", changes({ upserted: ["a"] }));
			flushFrame();

			const [, second] = lastCall(callback);
			expect(second).toEqual({
				upserted: new Set(["a"]),
				deleted: new Set(),
			});
		});

		it("should restart tracking on renderNow without a change set", () => {
			const callback = vi.fn();
			const scheduler = new RenderScheduler(callback);

			scheduler.markDirty("document", changes({ upserted: ["a"] }));
			scheduler.renderNow();

			// Forced full render: no change set (everything may have changed)…
			expect(lastCall(callback)).toEqual(["full"]);

			// …and the pre-renderNow ids must not leak into the next frame.
			scheduler.markDirty("document", changes({ upserted: ["b"] }));
			flushFrame();
			const [, next] = lastCall(callback);
			expect(next).toEqual({ upserted: new Set(["b"]), deleted: new Set() });
		});
	});

	describe("strategy resolution", () => {
		it("should render a `render` dirt as a non-interacting overlayOnly frame", () => {
			const callback = vi.fn();
			const scheduler = new RenderScheduler(callback);

			// A tile-convergence follow-up (and async resource loads) go through the
			// `render` reason: it must re-render at the settle budget, not the
			// interaction one, so tile convergence proceeds instead of stalling.
			scheduler.markDirty("render");
			flushFrame();

			const [strategy] = lastCall(callback);
			expect(strategy).toBe("overlayOnly");
		});

		it("should blit the cached frame for a viewport interaction", () => {
			const callback = vi.fn();
			const scheduler = new RenderScheduler(callback);

			// Pan and zoom interactions both try the composite blit; CanvasLayer
			// falls through to a re-render when the cache no longer covers the
			// visible world.
			scheduler.markDirty("viewport");
			flushFrame();

			expect(lastCall(callback)[0]).toBe("viewportBlit");
		});

		it("should let selection ride along a viewport blit", () => {
			const callback = vi.fn();
			const scheduler = new RenderScheduler(callback);

			// selection only affects the overlay layer (re-rendered every frame),
			// so it does not force a document re-render.
			scheduler.markDirty("viewport");
			scheduler.markDirty("selection");
			flushFrame();

			expect(lastCall(callback)[0]).toBe("viewportBlit");
		});

		it("should fall back to fullInteraction when a preview rides with a viewport change", () => {
			const callback = vi.fn();
			const scheduler = new RenderScheduler(callback);

			// An in-progress draw needs real document pixels, so no blit.
			scheduler.markDirty("viewport");
			scheduler.markDirty("preview");
			flushFrame();

			expect(lastCall(callback)[0]).toBe("fullInteraction");
		});

		it("should fall back to fullInteraction when a render dirt rides with a viewport change", () => {
			const callback = vi.fn();
			const scheduler = new RenderScheduler(callback);

			scheduler.markDirty("viewport");
			scheduler.markDirty("render");
			flushFrame();

			expect(lastCall(callback)[0]).toBe("fullInteraction");
		});

		it("should re-render at full quality once the interaction settles", () => {
			// Fake only the settle timer; leave requestAnimationFrame to the
			// manual rafQueue stub the suite installs in beforeEach.
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			try {
				const callback = vi.fn();
				const scheduler = new RenderScheduler(callback);

				scheduler.markDirty("viewport");
				flushFrame();
				expect(lastCall(callback)[0]).toBe("viewportBlit");

				// After the 100ms settle the scheduler drops interacting and fires a
				// viewport dirty, which resolves to a real (overlayOnly) render.
				vi.advanceTimersByTime(100);
				flushFrame();
				expect(lastCall(callback)[0]).toBe("overlayOnly");
			} finally {
				vi.useRealTimers();
			}
		});
	});
});

// Helpers

function changes(init: {
	upserted?: string[];
	deleted?: string[];
}): ChangedElements {
	return {
		upserted: new Set(init.upserted ?? []),
		deleted: new Set(init.deleted ?? []),
	};
}

function lastCall(callback: ReturnType<typeof vi.fn>): unknown[] {
	const call = callback.mock.calls.at(-1);
	if (!call) throw new Error("Expected the render callback to have fired");
	return call;
}
