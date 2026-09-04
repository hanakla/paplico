import polygonClipping, {
	type MultiPolygon,
	type Polygon,
	type Ring,
} from "polygon-clipping";
import {
	readStoredBrushSize,
	readStoredBrushStroking,
} from "../../../brush/access";
import { createIdentityTransform } from "../../../document/factory";
import {
	type AnyArtObject,
	type BlendObject,
	type BoundingBox,
	type Color,
	type CompoundPath,
	type CubicBezierSegment,
	type ElementTransform,
	type FillAppearance,
	type Filter,
	type Group,
	getTransform,
	hasGroupAppearances,
	isFilterEnabled,
	isIdentityTransform,
	isPath,
	type Path,
	type PathSegment,
	type Solid3DBaseParams,
	type StrokeAppearance,
	type TextElement,
	type Vec3,
	type Viewport,
} from "../../../schema";
import { generateRectangleSegments } from "../../../tools/ShapeTool";
import {
	computeBlendIntermediates,
	type FilterInterpolator,
	resolveBlendSourcePath,
	resolveBlendSpinePath,
} from "../../../utils/geometry/blendInterpolation";
import {
	calculatePathBounds,
	type WorldBBox,
} from "../../../utils/geometry/bounds";
import { composeTransforms } from "../../../utils/geometry/geometry";
import { type Mat4, mat4TransformPoint } from "../../../utils/geometry/mat4";
import {
	computeQuadProjectiveWeights,
	quadOfBounds,
} from "../../../utils/geometry/quadProjection";
import { groupRingsByContainment } from "../../../utils/geometry/ringContainment";
import {
	appendSubpath,
	reconstructSegmentsFromWorld,
	toWorldPath,
	transformSegmentsToWorld,
} from "../../../utils/geometry/segmentOps";
import { neverReached } from "../../../utils/lang";
import {
	aabbOfQuad,
	splitIntoSubPaths,
} from "../../canvas/CanvasLayer.helpers";
import type { BlitLayer, BlitUVRect } from "../../canvas/CanvasLayerTypes";
import {
	type AppearanceCache,
	type AppearanceCacheEntry,
	instanceAppearanceUid,
} from "../../canvas/caches/AppearanceCache";
import type { CompoundPathCache } from "../../canvas/caches/CompoundPathCache";
import { buildTextGeometry } from "../../canvas/elements/textGeometry";
import type {
	BackdropEffectCoordinator,
	BackdropEffectRequest,
} from "../../canvas/pipeline/BackdropEffectCoordinator";
import type {
	BackdropEffectDriver,
	FilterGeometryContext,
	FilterRenderer,
	UnderlayCoverage,
	UnderlayResult,
} from "../../canvas/pipeline/FilterRenderer";
import { resolveRenderConfigure } from "../../canvas/pipeline/FilterRenderer";
import { collectGroupSegments } from "../../canvas/pipeline/GroupAppearanceCollector";
import type { MeshPassRenderer } from "../../canvas/pipeline/MeshPassRenderer";
import {
	applyPreFilters,
	resolveElementGeometry,
} from "../../canvas/pipeline/PreFilterRenderer";
import {
	createBorrowedTextureRef,
	createRenderSurface,
	type RasterizedRenderSurface,
	type TextureRef,
} from "../../canvas/pipeline/RenderSurface";
import type { TexturePool } from "../../canvas/pipeline/TexturePool";
import type { GPUTimingProfiler } from "../../GPUTimingProfiler";
import { applyCornerRadius } from "../../generators/CornerRadiusProcessor";
import { flattenBezierPath } from "../../geometry/bezierFlatten";
import {
	type ExtrudeMeshBaker,
	type ExtrudeOutline,
	extrudeNeedsBackdrop,
	type ScopedAppearanceCache,
} from "./ExtrudeMeshBaker";
import type { RefractionCompositor } from "./RefractionCompositor";

/** Frame-local extrusion render result, blitted during the main pass. */
export interface ExtrudeFrameEntry {
	texture: TextureRef;
	/** Projected bounds of the rotated solid in the element's untransformed
	 *  space (blit destination when no element transform applies). */
	bounds: {
		minX: number;
		minY: number;
		maxX: number;
		maxY: number;
		width: number;
		height: number;
	};
	/**
	 * Blit corners (TL → TR → BR → BL, world space) with the element's
	 * composed transform applied — present when the transform is not
	 * identity. Keeps the 3D result following element/group moves exactly
	 * like the GPU-transformed fill/stroke geometry.
	 */
	quad?: readonly [
		{ x: number; y: number },
		{ x: number; y: number },
		{ x: number; y: number },
		{ x: number; y: number },
	];
	/** Used sub-rect of the pool-quantized texture. */
	uvRect: BlitUVRect;
	/**
	 * Content hash of everything this bake was produced from (mesh geometry +
	 * render params + the element's paint). Lets a consumer that derives its
	 * own cached artifact from the bake (the coverage-driven drop shadow) key
	 * on the bake generation without re-deriving those inputs.
	 */
	contentHash: string;
	/**
	 * Glass distortion: the screen-space normal MRT + refraction params. When
	 * present, the element is composited post-pass by the refraction compositor
	 * (needs the backdrop). Produced for any glass material; rotated glass
	 * refracts through its projected quad.
	 */
	refraction?: {
		normalTexture: TextureRef;
		refractScale: number;
		aberration: number;
		/**
		 * Backdrop blur radius in WORLD px. The compositor converts it to
		 * capture texels with the capture's actual texels-per-world-px, so the
		 * blur covers the same world distance at every viewport zoom and at
		 * every export scale.
		 */
		blurWorld: number;
	};
}

interface ExtrudeRendererDeps {
	device: GPUDevice;
	texturePool: TexturePool;
	/** Engine appearance cache (RenderCacheManager.appearance). */
	appearanceCache: AppearanceCache;
	filterRenderer: FilterRenderer;
	/** The 3D solid processor this driver serves ("extrude3d" / "revolve3d") —
	 *  each handler owns one driver per canvas, scoped to its own appearances. */
	processor: string;
	/** Child → parent group mapping (from ViewportManager). */
	getParentGroupMap: () => ReadonlyMap<string, string>;
	/** CompoundPath resolver used by group flattening (RenderCacheManager.compoundPath). */
	compoundPathCache: CompoundPathCache;
	/**
	 * Rasterize an element (a fill-only temp path, or a temp group wrapping
	 * the real children) into an offscreen texture covering `textureBounds`.
	 * Generic OffscreenPresenter method — the extrude renderer only supplies
	 * the temp element it wants baked.
	 */
	renderElementToTexture: (
		encoder: GPUCommandEncoder,
		element: AnyArtObject,
		textureBounds: WorldBBox,
		elementsMap: Map<string, AnyArtObject> | undefined,
		rasterScale: number,
	) => RasterizedRenderSurface | null;
	/**
	 * Resolve a pattern def to its tiled GPU texture (one seamless tile) and
	 * world-unit tile size. Used for the material surface pattern. Null when the
	 * def is missing/cold. From CanvasLayer.resolvePatternTexture.
	 */
	resolvePatternTexture: (defId: string) => {
		texture: GPUTexture;
		tileWorldSize: { width: number; height: number };
		revision: number;
	} | null;
	/** Synchronous glyph-outline cache lookup for a Text element; null on a
	 *  cache miss. From CanvasLayer.resolveTextOutline. */
	resolveTextOutline: (
		element: TextElement,
	) => { paths: Path[]; localBounds: BoundingBox } | null;
	/** Fire-and-forget: warm the glyph-outline cache for a later frame. */
	requestTextOutline: (element: TextElement) => void;
	/** Whether an embedded image file's GPU texture has finished decoding. */
	isImageReady: (fileUid: string) => boolean;
	/** Shared lit-mesh pass + baker (owned by the handler, injected here). */
	meshPass: MeshPassRenderer;
	baker: ExtrudeMeshBaker;
	/** Composite-time glass refraction (warps the backdrop under the solid). */
	refractionCompositor: RefractionCompositor;
	/** Shared backdrop capture/pyramid service (owned by the CanvasLayer). */
	backdropEffectCoordinator: BackdropEffectCoordinator;
	/** Defer a frame-local texture's destruction to a GPU-safe point. */
	deferDestroy: (texture: GPUTexture) => void;
}

/**
 * Glass-extrude pre-pass driver. For every *glass* (backdrop-warping)
 * extrude3d appearance it runs the shared ExtrudeMeshBaker before the main
 * pass, producing frame-local refraction entries the compositor later warps
 * at the element's z-order. Opaque extrudes do NOT go through here — they
 * render via Extrude3DFilterHandler.postProcess. (This module also exports the
 * outline/projection helpers both paths share.) Frame textures return to the
 * TexturePool after the frame.
 */
export class ExtrudeAppearanceRenderer implements BackdropEffectDriver {
	/** This frame's baked glass solids grouped by element id. A plain
	 *  path/group/text keeps one entry; an all-glass blend keeps one per
	 *  interpolated instance (key + intermediate), composited in that order. */
	private readonly elementEntries = new Map<string, ExtrudeFrameEntry[]>();
	private frameTextures: GPUTexture[] = [];
	/** Glass entries already composited inline at their z-order this frame, so
	 *  flushRemaining doesn't compose them again. */
	private readonly inlineComposedRefractions = new Set<ExtrudeFrameEntry>();
	/** This frame's backdrop request per glass entry — the same object handed
	 *  to the coordinator's planFrame, so acquireSample can match it. */
	private readonly frameRequests = new Map<
		ExtrudeFrameEntry,
		BackdropEffectRequest
	>();
	/** Coverage-driven underlays (drop shadows) per element: the layers to draw
	 *  under the glass composite — cache-owned textures, never released per
	 *  frame — plus any filter that declined to produce one and must therefore
	 *  fall back to the ordinary post-composite chain. */
	private readonly elementUnderlays = new Map<
		string,
		{ layers: UnderlayResult[]; fallbackFilters: Filter[] }
	>();
	/** Appearance uids each element's underlays were last cached under, so a
	 *  frame that stops producing one releases its texture. Spans frames — do
	 *  NOT clear it per frame. */
	private readonly underlayUids = new Map<string, Set<string>>();

	public constructor(private readonly deps: ExtrudeRendererDeps) {}

	/** Reset per-frame compositor pools and inline-composed tracking. */
	public beginFrame(): void {
		this.deps.refractionCompositor.beginFrame();
		this.inlineComposedRefractions.clear();
		this.frameRequests.clear();
		this.elementUnderlays.clear();
	}

	/**
	 * Encode a glass-refraction pre-pass for every visible element carrying an
	 * enabled *glass* extrude3d appearance (bakeAppearance(glassOnly=true)
	 * skips opaque ones — those go through postProcess). Call before the main
	 * pass, on the same encoder. `elementsMap` must be the override-merged
	 * frame view so tool drag previews and ancestor group transforms show.
	 *
	 * `backdropScale` is the backdrop capture's texels per world px (device
	 * pixels per world px for the on-screen canvas, the export raster scale
	 * when exporting). Glass blur is authored in world px, so this is what
	 * turns it into the capture-texel sigma the coordinator plans against.
	 */
	public prepareFrame(
		encoder: GPUCommandEncoder,
		elementsMap: Map<string, AnyArtObject>,
		dpiScale: number,
		backdropScale: number,
		profiler?: GPUTimingProfiler | null,
		filter?: ReadonlySet<string>,
	): void {
		// Elements absorbed as blend keys never render standalone — the blend
		// renders them (per-instance below). Skip them here so a glass key isn't
		// baked twice (once as itself, once inside its blend) and double-stacked.
		const blendMemberIds = new Set<string>();
		for (const element of elementsMap.values()) {
			if (element.type === "blend") {
				for (const id of element.objectIds) blendMemberIds.add(id);
			}
		}
		// Every element the driver considered this frame, entries or not. The
		// underlay sync below walks THIS, not elementEntries: an element that
		// stopped producing glass still has to release the shadow it cached.
		const scanned: AnyArtObject[] = [];
		for (const element of elementsMap.values()) {
			if (
				element.visible === false ||
				!hasEnabledSolidAppearance(element, this.deps.processor)
			) {
				continue;
			}
			// Export/copy: skip front (non-target) solids so they never bake into
			// the shared frame textures the export samples.
			if (filter && !filter.has(element.id)) continue;
			if (blendMemberIds.has(element.id)) continue;
			scanned.push(element);
			// A blend with any glass instance bakes one solid per interpolated
			// instance so each carries its own depth/rotation/material (opaque
			// instances composite as zero-warp solids); plain elements — and a
			// blend whose instances don't resolve — bake one combined solid.
			if (
				element.type === "blend" &&
				this.prepareBlendInstances(
					encoder,
					element,
					elementsMap,
					dpiScale,
					profiler,
				)
			) {
				continue;
			}
			this.prepareSingleSolid(
				encoder,
				element,
				elementsMap,
				dpiScale,
				profiler,
			);
		}

		// Declare every glass entry's backdrop need up front so the coordinator
		// can batch compatible captures into one shared pyramid. The request
		// objects are keyed per entry — refractOne passes the same reference
		// back to acquireSample.
		for (const element of scanned) {
			const glassEntries = (this.elementEntries.get(element.id) ?? []).filter(
				(
					entry,
				): entry is ExtrudeFrameEntry & {
					refraction: NonNullable<ExtrudeFrameEntry["refraction"]>;
				} => entry.refraction !== undefined,
			);
			// Coverage-driven downstream filters (drop shadow) build their own
			// cached, world-placed texture from the solid's alpha before the
			// capture is planned — they neither read the backdrop nor need it
			// captured over their spread, so they stay out of the expansion.
			// Runs even with no glass entries left: that transition (glass turned
			// opaque, a blend emptied) is exactly when the cached shadows have to
			// be released.
			this.syncUnderlays(encoder, element, glassEntries, dpiScale, profiler);
			if (glassEntries.length === 0) continue;
			const bounds = unionEntryBounds(glassEntries);
			const downstreamFilters = this.getDownstreamFilters(element).chained;
			const downstreamExpansion =
				downstreamFilters.length === 0
					? 0
					: this.deps.filterRenderer.calculateExpansion(downstreamFilters, {
							width: bounds.width,
							height: bounds.height,
						});
			const request: BackdropEffectRequest = {
				bounds: expandBounds(bounds, downstreamExpansion),
				blurSigma:
					Math.max(...glassEntries.map((entry) => entry.refraction.blurWorld)) *
					backdropScale,
			};
			for (const entry of glassEntries) this.frameRequests.set(entry, request);
		}
		// An element can also leave this driver's sight entirely — its 3D
		// appearance removed or disabled — which the per-element sync above can
		// no longer reach. Skipped while an element filter is active: an export
		// legitimately renders a subset, and dropping the rest's shadows would
		// only make the next live frame rebuild them.
		if (!filter) {
			const scannedIds = new Set(scanned.map((element) => element.id));
			for (const elementId of [...this.underlayUids.keys()]) {
				if (!scannedIds.has(elementId)) {
					this.releaseUnusedUnderlays(elementId, new Set());
				}
			}
		}
		this.deps.backdropEffectCoordinator.planFrame([
			...new Set(this.frameRequests.values()),
		]);
	}

	/**
	 * Bake one combined glass solid for an element (one entry per enabled
	 * extrude3d appearance). Used for plain elements and for blends not rendered
	 * per-instance (mixed glass/opaque). Opaque appearances are skipped by
	 * bakeAppearance(glassOnly=true) — they render via the postProcess path.
	 */
	private prepareSingleSolid(
		encoder: GPUCommandEncoder,
		element: AnyArtObject,
		elementsMap: Map<string, AnyArtObject>,
		dpiScale: number,
		profiler?: GPUTimingProfiler | null,
	): void {
		const { meshPass, baker } = this.deps;
		const apps = (element.filters ?? []).filter(
			(f) => f.processor === this.deps.processor && isFilterEnabled(f),
		);
		const geom = this.geometryContext(element, elementsMap);
		const outline = baker.buildOutline(geom);
		if (!outline) return;
		const cache = this.scopedCache(element.id);
		for (const app of apps) {
			const entry = baker.bakeAppearance(
				encoder,
				meshPass,
				app,
				outline,
				geom,
				cache,
				dpiScale,
				this.frameTextures,
				// Opaque extrudes render via the postProcess path; skip them.
				true,
				// Cache this appearance's bake output across frames (glass only —
				// backdrop compositing stays live per-frame regardless via
				// refractOne, so caching the backdrop-independent bake can't go
				// stale). bakeAppearance owns pushing into `sink`
				// (=this.frameTextures) for whatever it newly creates or replaces;
				// a cache-hit texture must NOT be pushed here, since releasing it
				// this frame would let some unrelated bake grab the same texture
				// from the pool while this entry still points to it.
				true,
				false,
				profiler,
			);
			if (entry) this.addFrameEntry(element.id, entry);
		}
	}

	/**
	 * Bake one solid per interpolated blend instance (key + intermediate), each
	 * at its own depth/rotation and its own interpolated material — the
	 * glass-driver analogue of Extrude3DFilterHandler.bakeBlendInstances (opaque
	 * path). Taken whenever ANY instance is glass: non-distorting instances of a
	 * mixed blend bake with a forced normal MRT and composite as zero-warp
	 * solids through the same backdrop path, so every instance keeps its own
	 * (interpolated) material and the flat blend paint order. Returns false
	 * (caller falls back to the single combined-outline solid) only when no
	 * instance resolves.
	 */
	private prepareBlendInstances(
		encoder: GPUCommandEncoder,
		blend: BlendObject,
		elementsMap: Map<string, AnyArtObject>,
		dpiScale: number,
		profiler?: GPUTimingProfiler | null,
	): boolean {
		const { meshPass, baker, filterRenderer, processor } = this.deps;
		const glassApp = (blend.filters ?? []).find(
			(f) =>
				f.processor === processor &&
				isFilterEnabled(f) &&
				extrudeNeedsBackdrop(
					(f.paramData.params as Solid3DBaseParams).material,
				),
		);
		if (!glassApp) return false;
		const instances = collectBlendExtrudeInstances(
			blend,
			elementsMap,
			filterRenderer,
			processor,
		);
		if (instances.length === 0) return false;
		const cache = this.scopedCache(blend.id);
		// Lowering the blend's step count leaves the dropped instances' bakes in
		// the cache — nothing asks for their uid again, and stale-entry pruning
		// only looks at whether the BLEND still exists.
		cache.pruneInstances?.(glassApp.uid, instances.length);
		const baseGeom = this.geometryContext(blend, elementsMap);
		instances.forEach((instance, i) => {
			// Synthetic per-instance path: its own flat fill/stroke (no extrude3d)
			// bakes this instance's albedo; the mesh outline/params come from the
			// instance itself (already world-folded, so worldSpace: true).
			const tempPath: Path = {
				type: "path",
				id: `${blend.id}:instance-${i}`,
				opacity: 1,
				blendMode: "normal",
				transform: createIdentityTransform(),
				segments: instance.flatSegments,
				filters: instance.filters,
			};
			const geom: FilterGeometryContext = { ...baseGeom, element: tempPath };
			const outline: ExtrudeOutline = {
				segments: instance.segments,
				flatSegments: instance.flatSegments,
				worldSpace: true,
			};
			const instanceFilter: Filter = {
				...glassApp,
				uid: instanceAppearanceUid(glassApp.uid, i),
				paramData: { ...glassApp.paramData, params: instance.params },
			};
			const entry = baker.bakeAppearance(
				encoder,
				meshPass,
				instanceFilter,
				outline,
				geom,
				cache,
				dpiScale,
				this.frameTextures,
				// Not glassOnly: opaque instances of a mixed blend bake too, with a
				// forced normal MRT so they composite (zero-warp) through the same
				// backdrop path in paint order.
				false,
				true,
				true,
				profiler,
			);
			if (entry) this.addFrameEntry(blend.id, entry);
		});
		return true;
	}

	/** Assemble the geometry context the baker needs from the element + deps. */
	private geometryContext(
		element: AnyArtObject,
		elementsMap: Map<string, AnyArtObject>,
	): FilterGeometryContext {
		return {
			element,
			elementsMap,
			compoundPathCache: this.deps.compoundPathCache,
			getParentGroupMap: this.deps.getParentGroupMap,
			resolvePatternTexture: this.deps.resolvePatternTexture,
			renderElementToTexture: this.deps.renderElementToTexture,
			texturePool: this.deps.texturePool,
			resolveTextOutline: this.deps.resolveTextOutline,
			requestTextOutline: this.deps.requestTextOutline,
			isImageReady: this.deps.isImageReady,
		};
	}

	/** The engine AppearanceCache pre-bound to one element's id. */
	private scopedCache(elementId: string): ScopedAppearanceCache {
		const cache = this.deps.appearanceCache;
		return {
			get: (uid) => cache.get(elementId, uid),
			set: (uid, entry) => cache.set(elementId, uid, entry),
			pruneInstances: (baseUid, liveCount) =>
				cache.pruneInstances(elementId, baseUid, liveCount),
		};
	}

	/** Record one baked glass solid under its owning element id (blend instances
	 *  accumulate in emit order). */
	private addFrameEntry(elementId: string, entry: ExtrudeFrameEntry): void {
		let list = this.elementEntries.get(elementId);
		if (!list) {
			list = [];
			this.elementEntries.set(elementId, list);
		}
		list.push(entry);
	}

	/** This frame's baked glass solids for one element (empty when none). A
	 *  plain path/group/text keeps one; an all-glass blend keeps one per
	 *  interpolated instance, in emit (paint) order. */
	public getFrameEntries(elementId: string): ExtrudeFrameEntry[] {
		return this.elementEntries.get(elementId) ?? [];
	}

	/**
	 * Forget this frame's entries for the given elements.
	 *
	 * Baking is a side effect of drawing, and some draws are not part of the
	 * document — rendering mask content into the mask atlas bakes its solids
	 * just like a normal draw would. Left in place, `flushRemaining` would then
	 * composite them onto the canvas at frame end, so a 3D solid used purely as
	 * a mask would also appear as an object.
	 */
	public discardFrameEntries(elementIds: ReadonlySet<string>): void {
		for (const id of elementIds) {
			this.elementEntries.delete(id);
			this.elementUnderlays.delete(id);
		}
	}

	/**
	 * The element's baked glass solids as plain blit layers: the lit surface,
	 * with the refraction dropped.
	 *
	 * Refraction reads the document composited so far, and a mask is built
	 * before the thing it masks is drawn, so that input does not exist yet. Nor
	 * would it help: a mask uses luminance only, so refracted background would
	 * open the mask where the background happens to be bright — driving it by
	 * something that has nothing to do with the shape. The lit surface is
	 * backdrop-independent and is the coverage a mask is asking for.
	 */
	public backdropFreeLayers(element: AnyArtObject): BlitLayer[] {
		return this.findGlassRefractionEntries(element).map((entry) =>
			createRenderSurface(
				entry.texture,
				entry.quad
					? {
							kind: "world-quad",
							bounds: entry.bounds,
							quad: entry.quad,
							uvRect: entry.uvRect,
						}
					: {
							kind: "world-aabb",
							bounds: entry.bounds,
							uvRect: entry.uvRect,
						},
				{
					role: "color",
					alphaMode: "premultiplied",
					opacityState: "intrinsic",
				},
			),
		);
	}

	/** Frame entries carrying glass distortion (composited post-pass). */
	public getRefractionEntries(): ExtrudeFrameEntry[] {
		const result: ExtrudeFrameEntry[] = [];
		for (const list of this.elementEntries.values()) {
			for (const entry of list) if (entry.refraction) result.push(entry);
		}
		return result;
	}

	/** Return the frame's textures to the pool. Call after the frame's passes.
	 *  The underlay layers are dropped alongside the entries they came from,
	 *  but never released — their textures belong to the appearance cache. */
	public releaseFrame(release: (texture: GPUTexture) => void): void {
		for (const texture of this.frameTextures) release(texture);
		this.frameTextures = [];
		this.elementEntries.clear();
		this.elementUnderlays.clear();
	}

	/** Union each of the element's baked solids' projected bounds via `union`
	 *  (for viewport culling). No-op when the element has no baked solids. */
	public unionSolidBounds(
		element: AnyArtObject,
		union: (b: {
			minX: number;
			minY: number;
			maxX: number;
			maxY: number;
		}) => void,
	): void {
		for (const entry of this.getFrameEntries(element.id)) {
			union(entry.quad ? aabbOfQuad(entry.quad) : entry.bounds);
		}
	}

	/** Whether the element has a glass extrude to composite inline at its
	 *  z-order (the caller ends its pass and calls composeInline). */
	public hasInlineComposite(element: AnyArtObject): boolean {
		return this.findGlassRefractionEntries(element).length > 0;
	}

	/**
	 * Compose the element's glass extrude(s) over `targetTexture` at its z-order,
	 * and mark them so flushRemaining skips them. A blend contributes one entry
	 * per interpolated instance, composited in emit (paint) order so overlapping
	 * instances refract through each other correctly. The caller must have ended
	 * its active render pass first (refractOne opens its own).
	 */
	public composeInline(
		element: AnyArtObject,
		encoder: GPUCommandEncoder,
		targetTexture: GPUTexture,
		viewport: Viewport,
		width: number,
		height: number,
		profiler?: GPUTimingProfiler | null,
		renderToSeparateTexture = false,
	): BlitLayer | void {
		const entries = this.findGlassRefractionEntries(element);
		const prepared = this.elementUnderlays.get(element.id);
		const underlays = prepared?.layers ?? [];
		const downstreamFilters = [
			...(prepared?.fallbackFilters ?? []),
			...this.getDownstreamFilters(element).chained,
		];
		// Composing straight onto the target is cheaper, but leaves the caller
		// nothing to post-process: the pixels are already on the canvas by the
		// time it gets control back. An underlay needs the same room — it goes
		// UNDER the glass, and on the canvas the glass is already final.
		if (
			downstreamFilters.length === 0 &&
			underlays.length === 0 &&
			!renderToSeparateTexture
		) {
			for (const entry of entries) {
				this.refractOne(
					entry,
					encoder,
					targetTexture,
					targetTexture.createView(),
					true,
					viewport,
					width,
					height,
					profiler,
				);
				this.inlineComposedRefractions.add(entry);
			}
			return;
		}

		const filteredGlass = this.deps.texturePool.acquire(
			width,
			height,
			targetTexture.format,
			1,
			GPUTextureUsage.RENDER_ATTACHMENT |
				GPUTextureUsage.TEXTURE_BINDING |
				GPUTextureUsage.COPY_SRC |
				GPUTextureUsage.COPY_DST,
			"Filtered Glass Composite",
		);
		this.frameTextures.push(filteredGlass);
		// Coverage side-channel: where the glass REPLACED the backdrop.
		// Downstream filters redistribute the glass light but not the
		// replacement region, so this stays untouched by them and rides to
		// the final composite (BlitLayer.coverage), which punches the canvas
		// by it instead of keying on the filtered alpha.
		const glassCoverage = this.deps.texturePool.acquire(
			width,
			height,
			targetTexture.format,
			1,
			GPUTextureUsage.RENDER_ATTACHMENT |
				GPUTextureUsage.TEXTURE_BINDING |
				GPUTextureUsage.COPY_SRC |
				GPUTextureUsage.COPY_DST,
			"Glass Coverage",
		);
		this.frameTextures.push(glassCoverage);
		// Multi-entry batches compose against a private copy of the canvas so
		// a later instance refracts the earlier ones (refractOne's noteDraw
		// makes the coordinator recapture between entries, exactly like the
		// direct route on the real canvas); the union coverage then cuts the
		// glass-only content back out for the downstream filters. A single
		// entry composes straight into filteredGlass — identical output,
		// without the copy or the cut-out's fringe cost. Exact-size texture:
		// the capture path samples the backdrop in canvas-normalized uv, so a
		// pool-quantized (larger) texture would land the samples off-target.
		const virtualBackdrop =
			entries.length > 1
				? this.deps.device.createTexture({
						label: "Glass Virtual Backdrop",
						size: { width, height },
						format: targetTexture.format,
						usage:
							GPUTextureUsage.RENDER_ATTACHMENT |
							GPUTextureUsage.TEXTURE_BINDING |
							GPUTextureUsage.COPY_SRC |
							GPUTextureUsage.COPY_DST,
					})
				: null;
		if (virtualBackdrop) {
			this.frameTextures.push(virtualBackdrop);
			this.deps.refractionCompositor.copyRegion(
				encoder,
				targetTexture,
				virtualBackdrop.createView(),
				width,
				height,
			);
		}
		const composeTexture = virtualBackdrop ?? filteredGlass;
		let composedAny = false;
		for (const entry of entries) {
			// `composedAny` (before this entry) rather than the entry index:
			// when an earlier entry declines (off-screen sample), the first
			// compose that does run must still clear the pool textures.
			composedAny =
				this.refractOne(
					entry,
					encoder,
					virtualBackdrop ?? targetTexture,
					composeTexture.createView(),
					virtualBackdrop != null || composedAny,
					viewport,
					width,
					height,
					profiler,
					{ view: glassCoverage.createView(), load: composedAny },
				) || composedAny;
			this.inlineComposedRefractions.add(entry);
		}
		// Every compose declined — the solids are off screen, so acquireSample had
		// no region to give them. Only a compose clears this texture, so it still
		// holds whatever the pool last left there. Returning it would blit that
		// onto the canvas, invisibly while the pool is cold and as a ghost of an
		// unrelated element once it is warm.
		if (!composedAny) return;
		if (virtualBackdrop) {
			this.deps.refractionCompositor.cutOutCoverage(
				encoder,
				virtualBackdrop,
				glassCoverage,
				filteredGlass.createView(),
				width,
				height,
			);
		}
		// Slide the cached underlays in beneath the glass content, giving
		// "element OVER shadow" from a texture that only spans the shadow's own
		// bounds and only changes when the solid does.
		for (const underlay of underlays) {
			this.deps.refractionCompositor.blitUnderlay(
				encoder,
				filteredGlass.createView(),
				width,
				height,
				underlay,
				viewport,
			);
		}
		if (downstreamFilters.length > 0) {
			this.deps.filterRenderer.applyFilters(
				filteredGlass,
				downstreamFilters,
				encoder,
				undefined,
				viewport.zoom,
			);
		}

		const worldWidth = width / viewport.zoom;
		const worldHeight = height / viewport.zoom;
		const bounds = {
			minX: viewport.x - worldWidth / 2,
			minY: viewport.y - worldHeight / 2,
			maxX: viewport.x + worldWidth / 2,
			maxY: viewport.y + worldHeight / 2,
			width: worldWidth,
			height: worldHeight,
		};
		return {
			...createRenderSurface(
				createBorrowedTextureRef(filteredGlass, "external"),
				{
					kind: "world-aabb",
					bounds,
					uvRect: {
						minU: 0,
						minV: 0,
						maxU: width / filteredGlass.width,
						maxV: height / filteredGlass.height,
					},
				},
				{
					role: "color",
					alphaMode: "premultiplied",
					opacityState: "intrinsic",
				},
			),
			coverage: createBorrowedTextureRef(glassCoverage, "external"),
		};
	}

	/**
	 * Fallback for glass extrudes not composed inline at their z-order (a
	 * render path without a composite context). Runs after the document pass,
	 * so these still land on top — but the common paths handle refraction
	 * inline (see composeInline), and `inlineComposedRefractions` prevents any
	 * double compose.
	 */
	public flushRemaining(
		encoder: GPUCommandEncoder,
		prebufTexture: GPUTexture,
		viewport: Viewport,
		width: number,
		height: number,
		profiler?: GPUTimingProfiler | null,
	): void {
		for (const entry of this.getRefractionEntries()) {
			if (!entry.refraction) continue;
			if (this.inlineComposedRefractions.has(entry)) continue;
			this.refractOne(
				entry,
				encoder,
				prebufTexture,
				prebufTexture.createView(),
				true,
				viewport,
				width,
				height,
				profiler,
			);
		}
	}

	/**
	 * The element's glass-distortion extrude frame entries (those whose material
	 * needs the backdrop), in emit order. One for a plain path/group/text; one
	 * per interpolated instance for an all-glass blend. Empty when none.
	 */
	private findGlassRefractionEntries(
		element: AnyArtObject,
	): ExtrudeFrameEntry[] {
		return this.getFrameEntries(element.id).filter((e) => e.refraction);
	}

	/**
	 * The filters stacked after the glass appearance, split by how they can be
	 * evaluated.
	 *
	 * `underlay` holds AT MOST the FIRST filter, and only when it can build
	 * itself from the solid's coverage alone (drop shadow). Every later filter
	 * stays in `chained`, because the chain is sequential: a second drop shadow
	 * is cast by the alpha of "solid over the first shadow", not by the solid
	 * again. By the time `chained` runs, the first shadow is already composited
	 * into the glass texture it reads, so that stacking still holds.
	 */
	private getDownstreamFilters(element: AnyArtObject): {
		underlay: Filter[];
		chained: Filter[];
	} {
		const appearanceIndex =
			element.filters?.findIndex(
				(filter) =>
					filter.processor === this.deps.processor &&
					isFilterEnabled(filter) &&
					resolveRenderConfigure(
						this.deps.filterRenderer.getHandler(filter.processor),
						filter,
					).needsBackdrop,
			) ?? -1;
		if (appearanceIndex < 0) return { underlay: [], chained: [] };

		const downstream = (element.filters ?? [])
			.slice(appearanceIndex + 1)
			.filter((filter) => {
				if (!isFilterEnabled(filter)) return false;
				const handler = this.deps.filterRenderer.getHandler(filter.processor);
				return (
					!!handler?.postProcess &&
					!resolveRenderConfigure(handler, filter).needsBackdrop
				);
			});
		const leadsWithUnderlay =
			downstream.length > 0 &&
			!!this.deps.filterRenderer.getHandler(downstream[0].processor)
				?.postProcessUnderlay;
		return {
			underlay: leadsWithUnderlay ? downstream.slice(0, 1) : [],
			chained: leadsWithUnderlay ? downstream.slice(1) : downstream,
		};
	}

	/**
	 * Bring this element's coverage-driven underlays up to date for the frame.
	 *
	 * The glass composite is rebuilt every frame because the backdrop under it
	 * moves, but a drop shadow depends only on the solid's silhouette — so it
	 * is derived from the bake's coverage mask instead of the composite, at
	 * the document rasterization scale, and cached in the AppearanceCache.
	 * Panning and zooming then cost nothing here; only a changed shape, 3D
	 * projection, shadow setting or rasterization DPI regenerates it.
	 *
	 * Because those textures are cache-owned and keyed by appearance uid, the
	 * frame that STOPS producing one has to say so — turning the glass opaque,
	 * disabling the shadow or emptying a blend all leave a live element holding
	 * an unreachable texture otherwise. Hence the uid bookkeeping: whatever was
	 * written last frame and is not rewritten now is released.
	 */
	private syncUnderlays(
		encoder: GPUCommandEncoder,
		element: AnyArtObject,
		glassEntries: readonly (ExtrudeFrameEntry & {
			refraction: NonNullable<ExtrudeFrameEntry["refraction"]>;
		})[],
		dpiScale: number,
		profiler?: GPUTimingProfiler | null,
	): void {
		const { underlay } = this.getDownstreamFilters(element);
		const cache = this.deps.appearanceCache;
		if (underlay.length === 0 || glassEntries.length === 0) {
			this.releaseUnusedUnderlays(element.id, new Set());
			return;
		}

		const scoped = {
			get: (uid: string) => cache.get(element.id, uid),
			set: (uid: string, entry: AppearanceCacheEntry) =>
				cache.set(element.id, uid, entry),
		};
		const written = new Set<string>();
		const layers: UnderlayResult[] = [];
		const declined = new Set<Filter>();
		glassEntries.forEach((entry, index) => {
			const coverage: UnderlayCoverage = {
				// The normal MRT's alpha IS the solid's coverage, and unlike the
				// composite's alpha it does not depend on what is behind the glass.
				texture: entry.refraction.normalTexture.texture,
				uvRect: entry.uvRect,
				quad: entry.quad ?? quadOfBounds(entry.bounds),
			};
			for (const filter of underlay) {
				const handler = this.deps.filterRenderer.getHandler(filter.processor);
				const instanceFilter =
					index === 0
						? filter
						: { ...filter, uid: instanceAppearanceUid(filter.uid, index) };
				const result = handler?.postProcessUnderlay?.(
					{
						device: this.deps.device,
						commandEncoder: encoder,
						coverage,
						rasterScale: dpiScale,
						appearanceCache: scoped,
						coverageHash: entry.contentHash,
						profiler,
					},
					// A blend contributes one entry per instance; give each its own
					// cache slot so they don't evict one another every frame.
					instanceFilter,
				);
				if (result) {
					layers.push(result);
					written.add(instanceFilter.uid);
				} else {
					declined.add(filter);
				}
			}
		});
		this.releaseUnusedUnderlays(element.id, written);
		// A filter that declined this frame still has to be drawn — hand it back
		// to the ordinary post-composite chain rather than dropping it.
		this.elementUnderlays.set(element.id, {
			layers,
			fallbackFilters: underlay.filter((filter) => declined.has(filter)),
		});
	}

	/**
	 * Destroy the underlay entries this element wrote before but did not write
	 * now. `written` is the complete set of appearance uids that are live for
	 * it this frame — an empty set releases everything.
	 */
	private releaseUnusedUnderlays(
		elementId: string,
		written: ReadonlySet<string>,
	): void {
		const previous = this.underlayUids.get(elementId);
		if (previous) {
			for (const uid of previous) {
				if (!written.has(uid)) {
					this.deps.appearanceCache.deleteEntry(elementId, uid);
				}
			}
		}
		if (written.size > 0) this.underlayUids.set(elementId, new Set(written));
		else this.underlayUids.delete(elementId);
	}

	/**
	 * Compose one glass extrude's refraction over the current backdrop. The
	 * backdrop content (sharp capture + blur pyramid levels) comes from the
	 * shared coordinator, which captured `targetTexture` out first — so
	 * read/write on the same texture is safe. Opens its own render passes, so
	 * the active pass must be ended before calling.
	 */
	private refractOne(
		entry: ExtrudeFrameEntry,
		encoder: GPUCommandEncoder,
		backdropTexture: GPUTexture,
		targetView: GPUTextureView,
		load: boolean,
		viewport: Viewport,
		width: number,
		height: number,
		profiler?: GPUTimingProfiler | null,
		coverage?: { view: GPUTextureView; load: boolean },
	): boolean {
		if (!entry.refraction) return false;
		const request = this.frameRequests.get(entry);
		if (!request) return false;
		// The solid's projected footprint: the transform quad when the element
		// carries one, the local bounds otherwise. Its AABB is what the capture
		// must cover; the quad itself carries the UV mapping. NOT request.bounds
		// — that is the capture region (the element union expanded by
		// downstream-filter margins), and remapping against it would stretch the
		// mesh over the expansion.
		const quad = entry.quad ?? quadOfBounds(entry.bounds);
		const worldBounds = entry.quad ? aabbOfQuad(entry.quad) : entry.bounds;
		const sample = this.deps.backdropEffectCoordinator.acquireSample(
			encoder,
			backdropTexture,
			viewport,
			width,
			height,
			request,
			profiler,
		);
		if (!sample) return false;

		// The compose viewport is the capture rect, which the coordinator clamps
		// to the canvas edges. The mesh is drawn as its own quad in that
		// viewport's NDC, so a partly off-screen solid keeps its true shape and
		// size (the rasterizer + scissor drop what falls outside) instead of
		// being remapped into the visible box.
		const { rect } = sample;
		const z = viewport.zoom;
		const toNdc = (point: { x: number; y: number }): [number, number] => {
			const screenX = (point.x - viewport.x) * z + width / 2;
			const screenY = height / 2 - (point.y - viewport.y) * z;
			return [
				((screenX - rect.x) / rect.width) * 2 - 1,
				1 - ((screenY - rect.y) / rect.height) * 2,
			];
		};
		const ndc = quad.map(toNdc);

		this.deps.refractionCompositor.compose(
			encoder,
			targetView,
			load,
			entry.texture.texture,
			entry.refraction.normalTexture.texture,
			sample,
			{
				refractScale: entry.refraction.refractScale,
				aberration: entry.refraction.aberration,
				meshUvRect: [
					entry.uvRect.minU,
					entry.uvRect.minV,
					entry.uvRect.maxU,
					entry.uvRect.maxV,
				],
				quadNdc: [
					[...ndc[0], ...ndc[1]],
					[...ndc[2], ...ndc[3]],
				],
				quadQ: computeQuadProjectiveWeights(quad),
			},
			profiler,
			undefined,
			coverage,
		);
		// The compose painted the glass into its region — report it so a later
		// effect reading this area recaptures (glass-over-glass keeps reading
		// the earlier glass, exactly like the per-effect capture did).
		this.deps.backdropEffectCoordinator.noteDraw(worldBounds);
		return true;
	}
}

// Helpers

function unionEntryBounds(entries: readonly ExtrudeFrameEntry[]): BoundingBox {
	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (const entry of entries) {
		const bounds = entry.quad ? aabbOfQuad(entry.quad) : entry.bounds;
		minX = Math.min(minX, bounds.minX);
		minY = Math.min(minY, bounds.minY);
		maxX = Math.max(maxX, bounds.maxX);
		maxY = Math.max(maxY, bounds.maxY);
	}
	return {
		minX,
		minY,
		maxX,
		maxY,
		width: maxX - minX,
		height: maxY - minY,
	};
}

function expandBounds(bounds: BoundingBox, margin: number): BoundingBox {
	return {
		minX: bounds.minX - margin,
		minY: bounds.minY - margin,
		maxX: bounds.maxX + margin,
		maxY: bounds.maxY + margin,
		width: bounds.width + margin * 2,
		height: bounds.height + margin * 2,
	};
}

/**
 * Whether an element carries an enabled appearance of the given 3D solid
 * processor ("extrude3d" / "revolve3d"). Used inside the glass-refraction
 * driver (which solids to bake / composite inline). NOTE: the flat
 * fill/stroke suppression in ElementRenderer/CanvasLayer is decided by the
 * processor-agnostic isElementRenderReplaced, not by this.
 */
export function hasEnabledSolidAppearance(
	element: AnyArtObject,
	processor: string,
): boolean {
	return (
		element.filters?.some(
			(f) => f.processor === processor && isFilterEnabled(f),
		) ?? false
	);
}

/**
 * The extruded solid's surface color, always taken from the element's own
 * fill: the solid fill color, or the first stop of a gradient fill. Null
 * when the element has no usable fill color.
 */
export function resolveFillBaseColor(
	filters: readonly Filter[] | undefined,
): Color | null {
	for (const filter of filters ?? []) {
		if (filter.processor !== "fill" || !isFilterEnabled(filter)) continue;
		const fill = (filter as FillAppearance).paramData.params.fill;
		if (!fill) continue;
		if (fill.type === "solid") return fill.color;
		if ("stops" in fill && fill.stops.length > 0) {
			const stop = fill.stops[0];
			if ("color" in stop) return stop.color;
		}
	}
	return null;
}

/**
 * The element's first enabled fill appearance carrying an actual fill. Used to
 * bake a non-solid fill (gradient/pattern) into a texture for the extruded
 * surface; null when there is no usable fill.
 */
export function resolveFillAppearance(
	filters: readonly Filter[] | undefined,
): FillAppearance | null {
	for (const filter of filters ?? []) {
		if (filter.processor !== "fill" || !isFilterEnabled(filter)) continue;
		const fillApp = filter as FillAppearance;
		if (fillApp.paramData.params.fill) return fillApp;
	}
	return null;
}

/**
 * The outline the extrusion sweeps for a path: its fill geometry plus, when
 * an enabled stroke appearance is present, the stroke's swept outline —
 * sub-paths offset by half the stroke width (open sub-paths become capped
 * slabs; closed ones gain an outer expansion, plus an inner counter-wound
 * hole when no fill covers the middle). Solids are normalized to CCW and
 * holes to CW so buildExtrudeMesh's dominant-winding rule unions/cuts them
 * deterministically. Without a stroke the input is returned as-is.
 */
export function buildExtrudeOutline(
	filters: readonly Filter[] | undefined,
	segments: CubicBezierSegment[],
): CubicBezierSegment[] {
	const strokeApp = resolveStrokeAppearance(filters);
	if (!strokeApp || segments.length === 0) return segments;
	const brush = strokeApp.paramData.params.brushSettings;
	const halfWidth = (readStoredBrushSize(brush) ?? 1) / 2;
	if (!(halfWidth > 0)) return segments;

	const hasFill = resolveFillAppearance(filters) !== null;
	// Stroking geometry exists only on the geometric stroke pen; stamp
	// brushes fall back to the renderer's round join/cap defaults.
	const stroking = readStoredBrushStroking(brush);
	const roundJoin = (stroking?.lineJoin ?? "round") === "round";
	const roundCap = (stroking?.lineCap ?? "round") === "round";

	// Build the painted region as flat polygons and union them with
	// polygon-clipping, which resolves self-intersection and normalizes
	// winding (outer CCW, holes CW). This avoids the offset filter's
	// stroke-unfriendly winding correction / degeneracy guards that made thick
	// strokes and round joins flip faces. A fill's own area is unioned in too,
	// so a filled+stroked shape has no interior hole; a stroke-only shape keeps
	// its middle empty (a frame), because the swept quads never cover it.
	const operands: Polygon[] = [];
	const fillRings: Ring[] = [];
	for (const sub of splitIntoSubPaths(segments)) {
		const points = flattenSubPathPoints(sub);
		if (points.length < 2) continue;
		const isClosed = sub.at(-1)?.isClosed === true;
		if (hasFill && isClosed && points.length >= 3) {
			fillRings.push(toPolygonRing(points));
		}
		appendStrokePolygons(
			points,
			isClosed,
			halfWidth,
			roundJoin,
			roundCap,
			operands,
		);
	}
	// The fill's closed sub-paths describe ONE region with holes, not a pile of
	// separate shapes. Pushing a glyph's outer and its counter in as two
	// operands unions the counter shut, which is how a stroked "o" came back
	// solid; folding the holes into their outer keeps them open.
	for (const group of groupRingsByContainment(fillRings)) {
		operands.push(group.map((index) => fillRings[index]));
	}
	if (operands.length === 0) return segments;

	// Snap to a fine grid: polygon-clipping's sweep line is not fully robust
	// to near-coincident vertices (round joins/caps overlapping the segment
	// quads throw "segment not in SweepLine tree"). Snapping turns near-misses
	// into exact coincidences the library handles.
	const snap = (poly: Polygon): Polygon =>
		poly.map((ring) =>
			ring.map(
				([x, y]) =>
					[Math.round(x * 1e3) / 1e3, Math.round(y * 1e3) / 1e3] as [
						number,
						number,
					],
			),
		);
	const snapped = operands.map(snap);

	let union: MultiPolygon;
	try {
		union = polygonClipping.union(snapped[0], ...snapped.slice(1));
	} catch {
		return segments;
	}
	return multiPolygonToSegments(union);
}

/**
 * A group's world-space extrusion outline: every descendant path's
 * fill+stroke outline (open/stroke-only children become swept slabs, so a
 * group of lines extrudes as a frame), converted to world space via
 * toWorldPath and concatenated as one multi-subpath. buildExtrudeMesh's
 * dominant-winding normalization then unions the solids and cuts the holes.
 * Each descendant path runs the same corner-radius + pre-filter pipeline a
 * top-level path extrude does (in its own local space, before the transform
 * to world), so its 3D outline matches the flat look baked as its albedo —
 * otherwise a filleted/deformed child's mesh silhouette would mismatch the
 * baked texture's, leaving a gap at the difference (e.g. a rounded corner).
 * Blend children contribute their keys' + interpolated intermediates'
 * outlines (see collectBlendExtrudeOutline); Text children contribute one
 * outline per glyph from the same cached glyph paths normal text rendering
 * uses (see collectTextExtrudeOutline). Image children have no outline and
 * are skipped.
 */
export function collectGroupExtrudeOutline(
	group: Group,
	elementsMap: Map<string, AnyArtObject>,
	compoundPathCache: CompoundPathCache,
	worldTransform: ElementTransform,
	filterRenderer: FilterRenderer,
	resolveTextOutline: (
		element: TextElement,
	) => { paths: Path[]; localBounds: BoundingBox } | null,
	requestTextOutline: (element: TextElement) => void,
): CubicBezierSegment[] {
	const result: CubicBezierSegment[] = [];
	const append = (segments: CubicBezierSegment[]): void =>
		appendSubpath(result, segments);
	const ancestor = isIdentityTransform(worldTransform)
		? undefined
		: worldTransform;
	const groupPreFilters = (group.filters ?? []).filter(
		(f) =>
			f.enabled !== false &&
			!!filterRenderer.getHandler(f.processor)?.preProcess,
	);
	const shouldUseCombinedGroupShape =
		hasGroupAppearances(group) || groupPreFilters.length > 0;

	// A group with its own fill/stroke appearances or group-level pre-filters
	// paints a COMBINED shape: children are merged into one path, then the
	// group's path-union/path-offset-style geometry filters and fill/stroke
	// apply to that combined geometry. Extrude that rendered shape instead of
	// raw child outlines.
	if (shouldUseCombinedGroupShape) {
		const combined = collectGroupSegments(
			group,
			elementsMap,
			compoundPathCache,
		);
		if (combined.length === 0) return [];
		const flat = applyPreFilters(combined, groupPreFilters, filterRenderer);
		// `combined` already has each child's own transform folded in (group-local
		// space); fold the group's own world transform on top, matching how the
		// per-child branch folds `ancestor`.
		const world = toWorldPath(
			{
				type: "path",
				id: group.id,
				opacity: 1,
				blendMode: "normal",
				segments: flat,
				transform: createIdentityTransform(),
			},
			ancestor,
		);
		append(buildExtrudeOutline(group.filters, world.segments));
		return result;
	}

	// Apply the path's own corner-radius fillet + pre-filters (zigzag, etc.)
	// in its local space, matching applyOutline's top-level path branch,
	// before transforming to world.
	const toFlatWorldPath = (
		path: Path,
		nodeTransform: ElementTransform | undefined,
	): Path => {
		const flatSegments = resolveElementGeometry(
			path.segments,
			path.filters,
			filterRenderer,
		);
		return toWorldPath({ ...path, segments: flatSegments }, nodeTransform);
	};

	const recurse = (
		node: Group,
		nodeTransform: ElementTransform | undefined,
	): void => {
		for (const childId of node.childIds) {
			if (childId === node.clipPathId) continue;
			const child = elementsMap.get(childId);
			if (!child) continue;

			switch (child.type) {
				case "path": {
					const world = toFlatWorldPath(child, nodeTransform);
					append(buildExtrudeOutline(child.filters, world.segments));
					break;
				}
				case "compound-path": {
					const pathMap = new Map<string, Path>();
					for (const source of child.sources) {
						const el = elementsMap.get(source.id);
						if (el && isPath(el)) {
							pathMap.set(source.id, toFlatWorldPath(el, nodeTransform));
						}
					}
					append(compoundPathCache.resolve(child, pathMap));
					break;
				}
				case "blend":
					append(
						collectBlendExtrudeOutline(
							child,
							elementsMap,
							nodeTransform,
							filterRenderer,
						),
					);
					break;
				case "text":
					append(
						collectTextExtrudeOutline(
							child,
							nodeTransform,
							resolveTextOutline,
							requestTextOutline,
							filterRenderer,
						),
					);
					break;
				case "group": {
					const childTransform = getTransform(child);
					const composed = nodeTransform
						? composeTransforms(nodeTransform, childTransform)
						: childTransform;
					recurse(child, isIdentityTransform(composed) ? undefined : composed);
					break;
				}
				case "image": {
					const world = toWorldPath(
						{
							...child,
							segments: buildImageRectOutline(child),
						} as unknown as Path,
						nodeTransform,
					);
					append(buildExtrudeOutline(child.filters, world.segments));
					break;
				}
				case "mesh":
				case "reference3d":
				case "repeat":
					// Not extrudable — no outline.
					break;
				default:
					neverReached(child);
			}
		}
	};

	recurse(group, ancestor);
	return result;
}

/**
 * A blend's world-space extrusion outline: each key and interpolated
 * intermediate is resolved exactly as ElementRenderer.renderBlend draws it
 * (pre-filters baked; corner-radius left as a numeric field so
 * computeBlendIntermediates can interpolate it smoothly across the blend),
 * then everything is folded into world space around the blend's OWN bbox
 * center — mirroring blendKeyOutlines, not each key's own center — so the 3D
 * outline stays aligned with the flat rendering when the blend is rotated or
 * scaled. corner-radius is realized into fillet geometry per item (key or
 * intermediate) after that fold, matching renderPath's own draw-time step.
 * Returns an empty array when fewer than two keys resolve.
 */
/** Resolved, world-folded blend items (keys + interpolated intermediates)
 *  shared by collectBlendExtrudeOutline and collectBlendExtrudeInstances. */
interface ResolvedBlendItems {
	worldKeys: Path[];
	intermediatePairs: Path[][];
}

/**
 * Resolve a blend's keys + interpolated intermediates exactly as
 * ElementRenderer.renderBlend draws them (pre-filters baked; corner-radius
 * left as a numeric field so computeBlendIntermediates can interpolate it
 * smoothly), all world-baked (toWorldPath, no ancestor) so keys and
 * intermediates share one coordinate space. When `interpolateOtherFilter` is
 * given, non-fill/stroke filters (e.g. an extrude3d appearance's
 * depth/rotation) interpolate between adjacent keys too, instead of each
 * intermediate keeping the source key's filter unchanged. Null when fewer
 * than two keys resolve.
 */
function resolveBlendItems(
	blend: BlendObject,
	elementsMap: Map<string, AnyArtObject>,
	filterRenderer: FilterRenderer,
	interpolateOtherFilter?: FilterInterpolator,
): ResolvedBlendItems | null {
	if (blend.objectIds.length < 2) return null;

	const keys: Path[] = [];
	for (const id of blend.objectIds) {
		const el = elementsMap.get(id);
		if (!el) continue;
		const resolved = resolveBlendSourcePath(el, (cid) => elementsMap.get(cid));
		if (resolved) keys.push(resolved);
	}
	if (keys.length < 2) return null;

	// Bake pre-filters (zigzag, etc.) into each key, matching
	// ElementRenderer.bakeBlendKeyDeformation.
	const deformedKeys = keys.map((key) => {
		const filters = key.filters ?? [];
		const isPreFilter = (f: Filter) =>
			!!filterRenderer.getHandler(f.processor)?.preProcess;
		const hasEnabledPreFilter = filters.some(
			(f) => f.enabled !== false && isPreFilter(f),
		);
		if (!hasEnabledPreFilter) return key;
		return {
			...key,
			segments: applyPreFilters(key.segments, filters, filterRenderer),
			filters: filters.filter((f) => !isPreFilter(f)),
		};
	});

	const spineSource = resolveBlendSpinePath(blend, (id) => elementsMap.get(id));
	const intermediatePairs = computeBlendIntermediates(
		blend,
		deformedKeys,
		spineSource,
		interpolateOtherFilter,
	);
	// computeBlendIntermediates world-bakes its own copy of each key
	// internally (toWorldPath, no ancestor) to compute intermediates; bake our
	// own copy the same way so keys and intermediates share one coordinate
	// space before the shared blend-bbox fold below.
	const worldKeys = deformedKeys.map((key) => toWorldPath(key));
	return { worldKeys, intermediatePairs };
}

/** The blend-bbox center + composed transform every item folds into world
 *  around — mirroring blendKeyOutlines, not each item's own center, so the
 *  3D outline stays aligned with the flat rendering when the blend is
 *  rotated or scaled. */
function blendWorldOrigin(
	worldKeys: Path[],
	blend: BlendObject,
	nodeTransform: ElementTransform | undefined,
): { origin: { x: number; y: number }; worldT: ElementTransform } {
	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (const key of worldKeys) {
		const b = calculatePathBounds(key);
		minX = Math.min(minX, b.minX);
		minY = Math.min(minY, b.minY);
		maxX = Math.max(maxX, b.maxX);
		maxY = Math.max(maxY, b.maxY);
	}
	const origin = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
	const blendTransform = getTransform(blend);
	const worldT = nodeTransform
		? composeTransforms(nodeTransform, blendTransform)
		: blendTransform;
	return { origin, worldT };
}

/**
 * A blend's world-space extrusion outline: every key and interpolated
 * intermediate's outline, concatenated into one multi-subpath, folded into
 * world space around the blend's own bbox center. corner-radius is realized
 * into fillet geometry per item after that fold, matching renderPath's own
 * draw-time step. Used when the whole blend extrudes as ONE solid (e.g. a
 * group ancestor's own extrude3d, which has a single depth for all its
 * children) — see collectBlendExtrudeInstances for the blend's own
 * per-instance extrude, where each item keeps its own (possibly
 * interpolated) depth. Returns an empty array when fewer than two keys
 * resolve.
 */
export function collectBlendExtrudeOutline(
	blend: BlendObject,
	elementsMap: Map<string, AnyArtObject>,
	nodeTransform: ElementTransform | undefined,
	filterRenderer: FilterRenderer,
): CubicBezierSegment[] {
	const resolved = resolveBlendItems(blend, elementsMap, filterRenderer);
	if (!resolved) return [];
	const { worldKeys, intermediatePairs } = resolved;
	const { origin, worldT } = blendWorldOrigin(worldKeys, blend, nodeTransform);

	const result: CubicBezierSegment[] = [];
	const appendItem = (
		filters: Filter[] | undefined,
		segments: PathSegment[],
	): void => {
		const worldSegments = transformSegmentsToWorld(segments, worldT, origin);
		const flat = applyCornerRadius(
			reconstructSegmentsFromWorld(worldSegments, segments),
		);
		const outline = buildExtrudeOutline(filters, flat);
		appendSubpath(result, outline);
	};

	for (const key of worldKeys) appendItem(key.filters, key.segments);
	for (const pair of intermediatePairs) {
		for (const inter of pair) appendItem(inter.filters, inter.segments);
	}
	return result;
}

/** One blend instance's (a key or an interpolated intermediate) own solid
 *  outline, flat (pre-sweep) fill/stroke source, and 3D-solid params. */
export interface BlendExtrudeInstance {
	/** Stroke-swept outline (mesh silhouette). */
	segments: CubicBezierSegment[];
	/** Flat geometry without the stroke sweep, paired with `filters` to bake
	 *  this instance's own surface (e.g. its own solid/gradient fill). */
	flatSegments: CubicBezierSegment[];
	/** This instance's own fill/stroke filters (the 3D appearance excluded). */
	filters: Filter[];
	params: Solid3DBaseParams;
}

/**
 * A standalone blend's per-instance extrusion: every key and interpolated
 * intermediate extrudes as its OWN solid, at its OWN depth/rotation/
 * perspective/bevel — interpolated between adjacent keys via the extrude3d
 * handler's onInterpolate, not a single depth applied uniformly. Each
 * instance's outline is folded into world space around the blend's own bbox
 * center (see collectBlendExtrudeOutline). Skips an item with no extrude3d
 * filter (should not happen — the blend only reaches this path because a key
 * has one, hoisted onto the blend — but a partially-stripped filters array
 * is handled gracefully). Returns an empty array when fewer than two keys
 * resolve.
 */
export function collectBlendExtrudeInstances(
	blend: BlendObject,
	elementsMap: Map<string, AnyArtObject>,
	filterRenderer: FilterRenderer,
	/** The 3D solid processor whose per-key appearances shape the instances
	 *  ("extrude3d" / "revolve3d"). */
	processor: string,
): BlendExtrudeInstance[] {
	const interpolateOtherFilter: FilterInterpolator = (a, b, t) => {
		const handler = filterRenderer.getHandler(a.processor);
		if (!handler?.onInterpolate) return a;
		return {
			...a,
			paramData: {
				...a.paramData,
				params: handler.onInterpolate(
					a.paramData.params,
					b.paramData.params,
					t,
				),
			},
		};
	};
	const resolved = resolveBlendItems(
		blend,
		elementsMap,
		filterRenderer,
		interpolateOtherFilter,
	);
	if (!resolved) return [];
	const { worldKeys, intermediatePairs } = resolved;
	// A standalone blend has no ancestor group transform of its own to fold in
	// here (the caller applies the element's own transform at blit time).
	const { origin, worldT } = blendWorldOrigin(worldKeys, blend, undefined);

	const instances: BlendExtrudeInstance[] = [];
	const addItem = (
		filters: Filter[] | undefined,
		segments: PathSegment[],
	): void => {
		const solidFilter = (filters ?? []).find(
			(f) => f.processor === processor && isFilterEnabled(f),
		);
		if (!solidFilter) return;
		const worldSegments = transformSegmentsToWorld(segments, worldT, origin);
		const flat = applyCornerRadius(
			reconstructSegmentsFromWorld(worldSegments, segments),
		);
		const outline = buildExtrudeOutline(filters, flat);
		if (outline.length === 0) return;
		instances.push({
			segments: outline,
			flatSegments: flat,
			filters: (filters ?? []).filter(
				(f) => f.processor === "fill" || f.processor === "stroke",
			),
			params: solidFilter.paramData.params as Solid3DBaseParams,
		});
	};

	// Match ElementRenderer's flat blend paint order (paintCell): iterate cells
	// in renderOrder (falling back to objectIds), and within each cell emit the
	// key followed by its trailing intermediates. The per-instance blit z-order
	// (later = on top) then equals the flat blend's, instead of "all keys, then
	// all intermediates" in objectIds order. A defensive tail emits any cell
	// missing from renderOrder so nothing is dropped if the two drift.
	const indexById = new Map(blend.objectIds.map((id, i) => [id, i]));
	const emitted = new Set<number>();
	const addCell = (i: number): void => {
		if (emitted.has(i)) return;
		emitted.add(i);
		const key = worldKeys[i];
		if (!key) return;
		addItem(key.filters, key.segments);
		for (const inter of intermediatePairs[i] ?? []) {
			addItem(inter.filters, inter.segments);
		}
	};
	for (const id of blend.renderOrder ?? blend.objectIds) {
		const i = indexById.get(id);
		if (i != null) addCell(i);
	}
	for (let i = 0; i < worldKeys.length; i++) addCell(i);
	return instances;
}

/**
 * Combine a Text element's cached glyph outlines (one Path per non-empty
 * glyph) into one multi-subpath outline in the element's own LOCAL space,
 * running the SAME pipeline `buildOutline`'s path branch runs — corner radius,
 * then the element's geometry pre-filters, then the stroke sweep — over the
 * glyphs as a single shape. The order is the point: `buildExtrudeOutline`
 * normalizes winding (solids CCW, holes CW) through polygon-clipping, so a
 * boolean pre-filter has to run BEFORE it, or its unnormalized output reaches
 * buildExtrudeMesh and glyphs wound against the majority get cut away as
 * holes.
 *
 * Returns the pre-sweep fill outline as `flatSegments` (the albedo bake's
 * source) alongside the swept `segments` (the mesh silhouette), mirroring the
 * path branch's two values.
 *
 * Pure geometry — no transform composition. A caller needing world space must
 * still fold the element's own transform afterward, and should do so ONCE
 * around the combined outline (not per glyph), so a rotated/scaled text block
 * moves as one rigid shape instead of each glyph spinning around its own
 * center.
 */
export function buildTextGlyphOutline(
	cached: { paths: Path[] },
	element: { x: number; y: number; filters?: Filter[] },
	filterRenderer: Pick<FilterRenderer, "getHandler">,
): TextGlyphOutline {
	// The stroke sweep polygon-clips every sub-path of the whole text at once,
	// which costs tens of milliseconds on a line of CJK glyphs — far too much to
	// repeat while panning, where nothing it depends on changes. Glyph cache
	// entries and filter arrays are both replaced rather than mutated, so their
	// identity is a complete content key.
	const memo = textOutlineMemo.get(cached);
	if (
		memo &&
		memo.filters === element.filters &&
		memo.x === element.x &&
		memo.y === element.y
	) {
		return memo.outline;
	}

	const outline = computeTextGlyphOutline(cached, element, filterRenderer);
	textOutlineMemo.set(cached, {
		filters: element.filters,
		x: element.x,
		y: element.y,
		outline,
	});
	return outline;
}

interface TextGlyphOutline {
	segments: CubicBezierSegment[];
	flatSegments: CubicBezierSegment[];
}

const textOutlineMemo = new WeakMap<
	object,
	{
		filters: Filter[] | undefined;
		x: number;
		y: number;
		outline: TextGlyphOutline;
	}
>();

function computeTextGlyphOutline(
	cached: { paths: Path[] },
	element: { x: number; y: number; filters?: Filter[] },
	filterRenderer: Pick<FilterRenderer, "getHandler">,
): TextGlyphOutline {
	const ox = element.x;
	const oy = element.y;
	// Corner radius and the geometry filters both run inside buildTextGeometry,
	// over the concatenated text — the same resolution the flat render uses.
	const glyphFills = cached.paths.map((glyphPath) =>
		glyphPath.segments.map((seg) => ({
			...seg,
			start: seg.start
				? { ...seg.start, x: seg.start.x + ox, y: seg.start.y + oy }
				: undefined,
			end: { ...seg.end, x: seg.end.x + ox, y: seg.end.y + oy },
		})),
	);
	const flatSegments = buildTextGeometry(
		glyphFills,
		element.filters,
		filterRenderer,
	);
	return {
		segments: buildExtrudeOutline(element.filters, flatSegments),
		flatSegments,
	};
}

/**
 * An Image element's extrusion outline: a plain rectangle spanning its own
 * width/height around its (center) x/y, in the element's own local space —
 * images carry no vector geometry of their own, so extruding one is just the
 * flat rectangular plane its texture is painted onto.
 */
export function buildImageRectOutline(element: {
	x: number;
	y: number;
	width: number;
	height: number;
}): CubicBezierSegment[] {
	const halfW = element.width / 2;
	const halfH = element.height / 2;
	return generateRectangleSegments(
		{ x: element.x - halfW, y: element.y - halfH },
		{ x: element.x + halfW, y: element.y + halfH },
	);
}

/**
 * A standalone CompoundPath's world-space fill outline: every source path is
 * folded to world via its own transform (toWorldPath) and boolean-combined,
 * exactly as normal compound-path rendering does (renderCompoundPath) — the
 * compound's own transform is ignored, since the sources already define the
 * world position. Empty when no source resolves to a path.
 */
export function collectCompoundPathFillOutline(
	compound: CompoundPath,
	elementsMap: Map<string, AnyArtObject>,
	compoundPathCache: CompoundPathCache,
): CubicBezierSegment[] {
	const pathMap = new Map<string, Path>();
	for (const source of compound.sources) {
		const el = elementsMap.get(source.id);
		if (el && isPath(el)) pathMap.set(source.id, toWorldPath(el));
	}
	if (pathMap.size === 0) return [];
	return compoundPathCache.resolve(compound, pathMap);
}

/**
 * A Text element's world-space extrusion outline: its combined glyph outline
 * (buildTextGlyphOutline) folded to world ONCE via the element's own
 * transform composed with the ancestor chain, around the combined outline's
 * own bbox center — so a rotated/scaled text block stays rigid. Returns an
 * empty array on a cache miss (font still loading) after firing
 * `requestTextOutline` to warm the cache for a later frame — the same
 * flicker-prevention gap the rest of text rendering already tolerates.
 */
function collectTextExtrudeOutline(
	element: TextElement,
	nodeTransform: ElementTransform | undefined,
	resolveTextOutline: (
		element: TextElement,
	) => { paths: Path[]; localBounds: BoundingBox } | null,
	requestTextOutline: (element: TextElement) => void,
	filterRenderer: Pick<FilterRenderer, "getHandler">,
): CubicBezierSegment[] {
	const cached = resolveTextOutline(element);
	if (!cached) {
		requestTextOutline(element);
		return [];
	}
	const local = buildTextGlyphOutline(cached, element, filterRenderer).segments;
	if (local.length === 0) return [];
	const world = toWorldPath(
		{ ...element, segments: local } as unknown as Path,
		nodeTransform,
	);
	return world.segments;
}

/** Append `segments` as a new sub-path (marking its first segment isMoved)
 *  onto `result`, in place. No-op for an empty `segments`. */
/** Compose a group's own transform with all its ancestor group transforms. */
export function composeAncestorTransform(
	element: AnyArtObject,
	elementsMap: Map<string, AnyArtObject>,
	parentGroupMap: ReadonlyMap<string, string>,
): ElementTransform {
	let transform = getTransform(element);
	let parentId = parentGroupMap.get(element.id);
	while (parentId) {
		const ancestor = elementsMap.get(parentId);
		if (ancestor)
			transform = composeTransforms(getTransform(ancestor), transform);
		parentId = parentGroupMap.get(parentId);
	}
	return transform;
}

/** The element's first enabled stroke appearance carrying a stroke color. */
function resolveStrokeAppearance(
	filters: readonly Filter[] | undefined,
): StrokeAppearance | null {
	for (const filter of filters ?? []) {
		if (filter.processor !== "stroke" || !isFilterEnabled(filter)) continue;
		const strokeApp = filter as StrokeAppearance;
		if (strokeApp.paramData.params.strokeColor) return strokeApp;
	}
	return null;
}

/**
 * Fallback surface color from the stroke when the element has no fill: the
 * solid stroke color, or the first stop of a stroke gradient.
 */
export function resolveStrokeBaseColor(
	filters: readonly Filter[] | undefined,
): Color | null {
	const strokeColor =
		resolveStrokeAppearance(filters)?.paramData.params.strokeColor;
	if (!strokeColor) return null;
	if (strokeColor.type === "solid") return strokeColor.color;
	if (strokeColor.type === "stroke-gradient") {
		return strokeColor.gradient.stops[0]?.color ?? null;
	}
	return null;
}

/** Stroke tessellation: N-gon segments for a round join/cap circle. */
const STROKE_CIRCLE_SEGMENTS = 16;

/** Flatten a sub-path to absolute points (closing duplicate dropped). */
function flattenSubPathPoints(sub: CubicBezierSegment[]): [number, number][] {
	const flat = flattenBezierPath(sub, { curveTolerance: 0.25 });
	const points: [number, number][] = [];
	for (let i = 0; i + 1 < flat.length; i += 2) {
		points.push([flat[i], flat[i + 1]]);
	}
	if (
		points.length > 1 &&
		points[0][0] === points.at(-1)![0] &&
		points[0][1] === points.at(-1)![1]
	) {
		points.pop();
	}
	return points;
}

/** A closed polygon-clipping ring from flattened points (ring auto-closes). */
function toPolygonRing(points: [number, number][]): Ring {
	return points.map(([x, y]) => [x, y] as [number, number]);
}

/**
 * Stroke a flattened polyline into filled polygons: one quad per segment plus
 * a join wedge (round = circle, otherwise a bevel triangle pair) at every
 * interior vertex, and caps at the ends of an open path. The union of these
 * is the exact swept region — robust for any width and any join, unlike the
 * offset-then-guard approach.
 */
function appendStrokePolygons(
	points: [number, number][],
	isClosed: boolean,
	halfWidth: number,
	roundJoin: boolean,
	roundCap: boolean,
	out: Polygon[],
): void {
	const count = points.length;
	const last = isClosed ? count : count - 1;
	for (let i = 0; i < last; i++) {
		const a = points[i];
		const b = points[(i + 1) % count];
		const dx = b[0] - a[0];
		const dy = b[1] - a[1];
		const len = Math.hypot(dx, dy);
		if (len < 1e-9) continue;
		const nx = (-dy / len) * halfWidth;
		const ny = (dx / len) * halfWidth;
		out.push([
			[
				[a[0] + nx, a[1] + ny],
				[b[0] + nx, b[1] + ny],
				[b[0] - nx, b[1] - ny],
				[a[0] - nx, a[1] - ny],
			],
		]);
	}

	// Joins at shared vertices (interior of an open path, all of a closed one).
	const firstJoin = isClosed ? 0 : 1;
	for (let i = firstJoin; i < (isClosed ? count : count - 1); i++) {
		const v = points[i];
		if (roundJoin) {
			out.push([circleRing(v[0], v[1], halfWidth)]);
		} else {
			const prev = points[(i - 1 + count) % count];
			const next = points[(i + 1) % count];
			appendBevelWedge(v, prev, next, halfWidth, out);
		}
	}

	// End caps for open paths.
	if (!isClosed && count >= 2) {
		if (roundCap) {
			out.push([circleRing(points[0][0], points[0][1], halfWidth)]);
			out.push([
				circleRing(points[count - 1][0], points[count - 1][1], halfWidth),
			]);
		}
		// flat cap: the end quads already stop squarely at the endpoints.
	}
}

/** Bevel/miter join approximated by two triangles filling the outer gaps. */
function appendBevelWedge(
	v: [number, number],
	prev: [number, number],
	next: [number, number],
	halfWidth: number,
	out: Polygon[],
): void {
	const inNormal = perpUnit(v[0] - prev[0], v[1] - prev[1], halfWidth);
	const outNormal = perpUnit(next[0] - v[0], next[1] - v[1], halfWidth);
	if (!inNormal || !outNormal) return;
	out.push([
		[
			[v[0], v[1]],
			[v[0] + inNormal[0], v[1] + inNormal[1]],
			[v[0] + outNormal[0], v[1] + outNormal[1]],
		],
	]);
	out.push([
		[
			[v[0], v[1]],
			[v[0] - inNormal[0], v[1] - inNormal[1]],
			[v[0] - outNormal[0], v[1] - outNormal[1]],
		],
	]);
}

function perpUnit(
	dx: number,
	dy: number,
	scale: number,
): [number, number] | null {
	const len = Math.hypot(dx, dy);
	if (len < 1e-9) return null;
	return [(-dy / len) * scale, (dx / len) * scale];
}

function circleRing(cx: number, cy: number, r: number): Ring {
	const ring: Ring = [];
	for (let i = 0; i < STROKE_CIRCLE_SEGMENTS; i++) {
		const t = (i / STROKE_CIRCLE_SEGMENTS) * Math.PI * 2;
		ring.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]);
	}
	return ring;
}

/**
 * Convert a polygon-clipping result (outer CCW rings + CW hole rings) into
 * straight-line bezier sub-paths for buildExtrudeMesh. Winding is preserved,
 * so the mesh builder's dominant-winding rule unions solids and cuts holes.
 */
function multiPolygonToSegments(mp: MultiPolygon): CubicBezierSegment[] {
	const result: CubicBezierSegment[] = [];
	for (const polygon of mp) {
		for (const ring of polygon) {
			// polygon-clipping closes rings (last point repeats the first).
			const open =
				ring.length > 1 &&
				ring[0][0] === ring.at(-1)![0] &&
				ring[0][1] === ring.at(-1)![1]
					? ring.slice(0, -1)
					: ring;
			if (open.length < 3) continue;
			for (let i = 0; i < open.length; i++) {
				const end = open[(i + 1) % open.length];
				result.push({
					start: i === 0 ? { x: open[0][0], y: open[0][1] } : undefined,
					cp1: { x: 0, y: 0 },
					cp2: { x: 0, y: 0 },
					end: { x: end[0], y: end[1] },
					startTiltX: 0,
					startTiltY: 0,
					endTiltX: 0,
					endTiltY: 0,
					startDeltaTime: 0,
					endDeltaTime: 0,
					isMoved: i === 0,
					isClosed: i === open.length - 1,
				});
			}
		}
	}
	return result;
}

/** Same power-of-two bucketing as the Reference3D texture resolution. */
export function computeToleranceBucket(dpiScale: number): number {
	const bucket = 2 ** Math.ceil(Math.log2(dpiScale));
	return Math.min(Math.max(bucket, 0.25), 4);
}

/** The 8 corners of a solid's 3D bounding box (mesh bounds3d) — the inputs to
 *  the projected-bounds/offscreen sizing in the baker. */
export function boxCorners3d(bounds: {
	minX: number;
	minY: number;
	minZ: number;
	maxX: number;
	maxY: number;
	maxZ: number;
}): Vec3[] {
	const corners: Vec3[] = [];
	for (const x of [bounds.minX, bounds.maxX]) {
		for (const y of [bounds.minY, bounds.maxY]) {
			for (const z of [bounds.minZ, bounds.maxZ]) {
				corners.push([x, y, z]);
			}
		}
	}
	return corners;
}

export function ensureExtrudePerspectiveDistance(
	corners: Vec3[],
	model: Mat4,
	distance: number,
	halfDiagonal: number,
): number {
	let maxZ = -Infinity;
	for (const corner of corners) {
		maxZ = Math.max(maxZ, mat4TransformPoint(model, corner)[2]);
	}
	const nearPlaneMargin = Math.max(halfDiagonal * 0.05, 1e-3);
	return Math.max(distance, maxZ + nearPlaneMargin);
}

export function normalizeLightDir(dir: Vec3): [number, number, number] {
	const len = Math.hypot(dir[0], dir[1], dir[2]);
	if (len < 1e-9) return [0, 0, 1];
	return [dir[0] / len, dir[1] / len, dir[2] / len];
}

/** Inverse of an effective tile size (0 for degenerate sizes = no tiling). */
export function invTileSize(size: number): number {
	return size > 0 ? 1 / size : 0;
}
