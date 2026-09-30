import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Artboard, Document } from "../schema";
import { TimelapseExporter } from "./TimelapseExporter";
import type { TimelapsePlayer } from "./TimelapsePlayer";
import type { TimelapsePreviewSurface } from "./TimelapsePreviewSurface";
import type { TimelapseFrame } from "./types";

describe("TimelapseExporter", () => {
	const artboard: Artboard = {
		id: "artboard-1",
		name: "Artboard 1",
		x: 0,
		y: 0,
		width: 4,
		height: 4,
	};

	let encoders: FakeVideoEncoder[];

	beforeEach(() => {
		encoders = [];
		vi.stubGlobal(
			"VideoEncoder",
			class extends FakeVideoEncoder {
				public constructor() {
					super();
					encoders.push(this);
				}
			},
		);
		vi.stubGlobal("VideoFrame", FakeVideoFrame);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	describe("when the export is called off", () => {
		it("should reject with the abort reason and encode nothing further", async () => {
			const abort = new AbortController();
			const exporter = new TimelapseExporter(
				createSurface(artboard),
				createPlayer(20),
			);

			let framesAtAbort = -1;
			const exported = exporter.exportMP4({
				artboard,
				signal: abort.signal,
				onProgress: () => {
					if (abort.signal.aborted) return;
					framesAtAbort = encoders[0].encodedFrames;
					abort.abort();
				},
			});

			await expect(exported).rejects.toMatchObject({ name: "AbortError" });
			expect(framesAtAbort).toBeGreaterThan(0);
			expect(encoders[0].encodedFrames).toBe(framesAtAbort);
			expect(encoders[0].state).toBe("closed");
		});

		it("should reject while still measuring the recording", async () => {
			const abort = new AbortController();
			// Long enough for the measuring pass to hand control back, which is
			// where a cancel click gets in.
			const player = createPlayer(1000);
			const exporter = new TimelapseExporter(createSurface(artboard), player);

			const exported = exporter.exportMP4({ artboard, signal: abort.signal });
			player.onFirstSkip = () => abort.abort();

			await expect(exported).rejects.toMatchObject({ name: "AbortError" });
			expect(encoders[0].encodedFrames).toBe(0);
			expect(encoders[0].state).toBe("closed");
		});
	});
});

class FakeVideoEncoder {
	public state: "configured" | "closed" = "configured";
	public encodeQueueSize = 0;
	public encodedFrames = 0;

	public configure(): void {}

	public encode(): void {
		if (this.state === "closed") throw new Error("The encoder is closed");
		this.encodedFrames++;
	}

	public async flush(): Promise<void> {}

	public close(): void {
		this.state = "closed";
	}
}

class FakeVideoFrame {
	public close(): void {}
}

/** A surface that hands back a blank frame of the artboard's size. */
function createSurface(artboard: Artboard): TimelapsePreviewSurface {
	return {
		renderToImageData: async () =>
			new ImageData(artboard.width, artboard.height),
	} as unknown as TimelapsePreviewSurface;
}

/** A player whose recording changes the drawing on each of `ticks` steps. */
function createPlayer(ticks: number) {
	const frame = (): TimelapseFrame => ({
		document: {} as Document,
		changedElements: undefined,
	});
	let position = 0;

	const player = {
		onFirstSkip: null as (() => void) | null,
		totalEvents: ticks,
		get currentIndex() {
			return position - 1;
		},
		get hasFinished() {
			return position >= ticks;
		},
		setSpeed: () => {},
		captureCompletedFrame: () => ({}) as Document,
		restart: () => {
			position = 0;
			return frame();
		},
		skipBy: () => {
			position++;
			player.onFirstSkip?.();
			player.onFirstSkip = null;
		},
		advanceBy: () => {
			position++;
			return frame();
		},
	};
	return player as typeof player & TimelapsePlayer;
}
