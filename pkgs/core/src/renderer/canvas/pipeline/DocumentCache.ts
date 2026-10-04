import type { BoundingBox, Viewport } from "../../../schema";
import type { CompositeState, GPUCoreResources } from "../CanvasLayerTypes";

// ---------------------------------------------------------------------------
// Dependency interface
// ---------------------------------------------------------------------------

interface DocumentCacheDeps extends GPUCoreResources {
	compositeState: CompositeState;
	viewportState: { width: number; height: number; current: Viewport | null };
	deferDestroy: (texture: GPUTexture | null | undefined) => void;
}

// ---------------------------------------------------------------------------
// Free functions
// ---------------------------------------------------------------------------

export function boundsAlmostEqual(a: BoundingBox, b: BoundingBox): boolean {
	const epsilon = 0.001;
	return (
		Math.abs(a.minX - b.minX) < epsilon &&
		Math.abs(a.minY - b.minY) < epsilon &&
		Math.abs(a.maxX - b.maxX) < epsilon &&
		Math.abs(a.maxY - b.maxY) < epsilon &&
		Math.abs(a.width - b.width) < epsilon &&
		Math.abs(a.height - b.height) < epsilon
	);
}

// ---------------------------------------------------------------------------
// DocumentCache class
// ---------------------------------------------------------------------------

export class DocumentCache {
	private frameTexture: GPUTexture | null = null;

	public constructor(private readonly deps: DocumentCacheDeps) {}

	public get compositeFrameTexture(): GPUTexture | null {
		return this.frameTexture;
	}

	/**
	 * Ensure the previous-frame composite texture matches the prebuf size.
	 * Returns true when it was reallocated, i.e. it holds no captured frame yet.
	 */
	public ensureCompositeFrameTexture(width: number, height: number): boolean {
		if (
			this.frameTexture &&
			this.frameTexture.width === width &&
			this.frameTexture.height === height
		) {
			return false;
		}
		this.deps.deferDestroy(this.frameTexture);
		this.frameTexture = this.deps.device.createTexture({
			label: "Composite Frame Cache",
			size: { width, height },
			format: this.deps.canvasFormat,
			usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
		});
		return true;
	}

	public destroy(): void {
		const { compositeState } = this.deps;
		this.frameTexture?.destroy();
		this.frameTexture = null;
		compositeState.captureTexture?.destroy();
		compositeState.captureTexture = null;
		compositeState.layerTexture?.destroy();
		compositeState.layerTexture = null;
		compositeState.prebufTexture?.destroy();
		compositeState.prebufTexture = null;
		compositeState.canvasBaseTexture?.destroy();
		compositeState.canvasBaseTexture = null;
		compositeState.width = 0;
		compositeState.height = 0;
	}

	public ensureCompositeTextures(width: number, height: number): void {
		const { device, canvasFormat, compositeState } = this.deps;
		if (
			compositeState.captureTexture &&
			compositeState.layerTexture &&
			compositeState.prebufTexture &&
			compositeState.canvasBaseTexture &&
			compositeState.width === width &&
			compositeState.height === height
		) {
			return;
		}

		this.deps.deferDestroy(compositeState.captureTexture);
		this.deps.deferDestroy(compositeState.layerTexture);
		this.deps.deferDestroy(compositeState.prebufTexture);
		this.deps.deferDestroy(compositeState.canvasBaseTexture);

		compositeState.captureTexture = device.createTexture({
			label: "Composite Capture Texture",
			size: { width, height },
			format: canvasFormat,
			usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
		});
		compositeState.layerTexture = device.createTexture({
			label: "Composite Layer Texture",
			size: { width, height },
			format: canvasFormat,
			usage:
				GPUTextureUsage.RENDER_ATTACHMENT |
				GPUTextureUsage.TEXTURE_BINDING |
				GPUTextureUsage.COPY_SRC |
				GPUTextureUsage.COPY_DST,
		});
		compositeState.prebufTexture = device.createTexture({
			label: "Composite Prebuf Texture",
			size: { width, height },
			format: canvasFormat,
			usage:
				GPUTextureUsage.RENDER_ATTACHMENT |
				GPUTextureUsage.TEXTURE_BINDING |
				GPUTextureUsage.COPY_SRC |
				GPUTextureUsage.COPY_DST,
		});
		compositeState.canvasBaseTexture = device.createTexture({
			label: "Composite Canvas Base Texture",
			size: { width, height },
			format: canvasFormat,
			usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
		});
		compositeState.width = width;
		compositeState.height = height;
	}
}
