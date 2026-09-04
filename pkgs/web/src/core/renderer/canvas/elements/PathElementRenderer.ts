import { resolveBrushTextureUid } from "../../../brush/brushSource";
import { createStrokeBrushSettings } from "../../../document/factory";
import {
	type AnyArtObject,
	type BlendObject,
	type CompoundPath,
	colorToRawRGBA,
	type EmbeddedFile,
	type FillAppearance,
	type FillColor,
	type Filter,
	isPath,
	type LineCap,
	type LineJoin,
	type Path,
	type StrokeAppearance,
	type StrokeColor,
	type StrokeGradient,
	type StrokePattern,
	type StrokeWidthPoint,
	type TexturedFill,
} from "../../../schema";
import {
	resolveBlendSourcePath,
	resolveBlendSpinePath,
} from "../../../utils/geometry/blendInterpolation";
import { hashSegments, toWorldPath } from "../../../utils/geometry/segmentOps";
import {
	flattenBezierPath,
	flattenBezierPathWithPressure,
} from "../../geometry/bezierFlatten";
import {
	applyDashPattern,
	polylineArcLength,
	tessellateStroke,
} from "../../geometry/strokeTessellator";
import {
	buildStrokePaintKey,
	hashStrokeColor,
	hashStrokeGeometry,
	isStrokePaintSemiTransparent,
} from "../../helpers";
import {
	cleanupPolygonPoints,
	createCompoundPathRenderPath,
	splitIntoSubPaths,
} from "../CanvasLayer.helpers";
import type {
	AssetState,
	PipelineType,
	RenderState,
} from "../CanvasLayerTypes";
import type { BlendCache } from "../caches/BlendCache";
import type { CompoundPathCache } from "../caches/CompoundPathCache";
import type { GeometryCache } from "../caches/GeometryCache";
import type {
	StencilFillCache,
	StencilFillVariant,
} from "../caches/StencilFillCache";
import type { StrokeCache } from "../caches/StrokeCache";
import { resolveGeometricSizeByPressure } from "../pipeline/brush/strokeHalfWidth";
import type { FilterRenderer } from "../pipeline/FilterRenderer";
import type { GeometryStore } from "../pipeline/GeometryStore";
import { applyPreFilters } from "../pipeline/PreFilterRenderer";
import {
	createLocalFillBounds,
	type LocalFillBounds,
	type RunBatcher,
	type WorldFillBounds,
} from "../pipeline/RunBatcher";
import type { StrokeBatchContext } from "../pipeline/stroke/StrokeBatchContext";
import {
	type DrawableSegments,
	type ResolvedAppearancePass,
	resolveAppearancePasses,
} from "./appearancePasses";
import { ElementVertexBuffer } from "./ElementVertexBuffer";
import type { GradientRenderer } from "./GradientRenderer";

const EMPTY_F32 = new Float32Array(0);

// Stencil-fill AA fringe constants. renderStencilFill expands the fill
// bounds passed to the gradient renderer by FILL_BOUNDS_FRINGE_MARGIN;
// pattern anchoring subtracts it to recover the tight geometry corner.
const HALF_MITER_SCALE = 0.5;
const MITER_LIMIT = 4.0; // clamp miter scale to avoid spikes at very sharp corners
const FILL_BOUNDS_FRINGE_MARGIN = HALF_MITER_SCALE * MITER_LIMIT;

interface PathElementRendererDeps {
	device: GPUDevice;
	strokePipeline: GPURenderPipeline;
	stencilFanWritePipeline: GPURenderPipeline;
	stencilCoverPipeline: GPURenderPipeline;
	/** First-fragment-wins / stencil-restore pair for semi-transparent strokes. */
	strokeUnionPipeline: GPURenderPipeline;
	stencilZeroPipeline: GPURenderPipeline;
	/** Vertex-pulling variants used by the run batcher's merged draws. */
	pulledGeometryPipeline: GPURenderPipeline;
	pulledStencilFanWritePipeline: GPURenderPipeline;
	dummyGradientBindGroup: GPUBindGroup;
	getBindGroup: () => GPUBindGroup;
	getTransformsBindGroup: () => GPUBindGroup | null;
	getMaskBindGroup: () => GPUBindGroup;
	resolveWorldFillBounds: (
		elementId: string,
		bounds: LocalFillBounds,
	) => WorldFillBounds | null;
	// Mutable shared state (by reference)
	renderState: RenderState;
	assetState: AssetState;
	filterRenderer: FilterRenderer;
	strokeBatchContext: StrokeBatchContext;
	// Externally-owned caches (managed by RenderCacheManager). Accessed as
	// accessors so the active document scope resolves per access.
	geometryCache: GeometryCache;
	strokeCache: StrokeCache;
	stencilFillCache: StencilFillCache;
	getCompoundPathGeometryCache: () => CompoundPathCache;
	getBlendCache: () => BlendCache;
	/** Persistent shared vertex buffer the caches lease ranges from (one per
	 *  canvas target — plain value, not an accessor). */
	geometryStore: GeometryStore;
	/** Merges consecutive same-state solid draws into one drawIndexed. Plain
	 *  value, one per canvas target. */
	runBatcher: RunBatcher;
	/** Unified gradient/pattern fill+stroke renderer (shared instance). */
	gradientRenderer: GradientRenderer;
	/**
	 * Resolve a pattern def to its rasterized tile texture + world-space tile
	 * size + per-def revision counter. Returns null when the def is unknown,
	 * outside the def cache, or rasterization failed.
	 */
	resolvePatternTexture?: (defId: string) => {
		texture: GPUTexture;
		tileWorldSize: { width: number; height: number };
		revision: number;
	} | null;
	/**
	 * Ensure a brush texture is loaded. Owned by ElementRenderer (external
	 * callers also invoke it); returns true if ready, false if still loading.
	 */
	ensureBrushTexture: (
		textureFileUid: string,
		files: EmbeddedFile[],
	) => boolean;
}

export class PathElementRenderer {
	private readonly deps: PathElementRendererDeps;

	// Batched fill vertex data — accumulates all fan + cover vertex data
	// across the entire frame into a single CPU buffer, then uploads with
	// ONE writeBuffer call at flush time.  Draw calls reference the shared
	// GPU buffer at element-specific offsets.
	//
	// On the first frame the GPU buffer is null, so every element falls back
	// to per-element writeBuffer.  batchPeakBytes records the
	// high-water mark so beginFrame() can grow the GPU buffer before the
	// next frame — after which all elements use the batched path.
	private batchCpuBuf = new Float32Array(16384); // 64 KB initial
	private batchOffset = 0; // current write position (floats)
	private batchGPUBuf: GPUBuffer | null = null;
	private batchGPUBufSize = 0; // bytes
	private batchPeakBytes = 0;

	// Legacy per-element buffer pool — used as fallback when the shared
	// batch buffer is too small (first frame or rare growth).
	private fillBufferPool: Array<{ buffer: GPUBuffer; size: number }> = [];
	private fillDrawIndex = 0;

	public constructor(deps: PathElementRendererDeps) {
		this.deps = deps;
	}

	/** Reset per-frame pool indices. Call at the start of each render frame. */
	public beginFrame(): void {
		this.fillDrawIndex = 0;

		// Grow the shared batch GPU buffer to match peak usage from previous
		// frames.  This runs between frames so it is safe to destroy the old
		// buffer (the previous frame's command buffer has already been submitted).
		if (this.batchPeakBytes > this.batchGPUBufSize) {
			this.batchGPUBuf?.destroy();
			const size = Math.max(this.batchPeakBytes * 2, 65536);
			this.batchGPUBuf = this.deps.device.createBuffer({
				label: "Shared Fill Vertex Buffer (Batched)",
				size,
				usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
			});
			this.batchGPUBufSize = size;
			if (size / 4 > this.batchCpuBuf.length) {
				this.batchCpuBuf = new Float32Array(size / 4);
			}
		}
		this.batchOffset = 0;
		this.batchPeakBytes = 0;
	}

	/**
	 * Upload all accumulated fill vertex data to the GPU in a single
	 * writeBuffer call.  Must be called after the render pass ends but
	 * before queue.submit().
	 */
	public flushFillBatch(): void {
		if (this.batchOffset === 0 || !this.batchGPUBuf) return;

		this.deps.device.queue.writeBuffer(
			this.batchGPUBuf,
			0,
			this.batchCpuBuf.buffer,
			this.batchCpuBuf.byteOffset,
			this.batchOffset * 4,
		);
	}

	// ── Path rendering chain ──────────────────────────────────────────────

	public renderPath(
		passEncoder: GPURenderPassEncoder,
		path: Path,
		alphaMultiplier: number = 1.0,
		pipelineType: PipelineType = "main",
		cacheVariant: StencilFillVariant = "normal",
	): void {
		this.renderAppearancePasses(
			passEncoder,
			path,
			resolveAppearancePasses(path, this.deps.filterRenderer),
			alphaMultiplier,
			pipelineType,
			cacheVariant,
		);
	}

	/**
	 * Draw pre-resolved appearance passes in paint order. Callers that already
	 * resolved the path (to route on the appearance set, or to split the passes
	 * into runs) enter here so the resolution is never duplicated.
	 */
	public renderAppearancePasses(
		passEncoder: GPURenderPassEncoder,
		path: Path,
		passes: readonly ResolvedAppearancePass[],
		alphaMultiplier: number = 1.0,
		pipelineType: PipelineType = "main",
		cacheVariant: StencilFillVariant = "normal",
	): void {
		for (const { appearance, segments, cacheKey } of passes) {
			const appAlpha = alphaMultiplier * appearance.opacity;

			if (appearance.processor === "fill") {
				const fillColor = (appearance as FillAppearance).paramData.params.fill;
				if (fillColor) {
					this.renderPathFill(
						passEncoder,
						segments,
						fillColor,
						appAlpha,
						pipelineType,
						cacheKey,
						cacheVariant,
					);
				}
			} else {
				const strokeApp = appearance as StrokeAppearance;
				const strokeColor = strokeApp.paramData.params.strokeColor;
				if (!strokeColor) continue;

				const settings =
					strokeApp.paramData.params.brushSettings ??
					createStrokeBrushSettings(1);

				if (settings.engine === "geometric") {
					this.renderGeometricStroke(
						passEncoder,
						segments,
						strokeColor,
						settings.properties.size?.base ?? 1,
						// Baked paths carry the width in strokeWidths; the live
						// pressure term would apply it twice.
						path.strokeWidthsBaked
							? 0
							: resolveGeometricSizeByPressure(settings),
						appAlpha,
						settings.stroking?.lineCap ?? "round",
						settings.stroking?.lineJoin ?? "round",
						settings.stroking?.miterLimit ?? 4,
						pipelineType,
						path.id,
						`${cacheKey}:stroke`,
						settings.stroking?.dashArray,
						settings.stroking?.dashOffset,
						path.strokeWidths,
						settings.taperStart,
						settings.taperEnd,
						path.pathStart,
						path.pathEnd,
					);
				} else {
					const { strokeBatchContext } = this.deps;
					const textureUid = resolveBrushTextureUid(
						settings,
						strokeBatchContext.getTextureManager(),
					);
					if (textureUid) {
						if (
							!this.deps.ensureBrushTexture(
								textureUid,
								this.deps.assetState.currentFiles,
							)
						) {
							continue;
						}
					}

					// Stamp renderers encode an immediate draw. Pending solid runs
					// must be emitted first so appearance array order remains paint order.
					this.deps.runBatcher.flush();
					strokeBatchContext.render(
						passEncoder,
						{
							path,
							segments,
							strokeColor,
							settings,
							alphaMultiplier: appAlpha,
							transformIndex: this.deps.renderState.currentTransformIndex,
						},
						this.deps.getTransformsBindGroup()!,
					);
				}
			}
		}
	}

	/**
	 * Render fill for a closed path using stencil-then-cover.
	 * Supports compound paths with holes (e.g., font glyphs)
	 */
	public renderPathFill(
		passEncoder: GPURenderPassEncoder,
		segments: DrawableSegments,
		fill: FillColor,
		alphaMultiplier: number,
		pipelineType: PipelineType = "main",
		elementId?: string,
		cacheVariant: StencilFillVariant = "normal",
	): void {
		if (segments.length === 0) return;

		// World offset subtracted before flattening so triangle fan receives stable
		// local coordinates (avoids FP rounding drift in topology).
		const worldOffsetX = segments[0].start?.x ?? segments[0].end.x;
		const worldOffsetY = segments[0].start?.y ?? segments[0].end.y;

		// Fixed high-quality tolerance — zoom-independent so geometry cache
		// survives zoom changes (flattened subpath points are reused).
		const curveTolerance = 0.05;

		const geometryHash = hashSegments(segments);

		let flattenedSubPaths: number[][];
		let cachedOffsetX: number;
		let cachedOffsetY: number;

		const cached = elementId
			? this.deps.geometryCache.get(elementId)
			: undefined;
		if (
			cached &&
			cached.geometryHash === geometryHash &&
			cached.worldOffsetX === worldOffsetX &&
			cached.worldOffsetY === worldOffsetY
		) {
			flattenedSubPaths = cached.flattenedSubPaths;
			cachedOffsetX = cached.worldOffsetX;
			cachedOffsetY = cached.worldOffsetY;
		} else {
			// Split original segments into subpaths (no copy needed — splitIntoSubPaths only reads)
			const subPaths = splitIntoSubPaths(segments);
			if (subPaths.length === 0) return;

			// Flatten each subpath with worldOffset applied inside flattenBezierPath
			// (avoids the intermediate localSegments copy).
			const worldOffset = { x: worldOffsetX, y: worldOffsetY };
			flattenedSubPaths = [];
			for (const subPath of subPaths) {
				let points = flattenBezierPath(subPath, {
					curveTolerance,
					worldOffset,
				});
				points = cleanupPolygonPoints(points);
				if (points.length >= 6) {
					flattenedSubPaths.push(points);
				}
			}

			if (flattenedSubPaths.length === 0) return;

			cachedOffsetX = worldOffsetX;
			cachedOffsetY = worldOffsetY;

			if (elementId) {
				this.deps.geometryCache.set(elementId, {
					flattenedSubPaths,
					worldOffsetX,
					worldOffsetY,
					geometryHash,
				});
				// Geometry changed — stencilFillCache stores vertex data
				// derived from the previous flattenedSubPaths of this element,
				// so it must be invalidated (it only validates by zoom, not
				// geometry).
				this.deps.stencilFillCache.delete(elementId);
			}
		}

		if (flattenedSubPaths.length === 0) return;

		this.renderStencilFill(
			passEncoder,
			flattenedSubPaths,
			fill,
			alphaMultiplier,
			pipelineType,
			cachedOffsetX,
			cachedOffsetY,
			elementId,
			geometryHash,
			cacheVariant,
		);
	}

	public renderCompoundPath(
		passEncoder: GPURenderPassEncoder,
		compoundPath: CompoundPath,
		elementsMap: Map<string, AnyArtObject>,
		alphaMultiplier: number,
		pipelineType: PipelineType = "main",
		isMaskRender = false,
	): void {
		if (compoundPath.sources.length === 0) {
			return;
		}

		const pathMap = new Map<string, Path>();
		const validSources: CompoundPath["sources"] = [];
		let baseSourcePath: Path | undefined;
		for (const source of compoundPath.sources) {
			const el = elementsMap.get(source.id);
			if (!el || !isPath(el)) continue;
			baseSourcePath ??= el;
			pathMap.set(source.id, toWorldPath(el));
			validSources.push(source);
		}

		if (validSources.length === 0) return;

		const targetCompoundPath =
			validSources.length === compoundPath.sources.length
				? compoundPath
				: { ...compoundPath, sources: validSources };
		const segments = this.deps
			.getCompoundPathGeometryCache()
			.resolve(targetCompoundPath, pathMap);

		if (segments.length === 0) {
			return;
		}

		const tempPath = createCompoundPathRenderPath(
			compoundPath,
			segments,
			baseSourcePath,
			pipelineType,
			isMaskRender,
		);

		this.renderPath(
			passEncoder,
			tempPath,
			alphaMultiplier,
			pipelineType,
			isMaskRender ? "mask" : "normal",
		);
	}

	public renderBlend(
		passEncoder: GPURenderPassEncoder,
		blend: BlendObject,
		elementsMap: Map<string, AnyArtObject>,
		alphaMultiplier: number,
		pipelineType: PipelineType = "main",
	): void {
		if (blend.objectIds.length < 2) return;

		// Resolve each source to a plain Path: paths pass through, compound-paths
		// are flattened to their boolean outline (a multi-subpath Path) so holey
		// shapes blend correctly.
		const objects: Path[] = [];
		for (const id of blend.objectIds) {
			const el = elementsMap.get(id);
			if (!el) continue;
			const resolved = resolveBlendSourcePath(el, (cid) =>
				elementsMap.get(cid),
			);
			if (resolved) objects.push(resolved);
		}
		if (objects.length < 2) return;

		// Bake each key's path-deformation pre-filters (zigzag, path-offset, …) into
		// its shape so the blend interpolates the DEFORMED shapes — both the keys
		// drawn below and the intermediates derived from them.
		const deformedObjects = objects.map((o) => this.bakeBlendKeyDeformation(o));

		// Everything is drawn under the blend element's transform index, so the
		// source shapes must be baked to world space (their own transform folded
		// into segment coords) to match — exactly like renderCompoundPath.
		// intermediates[i] holds the paths between source i and i+1.
		//
		// Each world-baked source is drawn under a synthetic per-blend cache key
		// ("<blendId>::src<i>") instead of the original element id. The blend owns
		// a baked copy whose geometry (world space) differs from the element's own
		// rendering (local space). If they shared the source id and that source
		// were still referenced elsewhere (e.g. not fully absorbed), the two
		// renders would collide on one stencil-fill cache key with differing
		// geometry and destroy a GPU buffer mid-frame ("used in submit while
		// destroyed"). Mirrors CompoundPath's "<id>-render" key; "::" keeps the
		// live base id (blend id) intact for onDocumentChange pruning.
		const spineSource = resolveBlendSpinePath(blend, (id) =>
			elementsMap.get(id),
		);
		// Keys are baked onto the spine in their own transforms, so the world-baked
		// source already sits at its drawn position.
		const worldObjects = deformedObjects.map((o, i) => ({
			...toWorldPath(o),
			id: `${blend.id}::src${i}`,
		}));
		const intermediates = this.deps
			.getBlendCache()
			.resolve(blend, deformedObjects, spineSource);
		const blendAlpha = alphaMultiplier * blend.opacity;

		// Paint order is decoupled from the morph chain: worldObjects/intermediates
		// stay indexed by objectIds (positions/geometry), but each cell (a key plus
		// its trailing intermediates) is drawn front-to-back per blend.renderOrder.
		// renderOrder defaults to objectIds order; a defensive tail draws any key
		// missing from it so nothing is dropped if the two drift.
		const painted = new Set<number>();
		const paintCell = (i: number) => {
			if (painted.has(i)) return;
			painted.add(i);
			this.renderPath(passEncoder, worldObjects[i], blendAlpha, pipelineType);
			const pair = intermediates[i];
			if (pair) {
				for (const inter of pair) {
					this.renderPath(passEncoder, inter, blendAlpha, pipelineType);
				}
			}
		};
		const indexById = new Map(blend.objectIds.map((id, i) => [id, i]));
		for (const id of blend.renderOrder ?? blend.objectIds) {
			const i = indexById.get(id);
			if (i != null) paintCell(i);
		}
		for (let i = 0; i < worldObjects.length; i++) paintCell(i);
	}

	private renderGeometricStroke(
		passEncoder: GPURenderPassEncoder,
		segments: DrawableSegments,
		strokeColor: StrokeColor,
		strokeWidth: number,
		sizeByPressure: number,
		alphaMultiplier: number,
		lineCap: LineCap,
		lineJoin: LineJoin,
		miterLimit: number,
		_pipelineType: PipelineType,
		elementId: string,
		cacheKey: string,
		dashArray?: readonly number[],
		dashOffset?: number,
		strokeWidths?: StrokeWidthPoint[],
		taperStart?: number,
		taperEnd?: number,
		pathStart?: number,
		pathEnd?: number,
	): void {
		if (segments.length === 0) return;

		// Power-of-two zoom buckets: round join/cap subdivision follows the
		// device-space error budget without re-tessellating on every zoom tick.
		const zoomBucket = Math.round(
			Math.log2(Math.max(this.deps.renderState.currentZoom, 1e-3)),
		);
		const tessZoom = 2 ** zoomBucket;
		const geoHash = hashStrokeGeometry(
			segments,
			strokeWidth,
			sizeByPressure,
			lineCap,
			lineJoin,
			miterLimit,
			dashArray,
			dashOffset,
			strokeWidths,
			taperStart,
			taperEnd,
			pathStart,
			pathEnd,
			zoomBucket,
		);

		// Check stroke tessellation cache. Vertices bake the resolved paint, so
		// the variant carries it alongside the geometry key.
		const variantKey = `${cacheKey}:${buildStrokePaintKey(
			strokeColor,
			alphaMultiplier,
		)}`;
		const cached = this.deps.strokeCache.get(elementId, variantKey);
		const isSolidColor = strokeColor.type === "solid";
		// Along/across stroke gradients need per-vertex arc params baked into
		// the vertex data (mode is part of strokeColorHash, so the cache
		// separates them from within-mode data).
		const strokeGradientMode =
			strokeColor.type === "stroke-gradient"
				? strokeColor.mode === "along"
					? 1
					: strokeColor.mode === "across"
						? 2
						: 0
				: 0;
		const wantArcParams = strokeGradientMode !== 0;
		// A see-through stroke draws through the stencil so its own overlaps
		// composite once. Opaque strokes look identical either way, so they keep
		// the single batched draw.
		const unionCoverage = isStrokePaintSemiTransparent(
			strokeColor,
			alphaMultiplier,
		);
		const scHash = hashStrokeColor(strokeColor);
		const cacheUsable =
			cached &&
			cached.geometryHash === geoHash &&
			cached.strokeColorHash === scHash &&
			cached.transformIndex === this.deps.renderState.currentTransformIndex &&
			(isSolidColor ? cached.geometry != null : cached.gradientBounds != null);
		if (cacheUsable) {
			// Cache hit — skip tessellation + vertex assembly
			if (cached.vertexCount === 0) return;

			if (isSolidColor && cached.geometry) {
				// Vertices already live in the shared store — no upload needed
				// on either route.
				if (unionCoverage) {
					this.drawSolidStrokeUnion(
						passEncoder,
						cached.geometry.byteOffset,
						cached.vertexCount,
					);
				} else {
					// Queued through the run batcher so consecutive solid
					// strokes with identical state collapse into one drawIndexed.
					this.appendSolidStrokeRun(
						passEncoder,
						cached.geometry.firstVertex,
						cached.vertexCount,
					);
				}
			} else if (!isSolidColor) {
				const buf = ElementVertexBuffer.fromFloat32Array(
					cached.gpuData,
					cached.vertexCount,
					this.deps.renderState.currentTransformIndex,
				);
				const gb = cached.gradientBounds!;
				this.dispatchStrokeNonSolid(
					passEncoder,
					buf,
					strokeColor,
					[gb[0], gb[1]],
					[gb[2], gb[3]],
					`${cacheKey}:grad`,
					geoHash,
					strokeGradientMode,
					alphaMultiplier,
					unionCoverage,
				);
			}
			return;
		}

		// Cache miss — full tessellation
		const subPaths = splitIntoSubPaths(segments);
		if (subPaths.length === 0) return;

		const buf = new ElementVertexBuffer(
			this.deps.renderState.currentTransformIndex,
		);

		const curveTolerance = 0.05;
		let c = { r: 0, g: 0, b: 0, a: 1 };
		if (isSolidColor) {
			c = colorToRawRGBA(strokeColor.color);
		}

		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;

		// Under first-fragment-wins the fringe cannot stay next to the subpath
		// that produced it: emitted early, its AA ramp claims pixels a later
		// subpath's body would have filled, hollowing the overlap. Held back
		// here and replayed once every body is in.
		const deferredFringe: number[] | null = unionCoverage ? [] : null;
		const pushFringeVertex = (
			vx: number,
			vy: number,
			offsetX: number,
			offsetY: number,
			fringeAlpha: number,
			t: number,
			u: number,
		): void => {
			if (isSolidColor) {
				buf.pushFill(
					vx,
					vy,
					c.r,
					c.g,
					c.b,
					c.a * alphaMultiplier * fringeAlpha,
					offsetX,
					offsetY,
				);
			} else if (wantArcParams) {
				buf.pushGradientTU(
					vx,
					vy,
					t,
					u,
					alphaMultiplier * fringeAlpha,
					offsetX,
					offsetY,
				);
			} else {
				buf.pushGradient(
					vx,
					vy,
					alphaMultiplier * fringeAlpha,
					offsetX,
					offsetY,
				);
			}
		};

		for (const subPath of subPaths) {
			const { points: flatPoints, pressures: flatPressures } =
				flattenBezierPathWithPressure(subPath, {
					curveTolerance,
				});
			if (flatPoints.length < 4) continue;

			const lastSubSeg = subPath.at(-1)!;
			const isClosed = lastSubSeg.isClosed === true;

			const hasDash = !!dashArray?.length;
			let dashPoints = flatPoints;
			let dashPressures = flatPressures;

			// For closed paths with dash, close the polyline before splitting
			if (hasDash && isClosed) {
				const firstX = flatPoints[0];
				const firstY = flatPoints[1];
				const lastX = flatPoints[flatPoints.length - 2];
				const lastY = flatPoints[flatPoints.length - 1];
				if (
					Math.abs(firstX - lastX) > 1e-6 ||
					Math.abs(firstY - lastY) > 1e-6
				) {
					dashPoints = [...flatPoints, firstX, firstY];
					dashPressures = [...flatPressures, flatPressures[0]];
				}
			}

			const subPolylines = hasDash
				? applyDashPattern(
						dashPoints,
						dashPressures,
						dashArray!,
						dashOffset ?? 0,
					)
				: [{ points: flatPoints, pressures: flatPressures, arcOffset: 0 }];

			// Whole-polyline arc length so dash sub-polylines map their local
			// t into the full stroke's range.
			const subPathArcTotal = wantArcParams
				? polylineArcLength(hasDash ? dashPoints : flatPoints)
				: 0;

			for (const { points, pressures, arcOffset } of subPolylines) {
				if (points.length < 4) continue;

				// Taper is disabled when a dash pattern is active:
				// dash sub-polylines only carry their local arc length, so tapering
				// would shrink every dash instead of the whole stroke's ends.
				const result = tessellateStroke({
					points,
					pressures,
					baseWidth: strokeWidth,
					sizeByPressure,
					lineCap,
					lineJoin,
					miterLimit,
					isClosed: hasDash ? false : isClosed,
					strokeWidths,
					taperStart: hasDash ? undefined : taperStart,
					taperEnd: hasDash ? undefined : taperEnd,
					pathStart,
					pathEnd,
					arcParams: wantArcParams
						? { arcOffset, totalArcLength: subPathArcTotal }
						: undefined,
					zoom: tessZoom,
				});

				if (result.count === 0) continue;

				// Main stroke body vertices (4 floats: x, y, inward AA inset offset)
				const verts = result.vertices;
				const vertParams = result.vertexParams;
				for (let i = 0; i < verts.length; i += 4) {
					const vx = verts[i];
					const vy = verts[i + 1];
					const vox = verts[i + 2];
					const voy = verts[i + 3];
					if (vx < minX) minX = vx;
					if (vy < minY) minY = vy;
					if (vx > maxX) maxX = vx;
					if (vy > maxY) maxY = vy;

					if (isSolidColor) {
						const a = c.a * alphaMultiplier;
						buf.pushFill(vx, vy, c.r, c.g, c.b, a, vox, voy);
					} else if (wantArcParams) {
						const pi = i / 2;
						buf.pushGradientTU(
							vx,
							vy,
							vertParams[pi],
							vertParams[pi + 1],
							alphaMultiplier,
							vox,
							voy,
						);
					} else {
						buf.pushGradient(vx, vy, alphaMultiplier, vox, voy);
					}
				}

				// Fringe AA vertices (5 floats per vertex: x, y, offsetX, offsetY, alpha)
				const fv = result.fringeVertices;
				const fvParams = result.fringeParams;
				for (let i = 0; i < fv.length; i += 5) {
					const vx = fv[i];
					const vy = fv[i + 1];
					const ox = fv[i + 2];
					const oy = fv[i + 3];
					const fringeAlpha = fv[i + 4];
					const pi = (i / 5) * 2;
					const t = wantArcParams ? fvParams[pi] : 0;
					const u = wantArcParams ? fvParams[pi + 1] : 0;

					if (deferredFringe) {
						deferredFringe.push(vx, vy, ox, oy, fringeAlpha, t, u);
					} else {
						pushFringeVertex(vx, vy, ox, oy, fringeAlpha, t, u);
					}
				}
			}
		}

		if (deferredFringe) {
			for (let i = 0; i < deferredFringe.length; i += 7) {
				pushFringeVertex(
					deferredFringe[i],
					deferredFringe[i + 1],
					deferredFringe[i + 2],
					deferredFringe[i + 3],
					deferredFringe[i + 4],
					deferredFringe[i + 5],
					deferredFringe[i + 6],
				);
			}
		}

		if (buf.vertexCount === 0) {
			this.deps.strokeCache.set(elementId, variantKey, {
				gpuData: EMPTY_F32,
				vertexCount: 0,
				geometryHash: geoHash,
				strokeColorHash: scHash,
				gradientBounds: null,
				geometry: null,
				transformIndex: this.deps.renderState.currentTransformIndex,
			});
			return;
		}

		const data = buf.toOwnedFloat32Array();

		// Lease a shared-store range for solid strokes so cache hits bind the
		// persistent buffer with no upload at all.
		const geometry = isSolidColor ? this.deps.geometryStore.alloc(data) : null;

		// Store in cache for subsequent frames
		this.deps.strokeCache.set(elementId, variantKey, {
			gpuData: data,
			vertexCount: buf.vertexCount,
			geometryHash: geoHash,
			strokeColorHash: scHash,
			gradientBounds: isSolidColor ? null : [minX, minY, maxX, maxY],
			geometry,
			transformIndex: this.deps.renderState.currentTransformIndex,
		});

		if (isSolidColor) {
			if (unionCoverage) {
				this.drawSolidStrokeUnion(
					passEncoder,
					geometry!.byteOffset,
					buf.vertexCount,
				);
			} else {
				this.appendSolidStrokeRun(
					passEncoder,
					geometry!.firstVertex,
					buf.vertexCount,
				);
			}
		} else {
			this.dispatchStrokeNonSolid(
				passEncoder,
				buf,
				strokeColor,
				[minX, minY],
				[maxX, maxY],
				`${cacheKey}:grad`,
				geoHash,
				strokeGradientMode,
				alphaMultiplier,
				unionCoverage,
			);
		}
	}

	/**
	 * Draw a solid stroke's store-resident vertices so its self-overlaps
	 * composite once: the first fragment to reach a pixel writes and locks it
	 * through the stencil, then the same vertices run again with color writes
	 * off to hand the stencil back at zero. Re-drawing the geometry (rather
	 * than a bounding quad) is what keeps the AA fringe from leaving marks
	 * behind for the next element's stencil work to trip over.
	 */
	private drawSolidStrokeUnion(
		passEncoder: GPURenderPassEncoder,
		byteOffset: number,
		vertexCount: number,
	): void {
		// The stroke owns the stencil for these two draws, so pending merged
		// runs have to land first — both for paint order and to keep them out
		// of the stencil state.
		this.deps.runBatcher.flush();
		passEncoder.setBindGroup(0, this.deps.getBindGroup());
		passEncoder.setBindGroup(1, this.deps.getTransformsBindGroup()!);
		passEncoder.setBindGroup(2, this.deps.dummyGradientBindGroup);
		passEncoder.setBindGroup(3, this.deps.getMaskBindGroup());
		passEncoder.setVertexBuffer(
			0,
			this.deps.geometryStore.buffer(),
			byteOffset,
		);
		passEncoder.setPipeline(this.deps.strokeUnionPipeline);
		passEncoder.draw(vertexCount, 1, 0, 0);
		passEncoder.setPipeline(this.deps.stencilZeroPipeline);
		passEncoder.draw(vertexCount, 1, 0, 0);
	}

	/** Queue a store-resident solid stroke through the run batcher: identical
	 *  consecutive state (pulled plain pipeline, current mask) merges into a
	 *  single vertex-pulling draw over the shared store. */
	private appendSolidStrokeRun(
		passEncoder: GPURenderPassEncoder,
		firstVertex: number,
		vertexCount: number,
	): void {
		this.deps.runBatcher.append(
			passEncoder,
			{
				pipeline: this.deps.pulledGeometryPipeline,
				bg0: this.deps.getBindGroup(),
				bg1: this.deps.getTransformsBindGroup()!,
				bg3: this.deps.getMaskBindGroup(),
				storeBuffer: this.deps.geometryStore.buffer(),
			},
			firstVertex,
			vertexCount,
		);
	}

	/**
	 * Route a non-solid stroke color (gradient or pattern) through the
	 * unified gradient renderer. Stroke-pattern wraps the def texture under
	 * the pattern shader case, matching the fill side. Solid strokes use a
	 * dedicated fast path and never reach here.
	 *
	 * This path is reached only from `renderGeometricStroke`.
	 */
	private dispatchStrokeNonSolid(
		passEncoder: GPURenderPassEncoder,
		buf: ElementVertexBuffer,
		strokeColor: StrokeGradient | StrokePattern,
		boundsMin: [number, number],
		boundsMax: [number, number],
		cacheKey: string,
		geometryHash: number,
		strokeGradientMode: number,
		/** Alpha baked into `buf`; keeps the gradient cache honest. */
		alphaMultiplier: number,
		/** @see drawSolidStrokeUnion for what the stencil is doing here. */
		unionCoverage: boolean,
	): void {
		// Gradient/pattern strokes draw outside the run batcher — emit any
		// pending solid run first to preserve paint order.
		this.deps.runBatcher.flush();
		const pipeline = unionCoverage
			? this.deps.strokeUnionPipeline
			: this.deps.strokePipeline;
		if (strokeColor.type === "stroke-pattern") {
			const pattern = strokeColor.pattern;
			if (!pattern.defId) return;
			const resolved = this.deps.resolvePatternTexture?.(pattern.defId) ?? null;
			this.deps.gradientRenderer.renderGradientFillWithPipeline(
				passEncoder,
				buf,
				pattern,
				boundsMin,
				boundsMax,
				pipeline,
				{
					// Pattern draws are uncacheable today (see renderFillThroughGradientRenderer).
					geometryHash,
					transformIndex: this.deps.renderState.currentTransformIndex,
					alphaMultiplier,
					patternTexture: resolved?.texture ?? null,
					patternTileWorldSize: resolved?.tileWorldSize,
				},
			);
			if (unionCoverage) this.restoreStencilFromVertices(passEncoder, buf);
			return;
		}
		const gradient = strokeColor.gradient;
		this.deps.gradientRenderer.renderGradientFillWithPipeline(
			passEncoder,
			buf,
			gradient,
			boundsMin,
			boundsMax,
			pipeline,
			{
				cacheKey,
				geometryHash,
				transformIndex: this.deps.renderState.currentTransformIndex,
				alphaMultiplier,
				strokeGradientMode,
			},
		);
		if (unionCoverage) this.restoreStencilFromVertices(passEncoder, buf);
	}

	/** Zero the stencil a union draw claimed, by re-rasterizing the very same
	 *  vertices with color writes off. The gradient renderer owns its vertex
	 *  buffer, so the data is uploaded once more here instead of reaching into
	 *  whatever it happened to leave bound. */
	private restoreStencilFromVertices(
		passEncoder: GPURenderPassEncoder,
		buf: ElementVertexBuffer,
	): void {
		const data = buf.toFloat32Array();
		const buffer = this.acquireFillBuffer(data.byteLength);
		this.deps.device.queue.writeBuffer(
			buffer,
			0,
			data.buffer as ArrayBuffer,
			data.byteOffset,
			data.byteLength,
		);
		passEncoder.setPipeline(this.deps.stencilZeroPipeline);
		passEncoder.setBindGroup(0, this.deps.getBindGroup());
		passEncoder.setBindGroup(1, this.deps.getTransformsBindGroup()!);
		passEncoder.setBindGroup(2, this.deps.dummyGradientBindGroup);
		passEncoder.setBindGroup(3, this.deps.getMaskBindGroup());
		passEncoder.setVertexBuffer(0, buffer);
		passEncoder.draw(buf.vertexCount, 1, 0, 0);
	}

	/**
	 * Stencil-Then-Cover fill: uses GPU stencil buffer to handle
	 * self-intersections, holes, and compound paths without CPU-side
	 * polygon clipping or triangulation.
	 */
	private renderStencilFill(
		passEncoder: GPURenderPassEncoder,
		subPaths: number[][],
		fill: FillColor,
		alphaMultiplier: number,
		_pipelineType: PipelineType = "main",
		worldOffsetX = 0,
		worldOffsetY = 0,
		elementId?: string,
		geometryHash = 0,
		cacheVariant: StencilFillVariant = "normal",
	): void {
		// Fringe vertices bake the resolved paint (solid RGBA × alphaMultiplier,
		// or just alphaMultiplier for textured fills), so a cached entry is only
		// reusable for the same paint. Without this key, a glyph painted by two
		// fills (intrinsic color + fill appearance) reused the first paint's
		// fringe: wrong-colored AA edges that dominate when zoomed out.
		let paintKey: string;
		if (fill.type === "solid") {
			const c = colorToRawRGBA(fill.color);
			paintKey = `s:${c.r.toFixed(4)},${c.g.toFixed(4)},${c.b.toFixed(4)},${(
				c.a * alphaMultiplier
			).toFixed(4)}`;
		} else {
			paintKey = `g:${alphaMultiplier.toFixed(4)}`;
		}

		// Cache hit: reuse pre-computed fan + fringe vertex data
		const sfCached = elementId
			? this.deps.stencilFillCache.get(elementId, cacheVariant, paintKey)
			: undefined;
		if (
			sfCached &&
			sfCached.transformIndex === this.deps.renderState.currentTransformIndex &&
			sfCached.geometryHash === geometryHash
		) {
			const [minX, minY, maxX, maxY] = sfCached.bounds;
			const worldBounds = elementId
				? this.deps.resolveWorldFillBounds(
						elementId,
						createLocalFillBounds({ minX, minY, maxX, maxY }),
					)
				: null;

			// Solid store-resident fills route through the run batcher, which
			// re-sequences consecutive NON-overlapping fills into three merged
			// draws (fans → covers → fringes) instead of 3 draws per element.
			if (
				fill.type === "solid" &&
				worldBounds &&
				(sfCached.fringeVertexCount === 0 ||
					(sfCached.isSolidFill && sfCached.fringeGeometry != null))
			) {
				const coverData = this.buildSolidCoverQuadData(
					fill.color,
					alphaMultiplier,
					minX,
					minY,
					maxX,
					maxY,
				);
				const coverBatch = this.appendToBatch(coverData);
				if (coverBatch) {
					this.deps.runBatcher.appendFill(
						passEncoder,
						{
							fanPipeline: this.deps.pulledStencilFanWritePipeline,
							fringePipeline: this.deps.pulledGeometryPipeline,
							coverPipeline: this.deps.stencilCoverPipeline,
							coverBg2: this.deps.dummyGradientBindGroup,
							bg0: this.deps.getBindGroup(),
							bg1: this.deps.getTransformsBindGroup()!,
							bg3: this.deps.getMaskBindGroup(),
							storeBuffer: this.deps.geometryStore.buffer(),
							coverBuffer: coverBatch.buffer,
						},
						{
							firstVertex: sfCached.fanGeometry.firstVertex,
							vertexCount: sfCached.fanVertexCount,
						},
						{ byteOffset: coverBatch.byteOffset, vertexCount: 6 },
						sfCached.fringeGeometry && sfCached.fringeVertexCount > 0
							? {
									firstVertex: sfCached.fringeGeometry.firstVertex,
									vertexCount: sfCached.fringeVertexCount,
								}
							: null,
						worldBounds,
					);
					return;
				}
				// Shared batch or a matching CPU transform is unavailable:
				// fall through to the per-element path.
			}

			// Per-element emission (gradient cover, or batch overflow) bypasses
			// the run batcher — emit anything pending first (paint order).
			this.deps.runBatcher.flush();

			// Draw fan triangles to stencil buffer (already resident in the
			// shared geometry store — no upload)
			passEncoder.setPipeline(this.deps.stencilFanWritePipeline);
			passEncoder.setBindGroup(0, this.deps.getBindGroup());
			passEncoder.setBindGroup(1, this.deps.getTransformsBindGroup()!);
			passEncoder.setBindGroup(2, this.deps.dummyGradientBindGroup);
			passEncoder.setBindGroup(3, this.deps.getMaskBindGroup());
			passEncoder.setVertexBuffer(
				0,
				this.deps.geometryStore.buffer(),
				sfCached.fanGeometry.byteOffset,
			);
			passEncoder.draw(sfCached.fanVertexCount, 1, 0, 0);

			// Cover quad
			this.drawCoverQuad(
				passEncoder,
				fill,
				alphaMultiplier,
				minX,
				minY,
				maxX,
				maxY,
				elementId,
				geometryHash,
			);

			// AA fringe
			if (sfCached.fringeVertexCount > 0 && sfCached.fringeGeometry) {
				if (sfCached.isSolidFill) {
					passEncoder.setPipeline(this.deps.strokePipeline);
					passEncoder.setBindGroup(0, this.deps.getBindGroup());
					passEncoder.setBindGroup(1, this.deps.getTransformsBindGroup()!);
					passEncoder.setBindGroup(2, this.deps.dummyGradientBindGroup);
					passEncoder.setBindGroup(3, this.deps.getMaskBindGroup());
					passEncoder.setVertexBuffer(
						0,
						this.deps.geometryStore.buffer(),
						sfCached.fringeGeometry.byteOffset,
					);
					passEncoder.draw(sfCached.fringeVertexCount, 1, 0, 0);
				} else {
					const cachedFringeBuf = ElementVertexBuffer.fromFloat32Array(
						sfCached.fringeData,
						sfCached.fringeVertexCount,
						this.deps.renderState.currentTransformIndex,
					);
					this.renderFillThroughGradientRenderer(
						passEncoder,
						cachedFringeBuf,
						fill as TexturedFill,
						[minX, minY],
						[maxX, maxY],
						this.deps.strokePipeline,
						elementId ? `${elementId}:fill:fringe` : undefined,
						geometryHash,
						this.deps.renderState.currentTransformIndex,
						alphaMultiplier,
					);
				}
			}
			return;
		}

		// Cache miss: tessellate and emit per element, outside the run batcher.
		this.deps.runBatcher.flush();

		// Step 1: Compute per-vertex inward miter vectors for each sub-path.
		// Each miter vector is the unit inward normal scaled by 1/cos(halfAngle)
		// so that offsetting by halfFw * miter produces a uniform-width fringe
		// even at sharp corners.
		const subPathMiters: Array<{
			mx: Float64Array;
			my: Float64Array;
		}> = [];

		for (const sp of subPaths) {
			const pc = sp.length / 2;
			if (pc < 3) {
				subPathMiters.push({
					mx: new Float64Array(0),
					my: new Float64Array(0),
				});
				continue;
			}

			// Signed area to determine winding direction
			let area = 0;
			for (let i = 0; i < pc; i++) {
				const j = (i + 1) % pc;
				area += sp[i * 2] * sp[j * 2 + 1] - sp[j * 2] * sp[i * 2 + 1];
			}
			// CCW (area>0) → inward = -outward; CW (area<0) → inward = +outward
			const sign = area >= 0 ? -1 : 1;

			const miterX = new Float64Array(pc);
			const miterY = new Float64Array(pc);

			for (let i = 0; i < pc; i++) {
				const prev = (i - 1 + pc) % pc;
				const next = (i + 1) % pc;

				const e0x = sp[i * 2] - sp[prev * 2];
				const e0y = sp[i * 2 + 1] - sp[prev * 2 + 1];
				const l0 = Math.sqrt(e0x * e0x + e0y * e0y);

				const e1x = sp[next * 2] - sp[i * 2];
				const e1y = sp[next * 2 + 1] - sp[i * 2 + 1];
				const l1 = Math.sqrt(e1x * e1x + e1y * e1y);

				// Sum of two adjacent unit edge normals, flipped by sign for inward.
				// |sum| = 2*cos(halfAngle), so unit = sum/|sum|, miter scale = 1/cos = 2/|sum|.
				// Storing unit * miterScale = sum / |sum| * 2 / |sum| = sum * 2 / |sum|^2
				// is equivalent to sum / dot(sum, n_edge), but simpler to compute as:
				// miter = unitNormal / cos(halfAngle) = sum / (|sum| * cos) = sum / (|sum|^2 / 2)
				let sx = 0,
					sy = 0;
				if (l0 > 1e-10 && l1 > 1e-10) {
					const n0x = e0y / l0,
						n0y = -e0x / l0;
					const n1x = e1y / l1,
						n1y = -e1x / l1;
					sx = (n0x + n1x) * sign;
					sy = (n0y + n1y) * sign;
				} else if (l0 > 1e-10) {
					sx = (e0y / l0) * sign;
					sy = (-e0x / l0) * sign;
				} else if (l1 > 1e-10) {
					sx = (e1y / l1) * sign;
					sy = (-e1x / l1) * sign;
				}

				const sLen2 = sx * sx + sy * sy;
				if (sLen2 > 1e-10) {
					// miterScale = 1 / cos(halfAngle) = 2 / |sum|
					// miterVec = (sum / |sum|) * miterScale = sum * 2 / |sum|^2
					let scale = 2.0 / sLen2;
					// Clamp to miter limit
					const sLen = Math.sqrt(sLen2);
					if (scale * sLen > MITER_LIMIT) {
						scale = MITER_LIMIT / sLen;
					}
					miterX[i] = sx * scale;
					miterY[i] = sy * scale;
				}
			}

			subPathMiters.push({ mx: miterX, my: miterY });
		}

		// Step 2: Generate triangle fan vertices for all sub-paths
		// Fan boundary vertices are inset by halfFw so the stencil cover
		// region shrinks, leaving room for the center-placed AA fringe.
		let minX = Infinity,
			minY = Infinity,
			maxX = -Infinity,
			maxY = -Infinity;
		const fanBuf = new ElementVertexBuffer(
			this.deps.renderState.currentTransformIndex,
		);

		for (let spIdx = 0; spIdx < subPaths.length; spIdx++) {
			const sp = subPaths[spIdx];
			const pointCount = sp.length / 2;
			if (pointCount < 3) continue;

			const miters = subPathMiters[spIdx];

			// Compute centroid of sub-path
			let cx = 0,
				cy = 0;
			for (let i = 0; i < sp.length; i += 2) {
				cx += sp[i];
				cy += sp[i + 1];
			}
			cx /= pointCount;
			cy /= pointCount;

			const centerX = cx + worldOffsetX;
			const centerY = cy + worldOffsetY;

			// Emit triangle fan: (center, v[i], v[i+1]) for each edge
			// Boundary vertices carry miter offset in the offset field;
			// the shader scales it by 1/zoom for zoom-independent caching.
			for (let i = 0; i < pointCount; i++) {
				const i0 = i;
				const i1 = (i + 1) % pointCount;
				const x0 = sp[i0 * 2] + worldOffsetX;
				const y0 = sp[i0 * 2 + 1] + worldOffsetY;
				const x1 = sp[i1 * 2] + worldOffsetX;
				const y1 = sp[i1 * 2 + 1] + worldOffsetY;
				const ox0 = miters.mx[i0] * HALF_MITER_SCALE;
				const oy0 = miters.my[i0] * HALF_MITER_SCALE;
				const ox1 = miters.mx[i1] * HALF_MITER_SCALE;
				const oy1 = miters.my[i1] * HALF_MITER_SCALE;

				fanBuf.pushFill(centerX, centerY, 0, 0, 0, 0);
				fanBuf.pushFill(x0, y0, 0, 0, 0, 0, ox0, oy0);
				fanBuf.pushFill(x1, y1, 0, 0, 0, 0, ox1, oy1);

				// Update bounds using original (non-inset) positions
				const origX0 = sp[i0 * 2] + worldOffsetX;
				const origY0 = sp[i0 * 2 + 1] + worldOffsetY;
				const origX1 = sp[i1 * 2] + worldOffsetX;
				const origY1 = sp[i1 * 2 + 1] + worldOffsetY;
				if (origX0 < minX) minX = origX0;
				if (origY0 < minY) minY = origY0;
				if (origX0 > maxX) maxX = origX0;
				if (origY0 > maxY) maxY = origY0;
				if (origX1 < minX) minX = origX1;
				if (origY1 < minY) minY = origY1;
				if (origX1 > maxX) maxX = origX1;
				if (origY1 > maxY) maxY = origY1;
			}
		}

		if (fanBuf.vertexCount === 0) return;

		// Expand bbox by a fixed margin for outer fringe vertices.
		// The actual fringe width is HALF_MITER_SCALE/zoom (applied in shader),
		// but a generous fixed margin avoids zoom-dependent bounds.
		minX -= FILL_BOUNDS_FRINGE_MARGIN;
		minY -= FILL_BOUNDS_FRINGE_MARGIN;
		maxX += FILL_BOUNDS_FRINGE_MARGIN;
		maxY += FILL_BOUNDS_FRINGE_MARGIN;

		// Step 3: Write fan triangles to stencil buffer
		const fanData = fanBuf.toFloat32Array();
		// Copy before fringeBuf overwrites the shared vertex buffer
		const fanDataCopy = elementId ? new Float32Array(fanData) : null;
		const batch = this.appendToBatch(fanData);

		passEncoder.setPipeline(this.deps.stencilFanWritePipeline);
		passEncoder.setBindGroup(0, this.deps.getBindGroup());
		passEncoder.setBindGroup(1, this.deps.getTransformsBindGroup()!);
		passEncoder.setBindGroup(2, this.deps.dummyGradientBindGroup);
		passEncoder.setBindGroup(3, this.deps.getMaskBindGroup());

		if (batch) {
			passEncoder.setVertexBuffer(0, batch.buffer, batch.byteOffset);
		} else {
			const fanVertexBuffer = this.acquireFillBuffer(fanData.byteLength);
			this.deps.device.queue.writeBuffer(
				fanVertexBuffer,
				0,
				fanData.buffer,
				fanData.byteOffset,
				fanData.byteLength,
			);
			passEncoder.setVertexBuffer(0, fanVertexBuffer);
		}
		passEncoder.draw(fanBuf.vertexCount, 1, 0, 0);

		// Step 4: Draw cover quad with stencil test (renders color + resets stencil)
		this.drawCoverQuad(
			passEncoder,
			fill,
			alphaMultiplier,
			minX,
			minY,
			maxX,
			maxY,
			elementId,
			geometryHash,
		);

		// Step 5: Draw center-placed boundary fringe for AA
		// Inner edge at boundary + inward*halfFw (alpha=1), outer edge at
		// boundary - inward*halfFw (alpha=0). The geometric boundary sits at
		// the midpoint so alpha ≈ 0.5 there, smoothly blending with the cover.
		const fringeBuf = new ElementVertexBuffer(
			this.deps.renderState.currentTransformIndex,
		);

		const isSolidFill = fill.type === "solid";
		let fc = { r: 0, g: 0, b: 0, a: 1 };
		if (isSolidFill) {
			fc = colorToRawRGBA(fill.color);
		}

		for (let spIdx = 0; spIdx < subPaths.length; spIdx++) {
			const sp = subPaths[spIdx];
			const pointCount = sp.length / 2;
			if (pointCount < 3) continue;

			const miters = subPathMiters[spIdx];

			for (let i = 0; i < pointCount; i++) {
				const j = (i + 1) % pointCount;
				const x0 = sp[i * 2] + worldOffsetX;
				const y0 = sp[i * 2 + 1] + worldOffsetY;
				const x1 = sp[j * 2] + worldOffsetX;
				const y1 = sp[j * 2 + 1] + worldOffsetY;

				// Miter offsets: shader multiplies by 1/zoom
				const imx0 = miters.mx[i] * HALF_MITER_SCALE;
				const imy0 = miters.my[i] * HALF_MITER_SCALE;
				const imx1 = miters.mx[j] * HALF_MITER_SCALE;
				const imy1 = miters.my[j] * HALF_MITER_SCALE;

				if (isSolidFill) {
					const a = fc.a * alphaMultiplier;
					fringeBuf.pushFill(x0, y0, fc.r, fc.g, fc.b, a, imx0, imy0);
					fringeBuf.pushFill(x0, y0, fc.r, fc.g, fc.b, 0, -imx0, -imy0);
					fringeBuf.pushFill(x1, y1, fc.r, fc.g, fc.b, a, imx1, imy1);
					fringeBuf.pushFill(x0, y0, fc.r, fc.g, fc.b, 0, -imx0, -imy0);
					fringeBuf.pushFill(x1, y1, fc.r, fc.g, fc.b, 0, -imx1, -imy1);
					fringeBuf.pushFill(x1, y1, fc.r, fc.g, fc.b, a, imx1, imy1);
				} else {
					fringeBuf.pushGradient(x0, y0, alphaMultiplier, imx0, imy0);
					fringeBuf.pushGradient(x0, y0, 0, -imx0, -imy0);
					fringeBuf.pushGradient(x1, y1, alphaMultiplier, imx1, imy1);
					fringeBuf.pushGradient(x0, y0, 0, -imx0, -imy0);
					fringeBuf.pushGradient(x1, y1, 0, -imx1, -imy1);
					fringeBuf.pushGradient(x1, y1, alphaMultiplier, imx1, imy1);
				}
			}
		}

		if (fringeBuf.vertexCount > 0) {
			if (isSolidFill) {
				const fringeData = fringeBuf.toFloat32Array();
				const fringeBuffer = this.acquireFillBuffer(fringeData.byteLength);
				this.deps.device.queue.writeBuffer(
					fringeBuffer,
					0,
					fringeData.buffer as ArrayBuffer,
					fringeData.byteOffset,
					fringeData.byteLength,
				);

				passEncoder.setPipeline(this.deps.strokePipeline);
				passEncoder.setBindGroup(0, this.deps.getBindGroup());
				passEncoder.setBindGroup(1, this.deps.getTransformsBindGroup()!);
				passEncoder.setBindGroup(2, this.deps.dummyGradientBindGroup);
				passEncoder.setBindGroup(3, this.deps.getMaskBindGroup());
				passEncoder.setVertexBuffer(0, fringeBuffer);
				passEncoder.draw(fringeBuf.vertexCount, 1, 0, 0);
			} else {
				this.renderFillThroughGradientRenderer(
					passEncoder,
					fringeBuf,
					fill as TexturedFill,
					[minX, minY],
					[maxX, maxY],
					this.deps.strokePipeline,
					elementId ? `${elementId}:fill:fringe` : undefined,
					geometryHash,
					this.deps.renderState.currentTransformIndex,
					alphaMultiplier,
				);
			}
		}

		// Store computed vertex data in cache for subsequent frames. The
		// vertices are leased into the shared geometry store here so cache
		// hits bind the persistent buffer with no upload at all.
		if (elementId && fanDataCopy) {
			const fringeSlice = fringeBuf.toFloat32Array();
			const hasFringe = fringeBuf.vertexCount > 0;
			const fringeDataCopy = hasFringe
				? new Float32Array(fringeSlice)
				: EMPTY_F32;

			this.deps.stencilFillCache.set(elementId, cacheVariant, paintKey, {
				fanGeometry: this.deps.geometryStore.alloc(fanDataCopy),
				fanVertexCount: fanBuf.vertexCount,
				fringeGeometry: hasFringe
					? this.deps.geometryStore.alloc(fringeDataCopy)
					: null,
				fringeData: fringeDataCopy,
				fringeVertexCount: fringeBuf.vertexCount,
				bounds: [minX, minY, maxX, maxY],
				isSolidFill,
				transformIndex: this.deps.renderState.currentTransformIndex,
				geometryHash,
			});
		}
	}

	/**
	 * Draw a bounding-box quad with stencil test: renders color where
	 * winding != 0 and resets stencil to 0 for the next path.
	 */
	private drawCoverQuad(
		passEncoder: GPURenderPassEncoder,
		fill: FillColor,
		alphaMultiplier: number,
		minX: number,
		minY: number,
		maxX: number,
		maxY: number,
		elementId?: string,
		geometryHash = 0,
	): void {
		if (fill.type === "solid") {
			const coverData = this.buildSolidCoverQuadData(
				fill.color,
				alphaMultiplier,
				minX,
				minY,
				maxX,
				maxY,
			);
			const coverBatch = this.appendToBatch(coverData);

			passEncoder.setPipeline(this.deps.stencilCoverPipeline);
			passEncoder.setBindGroup(0, this.deps.getBindGroup());
			passEncoder.setBindGroup(1, this.deps.getTransformsBindGroup()!);
			passEncoder.setBindGroup(2, this.deps.dummyGradientBindGroup);
			passEncoder.setBindGroup(3, this.deps.getMaskBindGroup());

			if (coverBatch) {
				passEncoder.setVertexBuffer(
					0,
					coverBatch.buffer,
					coverBatch.byteOffset,
				);
			} else {
				const coverVertexBuffer = this.acquireFillBuffer(coverData.byteLength);
				this.deps.device.queue.writeBuffer(
					coverVertexBuffer,
					0,
					coverData.buffer,
					coverData.byteOffset,
					coverData.byteLength,
				);
				passEncoder.setVertexBuffer(0, coverVertexBuffer);
			}
			passEncoder.draw(6, 1, 0, 0);
		} else {
			// Gradient fill: use gradient bind group for cover quad
			const coverBuf = new ElementVertexBuffer(
				this.deps.renderState.currentTransformIndex,
			);
			coverBuf.pushGradient(minX, minY, alphaMultiplier);
			coverBuf.pushGradient(maxX, minY, alphaMultiplier);
			coverBuf.pushGradient(minX, maxY, alphaMultiplier);
			coverBuf.pushGradient(maxX, minY, alphaMultiplier);
			coverBuf.pushGradient(maxX, maxY, alphaMultiplier);
			coverBuf.pushGradient(minX, maxY, alphaMultiplier);

			this.renderFillThroughGradientRenderer(
				passEncoder,
				coverBuf,
				fill as TexturedFill,
				[minX, minY],
				[maxX, maxY],
				this.deps.stencilCoverPipeline,
				elementId ? `${elementId}:fill:cover` : undefined,
				geometryHash,
				this.deps.renderState.currentTransformIndex,
				alphaMultiplier,
			);
		}
	}

	/** Two triangles forming the bounding-box cover quad, color and alpha
	 *  baked into the vertices (unified layout). */
	private buildSolidCoverQuadData(
		color: Parameters<typeof colorToRawRGBA>[0],
		alphaMultiplier: number,
		minX: number,
		minY: number,
		maxX: number,
		maxY: number,
	): Float32Array {
		const coverBuf = new ElementVertexBuffer(
			this.deps.renderState.currentTransformIndex,
		);
		const c = colorToRawRGBA(color);
		const a = c.a * alphaMultiplier;
		coverBuf.pushFill(minX, minY, c.r, c.g, c.b, a);
		coverBuf.pushFill(maxX, minY, c.r, c.g, c.b, a);
		coverBuf.pushFill(minX, maxY, c.r, c.g, c.b, a);
		coverBuf.pushFill(maxX, minY, c.r, c.g, c.b, a);
		coverBuf.pushFill(maxX, maxY, c.r, c.g, c.b, a);
		coverBuf.pushFill(minX, maxY, c.r, c.g, c.b, a);
		return coverBuf.toFloat32Array();
	}

	/**
	 * Bake a blend key's path-deformation pre-filters (zigzag, path-offset, …)
	 * into its segments so the blend interpolates the deformed shape. The
	 * pre-filters are dropped from the returned path's filters (fill/stroke and
	 * post-filters are kept) so they are not applied again when the key or its
	 * intermediates are drawn. Returns the path unchanged when it has no enabled
	 * pre-filter.
	 */
	private bakeBlendKeyDeformation(path: Path): Path {
		const filters = path.filters ?? [];
		const isPreFilter = (f: Filter) =>
			!!this.deps.filterRenderer.getHandler(f.processor)?.preProcess;
		const hasEnabledPreFilter = filters.some(
			(f) => f.enabled !== false && isPreFilter(f),
		);
		if (!hasEnabledPreFilter) return path;
		return {
			...path,
			segments: applyPreFilters(
				path.segments,
				filters,
				this.deps.filterRenderer,
			),
			filters: filters.filter((f) => !isPreFilter(f)),
		};
	}

	/**
	 * Internal helper: dispatch the gradient renderer for any fill type,
	 * resolving pattern textures on the fly when `fill.type === "pattern"`.
	 * Pattern fills without a resolved texture fall back to a transparent
	 * sample (the def is not ready yet).
	 */
	private renderFillThroughGradientRenderer(
		passEncoder: GPURenderPassEncoder,
		buf: ElementVertexBuffer,
		fill: TexturedFill,
		boundsMin: [number, number],
		boundsMax: [number, number],
		pipeline: GPURenderPipeline,
		cacheKey: string | undefined,
		geometryHash: number | undefined,
		transformIndex: number | undefined,
		/** Alpha baked into `buf`; keeps the gradient cache honest. */
		alphaMultiplier: number,
	): void {
		// Gradient/pattern draws bypass the run batcher — emit any pending
		// solid run first to preserve paint order.
		this.deps.runBatcher.flush();
		if (fill.type === "pattern") {
			if (!fill.defId) return;
			const resolved = this.deps.resolvePatternTexture?.(fill.defId) ?? null;
			this.deps.gradientRenderer.renderGradientFillWithPipeline(
				passEncoder,
				buf,
				fill,
				boundsMin,
				boundsMax,
				pipeline,
				{
					// Pattern draws are uncacheable today — DefRasterizer keeps the
					// texture stable but the call frequency is low and avoiding the
					// cache simplifies revision invalidation.
					geometryHash,
					transformIndex,
					alphaMultiplier,
					patternTexture: resolved?.texture ?? null,
					patternTileWorldSize: resolved?.tileWorldSize,
					// Fill bounds arrive fringe-expanded (renderStencilFill); recover
					// the tight top-left corner for the pattern tile anchor.
					patternAnchor: [
						boundsMin[0] + FILL_BOUNDS_FRINGE_MARGIN,
						boundsMax[1] - FILL_BOUNDS_FRINGE_MARGIN,
					],
				},
			);
			return;
		}
		this.deps.gradientRenderer.renderGradientFillWithPipeline(
			passEncoder,
			buf,
			fill,
			boundsMin,
			boundsMax,
			pipeline,
			{ cacheKey, geometryHash, transformIndex, alphaMultiplier },
		);
	}

	// ── Fill-batch machinery ──────────────────────────────────────────────

	private acquireFillBuffer(requiredBytes: number): GPUBuffer {
		let entry = this.fillBufferPool[this.fillDrawIndex];
		if (!entry || entry.size < requiredBytes) {
			entry?.buffer.destroy();
			const size = Math.max(requiredBytes, 4096);
			entry = {
				buffer: this.deps.device.createBuffer({
					label: `Fill Vertex Buffer (Pooled #${this.fillDrawIndex})`,
					size,
					usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
				}),
				size,
			};
			this.fillBufferPool[this.fillDrawIndex] = entry;
		}
		this.fillDrawIndex++;
		return entry.buffer;
	}

	/**
	 * Append fill vertex data to the frame-wide batch buffer.
	 * Returns the GPU buffer and byte offset for setVertexBuffer, or null
	 * when the shared buffer is too small (caller must fall back to
	 * acquireFillBuffer + per-element writeBuffer).
	 */
	private appendToBatch(
		data: Float32Array,
	): { buffer: GPUBuffer; byteOffset: number } | null {
		const requiredBytes = (this.batchOffset + data.length) * 4;
		this.batchPeakBytes = Math.max(this.batchPeakBytes, requiredBytes);

		if (!this.batchGPUBuf || requiredBytes > this.batchGPUBufSize) {
			return null; // overflow — use legacy per-element buffer
		}

		// Grow CPU buffer if needed (cheap realloc, no GPU impact)
		if (this.batchOffset + data.length > this.batchCpuBuf.length) {
			const newBuf = new Float32Array(
				Math.max(this.batchOffset + data.length, this.batchCpuBuf.length * 2),
			);
			newBuf.set(this.batchCpuBuf.subarray(0, this.batchOffset));
			this.batchCpuBuf = newBuf;
		}

		const byteOffset = this.batchOffset * 4;
		this.batchCpuBuf.set(data, this.batchOffset);
		this.batchOffset += data.length;

		return { buffer: this.batchGPUBuf, byteOffset };
	}
}
