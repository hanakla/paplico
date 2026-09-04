import {
	createDefaultColor,
	createIdentityTransform,
} from "../../../document/factory";
import {
	type BlendObject,
	type CubicBezierSegment,
	colorToRawRGBA,
	type Extrude3DParams,
	type Filter,
	type Group,
	getTransform,
	isIdentityTransform,
	type Path,
	type Solid3DBaseParams,
} from "../../../schema";
import {
	brandWorldBBox,
	calculateLocalElementBounds,
} from "../../../utils/geometry/bounds";
import {
	applyTransformToPoint,
	composeTransforms,
} from "../../../utils/geometry/geometry";
import {
	mat4Multiply,
	mat4Orthographic,
	mat4PerspectiveDistanceFromFov,
	mat4RotationX,
	mat4RotationY,
	mat4RotationZ,
	mat4SimplePerspective,
	mat4TransformPoint,
	mat4Translation,
} from "../../../utils/geometry/mat4";
import { hashSegments } from "../../../utils/geometry/segmentOps";
import { neverReached } from "../../../utils/lang";
import type { AppearanceCacheEntry } from "../../canvas/caches/AppearanceCache";
import type {
	FilterGeometryContext,
	FilterRenderer,
} from "../../canvas/pipeline/FilterRenderer";
import {
	type MeshPassGeometry,
	MeshPassRenderer,
} from "../../canvas/pipeline/MeshPassRenderer";
import { resolveElementGeometry } from "../../canvas/pipeline/PreFilterRenderer";
import {
	createBorrowedTextureRef,
	createFrameTextureRef,
	type RasterizedRenderSurface,
} from "../../canvas/pipeline/RenderSurface";
import type { TexturePool } from "../../canvas/pipeline/TexturePool";
import type { GPUTimingProfiler } from "../../GPUTimingProfiler";
import {
	buildExtrudeMesh,
	type ExtrudeMeshData,
} from "../../geometry/extrudeMesh";
import { computePaintHash, hashRenderParams } from "../ExtrudeRenderCache";
import {
	boxCorners3d,
	buildExtrudeOutline,
	buildImageRectOutline,
	buildTextGlyphOutline,
	collectBlendExtrudeOutline,
	collectCompoundPathFillOutline,
	collectGroupExtrudeOutline,
	composeAncestorTransform,
	computeToleranceBucket,
	type ExtrudeFrameEntry,
	ensureExtrudePerspectiveDistance,
	invTileSize,
	normalizeLightDir,
	resolveFillAppearance,
	resolveFillBaseColor,
	resolveStrokeBaseColor,
} from "./ExtrudeAppearanceRenderer";

/** Element-scoped appearance cache view (element id pre-bound). */
export interface ScopedAppearanceCache {
	get(appearanceUid: string): AppearanceCacheEntry | undefined;
	set(appearanceUid: string, entry: AppearanceCacheEntry): void;
	/** Drop the entries of per-instance appearances beyond `liveCount` — see
	 *  AppearanceCache.pruneInstances. Absent on no-op scopes. */
	pruneInstances?(baseUid: string, liveCount: number): void;
}

/** The extrusion outline in the space its mesh lives in (element-local for a
 *  path, world for a group). */
export interface ExtrudeOutline {
	segments: CubicBezierSegment[];
	/** Original flat geometry (without the stroke sweep) — the bake draws
	 *  fill/stroke appearances on this so they land at their true spots. */
	flatSegments: CubicBezierSegment[];
	/** `segments` are already in world space (groups); skip the element
	 *  transform on both the blit and the bake. */
	worldSpace: boolean;
}

/**
 * Per-processor strategy shaping a 3D solid appearance's mesh. Everything else
 * in the baker (outline building, albedo bake, projection, lighting, glass,
 * caching) is shared and reads only Solid3DBaseParams. Extrude and revolve
 * each define one and hand it to their own ExtrudeMeshBaker instance.
 */
export interface Solid3DMeshStrategy {
	/** The appearance processor this strategy serves ("extrude3d" / "revolve3d"). */
	readonly processor: string;
	/** False when the params produce no solid (depth <= 0 / angleDeg <= 0). */
	isEnabled(params: Solid3DBaseParams): boolean;
	/**
	 * Mesh-hash fragment for the mesh-shaping params only — rotation/lighting/
	 * material stay out (uniforms/render-hash side), so rotating or relighting
	 * reuses the mesh.
	 */
	meshParamsHash(params: Solid3DBaseParams): string;
	/** Build the center-rebased CPU mesh. Null on degenerate input. */
	buildMesh(args: {
		segments: CubicBezierSegment[];
		params: Solid3DBaseParams;
		tolerance: number;
		uvInset: number;
	}): ExtrudeMeshData | null;
}

/** The extrude3d mesh strategy. The hash fragment is byte-compatible with the
 *  pre-strategy hash (`${depth}:${bevelSize}`), keeping warm caches valid. */
export const EXTRUDE_SOLID_STRATEGY: Solid3DMeshStrategy = {
	processor: "extrude3d",
	isEnabled: (params) => (params as Extrude3DParams).depth > 0,
	meshParamsHash: (params) => {
		const p = params as Extrude3DParams;
		return `${p.depth}:${p.bevel?.size ?? 0}`;
	},
	buildMesh: ({ segments, params, tolerance, uvInset }) => {
		const p = params as Extrude3DParams;
		return buildExtrudeMesh({
			segments,
			depth: p.depth,
			tolerance,
			bevelSize: p.bevel?.size ?? 0,
			uvInset,
			// Store positions center-relative so large world coordinates keep
			// their fp32 depth bits; the baker compensates with T(center).
			rebaseToCenter: true,
		});
	},
};

/** Flattening tolerance at bucket 1 (world units). */
const BASE_FLATTEN_TOLERANCE = 0.25;
/** Longest allowed offscreen side in pixels. */
const MAX_TEXTURE_SIDE = 4096;
/** Padding around the projected bounds (AA fringe). */
const BOUNDS_PADDING = 1;
// Glass distortion tuning. The offset is a screen-uv fraction of the region;
// the blur sigma is in region texels. Tuned on device.
export const REFRACTION_OFFSET_SCALE = 0.02;
export const ABERRATION_SCALE = 0.5;

/**
 * The 3D-solid rendering core: builds one appearance's outline mesh through
 * the injected per-processor strategy (cached in the AppearanceCache —
 * rotation/lighting/transform stay out of the hash so rotating or moving
 * reuses the mesh) and encodes one depth-tested offscreen pass through the
 * shared MeshPassRenderer. Driven per-appearance by both the opaque
 * postProcess path (main-pass filtered texture) and the glass prepare
 * pre-pass (refraction). Each solid handler owns one instance.
 */
export class ExtrudeMeshBaker {
	public constructor(
		private readonly device: GPUDevice,
		private readonly filterRenderer: FilterRenderer,
		private readonly strategy: Solid3DMeshStrategy,
	) {}

	/**
	 * Build the extrude outline for an element, or null when there is nothing
	 * to extrude. A path/text element extrudes its own outline in
	 * element-local space (the blit re-applies the element transform). A
	 * group extrudes the combined outline of every descendant in WORLD space,
	 * so its mesh, its baked texture, and its blit all live in one frame — no
	 * per-face uv remap needed.
	 *
	 * Exhaustively switches over every AnyArtObject variant so adding a new
	 * element type without deciding its extrude behavior here is a type
	 * error, not a silently-empty outline (the bug class this guards:
	 * Blend/Text were once unhandled group-child cases that contributed
	 * nothing, with no compiler signal).
	 */
	public buildOutline(geom: FilterGeometryContext): ExtrudeOutline | null {
		const element = geom.element;

		switch (element.type) {
			case "path": {
				const flatSegments = resolveElementGeometry(
					element.segments,
					element.filters,
					this.filterRenderer,
				);
				// Fold the stroke's swept outline into the extruded shape so stroked
				// paths — including open ones, which have no fill area at all —
				// extrude their painted region, Illustrator-style.
				const segments = buildExtrudeOutline(element.filters, flatSegments);
				if (segments.length === 0) return null;
				return { segments, flatSegments, worldSpace: false };
			}
			case "group": {
				const worldTransform = composeAncestorTransform(
					element,
					geom.elementsMap,
					geom.getParentGroupMap(),
				);
				const segments = collectGroupExtrudeOutline(
					element,
					geom.elementsMap,
					geom.compoundPathCache,
					worldTransform,
					this.filterRenderer,
					geom.resolveTextOutline,
					geom.requestTextOutline,
				);
				if (segments.length === 0) return null;
				return { segments, flatSegments: segments, worldSpace: true };
			}
			case "text": {
				const cached = geom.resolveTextOutline(element);
				if (!cached) {
					// Font/layout still loading — nothing to extrude yet; warm the
					// cache for a later frame (same flicker-prevention gap normal
					// text rendering already tolerates).
					geom.requestTextOutline(element);
					return null;
				}
				const { segments, flatSegments } = buildTextGlyphOutline(
					cached,
					element,
					this.filterRenderer,
				);
				if (segments.length === 0) return null;
				return { segments, flatSegments, worldSpace: false };
			}
			case "blend": {
				// Already fully composed (own transform folded in, no ancestor) —
				// same worldSpace:true convention as a group's pre-baked outline.
				const segments = collectBlendExtrudeOutline(
					element,
					geom.elementsMap,
					undefined,
					this.filterRenderer,
				);
				if (segments.length === 0) return null;
				return { segments, flatSegments: segments, worldSpace: true };
			}
			case "image": {
				// No vector geometry of its own — extrude the flat rectangular
				// plane its texture is painted onto.
				const segments = buildExtrudeOutline(
					element.filters,
					buildImageRectOutline(element),
				);
				if (segments.length === 0) return null;
				return { segments, flatSegments: segments, worldSpace: false };
			}
			case "compound-path": {
				// Boolean-combine the sources into their world-space fill outline
				// (same as normal compound-path rendering); the compound's own
				// transform is already folded into the sources. Sweep in any
				// stroke for the mesh silhouette while keeping the fill outline
				// for the albedo bake.
				const flatSegments = collectCompoundPathFillOutline(
					element,
					geom.elementsMap,
					geom.compoundPathCache,
				);
				if (flatSegments.length === 0) return null;
				const segments = buildExtrudeOutline(element.filters, flatSegments);
				if (segments.length === 0) return null;
				return { segments, flatSegments, worldSpace: true };
			}
			case "mesh":
			case "reference3d":
			case "repeat":
				// Not extrudable directly (yet) — no outline.
				return null;
			default:
				return neverReached(element);
		}
	}

	/**
	 * Encode one enabled extrude3d appearance into a frame-local texture via the
	 * shared mesh pass. Intermediate textures (bake albedo, glass normal MRT) are
	 * pushed to `sink` for frame-end release; the returned entry's output color
	 * texture is the caller's to release. Returns null when the appearance has no
	 * depth / projects to a degenerate region.
	 */
	public bakeAppearance(
		encoder: GPUCommandEncoder,
		meshPass: MeshPassRenderer,
		app: Filter,
		outline: ExtrudeOutline,
		geom: FilterGeometryContext,
		cache: ScopedAppearanceCache,
		dpiScale: number,
		sink: GPUTexture[],
		glassOnly = false,
		enableRenderCache = false,
		// Bake the normal MRT and return a refraction entry even for a
		// non-distorting material (its refractScale/aberration/blur come out 0,
		// so the composite is a plain solid-over-backdrop draw). Lets a mixed
		// glass/opaque blend run every instance through one backdrop-composite
		// path in paint order.
		forceBackdropComposite = false,
		profiler?: GPUTimingProfiler | null,
		outputMargin = 0,
	): ExtrudeFrameEntry | null {
		const params = app.paramData.params as Solid3DBaseParams;
		if (!this.strategy.isEnabled(params)) return null;
		// The prepare pre-pass only bakes glass; opaque solids render through
		// the postProcess filter path.
		if (glassOnly && !extrudeNeedsBackdrop(params.material)) return null;

		const element = geom.element;
		const { segments, flatSegments, worldSpace } = outline;
		const toleranceBucket = computeToleranceBucket(dpiScale);
		// Pull wall/bevel UV samples ~1.5 bake texels inside the outline so
		// they read the fill color instead of its antialiased coverage edge.
		const uvInset = 1.5 / dpiScale;

		// Composed element transform (ancestor groups included) with the same
		// rotation origin as the GPU transforms buffer: the element's local
		// bounds center. The blit follows it so the 3D result moves exactly like
		// the flat geometry would. World-space outlines (groups) already have
		// every transform baked in, so they stay at identity.
		let composedTransform = worldSpace
			? createIdentityTransform()
			: getTransform(element);
		if (!worldSpace) {
			const parentGroupMap = geom.getParentGroupMap();
			let parentId = parentGroupMap.get(element.id);
			while (parentId) {
				const ancestor = geom.elementsMap.get(parentId);
				if (ancestor) {
					composedTransform = composeTransforms(
						getTransform(ancestor),
						composedTransform,
					);
				}
				parentId = parentGroupMap.get(parentId);
			}
		}
		const hasTransform = !isIdentityTransform(composedTransform);
		let originX = 0;
		let originY = 0;
		if (hasTransform) {
			const localBounds = calculateLocalElementBounds(
				element,
				geom.elementsMap,
			);
			originX = (localBounds.minX + localBounds.maxX) / 2;
			originY = (localBounds.minY + localBounds.maxY) / 2;
		}

		const entry = this.getOrBuildMesh(
			cache,
			app.uid,
			segments,
			params,
			toleranceBucket,
			uvInset,
			geom.texturePool,
		);
		if (!entry) return null;

		// Material surface pattern: tile a pattern def across the mesh as the
		// albedo, independent of the element's own fill. Cold/missing = null.
		// Computed here, before encodePass, since its revision feeds the
		// render-cache hash below.
		const material = params.material;
		const pattern = material.pattern;
		const patternResolved = pattern?.defId
			? geom.resolvePatternTexture(pattern.defId)
			: null;

		// Cross-frame cache of this appearance's rendered output (color+normal),
		// gated by a content hash covering everything the bake depends on beyond
		// the mesh (already covered by entry.hash): rotation/perspective/material/
		// pattern-revision/dpiScale, plus the element's own paint content — recursively
		// for a group's descendants. Computed fresh every call (this codebase's
		// established idiom: no push-type dirty flags exist anywhere, so every
		// cache here self-validates via a recomputed content hash compared against
		// the stored one — see AppearanceCache/GradientCache/etc). backdrop
		// compositing (refractOne) always runs live per-frame regardless of this
		// cache, so caching the backdrop-independent bake here cannot go stale
		// with respect to what's behind the glass.
		const cachingActive = enableRenderCache;
		const renderHash = cachingActive
			? `${hashRenderParams(params, dpiScale, patternResolved?.revision ?? null)}::margin:${outputMargin}::${computePaintHash(
					element,
					geom.elementsMap,
					{
						resolvePatternTexture: geom.resolvePatternTexture,
						resolveTextOutline: geom.resolveTextOutline,
						isImageReady: geom.isImageReady,
						hasPreProcessHandler: (processor) =>
							!!this.filterRenderer.getHandler(processor)?.preProcess,
					},
				)}`
			: null;
		const cacheHit =
			cachingActive &&
			entry.renderHash === renderHash &&
			entry.colorTexture !== undefined;

		const [rxDeg, ryDeg, rzDeg] = params.rotationDeg;
		const rx = (rxDeg * Math.PI) / 180;
		const ry = (ryDeg * Math.PI) / 180;
		const rz = (rzDeg * Math.PI) / 180;
		// The solid's true 3D extent decides the rotation/perspective center and
		// the projected bounds. For an extrusion this box equals the profile ×
		// [-depth, 0]; a revolved solid grows past the profile in X and Z. The
		// XY center is also the mesh's rebase origin (see strategy.buildMesh).
		const b3 = entry.bounds3d;
		const centerX = (b3.minX + b3.maxX) / 2;
		const centerY = (b3.minY + b3.maxY) / 2;
		const centerZ = (b3.minZ + b3.maxZ) / 2;
		const corners = boxCorners3d(b3);

		// Model: rotate (Z·Y·X) around the solid's 3D center, so rotation never
		// orbits the solid.
		const rotation = mat4Multiply(
			mat4RotationZ(rz),
			mat4Multiply(mat4RotationY(ry), mat4RotationX(rx)),
		);
		const model = mat4Multiply(
			mat4Translation(centerX, centerY, centerZ),
			mat4Multiply(rotation, mat4Translation(-centerX, -centerY, -centerZ)),
		);
		const halfDiagonal = Math.hypot(b3.maxX - b3.minX, b3.maxY - b3.minY) / 2;
		const perspectiveDistance =
			params.perspective > 0 && halfDiagonal > 1e-9
				? ensureExtrudePerspectiveDistance(
						corners,
						model,
						mat4PerspectiveDistanceFromFov(params.perspective, halfDiagonal),
						halfDiagonal,
					)
				: 0;
		const projected =
			perspectiveDistance > 0
				? mat4Multiply(
						mat4SimplePerspective(perspectiveDistance, centerX, centerY),
						model,
					)
				: model;

		// True projected bounds: the rotated (and perspective-divided) corners
		// of the outline box decide the offscreen size.
		let pMinX = Infinity;
		let pMinY = Infinity;
		let pMinZ = Infinity;
		let pMaxX = -Infinity;
		let pMaxY = -Infinity;
		let pMaxZ = -Infinity;
		for (const corner of corners) {
			const [x, y, z] = mat4TransformPoint(projected, corner);
			pMinX = Math.min(pMinX, x);
			pMinY = Math.min(pMinY, y);
			pMinZ = Math.min(pMinZ, z);
			pMaxX = Math.max(pMaxX, x);
			pMaxY = Math.max(pMaxY, y);
			pMaxZ = Math.max(pMaxZ, z);
		}
		// Free rotation + perspective can push geometry through the projection
		// plane (w → 0); skip the appearance instead of feeding NaN/Infinity
		// into texture allocation.
		if (
			!Number.isFinite(pMinX) ||
			!Number.isFinite(pMinY) ||
			!Number.isFinite(pMaxX) ||
			!Number.isFinite(pMaxY) ||
			!Number.isFinite(pMinZ) ||
			!Number.isFinite(pMaxZ)
		) {
			return null;
		}
		const outputPadding = BOUNDS_PADDING + outputMargin;
		pMinX -= outputPadding;
		pMinY -= outputPadding;
		pMaxX += outputPadding;
		pMaxY += outputPadding;

		const width = Math.min(
			Math.max(Math.ceil((pMaxX - pMinX) * dpiScale), 1),
			MAX_TEXTURE_SIDE,
		);
		const height = Math.min(
			Math.max(Math.ceil((pMaxY - pMinY) * dpiScale), 1),
			MAX_TEXTURE_SIDE,
		);

		const mvp = mat4Multiply(
			mat4Multiply(
				mat4Orthographic(pMinX, pMaxX, pMinY, pMaxY, pMaxZ + 1, pMinZ - 1),
				projected,
			),
			// extrudeMesh rebases stored positions to the outline center for fp32
			// depth precision; translate them back to world before the projection
			// so the rendered result is unchanged.
			mat4Translation(centerX, centerY, 0),
		);

		// A cache hit reuses last frame's color/normal textures verbatim,
		// skipping texture acquisition, the albedo bake, and encodePass entirely
		// — this branch and its `else` counterpart (closed further below, right
		// before the cache-bookkeeping block) span everything that depends on
		// backdrop-independent render inputs.
		let colorTexture: GPUTexture;
		let normalTexture: GPUTexture | null = null;
		if (cacheHit) {
			colorTexture = entry.colorTexture!;
			normalTexture = entry.normalTexture ?? null;
		} else {
			// The color texture is the returned output — its lifetime is owned by the
			// caller (frame entries / filtered textures), not the intermediate sink.
			// COPY_SRC lets the opaque postProcess path clone a cache-held bake into
			// a frame-owned texture (see Extrude3DFilterHandler.copyBakeForCaller).
			colorTexture = geom.texturePool.acquire(
				width,
				height,
				meshPass.colorFormat,
				1,
				GPUTextureUsage.RENDER_ATTACHMENT |
					GPUTextureUsage.TEXTURE_BINDING |
					GPUTextureUsage.COPY_SRC,
				"Extrude Appearance Color",
			);

			// Glass distortion needs the screen-space normal (MRT) to warp the
			// backdrop at composite time. The capture region is the quad's world
			// AABB, so rotated glass refracts too (through a larger capture region).
			const needsRefraction =
				forceBackdropComposite || extrudeNeedsBackdrop(params.material);
			normalTexture = needsRefraction
				? geom.texturePool.acquire(
						width,
						height,
						MeshPassRenderer.NORMAL_FORMAT,
						1,
						GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
						"Extrude Appearance Normal",
					)
				: null;

			// Bake the surface albedo into a texture. bounds2d is the exact box the
			// mesh UVs span (world space for a group, element-local for a path), and
			// the bake covers that same box — so the mesh samples the texture
			// directly through texUvRect, no per-face remap.
			//   • group: render every child's real flat look (their own colors,
			//     gradients, images, text, overlaps) via renderElementToTexture.
			//   • path : render the fill+stroke appearances onto the flat geometry —
			//     but only when the surface isn't a plain solid fill.
			let baked: RasterizedRenderSurface | null = null;
			const { minX: bx, minY: by, maxX: bX, maxY: bY } = entry.bounds2d;
			const bw = bX - bx;
			const bh = bY - by;
			const bakeBounds = brandWorldBBox({
				minX: bx,
				minY: by,
				maxX: bX,
				maxY: bY,
				width: bw,
				height: bh,
			});

			if (element.type === "group" && bw > 0 && bh > 0) {
				// Temp group without the 3D solid filter → the bake draws its plain
				// flat look. Its children keep their own world transforms (GPU
				// transforms buffer), matching the world-space mesh and bounds. A
				// group with its OWN appearances (path-union/offset pre-filters,
				// fill/stroke) keeps them so its combined painted surface bakes to
				// match the outline; a plain group stays filterless (raw children).
				const groupAppearances = (element.filters ?? []).filter(
					(f) => !this.isRenderReplacingFilter(f),
				);
				const tempGroup: Group = {
					type: "group",
					id: element.id,
					opacity: 1,
					blendMode: "normal",
					transform: getTransform(element),
					childIds: element.childIds,
					clipPathId: element.clipPathId,
					...(groupAppearances.length > 0 && { filters: groupAppearances }),
				};
				baked = geom.renderElementToTexture(
					encoder,
					tempGroup,
					bakeBounds,
					geom.elementsMap,
					dpiScale,
				);
				if (baked) sink.push(baked.texture.texture);
			} else if (element.type === "path" && bw > 0 && bh > 0) {
				const flatApps = (element.filters ?? []).filter(
					(f) =>
						(f.processor === "fill" || f.processor === "stroke") &&
						f.enabled !== false,
				);
				const fillApp = resolveFillAppearance(element.filters);
				const needsBake =
					flatApps.some((f) => f.processor === "stroke") ||
					(fillApp !== null && fillApp.paramData.params.fill?.type !== "solid");
				if (needsBake && flatApps.length > 0) {
					const tempPath: Path = {
						type: "path",
						id: `${element.id}:extrude-fill:${app.uid}`,
						opacity: 1,
						blendMode: "normal",
						segments: flatSegments,
						filters: flatApps,
						transform: createIdentityTransform(),
						strokeWidths: element.strokeWidths,
						pathStart: element.pathStart,
						pathEnd: element.pathEnd,
					};
					baked = geom.renderElementToTexture(
						encoder,
						tempPath,
						bakeBounds,
						undefined,
						dpiScale,
					);
					if (baked) sink.push(baked.texture.texture);
				}
			} else if (
				(element.type === "text" || element.type === "compound-path") &&
				bw > 0 &&
				bh > 0
			) {
				// flatSegments is the fill outline in the same space bakeBounds spans:
				//   • text: the glyphs' fill shapes offset into the element's local
				//     frame (buildTextGlyphOutline) — glyph paths carry no paint;
				//   • compound-path: the sources' boolean-combined outline in world.
				// Fill it with the element's own fill/stroke appearances (e.g. a
				// gradient) and bake that as the surface, so a non-solid fill shows
				// instead of collapsing to the flat first-stop base color.
				const flatApps = (element.filters ?? []).filter(
					(f) =>
						(f.processor === "fill" || f.processor === "stroke") &&
						f.enabled !== false,
				);
				const fillApp = resolveFillAppearance(element.filters);
				const needsBake =
					flatApps.some((f) => f.processor === "stroke") ||
					(fillApp !== null && fillApp.paramData.params.fill?.type !== "solid");
				if (needsBake && flatApps.length > 0) {
					const tempPath: Path = {
						type: "path",
						id: `${element.id}:extrude-fill:${app.uid}`,
						opacity: 1,
						blendMode: "normal",
						segments: flatSegments,
						filters: flatApps,
						transform: createIdentityTransform(),
					};
					baked = geom.renderElementToTexture(
						encoder,
						tempPath,
						bakeBounds,
						undefined,
						dpiScale,
					);
					if (baked) sink.push(baked.texture.texture);
				}
			} else if (element.type === "blend" && bw > 0 && bh > 0) {
				// A blend's colors live on its interpolated keys, not on blend.filters,
				// so there is no single fill to sample. Render the blend's actual flat
				// look (keys + intermediates with their own colors) as the surface —
				// otherwise the mesh falls back to the default (black) base color.
				const tempBlend: BlendObject = {
					...element,
					id: `${element.id}:extrude-fill:${app.uid}`,
					filters: (element.filters ?? []).filter(
						(f) => !this.isRenderReplacingFilter(f),
					),
				};
				// Strip the render-replacing 3D appearances from the keys too (the
				// solid may have been hoisted here from them): the mesh shapes the
				// instances; the albedo is their flat 2D colors, so the keys must
				// render their flat fill here, not be suppressed as render-replaced.
				const albedoMap = new Map(geom.elementsMap);
				for (const keyId of element.objectIds) {
					const key = albedoMap.get(keyId);
					if (key?.filters?.some((f) => this.isRenderReplacingFilter(f))) {
						albedoMap.set(keyId, {
							...key,
							filters: key.filters.filter(
								(f) => !this.isRenderReplacingFilter(f),
							),
						});
					}
				}
				baked = geom.renderElementToTexture(
					encoder,
					tempBlend,
					bakeBounds,
					albedoMap,
					dpiScale,
				);
				if (baked) sink.push(baked.texture.texture);
			}

			const baseColor = colorToRawRGBA(
				resolveFillBaseColor(element.filters) ??
					resolveStrokeBaseColor(element.filters) ??
					createDefaultColor(),
			);
			const lightColor = material.lightColor
				? colorToRawRGBA(material.lightColor)
				: null;
			const shadowColor = material.shadowColor
				? colorToRawRGBA(material.shadowColor)
				: null;
			const fresnelColor = material.fresnelColor
				? colorToRawRGBA(material.fresnelColor)
				: null;
			meshPass.encodePass(
				encoder,
				colorTexture,
				{ width, height },
				entry.geometry,
				{
					mvp,
					model,
					baseColor: [baseColor.r, baseColor.g, baseColor.b, baseColor.a],
					lightDir: normalizeLightDir(material.lightDir),
					...(lightColor && {
						lightColor: [
							lightColor.r,
							lightColor.g,
							lightColor.b,
							lightColor.a,
						] satisfies [number, number, number, number],
					}),
					...(shadowColor && {
						shadowColor: [
							shadowColor.r,
							shadowColor.g,
							shadowColor.b,
							shadowColor.a,
						] satisfies [number, number, number, number],
					}),
					shadingMode:
						material.shading === "flat"
							? 0
							: material.shading === "lambert"
								? 1
								: 2,
					specularPower: material.specularPower ?? 32,
					pbr: {
						roughness: material.roughness ?? 0.5,
						metalness: material.metalness ?? 0,
						reflectivity: material.reflectivity ?? 0,
						glass: material.glass ?? 0,
					},
					...(material.fresnelEnabled && {
						fresnel: {
							color: (fresnelColor
								? [fresnelColor.r, fresnelColor.g, fresnelColor.b]
								: [1, 1, 1]) satisfies [number, number, number],
							bias: material.fresnelBias ?? 0,
							scale: material.fresnelScale ?? 1,
							intensity: material.fresnelIntensity ?? 1,
							factor: material.fresnelFactor ?? 5,
						},
					}),
					...(baked && {
						fillTexture: baked.texture.texture,
						texUvRect: [
							baked.placement.uvRect.minU,
							baked.placement.uvRect.minV,
							baked.placement.uvRect.maxU,
							baked.placement.uvRect.maxV,
						] satisfies [number, number, number, number],
					}),
					...(patternResolved &&
						pattern && {
							patternTexture: patternResolved.texture,
							patternInvTile: [
								invTileSize(
									patternResolved.tileWorldSize.width * pattern.scaleX,
								),
								invTileSize(
									patternResolved.tileWorldSize.height * pattern.scaleY,
								),
							] satisfies [number, number],
							patternRotation: pattern.rotation,
							patternOffset: [pattern.offsetX, pattern.offsetY] satisfies [
								number,
								number,
							],
							patternOpacity: material.patternOpacity ?? 1,
						}),
				},
				normalTexture ?? null,
				profiler,
			);

			if (cachingActive) {
				// Replacing this appearance's cached output: the outgoing generation
				// (if any — absent on the very first bake) is stale, not reused, so it
				// goes to `sink` for this frame's ordinary release rather than being
				// kept around by the cache entry.
				if (entry.colorTexture) sink.push(entry.colorTexture);
				if (entry.normalTexture) sink.push(entry.normalTexture);
				entry.renderHash = renderHash ?? undefined;
				entry.colorTexture = colorTexture;
				entry.normalTexture = normalTexture;
			}
		}

		return {
			texture: cachingActive
				? createBorrowedTextureRef(colorTexture, "appearance-cache")
				: createFrameTextureRef(colorTexture, (texture) =>
						geom.texturePool.release(texture),
					),
			...(normalTexture && {
				refraction: {
					normalTexture: cachingActive
						? createBorrowedTextureRef(normalTexture, "appearance-cache")
						: createFrameTextureRef(normalTexture, (texture) =>
								geom.texturePool.release(texture),
							),
					refractScale:
						((material.refraction ?? 1) - 1) *
						(material.thickness ?? 10) *
						REFRACTION_OFFSET_SCALE,
					aberration: (material.aberration ?? 0) * ABERRATION_SCALE,
					blurWorld: material.blur ?? 0,
				},
			}),
			contentHash: `${entry.hash}::${renderHash ?? "uncached"}`,
			bounds: {
				minX: pMinX,
				minY: pMinY,
				maxX: pMaxX,
				maxY: pMaxY,
				width: pMaxX - pMinX,
				height: pMaxY - pMinY,
			},
			quad: hasTransform
				? ([
						applyTransformToPoint(
							pMinX,
							pMaxY,
							composedTransform,
							originX,
							originY,
						),
						applyTransformToPoint(
							pMaxX,
							pMaxY,
							composedTransform,
							originX,
							originY,
						),
						applyTransformToPoint(
							pMaxX,
							pMinY,
							composedTransform,
							originX,
							originY,
						),
						applyTransformToPoint(
							pMinX,
							pMinY,
							composedTransform,
							originX,
							originY,
						),
					] as const)
				: undefined,
			uvRect: {
				minU: 0,
				minV: 0,
				maxU: width / colorTexture.width,
				maxV: height / colorTexture.height,
			},
		};
	}

	/**
	 * Whether the filter is a render-replacing appearance (extrude3d /
	 * revolve3d): the albedo bake strips these so the flat look renders
	 * underneath the 3D surface instead of recursing into another solid.
	 * Matches the historical `processor !== "extrude3d"` strip, which also
	 * ignored the enabled flag.
	 */
	private isRenderReplacingFilter(f: Filter): boolean {
		return !!this.filterRenderer
			.getHandler(f.processor)
			?.replacesElementRender?.(f);
	}

	/**
	 * Mesh lookup through the element-scoped AppearanceCache. The hash covers
	 * the outline geometry, the strategy's mesh-shaping params (depth/bevel for
	 * extrude, angle/offset/axis/cap for revolve), the tolerance bucket, and
	 * the UV inset — rotation/lighting/transform are uniforms or blit-side, so
	 * rotating or moving the solid reuses the mesh.
	 */
	private getOrBuildMesh(
		cache: ScopedAppearanceCache,
		appearanceUid: string,
		segments: CubicBezierSegment[],
		params: Solid3DBaseParams,
		toleranceBucket: number,
		uvInset: number,
		texturePool: TexturePool,
	): ExtrudeMeshCacheEntry | null {
		const hash = `${hashSegments(segments)}:${this.strategy.meshParamsHash(params)}:${toleranceBucket}:${uvInset}`;
		const cached = cache.get(appearanceUid) as
			| ExtrudeMeshCacheEntry
			| undefined;
		if (cached && cached.hash === hash) return cached;

		const mesh = this.strategy.buildMesh({
			segments,
			params,
			tolerance: BASE_FLATTEN_TOLERANCE / toleranceBucket,
			uvInset,
		});
		if (!mesh) return null;

		const device = this.device;
		const vertexBuffer = device.createBuffer({
			label: "Extrude Mesh Vertices",
			size: mesh.vertices.byteLength,
			usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
		});
		device.queue.writeBuffer(vertexBuffer, 0, mesh.vertices);
		const indexBuffer = device.createBuffer({
			label: "Extrude Mesh Indices",
			size: mesh.indices.byteLength,
			usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
		});
		device.queue.writeBuffer(indexBuffer, 0, mesh.indices);

		const entry: ExtrudeMeshCacheEntry = {
			hash,
			geometry: {
				vertexBuffer,
				indexBuffer,
				indexCount: mesh.indices.length,
			},
			bounds2d: mesh.bounds2d,
			bounds3d: mesh.bounds3d,
			// Reads colorTexture/normalTexture off `entry` itself (not a local
			// captured at construction time), so bakeAppearance can populate or
			// replace them on this same entry across many frames — a render-hash-
			// only change never needs a second cache.set() call (which would
			// wrongly re-trigger AppearanceCache's deferDestroy-the-previous-entry
			// path against this very entry).
			destroy: () => {
				vertexBuffer.destroy();
				indexBuffer.destroy();
				if (entry.colorTexture) texturePool.release(entry.colorTexture);
				if (entry.normalTexture) texturePool.release(entry.normalTexture);
				if (entry.callerClone) texturePool.release(entry.callerClone);
			},
		};
		cache.set(appearanceUid, entry);
		return entry;
	}
}

/** Distortion glass = any backdrop-warping param set (ior > 1 / aberration / blur). */
export function extrudeNeedsBackdrop(material: {
	refraction?: number;
	aberration?: number;
	blur?: number;
}): boolean {
	return (
		(material.refraction ?? 1) > 1 ||
		(material.aberration ?? 0) > 0 ||
		(material.blur ?? 0) > 0
	);
}

/**
 * GPU mesh cached per (elementId, appearanceUid) in the AppearanceCache.
 * `hash` (inherited) covers geometry only (segments/depth/bevel/tolerance/
 * uvInset) and never changes meaning — it stays the sole gate for mesh
 * rebuilds. `renderHash`/`colorTexture`/`normalTexture` are a SEPARATE,
 * independently-gated cache of this appearance's rendered bake output,
 * populated only once a caller passes enableRenderCache=true to
 * bakeAppearance; otherwise they stay undefined forever and behavior is
 * identical to before this cache existed.
 */
export interface ExtrudeMeshCacheEntry extends AppearanceCacheEntry {
	geometry: MeshPassGeometry;
	bounds2d: { minX: number; minY: number; maxX: number; maxY: number };
	bounds3d: ExtrudeMeshData["bounds3d"];
	renderHash?: string;
	colorTexture?: GPUTexture;
	normalTexture?: GPUTexture | null;
	/** Caller-owned clone of colorTexture reused across frames (see
	 *  Solid3DFilterHandlerBase.copyBakeForCaller) and the colorTexture
	 *  generation it was copied from. */
	callerClone?: GPUTexture;
	callerCloneSource?: GPUTexture;
}
