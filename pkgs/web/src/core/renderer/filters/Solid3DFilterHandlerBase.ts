import { localAppearances } from "../../document/appearancePresets";
import { createIdentityTransform } from "../../document/factory";
import {
	type Color,
	colorToRawRGBA,
	type Filter,
	isFilterEnabled,
	type Material3D,
	type Path,
	type Solid3DBaseParams,
	toRGBColor,
} from "../../schema";
import { lerpOptionalRGBColor, lerpOptionalScalar } from "../../utils/color";
import { lerp } from "../../utils/geometry/bezierBool";
import type { BlitUVRect } from "../canvas/CanvasLayerTypes";
import { instanceAppearanceUid } from "../canvas/caches/AppearanceCache";
import type {
	BackdropEffectCanvasResources,
	BackdropEffectDriver,
	FilterGeometryContext,
	FilterHandler,
	FilterProcessorContext,
	FilterRenderer,
	FilterRenderRequirements,
	PostProcessResult,
} from "../canvas/pipeline/FilterRenderer";
import { MeshPassRenderer } from "../canvas/pipeline/MeshPassRenderer";
import {
	createBorrowedTextureRef,
	createFrameTextureRef,
	createRenderSurface,
	type TextureRef,
} from "../canvas/pipeline/RenderSurface";
import {
	collectBlendExtrudeInstances,
	ExtrudeAppearanceRenderer,
	type ExtrudeFrameEntry,
} from "./Extrude3D/ExtrudeAppearanceRenderer";
import {
	ExtrudeMeshBaker,
	type ExtrudeMeshCacheEntry,
	type ExtrudeOutline,
	extrudeNeedsBackdrop,
	type ScopedAppearanceCache,
	type Solid3DMeshStrategy,
} from "./Extrude3D/ExtrudeMeshBaker";
import { RefractionCompositor } from "./Extrude3D/RefractionCompositor";

/**
 * Shared FilterHandler core for 3D solid appearances (extrude3d / revolve3d).
 * It owns the per-processor MeshPassRenderer (initialize = WGSL compile) and
 * ExtrudeMeshBaker (parameterized by the subclass's Solid3DMeshStrategy), and
 * drives them two ways:
 *   • opaque solids — postProcess() builds and bakes the 3D solid from
 *     ctx.geometry and returns it as a self-sized PostProcessResult, which the
 *     main pass blits at its own bounds/quad. getRenderConfigure reports
 *     needsSourceTexture=false, so the flat-look render is skipped.
 *   • glass solids (ior > 1 / aberration / blur) — the handler owns one
 *     glass-refraction driver per registered canvas (attachCanvas); the
 *     driver bakes the solid before the main pass and composites its
 *     refraction over the backdrop at the element's z-order, driven by the
 *     CanvasLayer through the generic BackdropEffectDriver interface.
 * Subclasses supply the mesh strategy and the params-shape-specific metadata
 * (onScaleFilter, getExpansionMargin, onInterpolate).
 */
export abstract class Solid3DFilterHandlerBase implements FilterHandler {
	/** The per-processor mesh strategy (also names the processor served). */
	protected abstract readonly strategy: Solid3DMeshStrategy;

	private device: GPUDevice | null = null;
	private meshPass: MeshPassRenderer | null = null;
	private baker: ExtrudeMeshBaker | null = null;
	private filterRenderer: FilterRenderer | null = null;
	/** Intermediate bake/normal textures acquired this frame, released after it. */
	private readonly frameTextures: GPUTexture[] = [];
	/** One glass-refraction driver per registered canvas, so the single shared
	 *  handler instance serves every canvas target without state collision. */
	private readonly canvasDrivers = new Map<
		string,
		{
			driver: ExtrudeAppearanceRenderer;
			refractionCompositor: RefractionCompositor;
		}
	>();

	/** Scale the params' spatial fields for an element resize. */
	public abstract onScaleFilter(
		filter: Filter,
		scale: [number, number],
	): Filter;
	/** Upper bound on how far the solid can escape the flat outline. */
	public abstract getExpansionMargin(filter: Filter): number;
	/** Lerp the params between a blend's adjacent keys. */
	public abstract onInterpolate(a: unknown, b: unknown, t: number): unknown;

	/** Inject the FilterRenderer the mesh baker needs (pre-filter application).
	 *  Call before initialize(). */
	public setFilterRenderer(filterRenderer: FilterRenderer): void {
		this.filterRenderer = filterRenderer;
	}

	public async initialize(
		device: GPUDevice,
		canvasFormat: GPUTextureFormat = "rgba8unorm",
	): Promise<void> {
		this.device = device;
		this.meshPass = new MeshPassRenderer(device, canvasFormat);
		this.meshPass.initialize();
		if (this.filterRenderer) {
			this.baker = new ExtrudeMeshBaker(
				device,
				this.filterRenderer,
				this.strategy,
			);
		}
	}

	/**
	 * Register a canvas's per-canvas resources, creating its glass-refraction
	 * driver (bakes glass solids before the main pass, composites their
	 * refraction over the backdrop at element z-order). Called once per
	 * CanvasLayer at construction, after initialize().
	 */
	public attachCanvas(
		canvasId: string,
		resources: BackdropEffectCanvasResources,
	): void {
		if (!this.device || !this.meshPass || !this.baker || !this.filterRenderer) {
			return;
		}
		const refractionCompositor = new RefractionCompositor(this.device);
		refractionCompositor.initialize(resources.canvasFormat);
		const driver = new ExtrudeAppearanceRenderer({
			device: this.device,
			texturePool: resources.texturePool,
			// Accessors, not snapshots: the resources' cache fields resolve the
			// cache manager's active document scope per access, and this chain
			// must not collapse them into fixed instances.
			get appearanceCache() {
				return resources.appearanceCache;
			},
			filterRenderer: this.filterRenderer,
			processor: this.strategy.processor,
			getParentGroupMap: resources.getParentGroupMap,
			get compoundPathCache() {
				return resources.compoundPathCache;
			},
			renderElementToTexture: resources.renderElementToTexture,
			resolvePatternTexture: resources.resolvePatternTexture,
			resolveTextOutline: resources.resolveTextOutline,
			requestTextOutline: resources.requestTextOutline,
			isImageReady: resources.isImageReady,
			meshPass: this.meshPass,
			baker: this.baker,
			refractionCompositor,
			backdropEffectCoordinator: resources.backdropEffectCoordinator,
			deferDestroy: resources.deferDestroy,
		});
		this.canvasDrivers.set(canvasId, { driver, refractionCompositor });
	}

	/** Drop and dispose the driver for a canvas being destroyed. */
	public detachCanvas(canvasId: string): void {
		const held = this.canvasDrivers.get(canvasId);
		if (!held) return;
		held.refractionCompositor.destroy();
		this.canvasDrivers.delete(canvasId);
	}

	/** The glass-refraction driver for a registered canvas, or null. */
	public getBackdropEffectDriver(
		canvasId: string,
	): BackdropEffectDriver | null {
		return this.canvasDrivers.get(canvasId)?.driver ?? null;
	}

	/** Shared lit-mesh pass + baker, available after initialize(). Null until
	 *  then, or if setFilterRenderer() was never called. */
	public getGeometryPassDrivers(): {
		meshPass: MeshPassRenderer;
		baker: ExtrudeMeshBaker;
	} | null {
		return this.meshPass && this.baker
			? { meshPass: this.meshPass, baker: this.baker }
			: null;
	}

	/** Reset the shared mesh pass's per-frame pools once per frame. */
	public startFrame(): void {
		this.meshPass?.beginFrame();
	}

	/**
	 * Render one 3D solid appearance as a self-sized filtered texture: the
	 * baker builds + bakes the projected 3D solid and the result is blitted at
	 * its own bounds/quad in the main pass. A blend bakes one solid PER
	 * INSTANCE (each key + interpolated intermediate, at its own shape
	 * params/rotation/perspective) instead of a single combined mesh, so
	 * returns an array in that case. Returns void for contexts without an
	 * element scope (the caller falls back to flat rendering).
	 */
	public postProcess(
		ctx: FilterProcessorContext,
		filter: Filter,
	): PostProcessResult | PostProcessResult[] | void {
		const { geometry } = ctx;
		if (!geometry || !this.meshPass || !this.baker) return;

		if (geometry.element.type === "blend") {
			return this.bakeBlendInstances(ctx, geometry, filter);
		}

		const outline = this.baker.buildOutline(geometry);
		if (!outline) return;
		// A no-op cache when no appearance scope was wired — the mesh is then
		// rebuilt each frame but still correct. The cross-frame render cache is
		// only enabled over a REAL scope: with the no-op cache the entry holding
		// the cached textures is dropped on the floor, which would leak them.
		const enableRenderCache = ctx.appearanceCache !== undefined;
		const cache: ScopedAppearanceCache = ctx.appearanceCache ?? {
			get: () => undefined,
			set: () => {},
		};
		const entry = this.baker.bakeAppearance(
			ctx.commandEncoder,
			this.meshPass,
			filter,
			outline,
			geometry,
			cache,
			ctx.sceneInfo.dpiScale,
			this.frameTextures,
			false,
			enableRenderCache,
			false,
			undefined,
			this.getDownstreamExpansionMargin(geometry.element, filter),
		);
		if (!entry) return;
		const output = enableRenderCache
			? this.copyBakeForCaller(ctx, geometry, entry, cache, filter.uid)
			: {
					texture: entry.texture,
					uvRect: entry.uvRect,
				};
		return {
			...createRenderSurface(
				output.texture,
				entry.quad
					? {
							kind: "world-quad",
							bounds: { ...entry.bounds },
							uvRect: output.uvRect,
							quad: entry.quad,
						}
					: {
							kind: "world-aabb",
							bounds: { ...entry.bounds },
							uvRect: output.uvRect,
						},
				{
					role: "color",
					alphaMode: "premultiplied",
					opacityState: "intrinsic",
				},
			),
			opacity: filter.opacity,
		};
	}

	/** Return the frame's intermediate bake/normal textures to the pool. */
	public releaseFrame(release: (texture: GPUTexture) => void): void {
		for (const tex of this.frameTextures) release(tex);
		this.frameTextures.length = 0;
	}

	/**
	 * postProcess builds its solid entirely from ctx.geometry (never the
	 * element's rasterized flat look), so needsSourceTexture is always false.
	 * Glass solids (ior > 1 / aberration / blur) warp the backdrop and are
	 * composited by the refraction compositor instead of being baked as an
	 * opaque solid, so needsBackdrop follows the material.
	 */
	public getRenderConfigure(
		filter: Filter<Solid3DBaseParams>,
	): FilterRenderRequirements {
		return {
			needsBackdrop: extrudeNeedsBackdrop(filter.paramData.params.material),
			needsSourceTexture: false,
		};
	}

	/** The 3D solid entirely replaces the element's flat 2D look. */
	public replacesElementRender(): boolean {
		return true;
	}

	/** The material's surface pattern def (albedo texture), if any. */
	public collectReferencedDefIds(filter: Filter<Solid3DBaseParams>): string[] {
		const defId = filter.paramData.params.material?.pattern?.defId;
		return defId ? [defId] : [];
	}

	/** Pass the material's light/shadow/fresnel colors through `adjustColor`. */
	public onAdjustColor(
		params: unknown,
		adjustColor: (color: Color) => Color,
	): unknown {
		const p = params as Solid3DBaseParams;
		const { material } = p;
		if (
			!material.lightColor &&
			!material.shadowColor &&
			!material.fresnelColor
		) {
			return params;
		}
		return {
			...p,
			material: {
				...material,
				...(material.lightColor && {
					lightColor: adjustColor(material.lightColor),
				}),
				...(material.shadowColor && {
					shadowColor: adjustColor(material.shadowColor),
				}),
				...(material.fresnelColor && {
					fresnelColor: adjustColor(material.fresnelColor),
				}),
			},
		};
	}

	public destroy(): void {
		for (const { refractionCompositor } of this.canvasDrivers.values()) {
			refractionCompositor.destroy();
		}
		this.canvasDrivers.clear();
		this.meshPass?.destroy();
		this.meshPass = null;
		this.baker = null;
		this.device = null;
	}

	/**
	 * Bake each of a blend's instances (keys + interpolated intermediates) as
	 * its own solid. Reuses ExtrudeMeshBaker.bakeAppearance's existing "path"
	 * albedo baking verbatim by swapping `geometry.element` for a synthetic
	 * per-instance Path (its own flat fill/stroke, no 3D appearance) — the
	 * mesh's own outline/params still come from the instance itself, so each
	 * solid gets its own shape and its own flat color instead of the whole
	 * blend's.
	 */
	private bakeBlendInstances(
		ctx: FilterProcessorContext,
		geometry: FilterGeometryContext,
		filter: Filter,
	): PostProcessResult[] | void {
		if (!this.meshPass || !this.baker || !this.filterRenderer) return;
		const instances = collectBlendExtrudeInstances(
			geometry.element as Extract<
				FilterGeometryContext["element"],
				{ type: "blend" }
			>,
			geometry.elementsMap,
			this.filterRenderer,
			this.strategy.processor,
		);
		if (instances.length === 0) return;

		// Same real-scope gate as postProcess: no scope → no cross-frame cache.
		const enableRenderCache = ctx.appearanceCache !== undefined;
		const cache: ScopedAppearanceCache = ctx.appearanceCache ?? {
			get: () => undefined,
			set: () => {},
		};
		// Lowering the blend's step count leaves the dropped instances' bakes in
		// the cache — nothing asks for their uid again, and stale-entry pruning
		// only looks at whether the BLEND still exists.
		cache.pruneInstances?.(filter.uid, instances.length);
		const results: PostProcessResult[] = [];
		instances.forEach((instance, i) => {
			const tempPath: Path = {
				type: "path",
				id: `${geometry.element.id}:instance-${i}`,
				opacity: 1,
				blendMode: "normal",
				transform: createIdentityTransform(),
				segments: instance.flatSegments,
				filters: instance.filters,
			};
			const instanceGeometry: FilterGeometryContext = {
				...geometry,
				element: tempPath,
			};
			const outline: ExtrudeOutline = {
				segments: instance.segments,
				flatSegments: instance.flatSegments,
				worldSpace: true,
			};
			const instanceFilter: Filter = {
				...filter,
				uid: instanceAppearanceUid(filter.uid, i),
				paramData: { ...filter.paramData, params: instance.params },
			};
			const entry = this.baker!.bakeAppearance(
				ctx.commandEncoder,
				this.meshPass!,
				instanceFilter,
				outline,
				instanceGeometry,
				cache,
				ctx.sceneInfo.dpiScale,
				this.frameTextures,
				false,
				enableRenderCache,
				false,
				undefined,
				this.getDownstreamExpansionMargin(geometry.element, filter),
			);
			if (!entry) return;
			const output = enableRenderCache
				? this.copyBakeForCaller(
						ctx,
						geometry,
						entry,
						cache,
						instanceFilter.uid,
					)
				: {
						texture: entry.texture,
						uvRect: entry.uvRect,
					};
			results.push({
				...createRenderSurface(
					output.texture,
					entry.quad
						? {
								kind: "world-quad",
								bounds: { ...entry.bounds },
								uvRect: output.uvRect,
								quad: entry.quad,
							}
						: {
								kind: "world-aabb",
								bounds: { ...entry.bounds },
								uvRect: output.uvRect,
							},
					{
						role: "color",
						alphaMode: "premultiplied",
						opacityState: "intrinsic",
					},
				),
				opacity: filter.opacity,
			});
		});
		return results.length > 0 ? results : undefined;
	}

	private getDownstreamExpansionMargin(
		element: FilterGeometryContext["element"],
		filter: Filter,
	): number {
		const filterIndex =
			localAppearances(element.filters).findIndex(
				(candidate) => candidate.uid === filter.uid,
			) ?? -1;
		if (filterIndex < 0 || !this.filterRenderer) return 0;

		let expansion = 0;
		for (const downstream of localAppearances(element.filters).slice(
			filterIndex + 1,
		)) {
			if (!isFilterEnabled(downstream)) continue;
			const handler = this.filterRenderer.getHandler(downstream.processor);
			if (!handler?.postProcess) continue;
			expansion = Math.max(expansion, handler.getExpansionMargin(downstream));
		}
		return expansion;
	}

	/**
	 * Clone a cache-held bake output into a caller-owned texture. With the
	 * render cache enabled, bakeAppearance's returned texture belongs to the
	 * cache entry (reused next frame) — but CanvasLayer's filteredTextures
	 * pipeline deferDestroys every PostProcessResult texture at frame end, and
	 * a downstream in-place filter may even rewrite it.
	 *
	 * The clone itself is also cached on the mesh entry and reused while the
	 * bake generation it was copied from stays current: panning re-composites
	 * the same bake every frame, and re-cloning a multi-MB texture per frame
	 * stalled the GPU process even though no render pass ran. Reused clones
	 * are returned as borrowed texture refs so frame cleanup leaves them alone.
	 */
	private copyBakeForCaller(
		ctx: FilterProcessorContext,
		geometry: FilterGeometryContext,
		entry: ExtrudeFrameEntry,
		cache: ScopedAppearanceCache,
		appearanceUid: string,
	): { texture: TextureRef; uvRect: BlitUVRect } {
		// The pool quantizes sizes; recover the used extent from the uv rect
		// (both factors are exact integers, so the round is lossless).
		const width = Math.round(entry.uvRect.maxU * entry.texture.texture.width);
		const height = Math.round(entry.uvRect.maxV * entry.texture.texture.height);

		const meshEntry = cache.get(appearanceUid) as
			| ExtrudeMeshCacheEntry
			| undefined;
		if (
			meshEntry?.callerClone &&
			meshEntry.callerCloneSource === entry.texture.texture
		) {
			const clone = meshEntry.callerClone;
			return {
				texture: createBorrowedTextureRef(clone, "appearance-cache"),
				uvRect: {
					minU: 0,
					minV: 0,
					maxU: width / clone.width,
					maxV: height / clone.height,
				},
			};
		}

		const copy = geometry.texturePool.acquire(
			width,
			height,
			entry.texture.texture.format,
			1,
			GPUTextureUsage.RENDER_ATTACHMENT |
				GPUTextureUsage.TEXTURE_BINDING |
				GPUTextureUsage.COPY_SRC |
				GPUTextureUsage.COPY_DST,
			"Extrude Bake Frame Copy",
		);
		ctx.commandEncoder.copyTextureToTexture(
			{ texture: entry.texture.texture },
			{ texture: copy },
			{ width, height },
		);
		const uvRect = {
			minU: 0,
			minV: 0,
			maxU: width / copy.width,
			maxV: height / copy.height,
		};
		if (meshEntry) {
			// A stale clone (its source bake was replaced) joins the frame sink;
			// the fresh one becomes the retained cross-frame clone.
			if (meshEntry.callerClone) this.frameTextures.push(meshEntry.callerClone);
			meshEntry.callerClone = copy;
			meshEntry.callerCloneSource = entry.texture.texture;
			return {
				texture: createBorrowedTextureRef(copy, "appearance-cache"),
				uvRect,
			};
		}
		return {
			texture: createFrameTextureRef(copy, (texture) =>
				geometry.texturePool.release(texture),
			),
			uvRect,
		};
	}
}

// Helpers

/**
 * Interpolate a Material3D's continuous fields between a blend's adjacent 3D
 * solid keys. Lighting direction, light/shadow/fresnel colors, and every
 * PBR/glass scalar (glass coverage, refraction/thickness/aberration/blur,
 * roughness/metalness/reflectivity/specular power, fresnel terms, pattern
 * opacity) ramp with `t`, each defaulting to its documented neutral value when
 * one side omits it, so a glass solid transitions smoothly into another glass
 * solid instead of the intermediates snapping to the source key's material.
 * Discrete fields (shading mode, fresnel toggle, surface-pattern def) can't
 * interpolate and keep the source key's value via the `...a` spread.
 */
export function interpolateMaterial3D(
	a: Material3D,
	b: Material3D,
	t: number,
): Material3D {
	const lightColor = lerpMaterialColor(a.lightColor, b.lightColor, t);
	const shadowColor = lerpMaterialColor(a.shadowColor, b.shadowColor, t);
	const fresnelColor = lerpMaterialColor(a.fresnelColor, b.fresnelColor, t);
	return {
		...a,
		lightDir: [
			lerp(a.lightDir[0], b.lightDir[0], t),
			lerp(a.lightDir[1], b.lightDir[1], t),
			lerp(a.lightDir[2], b.lightDir[2], t),
		],
		...(lightColor && { lightColor }),
		...(shadowColor && { shadowColor }),
		...(fresnelColor && { fresnelColor }),
		specularPower: lerpOptionalScalar(a.specularPower, b.specularPower, t, 32),
		roughness: lerpOptionalScalar(a.roughness, b.roughness, t, 0.5),
		metalness: lerpOptionalScalar(a.metalness, b.metalness, t, 0),
		reflectivity: lerpOptionalScalar(a.reflectivity, b.reflectivity, t, 0),
		glass: lerpOptionalScalar(a.glass, b.glass, t, 0),
		fresnelBias: lerpOptionalScalar(a.fresnelBias, b.fresnelBias, t, 0),
		fresnelScale: lerpOptionalScalar(a.fresnelScale, b.fresnelScale, t, 1),
		fresnelIntensity: lerpOptionalScalar(
			a.fresnelIntensity,
			b.fresnelIntensity,
			t,
			1,
		),
		fresnelFactor: lerpOptionalScalar(a.fresnelFactor, b.fresnelFactor, t, 5),
		refraction: lerpOptionalScalar(a.refraction, b.refraction, t, 1),
		thickness: lerpOptionalScalar(a.thickness, b.thickness, t, 0),
		aberration: lerpOptionalScalar(a.aberration, b.aberration, t, 0),
		blur: lerpOptionalScalar(a.blur, b.blur, t, 0),
		patternOpacity: lerpOptionalScalar(
			a.patternOpacity,
			b.patternOpacity,
			t,
			1,
		),
	};
}

/**
 * Interpolate two optional material colors in RGB. Absent on both sides stays
 * absent; present on only one keeps that one (no ramp toward a wrong default);
 * present on both ramps by `t`. HSV colors convert to RGB first.
 */
function lerpMaterialColor(
	a: Color | undefined,
	b: Color | undefined,
	t: number,
): Color | undefined {
	if (!a || !b) return a ?? b;
	return lerpOptionalRGBColor(
		toRGBColor(colorToRawRGBA(a)),
		toRGBColor(colorToRawRGBA(b)),
		t,
	);
}
