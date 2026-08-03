import {
	createIdentityTransform,
	createStrokeBrushSettings,
} from "../../../document/factory";
import {
	type BoundingBox,
	type CubicBezierSegment,
	type FillAppearance,
	type FillParams,
	type Filter,
	isIdentityTransform,
	type Path,
	type StrokeAppearance,
	type StrokeParams,
	type TextElement,
} from "../../../schema";
import {
	brandLocalBBox,
	brandWorldBBox,
	calculateSegmentListBounds,
	type WorldBBox,
} from "../../../utils/geometry/bounds";
import { applyTransformToBounds } from "../../../utils/geometry/geometry";
import {
	applyRotate3DToSegments,
	applyRotate3DWithContext,
	createRotate3DProjectionContext,
	type Rotate3DFilter,
} from "../../filters/Rotate3DFilterProcessor";
import type { PipelineType, RenderState, TextState } from "../CanvasLayerTypes";
import { boundsAlmostEqual } from "../pipeline/DocumentCache";

interface TextRendererDeps {
	textState: TextState;
	renderState: RenderState;
	renderPath: (
		passEncoder: GPURenderPassEncoder,
		path: Path,
		alphaMultiplier: number,
		pipelineType: PipelineType,
	) => void;
}

export class TextElementRenderer {
	// Path-cache builds run every frame, so a persistently failing font (e.g. an
	// unresolved family) would spam the console. Log each distinct failure once.
	private readonly loggedPathCacheErrors = new Set<string>();

	public constructor(private readonly deps: TextRendererDeps) {}

	public renderText(
		passEncoder: GPURenderPassEncoder,
		element: TextElement,
		alphaMultiplier: number,
		pipelineType: PipelineType = "main",
	): void {
		if (!this.deps.textState.renderer) {
			console.warn("TextRenderer not available, skipping text element");
			return;
		}

		// Cache key depends on text content/style/layout, not element world position.
		// Position is applied later by offsetting local glyph paths.
		const cacheKey = this.deps.textState.renderer.computeTextCacheKey(element);
		const cachedText = this.deps.textState.pathCache.get(cacheKey);

		if (!cachedText) {
			// Path extraction is async; cache and request a follow-up frame.
			this.requestTextPathCache(cacheKey, element);

			// Fall back to stale cache for flicker-free rendering
			const staleEntry =
				this.deps.textState.stalePathCache.get(cacheKey) ??
				findStaleByElementId(this.deps.textState.stalePathCache, element.id);
			if (!staleEntry) return;
			this.renderCachedText(
				passEncoder,
				element,
				staleEntry,
				alphaMultiplier,
				pipelineType,
			);
			return;
		}

		// Fresh cache hit — clear stale entries for this element
		clearStaleEntriesForElement(this.deps.textState.stalePathCache, element.id);
		this.renderResolvedTextPaths(
			passEncoder,
			element,
			cachedText.paths,
			cachedText.localBounds,
			alphaMultiplier,
			pipelineType,
		);
	}

	private renderCachedText(
		passEncoder: GPURenderPassEncoder,
		element: TextElement,
		cached: { paths: Path[]; localBounds: BoundingBox },
		alphaMultiplier: number,
		pipelineType: PipelineType,
	): void {
		this.renderResolvedTextPaths(
			passEncoder,
			element,
			cached.paths,
			cached.localBounds,
			alphaMultiplier,
			pipelineType,
		);
	}

	private renderResolvedTextPaths(
		passEncoder: GPURenderPassEncoder,
		element: TextElement,
		paths: Path[],
		localBounds: BoundingBox,
		alphaMultiplier: number,
		pipelineType: PipelineType,
	): void {
		this.syncTextBoundsIfNeeded(element, localBounds);
		const ox = element.x;
		const oy = element.y;
		const worldBounds = toWorldBounds(localBounds, ox, oy);

		// Axis path appearances render as an underlay so the text stays on top
		this.renderAxisAppearanceUnderlay(
			passEncoder,
			element,
			alphaMultiplier,
			pipelineType,
			ox,
			oy,
		);

		// Content-derived paint comes from the flow-chain head (the single
		// owner of runs/styles); flow targets have empty content of their own.
		// Per-member appearance filters stay frame-local.
		const paintStyle =
			this.deps.textState.renderer?.getFlowHead(element).defaultStyle ??
			element.defaultStyle;
		const defaultBrushWidth =
			paintStyle.strokeWidth ?? Math.max(1, paintStyle.fontSize * 0.03);

		const geometryFilters = (element.filters ?? []).filter(
			(f) =>
				f.processor !== "fill" &&
				f.processor !== "stroke" &&
				f.processor !== "content",
		);
		const sharedRotate3DFilters = geometryFilters.filter(
			(f) => f.processor === "3d-rotate" && f.enabled !== false,
		) as Rotate3DFilter[];
		const perPathGeometryFilters = geometryFilters.filter(
			(f) => f.processor !== "3d-rotate",
		);
		const worldPathSegments = paths.map((path) =>
			path.segments.map((seg) => ({
				...seg,
				start: seg.start
					? { ...seg.start, x: seg.start.x + ox, y: seg.start.y + oy }
					: undefined,
				cp1: seg.cp1,
				cp2: seg.cp2,
				end: { ...seg.end, x: seg.end.x + ox, y: seg.end.y + oy },
			})),
		);
		const sharedRotate3DContexts = sharedRotate3DFilters.map((filter) =>
			createRotate3DProjectionContext(
				filter.paramData.params,
				worldPathSegments.flat(),
				worldBounds,
			),
		);

		for (const [pathIndex, path] of paths.entries()) {
			const offsetFilters = buildGlyphPaintFilters({
				elementFilters: element.filters,
				glyphFilters: path.filters,
				defaultFill: paintStyle.fill ?? null,
				defaultStroke: paintStyle.stroke ?? null,
				defaultBrushWidth,
			});

			if (perPathGeometryFilters.length > 0) {
				offsetFilters.unshift(...perPathGeometryFilters);
			}

			let segments = worldPathSegments[pathIndex] as Path["segments"];
			for (const [filterIndex, filter] of sharedRotate3DFilters.entries()) {
				const context = sharedRotate3DContexts[filterIndex];
				segments = context
					? (applyRotate3DWithContext(segments, context) as Path["segments"])
					: (applyRotate3DToSegments(
							segments,
							filter.paramData.params,
							worldBounds,
						) as Path["segments"]);
			}

			const offsetPath: Path = {
				...path,
				filters: offsetFilters,
				opacity: element.opacity,
				blendMode: element.blendMode,
				segments,
			};
			this.deps.renderPath(
				passEncoder,
				offsetPath,
				alphaMultiplier,
				pipelineType,
			);
		}
	}

	/**
	 * Guide axis paths never paint in their own z-slot; when the user applies
	 * appearance filters to one, they render here as an underlay of the bound
	 * text (the text always stays on top). The path's base paint stays
	 * suppressed — only the appearance stack renders, Illustrator-style.
	 * Geometry uses the same pulled-back local space as the glyph paths so
	 * the text's transform re-applies it to the true world position.
	 */
	private renderAxisAppearanceUnderlay(
		passEncoder: GPURenderPassEncoder,
		element: TextElement,
		alphaMultiplier: number,
		pipelineType: PipelineType,
		ox: number,
		oy: number,
	): void {
		if (!element.axisBinding) return;
		const textRenderer = this.deps.textState.renderer;
		const axisPath = textRenderer?.getAxisPathObject?.(element);
		if (!axisPath) return;

		const filters = (axisPath.filters ?? []).filter(
			(f) => f.enabled !== false && f.processor !== "content",
		);
		if (filters.length === 0) return;

		// Two texts can bind one path — paint the underlay once per frame
		const painted = this.deps.renderState.paintedAxisPathIds;
		if (painted?.has(axisPath.id)) return;
		painted?.add(axisPath.id);

		const segments = textRenderer?.getAxisLocalSegments?.(element);
		if (!segments || segments.length === 0) return;
		const worldSegments = segments.map((seg) => ({
			...seg,
			start: seg.start
				? { ...seg.start, x: seg.start.x + ox, y: seg.start.y + oy }
				: undefined,
			end: { ...seg.end, x: seg.end.x + ox, y: seg.end.y + oy },
		}));

		this.deps.renderPath(
			passEncoder,
			{
				type: "path",
				id: axisPath.id,
				segments: worldSegments,
				// Documents from before the underlay carry the legacy guide-ify
				// opacity 0; the render skip is the hiding mechanism now
				opacity: axisPath.opacity === 0 ? 1 : axisPath.opacity,
				blendMode: axisPath.blendMode,
				transform: createIdentityTransform(),
				filters,
			},
			alphaMultiplier,
			pipelineType,
		);
	}

	/**
	 * Warp-ready glyph outline paths for a mesh warp container's text child:
	 * element-local space (x/y NOT applied), per-glyph paint filters resolved
	 * the same way renderResolvedTextPaths does. Returns null while the async
	 * glyph layout is pending (a follow-up render is requested).
	 */
	public getWarpGlyphPaths(element: TextElement): Path[] | null {
		if (!this.deps.textState.renderer) return null;
		const cacheKey = this.deps.textState.renderer.computeTextCacheKey(element);
		const cached = this.deps.textState.pathCache.get(cacheKey);
		if (!cached) {
			this.requestTextPathCache(cacheKey, element);
			return null;
		}

		const paintStyle =
			this.deps.textState.renderer.getFlowHead(element).defaultStyle ??
			element.defaultStyle;
		const defaultBrushWidth =
			paintStyle.strokeWidth ?? Math.max(1, paintStyle.fontSize * 0.03);
		// Geometry filters other than paint are dropped for warped glyphs; the
		// Coons warp replaces them as the deformation of record.
		return cached.paths.map((path) => ({
			...path,
			filters: buildGlyphPaintFilters({
				elementFilters: element.filters,
				glyphFilters: path.filters,
				defaultFill: paintStyle.fill ?? null,
				defaultStroke: paintStyle.stroke ?? null,
				defaultBrushWidth,
			}),
			opacity: element.opacity,
			blendMode: element.blendMode,
		}));
	}

	public async ensureTextPaths(element: TextElement): Promise<void> {
		if (!this.deps.textState.renderer) return;
		const cacheKey = this.deps.textState.renderer.computeTextCacheKey(element);
		if (this.deps.textState.pathCache.has(cacheKey)) return;

		this.deps.textState.pendingPathCacheKeys.add(cacheKey);
		try {
			const result =
				await this.deps.textState.renderer.textElementToPaths(element);
			const localBounds = toLocalBounds(result.bounds, element.x, element.y);
			this.deps.textState.pathCache.set(cacheKey, {
				paths: result.paths,
				localBounds,
			});
		} catch (err) {
			console.error("Failed to build text path cache:", err);
		} finally {
			this.deps.textState.pendingPathCacheKeys.delete(cacheKey);
		}
	}

	public requestTextPathCache(cacheKey: string, element: TextElement): void {
		if (
			!this.deps.textState.renderer ||
			this.deps.textState.pendingPathCacheKeys.has(cacheKey)
		) {
			return;
		}

		this.deps.textState.pendingPathCacheKeys.add(cacheKey);
		this.deps.textState.renderer
			.textElementToPaths(element)
			.then((result) => {
				const localBounds = toLocalBounds(result.bounds, element.x, element.y);
				this.deps.textState.pathCache.set(cacheKey, {
					paths: result.paths,
					localBounds,
				});
				this.deps.textState.onRequestRender?.();
			})
			.catch((err) => {
				const key = String(err instanceof Error ? err.message : err);
				if (!this.loggedPathCacheErrors.has(key)) {
					this.loggedPathCacheErrors.add(key);
					console.error("Failed to build text path cache:", err);
				}
			})
			.finally(() => {
				this.deps.textState.pendingPathCacheKeys.delete(cacheKey);
			});
	}

	public syncTextBoundsIfNeeded(
		element: TextElement,
		localBounds: BoundingBox,
	): void {
		if (
			!this.deps.textState.onTextBoundsComputed ||
			!this.deps.renderState.boundsCache
		) {
			return;
		}

		// Bound texts hit-test on their whole axis region, not just glyph ink.
		// Syncing ink-only bounds would drop the empty region area out of the
		// spatial index, making it unclickable with the text tool.
		const syncBounds = element.axisBinding
			? unionWithAxisBounds(
					localBounds,
					this.deps.textState.renderer?.getAxisLocalSegments(element) ?? null,
				)
			: localBounds;

		const worldBounds = toWorldBounds(syncBounds, element.x, element.y);

		// worldBounds is element-position-offset (same coordinate space as
		// calculateLocalElementBounds), not yet transformed by element.transform.
		const preTransformBounds = brandLocalBBox(worldBounds);

		// Update ViewportManager's local bounds cache so rotation origin
		// uses the precise text layout bounds instead of the initial estimate.
		this.deps.renderState.localBoundsCache?.set(element.id, preTransformBounds);

		// Apply element.transform so the BBox matches the vertex-shader rendering position.
		const transformedBounds = isIdentityTransform(element.transform)
			? worldBounds
			: applyTransformToBounds(worldBounds, element.transform);
		const cachedBounds = this.deps.renderState.boundsCache.get(element.id);
		if (cachedBounds && boundsAlmostEqual(cachedBounds, transformedBounds)) {
			return;
		}
		this.deps.textState.onTextBoundsComputed(
			element.id,
			transformedBounds,
			preTransformBounds,
		);
	}

	public invalidateTextCache(elementId?: string): void {
		if (elementId) {
			for (const [key, entry] of this.deps.textState.pathCache) {
				if (key.startsWith(`${elementId}:`)) {
					this.deps.textState.stalePathCache.set(key, entry);
					this.deps.textState.pathCache.delete(key);
					this.deps.textState.pendingPathCacheKeys.delete(key);
				}
			}
		} else {
			for (const [key, entry] of this.deps.textState.pathCache) {
				this.deps.textState.stalePathCache.set(key, entry);
			}
			this.deps.textState.pathCache.clear();
			this.deps.textState.pendingPathCacheKeys.clear();
		}
	}
}

function findStaleByElementId(
	staleCache: Map<string, { paths: Path[]; localBounds: BoundingBox }>,
	elementId: string,
): { paths: Path[]; localBounds: BoundingBox } | undefined {
	// Latest entry wins: during rapid typing several generations pile up and
	// the oldest snapshot would freeze the visible text until typing stops
	let latest: { paths: Path[]; localBounds: BoundingBox } | undefined;
	for (const [key, entry] of staleCache) {
		if (key.startsWith(`${elementId}:`)) latest = entry;
	}
	return latest;
}

function clearStaleEntriesForElement(
	staleCache: Map<string, unknown>,
	elementId: string,
): void {
	for (const key of staleCache.keys()) {
		if (key.startsWith(`${elementId}:`)) staleCache.delete(key);
	}
}

function toLocalBounds(bounds: BoundingBox, x: number, y: number): BoundingBox {
	return {
		minX: bounds.minX - x,
		minY: bounds.minY - y,
		maxX: bounds.maxX - x,
		maxY: bounds.maxY - y,
		width: bounds.width,
		height: bounds.height,
	};
}

/**
 * Union glyph-ink bounds with the axis path's local bounds. Returns the ink
 * bounds unchanged when the axis geometry can't be resolved.
 */
function unionWithAxisBounds(
	localBounds: BoundingBox,
	axisSegments: CubicBezierSegment[] | null,
): BoundingBox {
	const axis = axisSegments ? calculateSegmentListBounds(axisSegments) : null;
	if (!axis) return localBounds;
	const minX = Math.min(localBounds.minX, axis.minX);
	const minY = Math.min(localBounds.minY, axis.minY);
	const maxX = Math.max(localBounds.maxX, axis.maxX);
	const maxY = Math.max(localBounds.maxY, axis.maxY);
	return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

/**
 * Ordered per-glyph paint list resolved from the element's appearance stack.
 * "content" stands for the glyph's intrinsic fill (per-run fill, else the
 * default style fill) and paints at its stack position; legacy elements with
 * no content entry paint the intrinsic fill below the stack. Fill/stroke
 * appearances overpaint in stack order and disabled entries are skipped. A
 * default-style stroke applies only while no stroke appearance exists.
 */
export function buildGlyphPaintFilters(opts: {
	elementFilters: Filter[] | undefined;
	glyphFilters: Filter[] | undefined;
	defaultFill: FillParams["fill"] | null;
	defaultStroke: StrokeParams["strokeColor"] | null;
	defaultBrushWidth: number;
}): Filter[] {
	const {
		elementFilters,
		glyphFilters,
		defaultFill,
		defaultStroke,
		defaultBrushWidth,
	} = opts;

	const runFillEntry = (glyphFilters ?? []).find(
		(f): f is FillAppearance => f.processor === "fill",
	);
	const passthrough = (glyphFilters ?? []).filter(
		(f) => f.processor !== "fill",
	);

	const paint: Filter[] = [];
	const paintIntrinsic = () => {
		// The per-run fill entry passes through as-is (uid/params intact)
		if (runFillEntry) {
			paint.push(runFillEntry);
			return;
		}
		if (defaultFill == null) return;
		paint.push({
			processor: "fill",
			opacity: 1,
			blendMode: "normal",
			paramData: { version: "1", params: { fill: defaultFill } },
		} as FillAppearance);
	};

	const hasContentEntry = (elementFilters ?? []).some(
		(f) => f.processor === "content",
	);
	if (!hasContentEntry) paintIntrinsic();

	let hasStrokeApp = false;
	for (const app of elementFilters ?? []) {
		if (app.enabled === false) continue;
		if (app.processor === "content") {
			paintIntrinsic();
		} else if (app.processor === "fill") {
			paint.push({ ...(app as FillAppearance) });
		} else if (app.processor === "stroke") {
			hasStrokeApp = true;
			const params = (app as StrokeAppearance).paramData.params;
			paint.push({
				...(app as StrokeAppearance),
				paramData: {
					version: "1",
					params: {
						strokeColor: params.strokeColor,
						brushSettings:
							params.brushSettings ??
							createStrokeBrushSettings(defaultBrushWidth),
					},
				},
			} as StrokeAppearance);
		}
	}

	// Default-style stroke paints on top only while no stroke appearance
	// overrides it (legacy behavior)
	if (!hasStrokeApp && defaultStroke != null) {
		paint.push({
			processor: "stroke",
			opacity: 1,
			blendMode: "normal",
			paramData: {
				version: "1",
				params: {
					strokeColor: defaultStroke,
					brushSettings: createStrokeBrushSettings(defaultBrushWidth),
				},
			},
		} as StrokeAppearance);
	}

	return [...passthrough, ...paint];
}

function toWorldBounds(bounds: BoundingBox, x: number, y: number): WorldBBox {
	// Brand boundary: translating local text bounds by element position produces world-space bounds
	return brandWorldBBox({
		minX: bounds.minX + x,
		minY: bounds.minY + y,
		maxX: bounds.maxX + x,
		maxY: bounds.maxY + y,
		width: bounds.width,
		height: bounds.height,
	});
}
