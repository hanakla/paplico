import type { BoundingBox, Viewport } from "../../../schema";
import {
	type CompositeState,
	type GPUCoreResources,
	RENDER_SAMPLE_COUNT,
	type StencilState,
	type TextureState,
} from "../CanvasLayerTypes";

// ---------------------------------------------------------------------------
// Dependency interface
// ---------------------------------------------------------------------------

interface DocumentCacheDeps extends GPUCoreResources {
	stencil: StencilState;
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

	public ensureStencilTexture(width: number, height: number): void {
		ensureStencilTexture(
			this.deps,
			this.deps.stencil,
			width,
			height,
			"Stencil Texture",
		);
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

	public ensureFinalBlitStencilTexture(width: number, height: number): void {
		ensureStencilTexture(
			this.deps,
			this.deps.compositeState.finalBlitStencil,
			width,
			height,
			"Canvas Layer Final Blit Stencil",
		);
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
		ensureStencilTexture(
			this.deps,
			compositeState.backdropMaskStencil,
			width,
			height,
			"Backdrop Mask Stencil",
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

/** Sizes a StencilState slot may hold at once. Render-target sizes alternate
 *  within a frame (canvas prebuf vs cache texture), and a single-slot cache
 *  recreated the MSAA stencil on every switch — hundreds of MB of allocations
 *  per second while panning. */
const MAX_STENCIL_POOL_SIZES = 4;

function ensureStencilTexture(
	deps: Pick<DocumentCacheDeps, "device" | "deferDestroy">,
	state: StencilState,
	width: number,
	height: number,
	label: string,
): void {
	if (state.texture && state.width === width && state.height === height) {
		return;
	}

	const key = `${width}x${height}`;
	state.pool ??= new Map();
	let texture = state.pool.get(key);
	if (!texture) {
		if (state.pool.size >= MAX_STENCIL_POOL_SIZES) {
			for (const [oldKey, old] of state.pool) {
				// The outgoing current texture may still be referenced by passes
				// encoded this frame — deferDestroy handles that; just never evict
				// the one we are about to keep using.
				if (old === state.texture) continue;
				state.pool.delete(oldKey);
				deps.deferDestroy(old);
				break;
			}
		}
		texture = deps.device.createTexture({
			label,
			size: { width, height },
			format: "depth24plus-stencil8",
			sampleCount: RENDER_SAMPLE_COUNT,
			usage: GPUTextureUsage.RENDER_ATTACHMENT,
		});
		state.pool.set(key, texture);
	}
	state.texture = texture;
	state.width = width;
	state.height = height;
}

/** Destroy every stencil generation a StencilState holds (teardown path). */
export function destroyStencilState(state: StencilState): void {
	for (const texture of state.pool?.values() ?? []) texture.destroy();
	state.pool?.clear();
	state.texture = null;
	state.width = 0;
	state.height = 0;
}
