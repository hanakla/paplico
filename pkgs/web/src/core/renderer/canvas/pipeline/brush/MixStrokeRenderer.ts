import { BRUSH_PROPERTY_REGISTRY } from "../../../../brush/properties";
import { resolveBrushRenderRoute } from "../../../../brush/renderRoute";
import type {
	AnyArtObject,
	BoundingBox,
	BrushPropertyId,
	BrushSettingsV2,
	Filter,
	Path,
	StrokeAppearance,
	Viewport,
} from "../../../../schema";
import { isFilterEnabled } from "../../../../schema";
import {
	calculateElementBounds,
	expandBounds,
} from "../../../../utils/geometry/bounds";
import { hashSegmentsWithMetadata } from "../../../../utils/geometry/segmentOps";
import type { GPUTimingProfiler } from "../../../GPUTimingProfiler";
import { WET_SEED_TARGETS } from "../../../shaders/brushDab.wgsl";
import type { BlitLayer } from "../../CanvasLayerTypes";
import type {
	BackdropEffectCoordinator,
	BackdropEffectRequest,
} from "../BackdropEffectCoordinator";
import type { BackdropEffectDriver } from "../FilterRenderer";
import { createFrameTextureRef, createRenderSurface } from "../RenderSurface";
import { resolveSimulationDomain } from "../rasterizationDomain";
import type { StrokeBatchContext } from "../stroke/StrokeBatchContext";
import { WetLayerPass } from "../stroke/WetLayerPass";
import type { TexturePool } from "../TexturePool";
import type { UniformScope } from "../UniformScope";
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
	getBatchContext: () => StrokeBatchContext | null;
	getTransformIndex: (elementId: string) => number;
	getTransformsBindGroup: () => GPUBindGroup | undefined;
	getTransformsBuffer: () => GPUBuffer | null;
	/** Identity of the composite below the stroke (design §10-2), or null when
	 *  it cannot be determined — the result is then not cached. */
	getBackdropContentKey: (
		elementId: string,
		bounds: BoundingBox,
	) => string | null;
	getRasterScale: () => number;
}

/**
 * Backdrop-effect driver for color-mixing strokes (design §10). A mixing
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
	private wetLayerPass: WetLayerPass | null = null;
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
	/** Viewport the last frame composited at, to tell a pan from a still view. */
	private lastViewport: Viewport | null = null;
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
	 * (appendix A): a stroke that mixed from a changed element gets a new key,
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
		const batchContext = this.deps.getBatchContext();
		if (!batchContext) return;
		const { settings, filter } = stroke;
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
		const panning =
			this.lastViewport != null &&
			(this.lastViewport.x !== viewport.x ||
				this.lastViewport.y !== viewport.y ||
				this.lastViewport.zoom !== viewport.zoom ||
				this.lastViewport.rotation !== viewport.rotation);
		this.lastViewport = { ...viewport };
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

		// Backdrop below this stroke, on the fixed-R raster grid (§B-2).
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
		const depthTex = this.deps.texturePool.acquireExact(
			texW,
			texH,
			"depth24plus-stencil8",
			1,
			GPUTextureUsage.RENDER_ATTACHMENT,
			"Mix Stroke Stencil",
		);
		this.frameTextures.push(strokeTex, depthTex);
		const strokeView = strokeTex.createView();
		const depthView = depthTex.createView();

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
		batchContext.setActiveUniformBuffer(uniformEntry.buffer);
		const drawState = batchContext.prepareMixedDabStroke({
			path,
			settings,
			dabBuffer,
			mixedColors,
			alphaMultiplier: 1,
			transformIndex: this.deps.getTransformIndex(element.id),
		});
		batchContext.setActiveUniformBuffer(null);
		if (!drawState) return;

		const falloffLut = batchContext.getFalloffLutTexture();
		const transformsBindGroup = this.deps.getTransformsBindGroup();

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
				depthStencilAttachment: {
					view: depthView,
					depthClearValue: 1,
					depthLoadOp: "clear",
					depthStoreOp: "discard",
					stencilClearValue: 0,
					stencilLoadOp: "clear",
					stencilStoreOp: "discard",
				},
			});
			batchContext.drawMixedDabChunk(
				pass,
				drawState,
				firstDab,
				chunkLen,
				transformsBindGroup ?? undefined,
			);
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

		if (settings.wet?.enabled) {
			this.runWetLayer(encoder, {
				element,
				path,
				settings,
				bounds,
				// The dabs drew at the zoom the texture could hold, not the
				// document's: a capped texture holds fewer pixels per world unit,
				// and compositing at the document's scale lands the simulation
				// somewhere else entirely.
				scale: effectiveZoom,
				target: strokeView,
				targetSize: { width: texW, height: texH },
				dabBuffer,
				mixedColors,
				dabCount: dabs.count,
				batchContext,
				transformsBindGroup,
			});
		}

		// The draw viewport is centred on the bounds, so the used region sits in
		// the middle of the texture.
		const usedHalfU = (bounds.width * effectiveZoom) / (2 * texW);
		const usedHalfV = (bounds.height * effectiveZoom) / (2 * texH);
		const entry: MixResultCacheEntry = {
			key: cacheKey ?? "",
			stableKey: keys?.stableKey ?? "",
			texture: strokeTex,
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
			this.frameTextures = this.frameTextures.filter((t) => t !== strokeTex);
			this.storeResult(element.id, entry);
		}
		return this.cachedLayer(entry);
	}

	/**
	 * Spread the stroke's picked-up pigment through the wet simulation, on top
	 * of what the mixed dabs already painted. A mixing stroke is taken by this
	 * inline route before the per-appearance isolation the wet layer normally
	 * runs in, so without this the two features can never combine.
	 */
	private runWetLayer(
		encoder: GPUCommandEncoder,
		args: {
			element: AnyArtObject;
			path: Path;
			settings: BrushSettingsV2;
			bounds: BoundingBox;
			scale: number;
			target: GPUTextureView;
			targetSize: { width: number; height: number };
			dabBuffer: GPUBuffer;
			mixedColors: GPUBuffer;
			dabCount: number;
			batchContext: StrokeBatchContext;
			transformsBindGroup: GPUBindGroup | undefined;
		},
	): void {
		const wet = args.settings.wet;
		if (!wet) return;
		const segments = args.path.segments ?? [];
		const brushSize = Math.max(args.settings.properties.size?.base ?? 10, 1);
		const domain = resolveSimulationDomain(
			expandBounds(args.bounds, brushSize * wet.bleedRadius),
			brushSize,
			this.deps.device.limits.maxTextureDimension2D,
		);
		const base = (id: BrushPropertyId): number =>
			args.settings.properties[id]?.base ?? BRUSH_PROPERTY_REGISTRY[id].base;
		// Texels no dab covers keep the stroke's own coefficients.
		const clearValues = [
			{ r: 0, g: 0, b: 0, a: 0 },
			{ r: 0, g: 0, b: 0, a: 0 },
			{ r: 0, g: 0, b: 0, a: 0 },
			{ r: base("absorption"), g: base("granulation"), b: 0, a: 0 },
			{ r: base("bleedSoftness"), g: base("edgeDarkening"), b: 0, a: 0 },
			{ r: base("edgeRoughness"), g: 0, b: 0, a: 0 },
		];

		this.wetLayerPass ??= new WetLayerPass(
			this.deps.device,
			this.deps.canvasFormat,
		);
		for (const tile of domain.tiles) {
			const tileW = tile.textureSize.width;
			const tileH = tile.textureSize.height;
			if (tileW <= 0 || tileH <= 0) continue;

			const seeds = WET_SEED_TARGETS.map((seedTarget, index) =>
				this.deps.texturePool.acquireExact(
					tileW,
					tileH,
					seedTarget.format,
					1,
					GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
					`Mix Wet Seed ${index}`,
				),
			);
			this.frameTextures.push(...seeds);

			const seedPass = encoder.beginRenderPass({
				label: "Mix Wet Seed Pass",
				colorAttachments: seeds.map((texture, index) => ({
					view: texture.createView(),
					clearValue: clearValues[index],
					loadOp: "clear" as const,
					storeOp: "store" as const,
				})),
			});
			// Dabs draw in the domain's own space: one texel per domain pixel.
			const entry = this.deps.uniformScope.acquire(
				{
					x: tile.worldOrigin.x + (tileW * domain.worldPerPixel) / 2,
					y: tile.worldOrigin.y - (tileH * domain.worldPerPixel) / 2,
					zoom: 1 / domain.worldPerPixel,
					rotation: 0,
				},
				tileW,
				tileH,
			);
			args.batchContext.setActiveUniformBuffer(entry.buffer);
			args.batchContext.renderWetSeedDabs({
				passEncoder: seedPass,
				path: args.path,
				settings: args.settings,
				segments,
				alphaMultiplier: 1,
				transformsBindGroup: args.transformsBindGroup ?? undefined,
				transformIndex: this.deps.getTransformIndex(args.element.id),
				mixed: {
					dabBuffer: args.dabBuffer,
					colors: args.mixedColors,
					dabCount: args.dabCount,
				},
			});
			args.batchContext.setActiveUniformBuffer(null);
			seedPass.end();

			this.wetLayerPass.apply(encoder, {
				seeds: {
					pigment: seeds[0],
					fluidVelocity: seeds[1],
					moisture: seeds[2],
					absorptionGranulation: seeds[3],
					softnessEdgeDarkening: seeds[4],
					edgeRoughness: seeds[5],
				},
				domain: { width: tileW, height: tileH },
				domainWorldOrigin: tile.worldOrigin,
				domainWorldPerPixel: domain.worldPerPixel,
				target: args.target,
				targetResolution: args.targetSize,
				// The draw viewport is centred on the bounds, so the texture's
				// top-left corner is half a texture away from that centre —
				// which is not the bounds' corner once the texture is capped.
				targetWorldOrigin: {
					x:
						(args.bounds.minX + args.bounds.maxX) / 2 -
						args.targetSize.width / (2 * args.scale),
					y:
						(args.bounds.minY + args.bounds.maxY) / 2 +
						args.targetSize.height / (2 * args.scale),
				},
				targetWorldPerPixel: 1 / args.scale,
				brushRadiusPx: Math.max(brushSize * 0.5, 1) / domain.worldPerPixel,
				bleedRadius: wet.bleedRadius,
				pigmentLoad: wet.pigmentLoad,
				grainScale: wet.grainScale,
				randomSeed: args.settings.randomSeed,
				paperGrain: base("grainAmount"),
				scatter:
					(wet.scatter ?? 0) *
					(Math.max(brushSize * 0.5, 1) / domain.worldPerPixel),
			});
		}
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
	 * settings, the rasterization grid, the composite below it (§10-2), and
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
		this.wetLayerPass?.releaseFrame();
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
		this.wetLayerPass?.destroy();
		this.wetLayerPass = null;
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
 * Only the dab-v2 route mixes: a stroke still carrying wetV1 belongs to the
 * legacy wet ink path until the wet switchover (design §13-7), so the mix
 * pass must not start for it even with mixing enabled. Enablement is the
 * explicit boolean alone (§H-3).
 */
export function resolveMixingStroke(
	element: AnyArtObject,
): { settings: BrushSettingsV2; filter: Filter } | null {
	if (element.type !== "path") return null;
	for (const filter of element.filters ?? []) {
		if (!isFilterEnabled(filter) || filter.processor !== "stroke") continue;
		const raw = (filter as StrokeAppearance).paramData.params.brushSettings;
		if (raw == null) continue;
		const route = resolveBrushRenderRoute(raw);
		if (route.kind !== "dab-v2" || route.settings.mixing?.enabled !== true) {
			continue;
		}
		return { settings: route.settings, filter };
	}
	return null;
}
