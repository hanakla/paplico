import { CanvasTarget } from "../renderer/CanvasTarget";
import type { RenderOrchestrator } from "../renderer/RenderOrchestrator";
import { type Artboard, getArtboardBounds } from "../schema";
import type { TimelapseFrame } from "./types";

/** Surround of the artboard, in playback and in the exported video alike. */
const WHITE = { r: 1, g: 1, b: 1, a: 1 };

/**
 * WebGPU surface dedicated to timelapse playback.
 *
 * Playback owns a CanvasTarget of its own for two reasons. It draws straight
 * to the preview canvas, so no frame is read back from the GPU and pushed
 * through ImageData. And it gets its own cache scope, so replaying a document
 * that shares element ids with the live one stops evicting the caches the
 * editor is still using.
 *
 * Frames are drawn at the preview canvas's own size rather than the artboard's
 * full resolution, which is where most of the saving is for large artboards.
 */
export class TimelapsePreviewSurface {
	public static async create(
		renderer: RenderOrchestrator,
		canvas: HTMLCanvasElement,
	): Promise<TimelapsePreviewSurface> {
		const target = new CanvasTarget(canvas);
		await renderer.initCanvasTarget(target, { isolated: true });
		return new TimelapsePreviewSurface(renderer, target);
	}

	private constructor(
		private readonly renderer: RenderOrchestrator,
		private readonly target: CanvasTarget,
	) {}

	/**
	 * Draw one replayed frame: the artboard fitted inside the preview canvas on
	 * white, with nothing drawn outside it. Goes through the export render, so
	 * playback shows what the exported video shows.
	 */
	public async render(
		frame: TimelapseFrame,
		artboard: Artboard,
	): Promise<void> {
		this.target.updateSize();
		if (this.target.width === 0 || this.target.height === 0) return;

		const bounds = getArtboardBounds(artboard);
		await this.renderer.renderArtboardToCanvas(
			artboard,
			frame.document,
			Math.min(
				this.target.width / bounds.width,
				this.target.height / bounds.height,
			),
			WHITE,
			{ targetId: this.target.id, changedElements: frame.changedElements },
		);
	}

	/**
	 * Render one frame to pixels for video export and show it on the preview
	 * canvas. Uses the same target as playback, so the editor's cache scopes
	 * stay untouched during an export.
	 */
	public renderToImageData(
		frame: TimelapseFrame,
		artboard: Artboard,
		scale: number,
	): Promise<ImageData | null> {
		return this.renderer.renderArtboardToImageData(
			artboard,
			frame.document,
			scale,
			WHITE,
			{
				targetId: this.target.id,
				changedElements: frame.changedElements,
				presentToCanvas: true,
			},
		);
	}

	/** Releases the target's GPU resources, cache scopes included. */
	public dispose(): void {
		this.renderer.disposeCanvasTarget(this.target);
		this.target.dispose();
	}
}
