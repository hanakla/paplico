import { CanvasTarget } from "../renderer/CanvasTarget";
import type { RenderOrchestrator } from "../renderer/RenderOrchestrator";
import { type Artboard, type Document, getArtboardBounds } from "../schema";

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

	/** Draw one replayed frame, framing `artboard` to fill the preview canvas. */
	public render(document: Document, artboard: Artboard): void {
		this.target.updateSize();
		if (this.target.width === 0 || this.target.height === 0) return;

		const bounds = getArtboardBounds(artboard);
		this.target.setViewport({
			x: artboard.x,
			y: artboard.y,
			zoom: Math.min(
				this.target.width / bounds.width,
				this.target.height / bounds.height,
			),
			rotation: 0,
		});

		const previousTarget = this.renderer.getActiveCanvasTarget();
		this.renderer.setCanvasTarget(this.target);
		try {
			this.renderer.render(
				{
					viewport: this.target.getViewport(),
					document,
					strategy: "full",
					// Deliberately no changedElements, and culling off: this matches
					// the artboard export path, which is the configuration replayed
					// documents are known to render correctly under. A replay frame
					// is not an incremental edit of the frame before it — the whole
					// document is rebuilt from the Yjs stream each time.
					disableViewportCulling: true,
					// Match the exported video: white surround, artboard fills reach
					// the edges of the frame.
					clearColorOverride: { r: 1, g: 1, b: 1, a: 1 },
					paintArtboardBackgrounds: true,
				},
				{},
			);
		} finally {
			if (previousTarget) this.renderer.setCanvasTarget(previousTarget);
		}
	}

	/**
	 * Render one frame to pixels for video export. Uses the same target as
	 * playback, so the editor's cache scopes stay untouched during an export.
	 */
	public renderToImageData(
		document: Document,
		artboard: Artboard,
		scale: number,
	): Promise<ImageData | null> {
		return this.renderer.renderArtboardToImageData(
			artboard,
			document,
			scale,
			{ r: 1, g: 1, b: 1, a: 1 },
			{ targetId: this.target.id },
		);
	}

	/** Releases the target's GPU resources, cache scopes included. */
	public dispose(): void {
		this.renderer.disposeCanvasTarget(this.target);
		this.target.dispose();
	}
}
