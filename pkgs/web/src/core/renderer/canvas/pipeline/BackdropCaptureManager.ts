import type { BoundingBox, Filter, Viewport } from "../../../schema";
import { compileShaderModule } from "../../../utils/wgpu-utils";
import type { GPUTimingProfiler } from "../../GPUTimingProfiler";
import { createFullscreenPipeline } from "../../PipelineFactory";
import { BACKDROP_RESAMPLE_SHADER } from "../../shaders/blit.wgsl";
import type { FilterRenderer } from "./FilterRenderer";
import type { TexturePool } from "./TexturePool";

type BackdropCaptureViewport = Pick<Viewport, "x" | "y" | "zoom">;

interface CapturedBackdrop {
	texture: GPUTexture;
	/** Actual captured region in world coordinates (after rounding and clamping) */
	actualBounds: BoundingBox;
	/** Prebuf-space UV rect of the captured region, normalized to [0,1]. */
	sourceUV: { minU: number; minV: number; maxU: number; maxV: number };
	filtered: boolean;
}

export interface BackdropCaptureRegion {
	copyOrigin: { x: number; y: number };
	copySize: { width: number; height: number };
	actualBounds: BoundingBox;
	sourceUV: { minU: number; minV: number; maxU: number; maxV: number };
}

export interface BackdropPixelRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export type BackdropCaptureDomain =
	| { kind: "display-density"; density?: number }
	| { kind: "fixed-r"; rasterScale: number };

export interface BackdropCaptureDestination {
	texture: GPUTexture;
	/** Atlas slot or caller-owned texture origin, in destination texels. */
	origin: { x: number; y: number };
	/** Writable content rectangle relative to origin. */
	contentRect: BackdropPixelRect;
}

export interface BackdropCaptureIntoRequest {
	sourceTexture: GPUTexture;
	sourceWorldBounds: BoundingBox;
	viewport: BackdropCaptureViewport;
	canvasWidth: number;
	canvasHeight: number;
	destination: BackdropCaptureDestination;
	domain: BackdropCaptureDomain;
	profiler?: GPUTimingProfiler | null;
}

export interface CapturedBackdropInto {
	actualBounds: BoundingBox;
	sourceUV: { minU: number; minV: number; maxU: number; maxV: number };
	writtenRect: BackdropPixelRect;
}

export function calculateBackdropCaptureRegion(
	bounds: BoundingBox,
	viewport: BackdropCaptureViewport,
	canvasWidth: number,
	canvasHeight: number,
): BackdropCaptureRegion {
	const screenMinX =
		(bounds.minX - viewport.x) * viewport.zoom + canvasWidth / 2;
	const screenMaxX =
		(bounds.maxX - viewport.x) * viewport.zoom + canvasWidth / 2;
	const screenMinY =
		canvasHeight / 2 - (bounds.maxY - viewport.y) * viewport.zoom;
	const screenMaxY =
		canvasHeight / 2 - (bounds.minY - viewport.y) * viewport.zoom;

	const clampedMinX = Math.max(0, Math.floor(screenMinX));
	const clampedMinY = Math.max(0, Math.floor(screenMinY));
	const clampedMaxX = Math.min(canvasWidth, Math.ceil(screenMaxX));
	const clampedMaxY = Math.min(canvasHeight, Math.ceil(screenMaxY));

	const actualBounds: BoundingBox = {
		minX: (clampedMinX - canvasWidth / 2) / viewport.zoom + viewport.x,
		minY: (canvasHeight / 2 - clampedMaxY) / viewport.zoom + viewport.y,
		maxX: (clampedMaxX - canvasWidth / 2) / viewport.zoom + viewport.x,
		maxY: (canvasHeight / 2 - clampedMinY) / viewport.zoom + viewport.y,
		width: (clampedMaxX - clampedMinX) / viewport.zoom,
		height: (clampedMaxY - clampedMinY) / viewport.zoom,
	};

	return {
		copyOrigin: { x: clampedMinX, y: clampedMinY },
		copySize: {
			width: clampedMaxX - clampedMinX,
			height: clampedMaxY - clampedMinY,
		},
		actualBounds,
		sourceUV: {
			minU: clampedMinX / canvasWidth,
			minV: clampedMinY / canvasHeight,
			maxU: clampedMaxX / canvasWidth,
			maxV: clampedMaxY / canvasHeight,
		},
	};
}

/**
 * BackdropCaptureManager - General-purpose backdrop capture system
 *
 * Captures the current unrotated prebuf state for use in various effects
 * such as filters, UI panels, and post-processing.
 *
 * Use cases:
 * - FrostGlass: blur the backdrop behind an object
 * - UI panels: frosted glass effect for floating panels
 * - Post-processing: full-screen effects
 */
export class BackdropCaptureManager {
	private device: GPUDevice;
	private filterRenderer: FilterRenderer;
	/** Frame-transient allocator for region captures. Frame-local backdrop
	 * stages re-capture their region every frame; raw createTexture here
	 * re-allocated tens of MB per frame, so captures lease from the pool
	 * (exact size — the blit UV math assumes texture size == content size). */
	private texturePool: TexturePool | null = null;

	// Lazily-built pipeline that resamples the display-resolution backdrop into
	// a fixed rasterization-DPI (R) texture, so backdrop filters compute their
	// effect on a zoom/pan-invariant grid.
	private resamplePipeline: GPURenderPipeline | null = null;
	private resampleFormat: GPUTextureFormat | null = null;
	private resampleBindGroupLayout: GPUBindGroupLayout | null = null;
	private resampleSampler: GPUSampler | null = null;

	public constructor(device: GPUDevice, filterRenderer: FilterRenderer) {
		this.device = device;
		this.filterRenderer = filterRenderer;
	}

	/** Wire the per-canvas texture pool (CanvasLayer owns it, so it cannot be
	 * a constructor dependency — the manager is created per canvas target
	 * before its layer). */
	public setTexturePool(pool: TexturePool): void {
		this.texturePool = pool;
	}

	/** Copy a changed canvas region into an existing captured backdrop. The
	 * returned rectangle uses the captured texture's local pixel coordinates. */
	public patchCapturedRegion(
		encoder: GPUCommandEncoder,
		sourceTexture: GPUTexture,
		capturedTexture: GPUTexture,
		capturedRect: BackdropPixelRect,
		dirtyBounds: BoundingBox,
		viewport: BackdropCaptureViewport,
		canvasWidth: number,
		canvasHeight: number,
	): BackdropPixelRect | null {
		const dirtyRegion = calculateBackdropCaptureRegion(
			dirtyBounds,
			viewport,
			canvasWidth,
			canvasHeight,
		);
		const intersection = intersectPixelRects(capturedRect, {
			x: dirtyRegion.copyOrigin.x,
			y: dirtyRegion.copyOrigin.y,
			width: dirtyRegion.copySize.width,
			height: dirtyRegion.copySize.height,
		});
		if (!intersection) return null;

		encoder.copyTextureToTexture(
			{
				texture: sourceTexture,
				origin: { x: intersection.x, y: intersection.y },
			},
			{
				texture: capturedTexture,
				origin: {
					x: intersection.x - capturedRect.x,
					y: intersection.y - capturedRect.y,
				},
			},
			{ width: intersection.width, height: intersection.height },
		);

		return {
			x: intersection.x - capturedRect.x,
			y: intersection.y - capturedRect.y,
			width: intersection.width,
			height: intersection.height,
		};
	}

	/**
	 * @param bounds Region to capture in world coordinates
	 * @param viewport Unrotated prebuf viewport subset used for world/screen mapping
	 * @param canvasWidth Prebuf width in pixels
	 * @param canvasHeight Prebuf height in pixels
	 */
	/**
	 * @param rasterScale When provided, the captured region is resampled into a
	 *   texture sized at this fixed rasterization scale (R = rasterizationDpi/72,
	 *   texels per world px) instead of the display-resolution region, and the
	 *   filters run on that grid. This makes backdrop filters (frost glass,
	 *   pixelate) invariant to viewport zoom/pan. Omit for a
	 *   display-resolution capture (e.g. glass-extrude refraction).
	 */
	public captureRegion(
		encoder: GPUCommandEncoder,
		sourceTexture: GPUTexture,
		bounds: BoundingBox,
		viewport: BackdropCaptureViewport,
		canvasWidth: number,
		canvasHeight: number,
		filters?: Filter[],
		maskTexture?: GPUTexture,
		rasterScale?: number,
	): CapturedBackdrop {
		const region = calculateBackdropCaptureRegion(
			bounds,
			viewport,
			canvasWidth,
			canvasHeight,
		);
		const regionWidth = region.copySize.width;
		const regionHeight = region.copySize.height;

		if (regionWidth <= 0 || regionHeight <= 0) {
			const dummyTexture = this.device.createTexture({
				label: "Empty Backdrop Texture",
				size: { width: 1, height: 1 },
				format: sourceTexture.format,
				usage: GPUTextureUsage.TEXTURE_BINDING,
			});
			const dummyBounds: BoundingBox = {
				minX: 0,
				minY: 0,
				maxX: 1,
				maxY: 1,
				width: 1,
				height: 1,
			};
			return {
				texture: dummyTexture,
				actualBounds: dummyBounds,
				sourceUV: { minU: 0, minV: 0, maxU: 1, maxV: 1 },
				filtered: false,
			};
		}

		const useR = rasterScale !== undefined && rasterScale > 0;
		const captureBounds = useR
			? snapBoundsToRasterGrid(region.actualBounds, rasterScale)
			: region.actualBounds;
		const maxDim = this.device.limits.maxTextureDimension2D;
		const texWidth = Math.min(
			useR
				? Math.max(1, Math.round(captureBounds.width * rasterScale))
				: regionWidth,
			maxDim,
		);
		const texHeight = Math.min(
			useR
				? Math.max(1, Math.round(captureBounds.height * rasterScale))
				: regionHeight,
			maxDim,
		);

		// Use the same format as the source texture (canvasFormat) — no format
		// conversion needed since filter pipelines now also use canvasFormat.
		const regionUsage =
			GPUTextureUsage.RENDER_ATTACHMENT |
			GPUTextureUsage.TEXTURE_BINDING |
			GPUTextureUsage.COPY_SRC |
			GPUTextureUsage.COPY_DST;
		const regionTexture =
			this.texturePool?.acquireExact(
				texWidth,
				texHeight,
				sourceTexture.format,
				1,
				regionUsage,
				"Backdrop Region Texture",
			) ??
			this.device.createTexture({
				label: "Backdrop Region Texture",
				size: { width: texWidth, height: texHeight },
				format: sourceTexture.format,
				usage: regionUsage,
			});

		const captured = this.captureInto(encoder, {
			sourceTexture,
			sourceWorldBounds: bounds,
			viewport,
			canvasWidth,
			canvasHeight,
			destination: {
				texture: regionTexture,
				origin: { x: 0, y: 0 },
				contentRect: { x: 0, y: 0, width: texWidth, height: texHeight },
			},
			domain: useR
				? { kind: "fixed-r", rasterScale }
				: { kind: "display-density" },
		});
		if (!captured) {
			if (!this.texturePool?.release(regionTexture)) regionTexture.destroy();
			throw new Error("Failed to capture backdrop region");
		}

		let filtered = false;
		if (filters && filters.length > 0) {
			this.filterRenderer.applyFilters(
				regionTexture,
				filters,
				encoder,
				maskTexture,
				useR ? rasterScale : viewport.zoom,
			);
			filtered = true;
		}

		return {
			texture: regionTexture,
			actualBounds: captured.actualBounds,
			sourceUV: captured.sourceUV,
			filtered,
		};
	}

	/**
	 * Capture into caller-owned storage. This low-level form lets the caller
	 * own the destination texture's lifetime; `captureRegion` builds on it and
	 * keeps allocating its own frame-local wrapper.
	 */
	public captureInto(
		encoder: GPUCommandEncoder,
		request: BackdropCaptureIntoRequest,
	): CapturedBackdropInto | null {
		const {
			sourceTexture,
			sourceWorldBounds,
			viewport,
			canvasWidth,
			canvasHeight,
			destination,
			domain,
			profiler,
		} = request;
		const region = calculateBackdropCaptureRegion(
			sourceWorldBounds,
			viewport,
			canvasWidth,
			canvasHeight,
		);
		if (region.copySize.width <= 0 || region.copySize.height <= 0) return null;

		const targetRect = {
			x: destination.origin.x + destination.contentRect.x,
			y: destination.origin.y + destination.contentRect.y,
			width: destination.contentRect.width,
			height: destination.contentRect.height,
		};
		if (targetRect.width <= 0 || targetRect.height <= 0) return null;
		if (
			!this.supportsCaptureSize(targetRect.width, targetRect.height) ||
			targetRect.x < 0 ||
			targetRect.y < 0 ||
			targetRect.x + targetRect.width > destination.texture.width ||
			targetRect.y + targetRect.height > destination.texture.height
		) {
			return null;
		}

		let actualBounds = region.actualBounds;
		let sourceUV = region.sourceUV;
		const resampleDensity =
			domain.kind === "fixed-r" ? domain.rasterScale : domain.density;
		if (resampleDensity !== undefined) {
			if (!(resampleDensity > 0)) {
				throw new Error("backdrop capture density must be positive");
			}
			actualBounds = snapBoundsToRasterGrid(
				region.actualBounds,
				resampleDensity,
			);
			sourceUV = worldBoundsToPrebufUV(
				actualBounds,
				viewport,
				canvasWidth,
				canvasHeight,
			);
			this.resampleToTarget(
				encoder,
				sourceTexture,
				sourceUV,
				destination.texture,
				targetRect,
				profiler,
			);
		} else {
			const copyWidth = Math.min(region.copySize.width, targetRect.width);
			const copyHeight = Math.min(region.copySize.height, targetRect.height);
			encoder.copyTextureToTexture(
				{ texture: sourceTexture, origin: region.copyOrigin },
				{
					texture: destination.texture,
					origin: { x: targetRect.x, y: targetRect.y },
				},
				{
					width: copyWidth,
					height: copyHeight,
				},
			);
			targetRect.width = copyWidth;
			targetRect.height = copyHeight;
		}
		return {
			actualBounds,
			sourceUV,
			writtenRect: targetRect,
		};
	}

	public supportsCaptureSize(width: number, height: number): boolean {
		const maxDimension = this.device.limits.maxTextureDimension2D;
		return (
			width > 0 && height > 0 && width <= maxDimension && height <= maxDimension
		);
	}

	public destroy(): void {
		this.resamplePipeline = null;
		this.resampleFormat = null;
		this.resampleBindGroupLayout = null;
		this.resampleSampler = null;
	}

	/**
	 * Resample `sourceTexture` over `sourceUV` (prebuf UV rect) into the full
	 * extent of `target`, rescaling display resolution to the target's fixed
	 * rasterization resolution.
	 */
	private resampleToTarget(
		encoder: GPUCommandEncoder,
		sourceTexture: GPUTexture,
		sourceUV: { minU: number; minV: number; maxU: number; maxV: number },
		target: GPUTexture,
		destinationRect: BackdropPixelRect = {
			x: 0,
			y: 0,
			width: target.width,
			height: target.height,
		},
		profiler?: GPUTimingProfiler | null,
	): void {
		this.ensureResamplePipeline(target.format);

		const uniformBuffer = this.device.createBuffer({
			label: "Backdrop Resample Uniform",
			size: 16,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		});
		this.device.queue.writeBuffer(
			uniformBuffer,
			0,
			new Float32Array([
				sourceUV.minU,
				sourceUV.minV,
				sourceUV.maxU,
				sourceUV.maxV,
			]),
		);

		const bindGroup = this.device.createBindGroup({
			label: "Backdrop Resample Bind Group",
			layout: this.resampleBindGroupLayout!,
			entries: [
				{ binding: 0, resource: { buffer: uniformBuffer } },
				{ binding: 1, resource: this.resampleSampler! },
				{ binding: 2, resource: sourceTexture.createView() },
			],
		});

		const pass = encoder.beginRenderPass({
			label: "Backdrop Resample Pass",
			colorAttachments: [
				{
					view: target.createView(),
					loadOp: "load",
					storeOp: "store",
					clearValue: { r: 0, g: 0, b: 0, a: 0 },
				},
			],
			timestampWrites: profiler?.timestampWrites("Backdrop Capture Resample"),
		});
		pass.setViewport(
			destinationRect.x,
			destinationRect.y,
			destinationRect.width,
			destinationRect.height,
			0,
			1,
		);
		pass.setScissorRect(
			destinationRect.x,
			destinationRect.y,
			destinationRect.width,
			destinationRect.height,
		);
		pass.setPipeline(this.resamplePipeline!);
		pass.setBindGroup(0, bindGroup);
		pass.draw(3);
		pass.end();
	}

	private ensureResamplePipeline(format: GPUTextureFormat): void {
		if (this.resamplePipeline && this.resampleFormat === format) return;

		this.resampleBindGroupLayout ??= this.device.createBindGroupLayout({
			label: "Backdrop Resample Bind Group Layout",
			entries: [
				{
					binding: 0,
					visibility: GPUShaderStage.FRAGMENT,
					buffer: { type: "uniform" },
				},
				{
					binding: 1,
					visibility: GPUShaderStage.FRAGMENT,
					sampler: { type: "filtering" },
				},
				{
					binding: 2,
					visibility: GPUShaderStage.FRAGMENT,
					texture: { sampleType: "float" },
				},
			],
		});
		this.resampleSampler ??= this.device.createSampler({
			label: "Backdrop Resample Sampler",
			magFilter: "linear",
			minFilter: "linear",
			addressModeU: "clamp-to-edge",
			addressModeV: "clamp-to-edge",
		});

		const { module } = compileShaderModule(this.device, {
			label: "Backdrop Resample Shader",
			code: BACKDROP_RESAMPLE_SHADER,
		});
		this.resamplePipeline = createFullscreenPipeline({
			device: this.device,
			label: "Backdrop Resample Pipeline",
			shaderModule: module,
			pipelineLayout: this.device.createPipelineLayout({
				bindGroupLayouts: [this.resampleBindGroupLayout],
			}),
			targetFormat: format,
			multisampleCount: 1,
		});
		this.resampleFormat = format;
	}
}

function snapBoundsToRasterGrid(
	bounds: BoundingBox,
	rasterScale: number,
): BoundingBox {
	const minX = Math.floor(bounds.minX * rasterScale) / rasterScale;
	const minY = Math.floor(bounds.minY * rasterScale) / rasterScale;
	const maxX = Math.ceil(bounds.maxX * rasterScale) / rasterScale;
	const maxY = Math.ceil(bounds.maxY * rasterScale) / rasterScale;
	return {
		minX,
		minY,
		maxX,
		maxY,
		width: maxX - minX,
		height: maxY - minY,
	};
}

function worldBoundsToPrebufUV(
	bounds: BoundingBox,
	viewport: BackdropCaptureViewport,
	canvasWidth: number,
	canvasHeight: number,
) {
	const toU = (worldX: number) =>
		((worldX - viewport.x) * viewport.zoom + canvasWidth / 2) / canvasWidth;
	const toV = (worldY: number) =>
		(canvasHeight / 2 - (worldY - viewport.y) * viewport.zoom) / canvasHeight;
	return {
		minU: toU(bounds.minX),
		minV: toV(bounds.maxY),
		maxU: toU(bounds.maxX),
		maxV: toV(bounds.minY),
	};
}

function intersectPixelRects(
	a: BackdropPixelRect,
	b: BackdropPixelRect,
): BackdropPixelRect | null {
	const minX = Math.max(a.x, b.x);
	const minY = Math.max(a.y, b.y);
	const maxX = Math.min(a.x + a.width, b.x + b.width);
	const maxY = Math.min(a.y + a.height, b.y + b.height);
	if (minX >= maxX || minY >= maxY) return null;
	return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
