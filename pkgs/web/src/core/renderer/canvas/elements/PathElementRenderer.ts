import { resolveBrushTextureUid } from "../../../brush/brushSource";
import { localAppearances } from "../../../document/appearancePresets";
import { createStrokeBrushSettings } from "../../../document/factory";
import {
	type AnyArtObject,
	type BlendObject,
	type Color,
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
	type StrokeWidthPoint,
	type TexturedFill,
} from "../../../schema";
import {
	resolveBlendSourcePath,
	resolveBlendSpinePath,
} from "../../../utils/geometry/blendInterpolation";
import type { GPUTransformAffine } from "../../../utils/geometry/geometry";
import { hashSegments, toWorldPath } from "../../../utils/geometry/segmentOps";
import {
	flattenBezierPath,
	flattenBezierPathWithPressure,
} from "../../geometry/bezierFlatten";
import {
	appendFillLines,
	appendTriangleSoupLines,
	composeDeviceTransform,
	deviceScaleBucket,
	localCurveTolerance,
} from "../../geometry/strips/deviceGeometry";
import { rasterizeStrokeParams } from "../../geometry/strips/paramsRasterizer";
import { StripRasterizer } from "../../geometry/strips/stripRenderer";
import {
	type ClipRect,
	type DeviceTransform,
	type RasterFrame,
	type StripBatch,
	TILE_SIZE,
} from "../../geometry/strips/stripTypes";
import {
	applyDashPattern,
	polylineArcLength,
	tessellateStroke,
} from "../../geometry/strokeTessellator";
import { hashStrokeGeometry } from "../../helpers";
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
import type {
	FillOutline,
	LocalBounds,
	OutlineCache,
	OutlineEntry,
	StrokeOutline,
} from "../caches/OutlineCache";
import {
	type StripCache,
	type StripCacheVariant,
	type StripRasterKey,
	stripRasterKeyEquals,
} from "../caches/StripCache";
import type {
	BrushDrawBindings,
	BrushRenderer,
} from "../pipeline/brush/BrushRenderer";
import { resolveGeometricSizeByPressure } from "../pipeline/brush/strokeHalfWidth";
import type { FilterRenderer } from "../pipeline/FilterRenderer";
import { applyPreFilters } from "../pipeline/PreFilterRenderer";
import type { StripColor, StripFrame } from "../pipeline/strips/StripFrame";
import {
	type DrawableSegments,
	type ResolvedAppearancePass,
	resolveAppearancePasses,
} from "./appearancePasses";
import type { GradientRenderer } from "./GradientRenderer";

/** Sub-pixel translation phase resolution of the strip cache key. */
const PHASE_STEPS = 256;

interface PathElementRendererDeps {
	stripFrame: StripFrame;
	dummyGradientBindGroup: GPUBindGroup;
	getBindGroup: () => GPUBindGroup;
	getTransformsBuffer: () => GPUBuffer | null;
	getMaskBindGroup: () => GPUBindGroup;
	/** Texel space of the pass being encoded. */
	getRasterFrame: () => RasterFrame;
	/** Affine part of a transform slot, as the GPU reads it. */
	getGpuTransform: (slot: number) => GPUTransformAffine;
	// Mutable shared state (by reference)
	renderState: RenderState;
	assetState: AssetState;
	filterRenderer: FilterRenderer;
	brushRenderer: BrushRenderer;
	/** The viewport uniform / transforms / mask a brush draw binds right now. */
	getBrushDrawBindings: () => BrushDrawBindings;
	// Externally-owned caches (managed by RenderCacheManager). Accessed as
	// accessors so the active document scope resolves per access.
	outlineCache: OutlineCache;
	stripCache: StripCache;
	getCompoundPathGeometryCache: () => CompoundPathCache;
	getBlendCache: () => BlendCache;
	/** Builds paint bind groups for gradient / pattern fills and strokes. */
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

/** Paint of one strip draw: a solid colour, or a textured BG2 with an opacity. */
type StripPaint =
	| { kind: "solid"; color: StripColor }
	| { kind: "textured"; bindGroup: GPUBindGroup; alpha: number };

/**
 * Draws path fills and geometric strokes as sparse coverage strips.
 *
 * Fills are flattened and strokes tessellated once per scale bucket in
 * element-local space (OutlineCache). Per pass the outline is mapped into
 * the pass's texel space, rasterized into strips (StripCache, reused across
 * whole-texel pans), appended to the frame's strip buffers and drawn with the
 * paint resolved per instance. Non-geometric strokes go to the brush engine.
 */
export class PathElementRenderer {
	private readonly deps: PathElementRendererDeps;
	private readonly rasterizer = new StripRasterizer();

	public constructor(deps: PathElementRendererDeps) {
		this.deps = deps;
	}

	public renderPath(
		passEncoder: GPURenderPassEncoder,
		path: Path,
		alphaMultiplier: number = 1.0,
		pipelineType: PipelineType = "main",
		cacheVariant: StripCacheVariant = "normal",
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
		cacheVariant: StripCacheVariant = "normal",
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
						path.id,
						`${cacheKey}:stroke`,
						cacheVariant,
						settings.stroking?.dashArray,
						settings.stroking?.dashOffset,
						path.strokeWidths,
						settings.taperStart,
						settings.taperEnd,
						path.pathStart,
						path.pathEnd,
					);
				} else {
					const textureUid = resolveBrushTextureUid(
						settings,
						this.deps.brushRenderer.textures,
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

					this.deps.brushRenderer.render(
						passEncoder,
						{
							path,
							segments,
							strokeColor,
							settings,
							alphaMultiplier: appAlpha,
							transformIndex: this.deps.renderState.currentTransformIndex,
						},
						this.deps.getBrushDrawBindings(),
					);
				}
			}
		}
	}

	/**
	 * Fill a closed path under the nonzero rule. Subpaths that overlap with
	 * the same orientation union; opposite orientations cut holes.
	 */
	public renderPathFill(
		passEncoder: GPURenderPassEncoder,
		segments: DrawableSegments,
		fill: FillColor,
		alphaMultiplier: number,
		cacheKey: string,
		cacheVariant: StripCacheVariant = "normal",
	): void {
		if (segments.length === 0) return;
		const frame = this.deps.getRasterFrame();
		const transform = this.currentDeviceTransform(frame);
		const scaleBucket = deviceScaleBucket(transform);
		const geometryHash = hashSegments(segments);

		let outline = this.deps.outlineCache.get(cacheKey, "fill");
		if (
			outline?.kind !== "fill" ||
			outline.geometryHash !== geometryHash ||
			outline.scaleBucket !== scaleBucket
		) {
			outline = flattenFillOutline(segments, geometryHash, scaleBucket);
			this.deps.outlineCache.set(cacheKey, "fill", outline);
		}
		if (outline.subpathOffsets.length < 2) return;

		const paint =
			fill.type === "solid"
				? solidPaint(fill.color, alphaMultiplier)
				: this.texturedPaint(fill, outline.localBounds, alphaMultiplier, {
						cacheKey: `${cacheKey}:fill`,
						geometryHash,
					});
		if (!paint) return;

		this.drawOutline(
			passEncoder,
			outline,
			paint,
			cacheKey,
			stripVariantKey(cacheVariant, frame, "fill"),
			0,
			frame,
			transform,
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
		// ("<blendId>::src<i>") instead of the original element id: the blend owns
		// a baked copy whose geometry (world space) differs from the element's own
		// rendering (local space), so the two must not share cache entries. "::"
		// keeps the live base id (blend id) intact for onDocumentChange pruning.
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
		elementId: string,
		cacheKey: string,
		cacheVariant: StripCacheVariant,
		dashArray?: readonly number[],
		dashOffset?: number,
		strokeWidths?: StrokeWidthPoint[],
		taperStart?: number,
		taperEnd?: number,
		pathStart?: number,
		pathEnd?: number,
	): void {
		if (segments.length === 0) return;
		const frame = this.deps.getRasterFrame();
		const transform = this.currentDeviceTransform(frame);
		// Round join/cap subdivision follows the device-space error budget of
		// the scale bucket without re-tessellating on every zoom tick.
		const scaleBucket = deviceScaleBucket(transform);
		const geometryHash = hashStrokeGeometry(
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
			scaleBucket,
		);
		// Along/across stroke gradients need per-pixel arc params; the outline
		// carries them only when asked, so the mode is part of its key.
		const paramsMode =
			strokeColor.type === "stroke-gradient"
				? strokeColor.mode === "along"
					? 1
					: strokeColor.mode === "across"
						? 2
						: 0
				: 0;
		const outlineKey = `${cacheKey}:p${paramsMode === 0 ? 0 : 1}`;

		let outline = this.deps.outlineCache.get(elementId, outlineKey);
		if (
			outline?.kind !== "stroke" ||
			outline.geometryHash !== geometryHash ||
			outline.scaleBucket !== scaleBucket
		) {
			outline = tessellateStrokeOutline(
				segments,
				{
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
					wantArcParams: paramsMode !== 0,
					zoom: 2 ** scaleBucket,
				},
				geometryHash,
				scaleBucket,
			);
			this.deps.outlineCache.set(elementId, outlineKey, outline);
		}
		if (outline.triangles.length === 0) return;

		let paint: StripPaint | null;
		if (strokeColor.type === "solid") {
			paint = solidPaint(strokeColor.color, alphaMultiplier);
		} else if (strokeColor.type === "stroke-pattern") {
			paint = this.texturedPaint(
				strokeColor.pattern,
				outline.localBounds,
				alphaMultiplier,
				{ geometryHash },
			);
		} else {
			paint = this.texturedPaint(
				strokeColor.gradient,
				outline.localBounds,
				alphaMultiplier,
				{
					cacheKey: `${cacheKey}:grad`,
					geometryHash,
					strokeGradientMode: paramsMode,
				},
			);
		}
		if (!paint) return;

		this.drawOutline(
			passEncoder,
			outline,
			paint,
			elementId,
			stripVariantKey(cacheVariant, frame, cacheKey),
			paramsMode,
			frame,
			transform,
		);
	}

	/**
	 * Rasterize an outline for the current pass (or reuse the cached strips)
	 * and draw it. Strips are generated relative to the integer part of the
	 * outline's device translation, so a pan by whole texels re-uses them.
	 */
	private drawOutline(
		passEncoder: GPURenderPassEncoder,
		outline: OutlineEntry,
		paint: StripPaint,
		elementId: string,
		variantKey: string,
		paramsMode: number,
		frame: RasterFrame,
		transform: DeviceTransform,
	): void {
		const anchorX = Math.floor(transform.e);
		const anchorY = Math.floor(transform.f);
		const local: DeviceTransform = {
			...transform,
			e: transform.e - anchorX,
			f: transform.f - anchorY,
		};
		const key: StripRasterKey = {
			geometryHash: outline.geometryHash,
			scaleBucket: outline.scaleBucket,
			a: local.a,
			b: local.b,
			c: local.c,
			d: local.d,
			fracX: Math.round(local.e * PHASE_STEPS),
			fracY: Math.round(local.f * PHASE_STEPS),
			paramsMode,
		};
		const passRect: ClipRect = {
			x0: -anchorX,
			y0: -anchorY,
			x1: frame.width - anchorX,
			y1: frame.height - anchorY,
		};

		let entry = this.deps.stripCache.get(elementId, variantKey);
		if (
			!entry ||
			!stripRasterKeyEquals(entry.key, key) ||
			!rectContains(entry.coverage, passRect)
		) {
			const { coverage, clip } = generationClip(
				passRect,
				outline.localBounds,
				local,
			);
			entry = {
				key,
				coverage,
				batch: this.rasterizeOutline(outline, local, clip, paramsMode),
			};
			this.deps.stripCache.set(elementId, variantKey, entry);
		}

		const transformsBuffer = this.deps.getTransformsBuffer();
		if (!transformsBuffer) return;
		const color: StripColor =
			paint.kind === "solid" ? paint.color : [0, 0, 0, paint.alpha];
		const ranges = this.deps.stripFrame.append(
			entry.batch,
			anchorX,
			anchorY,
			frame.width,
			frame.height,
			this.deps.renderState.currentTransformIndex,
			color,
		);
		const paintBindGroup =
			paint.kind === "solid"
				? this.deps.dummyGradientBindGroup
				: paint.bindGroup;
		for (const range of ranges) {
			this.deps.stripFrame.draw(
				passEncoder,
				range,
				this.deps.getBindGroup(),
				transformsBuffer,
				paintBindGroup,
				this.deps.getMaskBindGroup(),
			);
		}
	}

	private rasterizeOutline(
		outline: OutlineEntry,
		transform: DeviceTransform,
		clip: ClipRect,
		paramsMode: number,
	): StripBatch {
		const lines = this.rasterizer.lines;
		if (outline.kind === "fill") {
			appendFillLines(
				lines,
				outline.points,
				outline.subpathOffsets,
				transform,
				clip,
			);
		} else {
			appendTriangleSoupLines(lines, outline.triangles, transform, clip);
		}
		const batch = this.rasterizer.rasterize(clip, {
			denseOnly: paramsMode !== 0,
		});
		if (paramsMode !== 0 && outline.kind === "stroke" && outline.params) {
			rasterizeStrokeParams(
				batch,
				outline.triangles,
				outline.params,
				transform,
				clip,
			);
		}
		return batch;
	}

	private currentDeviceTransform(frame: RasterFrame): DeviceTransform {
		return composeDeviceTransform(
			this.deps.getGpuTransform(this.deps.renderState.currentTransformIndex),
			frame,
		);
	}

	/**
	 * Paint bind group for a gradient / pattern fill over the outline's local
	 * bounds. Pattern fills without a resolved texture draw nothing (the def
	 * is not ready yet).
	 */
	private texturedPaint(
		fill: TexturedFill,
		bounds: LocalBounds,
		alphaMultiplier: number,
		options: {
			cacheKey?: string;
			geometryHash: number;
			strokeGradientMode?: number;
		},
	): StripPaint | null {
		const boundsMin: [number, number] = [bounds[0], bounds[1]];
		const boundsMax: [number, number] = [bounds[2], bounds[3]];
		const transformIndex = this.deps.renderState.currentTransformIndex;
		if (fill.type === "pattern") {
			if (!fill.defId) return null;
			const resolved = this.deps.resolvePatternTexture?.(fill.defId) ?? null;
			return {
				kind: "textured",
				alpha: alphaMultiplier,
				bindGroup: this.deps.gradientRenderer.acquirePaintBindGroup(
					fill,
					boundsMin,
					boundsMax,
					{
						// Pattern draws are uncacheable: DefRasterizer keeps the
						// texture stable but the call frequency is low and avoiding
						// the cache simplifies revision invalidation.
						geometryHash: options.geometryHash,
						transformIndex,
						patternTexture: resolved?.texture ?? null,
						patternTileWorldSize: resolved?.tileWorldSize,
					},
				),
			};
		}
		return {
			kind: "textured",
			alpha: alphaMultiplier,
			bindGroup: this.deps.gradientRenderer.acquirePaintBindGroup(
				fill,
				boundsMin,
				boundsMax,
				{ ...options, transformIndex },
			),
		};
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
		const filters = localAppearances(path.filters);
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
}

/**
 * Strip cache variant of a draw. The pass size is part of it because one
 * element can be drawn into several passes per frame (a mask atlas cell and a
 * standalone mask, say), each with its own sub-pixel phase; sharing one entry
 * would make them evict each other every frame.
 */
function stripVariantKey(
	cacheVariant: StripCacheVariant,
	frame: RasterFrame,
	suffix: string,
): string {
	return `${cacheVariant}:${frame.width}x${frame.height}:${suffix}`;
}

function solidPaint(color: Color, alphaMultiplier: number): StripPaint {
	const c = colorToRawRGBA(color);
	return { kind: "solid", color: [c.r, c.g, c.b, c.a * alphaMultiplier] };
}

/** Flatten closed subpaths at the bucket's local tolerance. */
function flattenFillOutline(
	segments: DrawableSegments,
	geometryHash: number,
	scaleBucket: number,
): FillOutline {
	const curveTolerance = localCurveTolerance(scaleBucket);
	const points: number[] = [];
	const offsets: number[] = [0];
	for (const subPath of splitIntoSubPaths(segments)) {
		const flat = cleanupPolygonPoints(
			flattenBezierPath(subPath, { curveTolerance }),
		);
		if (flat.length < 6) continue;
		for (const v of flat) points.push(v);
		offsets.push(points.length / 2);
	}
	return {
		kind: "fill",
		geometryHash,
		scaleBucket,
		localBounds: boundsOf(points),
		points: Float32Array.from(points),
		subpathOffsets: Int32Array.from(offsets),
	};
}

interface StrokeOutlineOptions {
	strokeWidth: number;
	sizeByPressure: number;
	lineCap: LineCap;
	lineJoin: LineJoin;
	miterLimit: number;
	dashArray?: readonly number[];
	dashOffset?: number;
	strokeWidths?: StrokeWidthPoint[];
	taperStart?: number;
	taperEnd?: number;
	pathStart?: number;
	pathEnd?: number;
	wantArcParams: boolean;
	zoom: number;
}

/** Tessellate a stroke into body triangles at the bucket's local tolerance. */
function tessellateStrokeOutline(
	segments: DrawableSegments,
	options: StrokeOutlineOptions,
	geometryHash: number,
	scaleBucket: number,
): StrokeOutline {
	const curveTolerance = localCurveTolerance(scaleBucket);
	const triangles: number[] = [];
	const params: number[] = [];
	const hasDash = !!options.dashArray?.length;

	for (const subPath of splitIntoSubPaths(segments)) {
		const { points: flatPoints, pressures: flatPressures } =
			flattenBezierPathWithPressure(subPath, { curveTolerance });
		if (flatPoints.length < 4) continue;

		const isClosed = subPath.at(-1)!.isClosed === true;
		let dashPoints = flatPoints;
		let dashPressures = flatPressures;
		// For closed paths with dash, close the polyline before splitting.
		if (hasDash && isClosed) {
			const firstX = flatPoints[0];
			const firstY = flatPoints[1];
			const lastX = flatPoints[flatPoints.length - 2];
			const lastY = flatPoints[flatPoints.length - 1];
			if (Math.abs(firstX - lastX) > 1e-6 || Math.abs(firstY - lastY) > 1e-6) {
				dashPoints = [...flatPoints, firstX, firstY];
				dashPressures = [...flatPressures, flatPressures[0]];
			}
		}

		const subPolylines = hasDash
			? applyDashPattern(
					dashPoints,
					dashPressures,
					options.dashArray!,
					options.dashOffset ?? 0,
				)
			: [{ points: flatPoints, pressures: flatPressures, arcOffset: 0 }];

		// Whole-polyline arc length so dash sub-polylines map their local
		// t into the full stroke's range.
		const subPathArcTotal = options.wantArcParams
			? polylineArcLength(hasDash ? dashPoints : flatPoints)
			: 0;

		for (const { points, pressures, arcOffset } of subPolylines) {
			if (points.length < 4) continue;
			// Taper is disabled when a dash pattern is active: dash sub-polylines
			// only carry their local arc length, so tapering would shrink every
			// dash instead of the whole stroke's ends.
			const result = tessellateStroke({
				points,
				pressures,
				baseWidth: options.strokeWidth,
				sizeByPressure: options.sizeByPressure,
				lineCap: options.lineCap,
				lineJoin: options.lineJoin,
				miterLimit: options.miterLimit,
				isClosed: hasDash ? false : isClosed,
				strokeWidths: options.strokeWidths,
				taperStart: hasDash ? undefined : options.taperStart,
				taperEnd: hasDash ? undefined : options.taperEnd,
				pathStart: options.pathStart,
				pathEnd: options.pathEnd,
				arcParams: options.wantArcParams
					? { arcOffset, totalArcLength: subPathArcTotal }
					: undefined,
				zoom: options.zoom,
			});
			for (const v of result.vertices) triangles.push(v);
			if (options.wantArcParams) {
				for (const v of result.vertexParams) params.push(v);
			}
		}
	}

	return {
		kind: "stroke",
		geometryHash,
		scaleBucket,
		localBounds: boundsOf(triangles),
		triangles: Float32Array.from(triangles),
		params: options.wantArcParams ? Float32Array.from(params) : null,
	};
}

function boundsOf(points: readonly number[]): LocalBounds {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (let i = 0; i + 1 < points.length; i += 2) {
		const x = points[i];
		const y = points[i + 1];
		if (x < minX) minX = x;
		if (y < minY) minY = y;
		if (x > maxX) maxX = x;
		if (y > maxY) maxY = y;
	}
	return points.length < 2 ? [0, 0, 0, 0] : [minX, minY, maxX, maxY];
}

/**
 * Where strips are generated. `coverage` is the pass rect grown by one pass
 * on each side, so whole-texel pans stay inside it and reuse the strips;
 * `clip` narrows that to what the outline can touch. Both are aligned
 * outward to the tile grid.
 */
function generationClip(
	passRect: ClipRect,
	localBounds: LocalBounds,
	t: DeviceTransform,
): { coverage: ClipRect; clip: ClipRect } {
	const passWidth = passRect.x1 - passRect.x0;
	const passHeight = passRect.y1 - passRect.y0;
	const coverage = alignToTiles({
		x0: passRect.x0 - passWidth,
		y0: passRect.y0 - passHeight,
		x1: passRect.x1 + passWidth,
		y1: passRect.y1 + passHeight,
	});
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const [lx, ly] of [
		[localBounds[0], localBounds[1]],
		[localBounds[2], localBounds[1]],
		[localBounds[0], localBounds[3]],
		[localBounds[2], localBounds[3]],
	]) {
		const x = t.a * lx + t.c * ly + t.e;
		const y = t.b * lx + t.d * ly + t.f;
		if (x < minX) minX = x;
		if (y < minY) minY = y;
		if (x > maxX) maxX = x;
		if (y > maxY) maxY = y;
	}
	const clip = alignToTiles({
		x0: Math.max(coverage.x0, minX - 1),
		y0: Math.max(coverage.y0, minY - 1),
		x1: Math.min(coverage.x1, maxX + 1),
		y1: Math.min(coverage.y1, maxY + 1),
	});
	return { coverage, clip };
}

function alignToTiles(rect: ClipRect): ClipRect {
	const x0 = Math.floor(rect.x0 / TILE_SIZE) * TILE_SIZE;
	const y0 = Math.floor(rect.y0 / TILE_SIZE) * TILE_SIZE;
	return {
		x0,
		y0,
		x1: Math.max(x0 + TILE_SIZE, Math.ceil(rect.x1 / TILE_SIZE) * TILE_SIZE),
		y1: Math.max(y0 + TILE_SIZE, Math.ceil(rect.y1 / TILE_SIZE) * TILE_SIZE),
	};
}

function rectContains(outer: ClipRect, inner: ClipRect): boolean {
	return (
		inner.x0 >= outer.x0 &&
		inner.y0 >= outer.y0 &&
		inner.x1 <= outer.x1 &&
		inner.y1 <= outer.y1
	);
}
