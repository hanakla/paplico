import { nanoid } from "nanoid";
import { createDefaultViewport } from "../document/factory";
import type { Viewport } from "../schema";
import { Emitter } from "../utils/emitter";

type CanvasTargetEventMap = {
	viewportChanged: { previous: Viewport; current: Viewport };
	/**
	 * The drawing surface changed shape. Overlays positioned against it have to
	 * follow: screen coordinates are measured from the canvas centre, so a
	 * stale size puts everything off by half the difference.
	 */
	sizeChanged: { width: number; height: number };
};

/**
 * Represents a single rendering target (canvas element) with its own viewport.
 *
 * In split view, each pane has its own CanvasTarget with an independent
 * viewport (pan, zoom, rotation). The RenderOrchestrator creates per-target
 * GPU resources (uniform buffers, layers, etc.) for each CanvasTarget.
 *
 * GPUCanvasContext is lazily initialized on first getContext() call
 * and cached for subsequent calls.
 */
export class CanvasTarget extends Emitter<CanvasTargetEventMap> {
	public readonly id: string;
	private readonly domElement: HTMLCanvasElement;
	public width = 0;
	public height = 0;
	private pixelRatio: number;

	private _context: GPUCanvasContext | null = null;
	private _disposed = false;
	private _viewport: Viewport;

	public constructor(
		canvas: HTMLCanvasElement,
		options?: {
			id?: string;
			viewport?: Viewport;
			pixelRatio?: number;
		},
	) {
		super();
		this.id = options?.id ?? nanoid();
		this.domElement = canvas;
		this._viewport = { ...(options?.viewport ?? createDefaultViewport()) };
		this.pixelRatio = options?.pixelRatio ?? (globalThis.devicePixelRatio || 1);

		this.updateSize();
	}

	public get canvas(): HTMLCanvasElement {
		return this.domElement;
	}

	public getViewport(): Viewport {
		return this._viewport;
	}

	public setViewport(next: Partial<Viewport> | Viewport): void {
		const previous = this._viewport;
		const current = { ...previous, ...next };
		if (
			previous.x === current.x &&
			previous.y === current.y &&
			previous.zoom === current.zoom &&
			previous.rotation === current.rotation
		) {
			return;
		}

		this._viewport = current;
		this.emit("viewportChanged", {
			previous: { ...previous },
			current: { ...current },
		});
	}

	/**
	 * Lazily initialize and cache the GPUCanvasContext.
	 * Configures the context on first call with the given device and format.
	 */
	public getContext(
		device: GPUDevice,
		format: GPUTextureFormat,
		options?: {
			toneMapping?: GPUCanvasToneMapping;
			colorSpace?: PredefinedColorSpace;
		},
	): GPUCanvasContext {
		if (this._disposed) {
			throw new Error(`CanvasTarget ${this.id} has been disposed`);
		}

		if (this._context) return this._context;

		const ctx = this.domElement.getContext("webgpu");
		if (!ctx) {
			throw new Error("Failed to get WebGPU context from canvas");
		}

		ctx.configure({
			device,
			format,
			alphaMode: "premultiplied",
			colorSpace: options?.colorSpace ?? "display-p3",
			toneMapping: options?.toneMapping,
			usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
		});

		this._context = ctx;
		return ctx;
	}

	/** Unconfigure and discard cached context. Used when switching HDR mode. */
	public unconfigureContext(): void {
		this._context?.unconfigure();
		this._context = null;
	}

	/** Update width/height from the current canvas bounding rect and sync canvas backing store. */
	public updateSize(): void {
		const rect = this.domElement.getBoundingClientRect();
		if (rect.width === 0 || rect.height === 0) return;

		// Only update canvas backing store when size actually changed
		if (this.width === rect.width && this.height === rect.height) return;

		this.width = rect.width;
		this.height = rect.height;

		this.domElement.width = rect.width;
		this.domElement.height = rect.height;

		this.emit("sizeChanged", { width: rect.width, height: rect.height });
	}

	public dispose(): void {
		if (this._disposed) return;
		this.offAll();
		this._disposed = true;
		this._context?.unconfigure();
		this._context = null;
	}
}
