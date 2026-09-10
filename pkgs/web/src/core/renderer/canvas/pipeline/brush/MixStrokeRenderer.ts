import type {
	AnyArtObject,
	BoundingBox,
	Filter,
	Path,
	StrokeAppearance,
	Viewport,
} from "../../../../schema";
import {
	calculateElementBounds,
	expandBounds,
} from "../../../../utils/geometry/bounds";
import { hashSegmentsWithMetadata } from "../../../../utils/geometry/segmentOps";
import type { GPUTimingProfiler } from "../../../GPUTimingProfiler";
import type { BlitLayer } from "../../CanvasLayerTypes";
import type {
	BackdropEffectCoordinator,
	BackdropEffectRequest,
} from "../BackdropEffectCoordinator";
import type { BackdropEffectDriver } from "../FilterRenderer";
import { createFrameTextureRef, createRenderSurface } from "../RenderSurface";
import type { TexturePool } from "../TexturePool";
import type { UniformScope } from "../UniformScope";
import {
	type BrushRenderer,
	findStrokeAppearance,
	type ResolvedStrokeAppearance,
} from "./BrushRenderer";
import { evaluateDabs } from "./DabEvaluator";
import { DAB_INSTANCE_FLOATS } from "./DabInstanceLayout";
import { MIX_CHUNK_SIZE, MixPass } from "./MixPass";

/** Same cap as the wash accumulators: keeps one stroke's buffer bounded. */
const MAX_MIX_STROKE_TEXTURE_SIDE = 4096;
/** Cross-frame result budget. One capped stroke buffer is 64 MB, so this
 *  holds a handful of them; the LRU drops the rest. */
const MAX_RESULT_CACHE_BYTES = 384 * 1024 * 1024;

/**
 * Carried-over state of a stroke still being drawn. Chunks run in dab order
 * because the smudge bucket threads through them, so a growing stroke would
 * otherwise replay every chunk it already has on every frame — the per-frame
 * cost climbing with the stroke's own length.
 */
interface LiveMixSession {
	elementId: string;
	/** Settings, backdrop and raster conditions the frozen state was built at. */
	key: string;
	texW: number;
	texH: number;
	/** Stroke buffer as of the last frozen chunk boundary. */
	texture: GPUTexture;
	/** Smudge bucket at that same boundary. */
	bucket: GPUBuffer;
	frozenDabs: number;
}

interface MixResultCacheEntry {
	key: string;
	/** The key without the visible rect: what a pan does not invalidate. */
	stableKey: string;
	texture: GPUTexture;
	bounds: BoundingBox;
	opacity: number;
	bytes: number;
	/** Portion of the texture the stroke actually drew into. A stroke wider
	 *  than the texture cap renders at a reduced zoom and leaves the rest of
	 *  the texture blank; blitting the whole thing stretches that blank space
	 *  across the bounds and squashes the stroke. */
	uvRect: { minU: number; minV: number; maxU: number; maxV: number };
}

export interface MixStrokeRendererDeps {
	device: GPUDevice;
	canvasFormat: GPUTextureFormat;
	texturePool: TexturePool;
	coordinator: BackdropEffectCoordinator;
	uniformScope: UniformScope;
	/** The canvas's brush renderer; this driver uses its dab route and its
	 *  wet layer driver. */
	brush: BrushRenderer;
	getTransformIndex: (elementId: string) => number;
	getTransformsBindGroup: () => GPUBindGroup | undefined;
	getMaskBindGroup: () => GPUBindGroup;
	getTransformsBuffer: () => GPUBuffer | null;
	/** Identity of the composite below the stroke, or null when
	 *  it cannot be determined — the result is then not cached. */
	getBackdropContentKey: (
		elementId: string,
		bounds: BoundingBox,
	) => string | null;
	getRasterScale: () => number;
}

/**
 * Backdrop-effect driver for color-mixing strokes. A mixing
 * stroke reads the live composite below itself, so — like glass — it draws
 * inline at its z-order: the caller ends its main pass, composeInline
 * captures the backdrop at the fixed-R grid and alternates the mix pass's
 * color-resolving compute with ranged dab draws chunk by chunk (each chunk
 * samples the stroke buffer the previous chunks painted), and the resolved
 * stroke comes back as a BlitLayer for the restarted pass.
 */
export class MixStrokeRenderer implements BackdropEffectDriver {
	private readonly deps: MixStrokeRendererDeps;
	private mixPass: MixPass | null = null;
	private liveSession: LiveMixSession | null = null;
	/** Dropped session resources, freed a frame late: this frame's commands
	 *  still reference them and have not been submitted yet. */
	private retiredSessions: Array<{
		texture: GPUTexture;
		bucket: GPUBuffer;
	}> = [];
	private frameRetiredSessions: Array<{
		texture: GPUTexture;
		bucket: GPUBuffer;
	}> = [];
	/** Viewport the previous frame composited at, and this frame's, to tell a
	 *  pan from a still view. Frame-scoped: every stroke in one frame has to
	 *  reach the same verdict, or only the first of them keeps its result. */
	private lastViewport: Viewport | null = null;
	private frameViewport: Viewport | null = null;
	/** elementId -> last resolved stroke, reused while its key holds. */
	private readonly resultCache = new Map<string, MixResultCacheEntry>();
	private resultCacheBytes = 0;
	private frameBuffers: GPUBuffer[] = [];
	private retiredBuffers: GPUBuffer[] = [];
	private frameTextures: GPUTexture[] = [];
	/** Evicted cache textures, returned to the pool next releaseFrame. */
	private retiredTextures: GPUTexture[] = [];

	public constructor(deps: MixStrokeRendererDeps) {
		this.deps = deps;
	}

	public beginFrame(): void {
		this.lastViewport = this.frameViewport;
		this.frameViewport = null;
		// The frame that owned these buffers has been submitted by now (the
		// orchestrator submits after render returns, i.e. after releaseFrame),
		// so this is the first safe point to free them.
		for (const buffer of this.retiredBuffers) buffer.destroy();
		this.retiredBuffers = [];
	}

	public prepareFrame(): void {}

	public unionSolidBounds(): void {}

	/**
	 * Cache key of an element's last resolved mixing result, or null when it
	 * has none. Backdrop keys embed this so invalidation is transitive
	 * a stroke that mixed from a changed element gets a new key,
	 * which in turn changes the key of any stroke mixing from it — even when
	 * the original change does not overlap that later stroke at all.
	 */
	public resultKeyOf(elementId: string): string | null {
		return this.resultCache.get(elementId)?.key ?? null;
	}

	public hasInlineComposite(element: AnyArtObject): boolean {
		return resolveMixingStroke(element) != null;
	}

	public composeInline(
		element: AnyArtObject,
		encoder: GPUCommandEncoder,
		targetTexture: GPUTexture,
		viewport: Viewport | null,
		width: number,
		height: number,
		profiler?: GPUTimingProfiler | null,
	): BlitLayer | void {
		const stroke = resolveMixingStroke(element);
		if (!stroke || !viewport) return;
		const path = element as Path;
		const segments = path.segments ?? [];
		if (segments.length === 0) return;
		const { settings, filter } = stroke;
		const strokeColor = (filter as StrokeAppearance).paramData.params
			.strokeColor;
		if (!strokeColor) return;
		const mixing = settings.mixing!;
		const rasterScale = this.deps.getRasterScale();

		// Stroke world bounds padded by the brush reach.
		const sizeBase = settings.properties.size?.base ?? 10;
		// Snapped outward: a stroke being drawn grows a little every frame, and
		// an exact fit would move the texture — and throw away everything
		// carried over — on each of them.
		const bounds = expandBounds(calculateElementBounds(element), sizeBase);

		// The stroke still paints into the target on a cache hit, so report it
		// either way — other backdrop consumers key off this.
		this.deps.coordinator.noteDraw(bounds);

		const keys = this.resultCacheKeys(
			element,
			filter,
			bounds,
			rasterScale,
			viewport,
			width,
			height,
		);
		// While the view is moving, the stroke keeps the result it already has:
		// only the visible rect changed, and re-resolving every chunk on every
		// frame of a pan costs more than the whole stroke did to draw. The
		// frame the view settles on has the exact key again and re-resolves.
		this.frameViewport ??= { ...viewport };
		const panning =
			this.lastViewport != null &&
			(this.lastViewport.x !== viewport.x ||
				this.lastViewport.y !== viewport.y ||
				this.lastViewport.zoom !== viewport.zoom ||
				this.lastViewport.rotation !== viewport.rotation);
		if (keys != null) {
			const hit = this.resultCache.get(element.id);
			if (
				hit != null &&
				(hit.key === keys.key || (panning && hit.stableKey === keys.stableKey))
			) {
				// Refresh LRU order.
				this.resultCache.delete(element.id);
				this.resultCache.set(element.id, hit);
				return this.cachedLayer(hit);
			}
		}
		const cacheKey = keys?.key ?? null;

		// Backdrop below this stroke, on the fixed-R raster grid.
		const request: BackdropEffectRequest = {
			bounds,
			blurSigma: 0,
			rasterScale,
		};
		const below = this.deps.coordinator.acquireFixedRRegion(
			encoder,
			targetTexture,
			viewport,
			width,
			height,
			request,
			profiler,
		);
		if (!below) return;

		const transforms = this.deps.getTransformsBuffer();
		if (!transforms) return;
		const dabs = evaluateDabs(segments, settings, {
			pathStart: path.pathStart ?? 0,
			pathEnd: path.pathEnd ?? 1,
			strokeWidths: path.strokeWidths,
			strokeWidthsBaked: path.strokeWidthsBaked,
		});
		if (dabs.count === 0) return;

		const dabBuffer = this.uploadFrameBuffer(
			dabs.data.subarray(0, dabs.count * DAB_INSTANCE_FLOATS),
			"Mix Dab Instances",
		);
		const mixParamsBuffer = this.uploadFrameBuffer(
			dabs.mixParams.subarray(0, dabs.count * 4),
			"Mix Dab Params",
		);
		const mixedColors = this.deps.device.createBuffer({
			label: "Mix Resolved Colors",
			size: dabs.count * 16,
			usage: GPUBufferUsage.STORAGE,
		});
		this.frameBuffers.push(mixedColors);
		this.mixPass ??= new MixPass(this.deps.device);
		const bucket = this.mixPass.createBucket();
		this.frameBuffers.push(bucket);

		// Stroke buffer texture on the same DPI grid, capped like wash.
		const maxDim = Math.min(
			this.deps.device.limits.maxTextureDimension2D,
			MAX_MIX_STROKE_TEXTURE_SIDE,
		);
		const texW = Math.max(
			1,
			Math.min(Math.ceil(bounds.width * rasterScale), maxDim),
		);
		const texH = Math.max(
			1,
			Math.min(Math.ceil(bounds.height * rasterScale), maxDim),
		);
		const effectiveZoom = Math.min(texW / bounds.width, texH / bounds.height);
		const strokeTex = this.deps.texturePool.acquireExact(
			texW,
			texH,
			this.deps.canvasFormat,
			1,
			GPUTextureUsage.RENDER_ATTACHMENT |
				GPUTextureUsage.TEXTURE_BINDING |
				GPUTextureUsage.COPY_SRC |
				GPUTextureUsage.COPY_DST,
			"Mix Stroke Buffer",
		);
		this.frameTextures.push(strokeTex);
		const strokeView = strokeTex.createView();

		// Dab draws target the stroke texture's own world viewport.
		const uniformEntry = this.deps.uniformScope.acquire(
			{
				x: (bounds.minX + bounds.maxX) / 2,
				y: (bounds.minY + bounds.maxY) / 2,
				zoom: effectiveZoom,
				rotation: 0,
			},
			texW,
			texH,
		);
		const strokeInput = {
			path,
			segments,
			strokeColor,
			settings,
			alphaMultiplier: 1,
			transformIndex: this.deps.getTransformIndex(element.id),
		};
		const transformsBindGroup = this.deps.getTransformsBindGroup();
		const maskBindGroup = this.deps.getMaskBindGroup();
		const drawState = this.deps.brush.dabs.prepareMixed(
			strokeInput,
			{ dabBuffer, colors: mixedColors },
			{
				uniformBuffer: uniformEntry.buffer,
				transformsBindGroup,
				maskBindGroup,
			},
		);
		if (!drawState) return;

		const falloffLut = this.deps.brush.dabs.getFalloffLutTexture();

		// The last two chunks stay live: a stroke's tail is refitted as it is
		// drawn, so only what lies behind it can be trusted to stay put.
		const freezeAt = Math.max(
			0,
			Math.floor(dabs.count / MIX_CHUNK_SIZE) * MIX_CHUNK_SIZE - MIX_CHUNK_SIZE,
		);
		const sessionKey = `${keys?.stableKey ?? ""}:${texW}x${texH}`;
		const session =
			this.liveSession?.elementId === element.id &&
			this.liveSession.key === sessionKey &&
			this.liveSession.frozenDabs <= dabs.count
				? this.liveSession
				: null;
		if (!session) this.disposeLiveSession();
		const startDab = session?.frozenDabs ?? 0;
		if (session) {
			encoder.copyTextureToTexture(
				{ texture: session.texture },
				{ texture: strokeTex },
				{ width: texW, height: texH, depthOrArrayLayers: 1 },
			);
			encoder.copyBufferToBuffer(session.bucket, 0, bucket, 0, 16);
		}

		for (
			let firstDab = startDab;
			firstDab < dabs.count;
			firstDab += MIX_CHUNK_SIZE
		) {
			const chunkLen = Math.min(MIX_CHUNK_SIZE, dabs.count - firstDab);
			this.mixPass.resolveChunk(encoder, {
				dabBuffer,
				firstDab,
				dabCount: chunkLen,
				mixParams: mixParamsBuffer,
				mixParamsOffsetBytes: firstDab * 16,
				below: below.texture,
				belowBounds: below.actualBounds,
				stroke: firstDab === 0 ? null : strokeTex,
				strokeBounds: bounds,
				pathMetas: drawState.pathMetaBuffer,
				colorStops: drawState.colorStopsBuffer,
				transforms,
				sampleRadiusRatio: mixing.sampleRadius,
				sampleTrail: mixing.sampleTrail,
				blendStyle: mixing.blendStyle,
				falloffLut,
				bucket,
				outColors: mixedColors,
				outColorsOffsetBytes: firstDab * 16,
			});
			const pass = encoder.beginRenderPass({
				label: "Mix Stroke Chunk Pass",
				colorAttachments: [
					{
						view: strokeView,
						clearValue: { r: 0, g: 0, b: 0, a: 0 },
						loadOp: firstDab === 0 && !session ? "clear" : "load",
						storeOp: "store",
					},
				],
			});
			this.deps.brush.dabs.drawMixedChunk(pass, drawState, firstDab, chunkLen);
			pass.end();

			if (firstDab + chunkLen === freezeAt && freezeAt > startDab) {
				this.freezeLiveSession(encoder, {
					elementId: element.id,
					key: sessionKey,
					texW,
					texH,
					source: strokeTex,
					bucket,
					frozenDabs: freezeAt,
				});
			}
		}

		// The mixed dabs are the trail the bucket samples, not the picture: a
		// wet stroke's picture is the wash the simulation paints from them.
		// Compositing that wash back onto the same texture would lay the same
		// pigment down twice — the stroke came out at double density and buried
		// whatever it was dragged over.
		const washTex = settings.wet?.enabled
			? this.deps.texturePool.acquireExact(
					texW,
					texH,
					this.deps.canvasFormat,
					1,
					GPUTextureUsage.RENDER_ATTACHMENT |
						GPUTextureUsage.TEXTURE_BINDING |
						GPUTextureUsage.COPY_SRC |
						GPUTextureUsage.COPY_DST,
					"Mix Wash Buffer",
				)
			: null;
		if (washTex) {
			this.frameTextures.push(washTex);
			// The wash composite loads its target, so it has to start empty.
			encoder
				.beginRenderPass({
					label: "Mix Wash Clear",
					colorAttachments: [
						{
							view: washTex.createView(),
							clearValue: { r: 0, g: 0, b: 0, a: 0 },
							loadOp: "clear",
							storeOp: "store",
						},
					],
				})
				.end();
		}
		const resultTex = washTex ?? strokeTex;

		if (washTex) {
			// A mixing stroke is taken by this inline route before the
			// per-appearance isolation the wet layer normally runs in, so the
			// wet layer runs here for the two features to combine.
			this.deps.brush.wet.renderMixed(
				encoder,
				strokeInput,
				{ dabBuffer, colors: mixedColors, dabCount: dabs.count },
				{ view: washTex.createView(), width: texW, height: texH },
				bounds,
				// The dabs drew at the zoom the texture could hold, not the
				// document's: a capped texture holds fewer pixels per world unit,
				// and compositing at the document's scale lands the simulation
				// somewhere else entirely.
				effectiveZoom,
				{ transformsBindGroup, maskBindGroup },
			);
		}

		// The draw viewport is centred on the bounds, so the used region sits in
		// the middle of the texture.
		const usedHalfU = (bounds.width * effectiveZoom) / (2 * texW);
		const usedHalfV = (bounds.height * effectiveZoom) / (2 * texH);
		const entry: MixResultCacheEntry = {
			key: cacheKey ?? "",
			stableKey: keys?.stableKey ?? "",
			texture: resultTex,
			bounds,
			uvRect:
				usedHalfU >= 0.5 && usedHalfV >= 0.5
					? { minU: 0, minV: 0, maxU: 1, maxV: 1 }
					: {
							minU: 0.5 - usedHalfU,
							minV: 0.5 - usedHalfV,
							maxU: 0.5 + usedHalfU,
							maxV: 0.5 + usedHalfV,
						},
			// Wash semantics: strokeOpacity applies exactly once, here.
			opacity:
				filter.opacity *
				(settings.paintMode === "wash" ? settings.strokeOpacity : 1),
			bytes: texW * texH * 4,
		};
		if (cacheKey != null) {
			// The cache owns the texture from here; drop the frame's claim so
			// releaseFrame does not hand it back to the pool.
			this.frameTextures = this.frameTextures.filter((t) => t !== resultTex);
			this.storeResult(element.id, entry);
		}
		return this.cachedLayer(entry);
	}

	/**
	 * Keep the stroke buffer and bucket as they stand at a chunk boundary, so
	 * the next frame resumes from there instead of replaying the whole stroke.
	 */
	private freezeLiveSession(
		encoder: GPUCommandEncoder,
		args: {
			elementId: string;
			key: string;
			texW: number;
			texH: number;
			source: GPUTexture;
			bucket: GPUBuffer;
			frozenDabs: number;
		},
	): void {
		const current = this.liveSession;
		const reusable = current?.texW === args.texW && current?.texH === args.texH;
		if (current && !reusable) this.disposeLiveSession();

		const texture =
			(reusable ? current?.texture : null) ??
			this.deps.device.createTexture({
				label: "Mix Live Frozen Buffer",
				size: [args.texW, args.texH],
				format: this.deps.canvasFormat,
				usage: GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
			});
		const bucket =
			(reusable ? current?.bucket : null) ??
			this.deps.device.createBuffer({
				label: "Mix Live Frozen Bucket",
				size: 16,
				usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
			});
		encoder.copyTextureToTexture(
			{ texture: args.source },
			{ texture },
			{ width: args.texW, height: args.texH, depthOrArrayLayers: 1 },
		);
		encoder.copyBufferToBuffer(args.bucket, 0, bucket, 0, 16);
		this.liveSession = {
			elementId: args.elementId,
			key: args.key,
			texW: args.texW,
			texH: args.texH,
			texture,
			bucket,
			frozenDabs: args.frozenDabs,
		};
	}

	private disposeLiveSession(): void {
		if (this.liveSession) {
			this.frameRetiredSessions.push({
				texture: this.liveSession.texture,
				bucket: this.liveSession.bucket,
			});
		}
		this.liveSession = null;
	}

	/** BlitLayer over a resolved stroke texture the caller does not own. */
	private cachedLayer(entry: MixResultCacheEntry): BlitLayer {
		const surface = createRenderSurface(
			createFrameTextureRef(entry.texture, () => {}),
			{
				kind: "world-aabb",
				bounds: entry.bounds,
				uvRect: entry.uvRect,
			},
			{
				role: "color",
				alphaMode: "premultiplied",
				opacityState: "intrinsic",
			},
		);
		return { ...surface, opacity: entry.opacity };
	}

	/**
	 * Everything the resolved stroke depends on: its own geometry and
	 * settings, the rasterization grid, the composite below it, and
	 * the visible world rect — the backdrop capture is clamped to the canvas,
	 * so a stroke running off screen resolves differently once panned into
	 * view. Null when the backdrop identity is unknown.
	 */
	private resultCacheKeys(
		element: AnyArtObject,
		filter: Filter,
		bounds: BoundingBox,
		rasterScale: number,
		viewport: Viewport,
		width: number,
		height: number,
	): { key: string; stableKey: string } | null {
		const backdropKey = this.deps.getBackdropContentKey(element.id, bounds);
		if (backdropKey == null) return null;
		const path = element as Path;
		const halfW = width / 2 / viewport.zoom;
		const halfH = height / 2 / viewport.zoom;
		const snap = (value: number, round: (v: number) => number) =>
			round(value * rasterScale) / rasterScale;
		const visible = [
			snap(Math.max(bounds.minX, viewport.x - halfW), Math.floor),
			snap(Math.max(bounds.minY, viewport.y - halfH), Math.floor),
			snap(Math.min(bounds.maxX, viewport.x + halfW), Math.ceil),
			snap(Math.min(bounds.maxY, viewport.y + halfH), Math.ceil),
		].join(",");
		const stableKey = [
			hashSegmentsWithMetadata(path.segments).toString(36),
			JSON.stringify(filter),
			element.opacity,
			JSON.stringify(element.transform),
			path.pathStart ?? 0,
			path.pathEnd ?? 1,
			rasterScale,
			backdropKey,
		].join(":");
		return { key: `${stableKey}:${visible}`, stableKey };
	}

	private storeResult(elementId: string, entry: MixResultCacheEntry): void {
		const previous = this.resultCache.get(elementId);
		if (previous) {
			this.resultCacheBytes -= previous.bytes;
			this.retiredTextures.push(previous.texture);
			this.resultCache.delete(elementId);
		}
		this.resultCache.set(elementId, entry);
		this.resultCacheBytes += entry.bytes;
		for (const [id, cached] of this.resultCache) {
			if (this.resultCacheBytes <= MAX_RESULT_CACHE_BYTES) break;
			if (id === elementId) continue;
			this.resultCacheBytes -= cached.bytes;
			this.retiredTextures.push(cached.texture);
			this.resultCache.delete(id);
		}
	}

	public flushRemaining(): void {}

	public releaseFrame(release: (texture: GPUTexture) => void): void {
		for (const dropped of this.retiredSessions) {
			dropped.texture.destroy();
			dropped.bucket.destroy();
		}
		this.retiredSessions = this.frameRetiredSessions;
		this.frameRetiredSessions = [];
		for (const texture of [...this.frameTextures, ...this.retiredTextures]) {
			release(texture);
		}
		this.frameTextures = [];
		this.retiredTextures = [];
		// Destroying here would hit the still-unsubmitted encoder; hand them
		// to the next frame instead.
		this.retiredBuffers.push(...this.frameBuffers);
		this.frameBuffers = [];
		this.mixPass?.retireChunkResources();
	}

	public destroy(): void {
		this.disposeLiveSession();
		for (const dropped of [
			...this.retiredSessions,
			...this.frameRetiredSessions,
		]) {
			dropped.texture.destroy();
			dropped.bucket.destroy();
		}
		this.retiredSessions = [];
		this.frameRetiredSessions = [];
		for (const buffer of [...this.retiredBuffers, ...this.frameBuffers]) {
			buffer.destroy();
		}
		this.retiredBuffers = [];
		this.frameBuffers = [];
		this.frameTextures = [];
		this.retiredTextures = [];
		this.resultCache.clear();
		this.resultCacheBytes = 0;
		this.mixPass?.destroy();
		this.mixPass = null;
	}

	private uploadFrameBuffer(data: Float32Array, label: string): GPUBuffer {
		const buffer = this.deps.device.createBuffer({
			label,
			size: Math.max(data.byteLength, 16),
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
		});
		this.deps.device.queue.writeBuffer(
			buffer,
			0,
			data.buffer as ArrayBuffer,
			data.byteOffset,
			data.byteLength,
		);
		this.frameBuffers.push(buffer);
		return buffer;
	}
}

/**
 * The element's mixing stroke appearance, or null when it has none.
 *
 * Only the dab engine mixes; ribbon and geometric strokes have no dabs to
 * sample under. Enablement is the explicit boolean alone.
 */
export function resolveMixingStroke(
	element: AnyArtObject,
): ResolvedStrokeAppearance | null {
	return findStrokeAppearance(element, (r) => r.mixingEnabled);
}
