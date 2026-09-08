import type { BoundingBox, Viewport } from "../../../schema";
import type {
	CompositeState,
	GPUCoreResources,
	TextureState,
} from "../CanvasLayerTypes";

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
	public constructor(private readonly deps: DocumentCacheDeps) {}

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

	public ensureBackdropMaskTextures(width: number, height: number): void {
		const { device, canvasFormat, compositeState } = this.deps;
		ensureColorTexture(
			{ device, canvasFormat, deferDestroy: this.deps.deferDestroy },
			compositeState.backdropMask,
			width,
			height,
			"Backdrop Mask Texture",
			GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
		);
	}
}

function ensureColorTexture(
	deps: Pick<DocumentCacheDeps, "device" | "canvasFormat" | "deferDestroy">,
	state: TextureState,
	width: number,
	height: number,
	label: string,
	usage: GPUTextureUsageFlags,
): void {
	if (state.texture && state.width === width && state.height === height) {
		return;
	}

	deps.deferDestroy(state.texture);
	state.texture = deps.device.createTexture({
		label,
		size: { width, height },
		format: deps.canvasFormat,
		usage,
	});
	state.width = width;
	state.height = height;
}
