import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FONT_POLL_INTERVAL_MS, pollFontChanges } from "./fontChangePolling";

describe("pollFontChanges", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("should report a font installed since the last listing", async () => {
		const installed = [{ postScriptName: "A-Regular" }];
		const onChange = vi.fn();
		const stop = pollFontChanges(async () => installed, onChange);
		await vi.advanceTimersByTimeAsync(0);

		installed.push({ postScriptName: "B-Regular" });
		await vi.advanceTimersByTimeAsync(FONT_POLL_INTERVAL_MS);

		expect(onChange).toHaveBeenCalledTimes(1);
		stop();
	});

	it("should stay quiet while the fonts do not change", async () => {
		const onChange = vi.fn();
		const stop = pollFontChanges(
			async () => [{ postScriptName: "A-Regular" }],
			onChange,
		);

		await vi.advanceTimersByTimeAsync(FONT_POLL_INTERVAL_MS * 3);

		expect(onChange).not.toHaveBeenCalled();
		stop();
	});

	it("should check again when the window regains focus", async () => {
		const installed = [{ postScriptName: "A-Regular" }];
		const onChange = vi.fn();
		const stop = pollFontChanges(async () => installed, onChange);
		await vi.advanceTimersByTimeAsync(0);

		installed.pop();
		window.dispatchEvent(new Event("focus"));
		await vi.advanceTimersByTimeAsync(0);

		expect(onChange).toHaveBeenCalledTimes(1);
		stop();
	});
});
