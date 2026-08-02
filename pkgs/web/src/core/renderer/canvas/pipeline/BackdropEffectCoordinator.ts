import type { BoundingBox, Viewport } from "../../../schema";
import type { GPUTimingProfiler } from "../../GPUTimingProfiler";
import {
	type BackdropCaptureManager,
	type BackdropPixelRect,
	calculateBackdropCaptureRegion,
} from "./BackdropCaptureManager";
import {
	BlurPyramidBuilder,
	type BlurPyramidLevel,
	type BlurTextureCtl,
	blurTextureCtl,
	PYRAMID_KERNEL_RADIUS,
	requiredPyramidLevels,
	selectPyramidLevels,
} from "./BlurPyramid";
import type { TexturePool } from "./TexturePool";

/** One backdrop-consuming effect's declared need for this frame: the world
 *  region it composites over and the backdrop blur it wants there. */
export interface BackdropEffectRequest {
	/** World bounds of the effect's composite quad. */
	bounds: BoundingBox;
	/** Gaussian blur sigma applied to the backdrop, in region texels. */
	blurSigma: number;
	/** When set, the request is served from a fixed-R batch: the capture is
	 *  resampled onto the world-snapped rasterization grid (texels per world
	 *  px) instead of device pixels, so backdrop filters stay invariant to
	 *  viewport zoom/pan. Requests batch per rasterScale value. */
	rasterScale?: number;
}

/** Pyramid sample for one blur sigma over a fixed-R region: the two batch
 *  levels bracketing it, their sampling ctl, the variance-space lerp factor,
 *  and the region→batch uv remap (batch = xy + regionUv·zw). */
export interface BackdropBlurLevels {
	blurLo: GPUTexture;
	blurLoCtl: BlurTextureCtl;
	blurHi: GPUTexture;
	blurHiCtl: BlurTextureCtl;
	blurMix: number;
	remap: readonly [number, number, number, number];
}

/** What a fixed-R request gets back: its own region cropped out of the
 *  shared batch capture, shaped like BackdropCaptureManager's result so the
 *  backdrop-filter blit path consumes it unchanged. The texture is exclusive
 *  to the request (filter chains mutate it in place). */
export interface FixedRBackdropRegion {
	texture: GPUTexture;
	/** Captured world bounds of the region (R-grid snapped, canvas-clamped). */
	actualBounds: BoundingBox;
	/** Prebuf-space UV rect of the region, normalized to [0,1]. */
	sourceUV: { minU: number; minV: number; maxU: number; maxV: number };
	/** Shared-pyramid accessor for blurring filters (frost glass): the levels
	 *  bracketing `sigma` (in R texels) over this region, or null when the
	 *  batch has no pyramid (the filter then blurs on its own). Consume
	 *  synchronously — the underlying batch only lives until the next
	 *  intersecting draw. */
	sampleBlur: (sigma: number) => BackdropBlurLevels | null;
}

/**
 * What an effect gets back for one request: the two pyramid levels bracketing
 * its blurSigma (level 0 = the sharp capture itself, so a sigma-0 effect gets
 * it as both levels), ready to be lerped in-shader. All textures cover the
 * batch's capture region; `backdropRemap` maps the effect's own
 * compose-viewport uv into that shared region uv.
 */
export interface BackdropEffectSample {
	blurLo: GPUTexture;
	blurLoCtl: BlurTextureCtl;
	blurHi: GPUTexture;
	blurHiCtl: BlurTextureCtl;
	/** Lerp factor between blurLo and blurHi (variance-space calibrated). */
	blurMix: number;
	/** The effect's own clamped compose rect in device pixels. */
	rect: { x: number; y: number; width: number; height: number };
	/** Compose-viewport uv → capture-region uv: region = xy + uv·zw. */
	backdropRemap: readonly [number, number, number, number];
}

export interface BackdropCoordinatorStats {
	frameLocalFallbacks: number;
	frameLocalCaptures: number;
	pyramidBuilds: number;
	pyramidPatches: number;
}

export const FULL_PYRAMID_REBUILD_THRESHOLD = 0.5;

export interface PyramidDirtyUpdate {
	sharp: BackdropPixelRect[];
	levels: Array<{
		horizontal: BackdropPixelRect[];
		vertical: BackdropPixelRect[];
	}>;
}

/** Axis-aligned world-bounds intersection (touching counts as intersecting —
 *  a draw flush against a capture edge can still bleed into it via AA). */
export function boundsIntersect(a: BoundingBox, b: BoundingBox): boolean {
	return (
		a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY
	);
}

/**
 * The capture bounds for a new batch serving `target`: the union of every
 * still-pending request (they all reuse this capture unless something draws
 * into their region in between). Always one shared capture — the region is
 * clamped to the canvas anyway, so the worst case is one screen-sized
 * capture + pyramid per epoch, independent of effect count. Splitting into
 * per-effect captures was measured to cost MORE (render-pass count × fixed
 * per-pass overhead on the GPU process dominates the texel savings). Callers
 * pre-filter `pending` to viewport-intersecting requests so one small
 * on-screen effect isn't inflated to a full-screen capture by off-screen
 * ones.
 */
export function planBatchBounds(
	target: BackdropEffectRequest,
	pending: readonly BackdropEffectRequest[],
): BoundingBox {
	let minX = target.bounds.minX;
	let minY = target.bounds.minY;
	let maxX = target.bounds.maxX;
	let maxY = target.bounds.maxY;
	for (const req of pending) {
		if (req === target) continue;
		minX = Math.min(minX, req.bounds.minX);
		minY = Math.min(minY, req.bounds.minY);
		maxX = Math.max(maxX, req.bounds.maxX);
		maxY = Math.max(maxY, req.bounds.maxY);
	}
	return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

interface ActiveBatch {
	/** World bounds the capture was planned over (pre-clamp). */
	worldBounds: BoundingBox;
	/** Screen-px rect of the actual (clamped) capture. */
	rect: { x: number; y: number; width: number; height: number };
	/** Fixed-R batches only: captured world bounds (R-grid snapped). */
	capturedBounds?: BoundingBox;
	sharp: GPUTexture;
	sharpCtl: BlurTextureCtl;
	/** Levels 1..N (level 0 is `sharp`). */
	levels: BlurPyramidLevel[];
	/** Draw regions reported since this batch's sharp capture. */
	dirtyBounds: BoundingBox[];
}

/** Batch-map key for display-resolution requests (rasterScale is never 0). */
const DISPLAY_BATCH_KEY = 0;

/**
 * Shared backdrop service for effects that composite over the document at
 * element z-order (glass extrude today; frosted glass and other backdrop
 * effects can adopt the same contract). Owns the draw-order bookkeeping
 * (which main-pass draws invalidate a captured backdrop), batches compatible
 * requests into one capture, and builds a single calibrated Gaussian pyramid
 * per batch so N effects with M distinct blur sigmas cost one pyramid, not
 * N full-resolution blurs.
 *
 * Correctness contract: a sample handed out for a request always reflects
 * every draw the caller reported (`noteDraw`) before `acquireSample` — a
 * batch is dropped and recaptured the moment a reported draw intersects its
 * capture region, so z-order backdrop reads behave exactly like the previous
 * per-effect capture.
 *
 * Two batch domains coexist per frame: display-resolution batches
 * (`acquireSample`, glass extrude's screen-space sampling) and fixed-R
 * batches (`acquireFixedRRegion`, backdrop filters on the world-snapped
 * rasterization grid — one batch per rasterScale). Fixed-R batches skip the
 * device-px patch path and recapture on intersecting draws instead.
 */
export class BackdropEffectCoordinator {
	/** Shared blur passes; this class supplies only the capture and the
	 *  dirty-region bookkeeping around them. */
	private readonly pyramid: BlurPyramidBuilder;

	private pending: BackdropEffectRequest[] = [];
	/** Live batches keyed by rasterScale (DISPLAY_BATCH_KEY = display-res). */
	private batches = new Map<number, ActiveBatch>();
	/** Scales whose union capture hit the device texture-size limit this
	 *  frame — their requests are served individually without re-trying. */
	private clampedScales = new Set<number>();
	/** Every texture created/acquired this frame, released at frame end (they
	 *  may be referenced by not-yet-submitted passes, so never earlier). */
	private frameTextures: GPUTexture[] = [];
	private readonly stats: BackdropCoordinatorStats = emptyCoordinatorStats();

	public constructor(
		private readonly device: GPUDevice,
		private readonly texturePool: TexturePool,
		private readonly backdropCaptureManager: BackdropCaptureManager,
	) {
		this.pyramid = new BlurPyramidBuilder(device, (width, height, format) =>
			this.acquireLevelTexture(width, height, format),
		);
	}

	/** Reset per-frame state. Call once per frame before the main pass. */
	public beginFrame(): void {
		this.pending = [];
		this.batches.clear();
		this.clampedScales.clear();
		this.pyramid.beginFrame();
	}

	/** Register this frame's backdrop requests (same object identities must be
	 *  passed to acquireSample). Called by the effect driver after baking. */
	public planFrame(requests: readonly BackdropEffectRequest[]): void {
		this.pending.push(...requests);
	}

	/** Report a main-pass draw so exact frames can refresh the affected backdrop
	 * texels before a later effect samples them. */
	public noteDraw(bounds: BoundingBox): void {
		for (const batch of this.batches.values()) {
			batch.dirtyBounds = mergeBoundingBoxes(batch.dirtyBounds, bounds);
		}
	}

	/** Drop every live batch unconditionally — for prebuf writes without
	 *  usable bounds. */
	public invalidate(): void {
		this.batches.clear();
	}

	/**
	 * Hand out the backdrop sample for one request, capturing + building the
	 * shared pyramid if no live batch covers it. `sourceTexture` is the
	 * document target being composed over (also the capture source). Returns
	 * null for a fully off-screen region.
	 */
	public acquireSample(
		encoder: GPUCommandEncoder,
		sourceTexture: GPUTexture,
		viewport: Pick<Viewport, "x" | "y" | "zoom">,
		canvasWidth: number,
		canvasHeight: number,
		request: BackdropEffectRequest,
		profiler?: GPUTimingProfiler | null,
	): BackdropEffectSample | null {
		const pendingIndex = this.pending.indexOf(request);
		if (pendingIndex >= 0) this.pending.splice(pendingIndex, 1);

		const region = calculateBackdropCaptureRegion(
			request.bounds,
			viewport,
			canvasWidth,
			canvasHeight,
		);
		if (region.copySize.width <= 0 || region.copySize.height <= 0) return null;

		// The live batch must also actually contain this request's region —
		// an individual (waste-ratio fallback) batch doesn't serve the others.
		let batch = this.batches.get(DISPLAY_BATCH_KEY);
		if (batch && !containsRect(batch.rect, region)) {
			this.batches.delete(DISPLAY_BATCH_KEY);
			batch = undefined;
		}
		// Patch the current batch after a reported draw intersects this request.
		// The patch applies every pending dirty region in the batch, so later
		// requests can keep sharing it while sampling exact z-order output.
		if (
			batch &&
			batch.dirtyBounds.some((bounds) =>
				boundsIntersect(bounds, request.bounds),
			)
		) {
			this.updateBatch(
				encoder,
				sourceTexture,
				batch,
				viewport,
				canvasWidth,
				canvasHeight,
				profiler,
			);
			batch.dirtyBounds = [];
		}

		if (!batch) {
			const fresh = this.captureBatch(
				encoder,
				sourceTexture,
				viewport,
				canvasWidth,
				canvasHeight,
				request,
				profiler,
			);
			if (!fresh) return null;
			batch = fresh;
			this.batches.set(DISPLAY_BATCH_KEY, fresh);
		}
		const { lo, hi, mix } = selectPyramidLevels(
			request.blurSigma,
			batch.levels.length,
		);
		const levelTexture = (index: number) =>
			index === 0 ? batch.sharp : batch.levels[index - 1].texture;
		const levelCtl = (index: number) =>
			index === 0 ? batch.sharpCtl : batch.levels[index - 1].ctl;

		return {
			blurLo: levelTexture(lo),
			blurLoCtl: levelCtl(lo),
			blurHi: levelTexture(hi),
			blurHiCtl: levelCtl(hi),
			blurMix: mix,
			rect: {
				x: region.copyOrigin.x,
				y: region.copyOrigin.y,
				width: region.copySize.width,
				height: region.copySize.height,
			},
			backdropRemap: [
				(region.copyOrigin.x - batch.rect.x) / batch.rect.width,
				(region.copyOrigin.y - batch.rect.y) / batch.rect.height,
				region.copySize.width / batch.rect.width,
				region.copySize.height / batch.rect.height,
			],
		};
	}

	/**
	 * Hand out one fixed-R request's backdrop region, capturing the shared
	 * R-grid batch if no live batch covers it. Unlike display batches, a
	 * fixed-R batch is dropped and recaptured when a reported draw intersects
	 * the request (the device-px patch path cannot write the R grid). Returns
	 * null for a fully off-screen region.
	 */
	public acquireFixedRRegion(
		encoder: GPUCommandEncoder,
		sourceTexture: GPUTexture,
		viewport: Pick<Viewport, "x" | "y" | "zoom">,
		canvasWidth: number,
		canvasHeight: number,
		request: BackdropEffectRequest,
		profiler?: GPUTimingProfiler | null,
	): FixedRBackdropRegion | null {
		const scale = request.rasterScale;
		if (!scale || scale <= 0) {
			throw new Error("acquireFixedRRegion requires a positive rasterScale");
		}
		const pendingIndex = this.pending.indexOf(request);
		if (pendingIndex >= 0) this.pending.splice(pendingIndex, 1);

		if (this.clampedScales.has(scale)) {
			return this.acquireIndividualFixedR(
				encoder,
				sourceTexture,
				viewport,
				canvasWidth,
				canvasHeight,
				request,
				scale,
			);
		}

		// Round the request region exactly like a direct captureRegion call
		// would (screen-px clamp, then R-grid snap), so the cropped region's
		// bounds — and thus the filter output — match the per-element path.
		const clamped = calculateBackdropCaptureRegion(
			request.bounds,
			viewport,
			canvasWidth,
			canvasHeight,
		);
		if (clamped.copySize.width <= 0 || clamped.copySize.height <= 0) {
			return null;
		}
		const snapped = snapBoundsToRasterGrid(clamped.actualBounds, scale);
		let batch = this.batches.get(scale);
		if (
			batch &&
			(!batch.capturedBounds ||
				!containsBounds(batch.capturedBounds, snapped, 0.5 / scale) ||
				batch.dirtyBounds.some((bounds) =>
					boundsIntersect(bounds, request.bounds),
				))
		) {
			this.batches.delete(scale);
			batch = undefined;
		}
		if (!batch) {
			const fresh = this.captureFixedRBatch(
				encoder,
				sourceTexture,
				viewport,
				canvasWidth,
				canvasHeight,
				request,
				scale,
			);
			if (!fresh) return null;
			batch = fresh;
			this.batches.set(scale, fresh);
		}

		// A capture that hit the device texture-size limit was compressed off
		// the R grid — integer-offset cropping is invalid there, so serve the
		// requests from their own captures (the pre-batching per-element
		// behavior) for the rest of the frame.
		const captured = batch.capturedBounds!;
		if (
			Math.round(captured.width * scale) !== batch.sharp.width ||
			Math.round(captured.height * scale) !== batch.sharp.height
		) {
			this.batches.delete(scale);
			this.clampedScales.add(scale);
			return this.acquireIndividualFixedR(
				encoder,
				sourceTexture,
				viewport,
				canvasWidth,
				canvasHeight,
				request,
				scale,
			);
		}

		// Crop the request's region out of the shared capture. Both rects are
		// snapped to the same world R grid, so the offsets are integer texels.
		const crop = intersectWorldBounds(snapped, captured);
		if (!crop) return null;
		const originX = Math.round((crop.minX - captured.minX) * scale);
		const originY = Math.round((captured.maxY - crop.maxY) * scale);
		const cropWidth = Math.max(
			1,
			Math.min(Math.round(crop.width * scale), batch.sharp.width - originX),
		);
		const cropHeight = Math.max(
			1,
			Math.min(Math.round(crop.height * scale), batch.sharp.height - originY),
		);
		// Exact size: the crop's blit UV math assumes texture == content, and
		// pooling (vs createTexture) stops the per-frame re-allocation of this
		// crop for stages that stay frame-local.
		const texture = this.texturePool.acquireExact(
			cropWidth,
			cropHeight,
			batch.sharp.format,
			1,
			GPUTextureUsage.RENDER_ATTACHMENT |
				GPUTextureUsage.TEXTURE_BINDING |
				GPUTextureUsage.COPY_SRC |
				GPUTextureUsage.COPY_DST,
			"Backdrop Fixed-R Region",
		);
		this.frameTextures.push(texture);
		encoder.copyTextureToTexture(
			{
				texture: batch.sharp,
				origin: { x: originX, y: originY },
			},
			{ texture },
			{ width: cropWidth, height: cropHeight },
		);

		return {
			texture,
			actualBounds: crop,
			sourceUV: worldBoundsToPrebufUV(
				crop,
				viewport,
				canvasWidth,
				canvasHeight,
			),
			sampleBlur: makeBlurSampler(batch, crop, captured),
		};
	}

	/** Release this frame's capture + pyramid textures (pool-aware callback,
	 *  same contract as the drivers' releaseFrame). */
	public releaseFrame(release: (texture: GPUTexture) => void): void {
		for (const texture of this.frameTextures) release(texture);
		this.frameTextures = [];
		this.batches.clear();
	}

	public destroy(): void {
		this.pyramid.destroy();
	}

	/** Capture the batch region and build its pyramid levels. */
	private captureBatch(
		encoder: GPUCommandEncoder,
		sourceTexture: GPUTexture,
		viewport: Pick<Viewport, "x" | "y" | "zoom">,
		canvasWidth: number,
		canvasHeight: number,
		target: BackdropEffectRequest,
		profiler?: GPUTimingProfiler | null,
	): ActiveBatch | null {
		// Off-screen pending effects never compose this frame (viewport culling)
		// — folding them in would inflate a single on-screen effect's capture to
		// the whole (clamped) screen for nothing. Fixed-R requests batch
		// separately, so they never inflate the display capture either.
		const viewBounds = viewportWorldBounds(viewport, canvasWidth, canvasHeight);
		const visiblePending = this.pending.filter(
			(req) =>
				req.rasterScale == null && boundsIntersect(req.bounds, viewBounds),
		);
		const worldBounds = planBatchBounds(target, visiblePending);
		const maxSigma = [target, ...visiblePending].reduce(
			(max, req) => Math.max(max, req.blurSigma),
			0,
		);

		const region = calculateBackdropCaptureRegion(
			worldBounds,
			viewport,
			canvasWidth,
			canvasHeight,
		);
		if (region.copySize.width <= 0 || region.copySize.height <= 0) return null;

		const captured = this.backdropCaptureManager.captureRegion(
			encoder,
			sourceTexture,
			worldBounds,
			viewport,
			canvasWidth,
			canvasHeight,
		);
		this.stats.frameLocalCaptures++;
		this.frameTextures.push(captured.texture);

		const sharpWidth = region.copySize.width;
		const sharpHeight = region.copySize.height;
		const levels = this.pyramid.build(
			encoder,
			captured.texture,
			sharpWidth,
			sharpHeight,
			requiredPyramidLevels(maxSigma),
			profiler,
			"Backdrop Pyramid Build",
		);
		if (levels.length > 0) this.stats.pyramidBuilds++;

		return {
			worldBounds,
			rect: {
				x: region.copyOrigin.x,
				y: region.copyOrigin.y,
				width: sharpWidth,
				height: sharpHeight,
			},
			sharp: captured.texture,
			sharpCtl: blurTextureCtl(sharpWidth, sharpHeight, captured.texture),
			levels,
			dirtyBounds: [],
		};
	}

	/** One request's own uncropped fixed-R capture — used when the shared
	 *  batch cannot serve it on an intact R grid. Not stored as a batch: the
	 *  returned texture is mutated in place by the caller's filter chain. */
	private acquireIndividualFixedR(
		encoder: GPUCommandEncoder,
		sourceTexture: GPUTexture,
		viewport: Pick<Viewport, "x" | "y" | "zoom">,
		canvasWidth: number,
		canvasHeight: number,
		request: BackdropEffectRequest,
		scale: number,
	): FixedRBackdropRegion | null {
		const own = this.captureFixedRBatch(
			encoder,
			sourceTexture,
			viewport,
			canvasWidth,
			canvasHeight,
			request,
			scale,
			true,
		);
		if (!own) return null;
		const ownBounds = own.capturedBounds!;
		return {
			texture: own.sharp,
			actualBounds: ownBounds,
			sourceUV: worldBoundsToPrebufUV(
				ownBounds,
				viewport,
				canvasWidth,
				canvasHeight,
			),
			sampleBlur: makeBlurSampler(own, ownBounds, ownBounds),
		};
	}

	/** Capture the shared fixed-R batch for one rasterScale: the union of the
	 *  still-pending same-scale visible requests, resampled onto the
	 *  world-snapped R grid by BackdropCaptureManager. */
	private captureFixedRBatch(
		encoder: GPUCommandEncoder,
		sourceTexture: GPUTexture,
		viewport: Pick<Viewport, "x" | "y" | "zoom">,
		canvasWidth: number,
		canvasHeight: number,
		target: BackdropEffectRequest,
		scale: number,
		individual = false,
	): ActiveBatch | null {
		const viewBounds = viewportWorldBounds(viewport, canvasWidth, canvasHeight);
		const visiblePending = individual
			? []
			: this.pending.filter(
					(req) =>
						req.rasterScale === scale &&
						boundsIntersect(req.bounds, viewBounds),
				);
		const worldBounds = planBatchBounds(target, visiblePending);
		const maxSigma = [target, ...visiblePending].reduce(
			(max, req) => Math.max(max, req.blurSigma),
			0,
		);

		const region = calculateBackdropCaptureRegion(
			worldBounds,
			viewport,
			canvasWidth,
			canvasHeight,
		);
		if (region.copySize.width <= 0 || region.copySize.height <= 0) return null;

		const captured = this.backdropCaptureManager.captureRegion(
			encoder,
			sourceTexture,
			worldBounds,
			viewport,
			canvasWidth,
			canvasHeight,
			undefined,
			undefined,
			scale,
		);
		this.stats.frameLocalCaptures++;
		this.frameTextures.push(captured.texture);

		const levels = this.pyramid.build(
			encoder,
			captured.texture,
			captured.texture.width,
			captured.texture.height,
			requiredPyramidLevels(maxSigma),
			undefined,
			"Backdrop Pyramid Build",
		);
		if (levels.length > 0) this.stats.pyramidBuilds++;

		return {
			worldBounds,
			rect: {
				x: region.copyOrigin.x,
				y: region.copyOrigin.y,
				width: region.copySize.width,
				height: region.copySize.height,
			},
			capturedBounds: captured.actualBounds,
			sharp: captured.texture,
			sharpCtl: blurTextureCtl(
				captured.texture.width,
				captured.texture.height,
				captured.texture,
			),
			levels,
			dirtyBounds: [],
		};
	}

	/** Copy changed canvas pixels into the shared sharp capture, then refresh
	 * only the blur-pyramid texels whose inputs may have changed. */
	private updateBatch(
		encoder: GPUCommandEncoder,
		sourceTexture: GPUTexture,
		batch: ActiveBatch,
		viewport: Pick<Viewport, "x" | "y" | "zoom">,
		canvasWidth: number,
		canvasHeight: number,
		profiler?: GPUTimingProfiler | null,
	): void {
		const sharpDirtyRects = batch.dirtyBounds.flatMap((bounds) => {
			const rect = this.backdropCaptureManager.patchCapturedRegion(
				encoder,
				sourceTexture,
				batch.sharp,
				batch.rect,
				bounds,
				viewport,
				canvasWidth,
				canvasHeight,
			);
			return rect ? [rect] : [];
		});
		if (sharpDirtyRects.length === 0) return;

		const update = planPyramidDirtyUpdate(
			sharpDirtyRects,
			batch.rect.width,
			batch.rect.height,
			batch.levels.length,
		);
		this.refreshPyramid(encoder, batch, update, profiler);
	}

	/** Recompute dirty regions of the retained horizontal intermediates and
	 * final pyramid levels. */
	private refreshPyramid(
		encoder: GPUCommandEncoder,
		batch: ActiveBatch,
		update: PyramidDirtyUpdate,
		profiler?: GPUTimingProfiler | null,
	): void {
		this.stats.pyramidPatches++;
		let sourceTexture = batch.sharp;
		let sourceWidth = batch.rect.width;
		let sourceHeight = batch.rect.height;

		for (const [index, level] of batch.levels.entries()) {
			const { horizontal, vertical } = update.levels[index];
			const rebuildWholeLevel =
				shouldRebuildFullPyramid(horizontal, level.usedWidth, sourceHeight) ||
				shouldRebuildFullPyramid(vertical, level.usedWidth, level.usedHeight);
			if (rebuildWholeLevel) {
				// The retained intermediate can be stale after fused tile updates,
				// so a fallback refreshes both separable passes across the level.
				this.pyramid.encodeLevelPass(
					encoder,
					sourceTexture,
					sourceWidth,
					sourceHeight,
					level.intermediate,
					level.usedWidth,
					sourceHeight,
					[1, 0],
					profiler,
					undefined,
					true,
					"Backdrop Pyramid Patch",
				);
				this.pyramid.encodeLevelPass(
					encoder,
					level.intermediate,
					level.usedWidth,
					sourceHeight,
					level.texture,
					level.usedWidth,
					level.usedHeight,
					[0, 1],
					profiler,
					undefined,
					true,
					"Backdrop Pyramid Patch",
				);
			} else {
				this.pyramid.encodeFusedLevelPass(
					encoder,
					sourceTexture,
					sourceWidth,
					sourceHeight,
					level.texture,
					level.usedWidth,
					level.usedHeight,
					vertical,
					profiler,
					"Backdrop Pyramid Patch",
				);
			}

			sourceTexture = level.texture;
			sourceWidth = level.usedWidth;
			sourceHeight = level.usedHeight;
		}
	}

	private acquireLevelTexture(
		width: number,
		height: number,
		format: GPUTextureFormat,
	): GPUTexture {
		const texture = this.texturePool.acquire(
			width,
			height,
			format,
			1,
			GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
			"Backdrop Pyramid Level",
		);
		this.frameTextures.push(texture);
		return texture;
	}
}

function emptyCoordinatorStats(): BackdropCoordinatorStats {
	return {
		frameLocalFallbacks: 0,
		frameLocalCaptures: 0,
		pyramidBuilds: 0,
		pyramidPatches: 0,
	};
}

// Helpers

function unionBounds(a: BoundingBox, b: BoundingBox): BoundingBox {
	const minX = Math.min(a.minX, b.minX);
	const minY = Math.min(a.minY, b.minY);
	const maxX = Math.max(a.maxX, b.maxX);
	const maxY = Math.max(a.maxY, b.maxY);
	return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

/** Expand bounds outward onto the fixed-R world grid (R texels per world px),
 *  mirroring BackdropCaptureManager's R-path snapping so batch and request
 *  rects land on the same grid. */
export function snapBoundsToRasterGrid(
	bounds: BoundingBox,
	rasterScale: number,
): BoundingBox {
	const minX = Math.floor(bounds.minX * rasterScale) / rasterScale;
	const maxX = Math.ceil(bounds.maxX * rasterScale) / rasterScale;
	const minY = Math.floor(bounds.minY * rasterScale) / rasterScale;
	const maxY = Math.ceil(bounds.maxY * rasterScale) / rasterScale;
	return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

/** Build a fixed-R region's pyramid accessor: levels come from `batch`,
 *  remapped from the region's crop rect into the batch's captured rect. */
function makeBlurSampler(
	batch: ActiveBatch,
	crop: BoundingBox,
	captured: BoundingBox,
): (sigma: number) => BackdropBlurLevels | null {
	return (sigma) => {
		if (sigma > 0 && batch.levels.length === 0) return null;
		const { lo, hi, mix } = selectPyramidLevels(sigma, batch.levels.length);
		const texture = (index: number) =>
			index === 0 ? batch.sharp : batch.levels[index - 1].texture;
		const ctl = (index: number) =>
			index === 0 ? batch.sharpCtl : batch.levels[index - 1].ctl;
		return {
			blurLo: texture(lo),
			blurLoCtl: ctl(lo),
			blurHi: texture(hi),
			blurHiCtl: ctl(hi),
			blurMix: mix,
			remap: [
				(crop.minX - captured.minX) / captured.width,
				(captured.maxY - crop.maxY) / captured.height,
				crop.width / captured.width,
				crop.height / captured.height,
			],
		};
	};
}

/** Prebuf-space UV rect for world bounds (world Y up flips to V down). */
export function worldBoundsToPrebufUV(
	bounds: BoundingBox,
	viewport: Pick<Viewport, "x" | "y" | "zoom">,
	canvasWidth: number,
	canvasHeight: number,
): { minU: number; minV: number; maxU: number; maxV: number } {
	const toU = (wx: number) =>
		((wx - viewport.x) * viewport.zoom + canvasWidth / 2) / canvasWidth;
	const toV = (wy: number) =>
		(canvasHeight / 2 - (wy - viewport.y) * viewport.zoom) / canvasHeight;
	return {
		minU: toU(bounds.minX),
		minV: toV(bounds.maxY),
		maxU: toU(bounds.maxX),
		maxV: toV(bounds.minY),
	};
}

function intersectWorldBounds(
	a: BoundingBox,
	b: BoundingBox,
): BoundingBox | null {
	const minX = Math.max(a.minX, b.minX);
	const minY = Math.max(a.minY, b.minY);
	const maxX = Math.min(a.maxX, b.maxX);
	const maxY = Math.min(a.maxY, b.maxY);
	if (minX >= maxX || minY >= maxY) return null;
	return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

/** Whether `outer` contains `inner`, within `epsilon` world units (the two
 *  rects come from independent float paths onto the same R grid). */
function containsBounds(
	outer: BoundingBox,
	inner: BoundingBox,
	epsilon: number,
): boolean {
	return (
		inner.minX >= outer.minX - epsilon &&
		inner.minY >= outer.minY - epsilon &&
		inner.maxX <= outer.maxX + epsilon &&
		inner.maxY <= outer.maxY + epsilon
	);
}

/** Plan the texels that must be refreshed after sharp-level pixels change.
 * Each pass grows the changed source area by the Gaussian support before it
 * maps the area into the downsampled destination level. */
export function planPyramidDirtyUpdate(
	dirtyRects: readonly BackdropPixelRect[],
	sharpWidth: number,
	sharpHeight: number,
	levelCount: number,
): PyramidDirtyUpdate {
	const sharp = mergePixelRects(
		dirtyRects
			.map((rect) => clipPixelRect(rect, sharpWidth, sharpHeight))
			.filter((rect): rect is BackdropPixelRect => rect != null),
	);
	const levels: PyramidDirtyUpdate["levels"] = [];
	let sourceRects = sharp;
	let sourceWidth = sharpWidth;
	let sourceHeight = sharpHeight;

	for (let level = 0; level < levelCount; level++) {
		const width = Math.max(1, Math.ceil(sourceWidth / 2));
		const height = Math.max(1, Math.ceil(sourceHeight / 2));
		const horizontal = mapDirtyRects(
			sourceRects,
			sourceWidth,
			sourceHeight,
			width,
			sourceHeight,
			PYRAMID_KERNEL_RADIUS,
			0,
		);
		const vertical = mapDirtyRects(
			horizontal,
			width,
			sourceHeight,
			width,
			height,
			0,
			PYRAMID_KERNEL_RADIUS,
		);
		levels.push({ horizontal, vertical });
		sourceRects = vertical;
		sourceWidth = width;
		sourceHeight = height;
	}

	return { sharp, levels };
}

/** Whether rasterizing the union of dirty tiles would cover at least half of
 * a level. A full pass is cheaper and simpler beyond this point. */
export function shouldRebuildFullPyramid(
	rects: readonly BackdropPixelRect[],
	width: number,
	height: number,
): boolean {
	if (width <= 0 || height <= 0) return false;
	const area = mergePixelRects(
		rects
			.map((rect) => clipPixelRect(rect, width, height))
			.filter((rect): rect is BackdropPixelRect => rect != null),
	).reduce((total, rect) => total + rect.width * rect.height, 0);
	return area >= width * height * FULL_PYRAMID_REBUILD_THRESHOLD;
}

function mapDirtyRects(
	rects: readonly BackdropPixelRect[],
	sourceWidth: number,
	sourceHeight: number,
	destinationWidth: number,
	destinationHeight: number,
	paddingX: number,
	paddingY: number,
): BackdropPixelRect[] {
	return mergePixelRects(
		rects
			.map((rect) => {
				const minX = Math.floor(
					((rect.x - paddingX) * destinationWidth) / sourceWidth,
				);
				const minY = Math.floor(
					((rect.y - paddingY) * destinationHeight) / sourceHeight,
				);
				const maxX = Math.ceil(
					((rect.x + rect.width + paddingX) * destinationWidth) / sourceWidth,
				);
				const maxY = Math.ceil(
					((rect.y + rect.height + paddingY) * destinationHeight) /
						sourceHeight,
				);
				return clipPixelRect(
					{ x: minX, y: minY, width: maxX - minX, height: maxY - minY },
					destinationWidth,
					destinationHeight,
				);
			})
			.filter((rect): rect is BackdropPixelRect => rect != null),
	);
}

function mergeBoundingBoxes(
	boxes: readonly BoundingBox[],
	addition: BoundingBox,
): BoundingBox[] {
	const pending = [{ ...addition }];
	const result = boxes.map((bounds) => ({ ...bounds }));
	while (pending.length > 0) {
		const current = pending.pop();
		if (!current) break;
		const overlappingIndex = result.findIndex((bounds) =>
			boundsIntersect(bounds, current),
		);
		if (overlappingIndex === -1) {
			result.push(current);
			continue;
		}
		const [overlapping] = result.splice(overlappingIndex, 1);
		pending.push(unionBounds(overlapping, current));
	}
	return result;
}

function mergePixelRects(
	rects: readonly BackdropPixelRect[],
): BackdropPixelRect[] {
	const pending = rects.map((rect) => ({ ...rect }));
	const result: BackdropPixelRect[] = [];
	while (pending.length > 0) {
		const current = pending.pop();
		if (!current) break;
		const overlappingIndex = result.findIndex((rect) =>
			pixelRectsTouch(rect, current),
		);
		if (overlappingIndex === -1) {
			result.push(current);
			continue;
		}
		const [overlapping] = result.splice(overlappingIndex, 1);
		pending.push(unionPixelRects(overlapping, current));
	}
	return result;
}

function clipPixelRect(
	rect: BackdropPixelRect,
	width: number,
	height: number,
): BackdropPixelRect | null {
	const minX = Math.max(0, rect.x);
	const minY = Math.max(0, rect.y);
	const maxX = Math.min(width, rect.x + rect.width);
	const maxY = Math.min(height, rect.y + rect.height);
	if (minX >= maxX || minY >= maxY) return null;
	return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function pixelRectsTouch(a: BackdropPixelRect, b: BackdropPixelRect): boolean {
	return (
		a.x <= b.x + b.width &&
		a.x + a.width >= b.x &&
		a.y <= b.y + b.height &&
		a.y + a.height >= b.y
	);
}

function unionPixelRects(
	a: BackdropPixelRect,
	b: BackdropPixelRect,
): BackdropPixelRect {
	const minX = Math.min(a.x, b.x);
	const minY = Math.min(a.y, b.y);
	const maxX = Math.max(a.x + a.width, b.x + b.width);
	const maxY = Math.max(a.y + a.height, b.y + b.height);
	return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** The world-space rect the viewport shows (world Y up, origin center). */
function viewportWorldBounds(
	viewport: Pick<Viewport, "x" | "y" | "zoom">,
	canvasWidth: number,
	canvasHeight: number,
): BoundingBox {
	const halfW = canvasWidth / 2 / viewport.zoom;
	const halfH = canvasHeight / 2 / viewport.zoom;
	return {
		minX: viewport.x - halfW,
		minY: viewport.y - halfH,
		maxX: viewport.x + halfW,
		maxY: viewport.y + halfH,
		width: halfW * 2,
		height: halfH * 2,
	};
}

/** Whether a capture rect fully contains a request's clamped region rect. */
function containsRect(
	outer: { x: number; y: number; width: number; height: number },
	region: {
		copyOrigin: { x: number; y: number };
		copySize: { width: number; height: number };
	},
): boolean {
	return (
		region.copyOrigin.x >= outer.x &&
		region.copyOrigin.y >= outer.y &&
		region.copyOrigin.x + region.copySize.width <= outer.x + outer.width &&
		region.copyOrigin.y + region.copySize.height <= outer.y + outer.height
	);
}
