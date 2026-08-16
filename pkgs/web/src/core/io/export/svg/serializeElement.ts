import { resolveBrushRenderRoute } from "../../../brush/renderRoute";
import type { FilterRenderer } from "../../../renderer/canvas/pipeline/FilterRenderer";
import { resolveElementGeometry } from "../../../renderer/canvas/pipeline/PreFilterRenderer";
import {
	type AnyArtObject,
	type BoundingBox,
	type CompoundPath,
	type CubicBezierSegment,
	type Document,
	type ElementTransform,
	type FillAppearance,
	type FillColor,
	type Group,
	getTransform,
	type ImageObject,
	isFilterEnabled,
	isIdentityTransform,
	isVisibleFill,
	type ObjectMask,
	type Path,
	type PathSegment,
	type PatternFill,
	type StrokeAppearance,
	type TextElement,
} from "../../../schema";
import {
	boundsIntersect,
	calculateLocalElementBounds,
	calculateSegmentListBounds,
	expandBounds,
} from "../../../utils/geometry/bounds";
import { bakeCompoundPathSegments } from "../../../utils/geometry/compoundBake";
import { composeTransforms } from "../../../utils/geometry/geometry";
import {
	reconstructSegmentsFromWorld,
	transformSegmentsToWorld,
} from "../../../utils/geometry/segmentOps";
import {
	type ClassifyOptions,
	isVisibleStroke,
	planLayerItems,
} from "./classify";
import { bytesToDataUrl } from "./dataUrl";
import {
	colorToSvgPaint,
	gradientToSvgPaint,
	type SvgPaint,
} from "./paintServer";
import {
	boundsUnitAffine,
	composeWorldAffine,
	createCoordMapper,
	elementTransformToWorldAffine,
	type SvgCoordMapper,
	segmentsToPathData,
	svgMatrixToString,
	uniformTransformScale,
	type WorldAffine,
} from "./pathData";
import type { RasterChunkResult } from "./rasterChunk";
import type { SvgDocumentBuilder, SvgNode } from "./svgBuilder";

/** Everything element serialization needs, wired once by the exporter. */
export interface SerializeContext {
	document: Document;
	/** Map view of document.objects for bounds helpers that need one. */
	elementsMap: ReadonlyMap<string, AnyArtObject>;
	builder: SvgDocumentBuilder;
	mapper: SvgCoordMapper;
	viewBox: { width: number; height: number };
	classify: ClassifyOptions;
	/**
	 * Region this context's output can actually show, in the SAME space the
	 * geometry is serialized in (world artboard bounds; the tile rect for
	 * pattern-tile serialization). Elements whose painted bounds do not reach
	 * it are dropped instead of shipping invisible markup.
	 */
	cullBounds: BoundingBox;
	filterResolver: Pick<FilterRenderer, "getHandler">;
	outlineText(element: TextElement): Promise<{
		outlinedPaths: Array<{
			path: Path;
			runIndex: number;
			paragraphIndex: number;
		}>;
		bounds: BoundingBox;
	}>;
	/** Flow-chain head carrying the run styles (TextRenderer.getFlowHead). */
	getTextPaintSource(element: TextElement): TextElement;
	renderRasterRun(elementIds: string[]): Promise<RasterChunkResult | null>;
	/** Base <pattern> id per DefEntry id; null = unusable def. */
	patternBaseIds: Map<string, string | null>;
	/** Lazily-allocated shared defs (luminance-invert filter for inverted masks). */
	state: { invertFilterId: string | null };
}

/**
 * Serialize one z-ordered id list (layer elementIds / group childIds) into
 * SVG nodes: vector items are serialized in place, raster runs become
 * data-URL <image> chunks.
 */
export async function serializePlanItems(
	elementIds: readonly string[],
	ctx: SerializeContext,
	ancestorTransform?: ElementTransform,
): Promise<SvgNode[]> {
	const nodes: SvgNode[] = [];
	for (const item of planLayerItems(
		elementIds,
		ctx.classify,
		ancestorTransform,
	)) {
		if (item.kind === "raster") {
			const chunk = await ctx.renderRasterRun(item.elementIds);
			if (!chunk) continue;
			const topLeft = ctx.mapper.point({
				x: chunk.bounds.minX,
				y: chunk.bounds.maxY,
			});
			nodes.push({
				tag: "image",
				attrs: {
					x: topLeft.x,
					y: topLeft.y,
					width: chunk.bounds.width,
					height: chunk.bounds.height,
					preserveAspectRatio: "none",
					...(item.blendMode
						? { style: `mix-blend-mode:${item.blendMode}` }
						: {}),
					href: chunk.dataUrl,
				},
			});
			continue;
		}

		const element = ctx.document.objects[item.elementId];
		if (!element) continue;
		const node = await serializeVectorElement(element, ctx, ancestorTransform);
		if (node) nodes.push(node);
	}
	return nodes;
}

async function serializeVectorElement(
	element: AnyArtObject,
	ctx: SerializeContext,
	ancestorTransform?: ElementTransform,
): Promise<SvgNode | null> {
	switch (element.type) {
		case "path":
			return serializePathLike(
				element,
				element.segments,
				ctx,
				ancestorTransform,
			);
		case "compound-path":
			return serializePathLike(
				element,
				bakeCompoundPathSegments(element, (id) => ctx.document.objects[id]),
				ctx,
				ancestorTransform,
				compoundTransformOrigin(element, ctx),
			);
		case "group":
			return serializeGroup(element, ctx, ancestorTransform);
		case "image":
			return serializeImage(element, ctx, ancestorTransform);
		case "text":
			return serializeText(element, ctx, ancestorTransform);
		default:
			return null;
	}
}

// --- Path / CompoundPath ---

async function serializePathLike(
	element: Path | CompoundPath,
	localSegments: CubicBezierSegment[],
	ctx: SerializeContext,
	ancestorTransform?: ElementTransform,
	transformOrigin?: { x: number; y: number },
): Promise<SvgNode | null> {
	const geometry = resolveElementGeometry(
		localSegments,
		element.filters,
		ctx.filterResolver,
	);
	if (geometry.length === 0) return null;

	const composed = composeAncestor(ancestorTransform, getTransform(element));
	const origin = transformOrigin ??
		segmentsBoundsCenter(localSegments) ?? { x: 0, y: 0 };
	const worldSegments = bakeSegmentsToWorld(geometry, composed, origin);
	const d = segmentsToPathData(worldSegments, ctx.mapper);
	if (!d) return null;

	const worldBounds = calculateSegmentListBounds(worldSegments);
	if (!worldBounds) return null;

	// The renderer evaluates gradient/pattern uv in the element's LOCAL
	// (pre-transform) space (gradientFill.wgsl), so paints must ride the
	// element transform instead of the world-baked bbox.
	const localBounds = calculateSegmentListBounds(geometry);
	const localToWorld = elementTransformToWorldAffine(composed, origin);
	// A constant-width stroke scales with the transform in the renderer; a
	// non-uniform/skewed transform is classified as raster before reaching here.
	const strokeScale = uniformTransformScale(composed) ?? 1;

	// Cull elements whose painted area (geometry + stroke reach) cannot touch
	// the visible region — invisible markup must not ship in the export.
	const cullMargin = maxStrokeWidth(element) * strokeScale;
	if (
		!boundsIntersect(
			cullMargin > 0 ? expandBounds(worldBounds, cullMargin) : worldBounds,
			ctx.cullBounds,
		)
	) {
		return null;
	}

	const elementAlpha = element.opacity;
	const shapes: SvgNode[] = [];
	for (const filter of element.filters ?? []) {
		if (!isFilterEnabled(filter)) continue;
		if (filter.processor === "fill") {
			const fillAppearance = filter as FillAppearance;
			if (!isVisibleFill(fillAppearance)) continue;
			if (!localBounds) continue;
			const fill = fillAppearance.paramData.params.fill;
			const paint = await resolveFillPaint(
				fill,
				{ localBounds, localToWorld },
				ctx,
			);
			if (paint.paint === "none") continue;
			shapes.push({
				tag: "path",
				attrs: {
					d,
					fill: paint.paint,
					...opacityAttr(
						"fill-opacity",
						paint.opacity * filter.opacity * elementAlpha,
					),
				},
			});
		} else if (filter.processor === "stroke") {
			const node = strokeAppearanceToNode(
				filter as StrokeAppearance,
				d,
				strokeScale,
				elementAlpha,
			);
			if (node) shapes.push(node);
		}
	}
	if (shapes.length === 0) return null;

	// Element opacity is already distributed into each shape's paint opacity
	// (the renderer applies it per appearance, non-isolated), so the wrapper
	// must not add a second, isolated group opacity.
	return wrapElement(
		mergeFillStrokePairs(shapes),
		element,
		ctx,
		composed,
		{},
		false,
	);
}

/**
 * Collapse an adjacent fill `<path>` / stroke `<path>` pair of the same
 * geometry into one `<path fill stroke>`. A single SVG path paints fill then
 * stroke by default, matching a fill under its stroke; the reverse order is
 * expressed with `paint-order="stroke"`.
 */
function mergeFillStrokePairs(shapes: SvgNode[]): SvgNode[] {
	const merged: SvgNode[] = [];
	for (const shape of shapes) {
		const prev = merged.at(-1);
		if (
			prev &&
			prev.tag === "path" &&
			shape.tag === "path" &&
			prev.attrs.d === shape.attrs.d
		) {
			if (isFillOnlyPath(prev) && isStrokeOnlyPath(shape)) {
				const { d: _d, fill: _none, ...strokeAttrs } = shape.attrs;
				prev.attrs = { ...prev.attrs, ...strokeAttrs };
				continue;
			}
			if (isStrokeOnlyPath(prev) && isFillOnlyPath(shape)) {
				const { d: _d, ...fillAttrs } = shape.attrs;
				prev.attrs = { ...prev.attrs, ...fillAttrs, "paint-order": "stroke" };
				continue;
			}
		}
		merged.push(shape);
	}
	return merged;
}

function isFillOnlyPath(node: SvgNode): boolean {
	return node.attrs.fill !== "none" && node.attrs.stroke === undefined;
}

function isStrokeOnlyPath(node: SvgNode): boolean {
	return node.attrs.fill === "none" && node.attrs.stroke !== undefined;
}

/**
 * The renderer's GPU transform origin for a compound path is the center of
 * its SOURCES' bounds union (calculateCompoundPathBounds), not the boolean
 * result's bbox — subtract/intersect results differ.
 */
function compoundTransformOrigin(
	compound: CompoundPath,
	ctx: SerializeContext,
): { x: number; y: number } {
	const bounds = calculateLocalElementBounds(compound, ctx.elementsMap);
	return boundsCenter(bounds);
}

function strokeAppearanceToNode(
	appearance: StrokeAppearance,
	d: string,
	strokeScale: number,
	elementAlpha: number,
): SvgNode | null {
	const params = appearance.paramData.params;
	if (params.strokeColor.type !== "solid") return null;
	if (!isVisibleStroke(appearance)) return null;
	const paint = colorToSvgPaint(params.strokeColor.color);

	const settings = params.brushSettings
		? resolveBrushRenderRoute(params.brushSettings).settings
		: null;
	const stroking = settings?.stroking;
	const miterLimit = stroking?.miterLimit ?? 4;

	return {
		tag: "path",
		attrs: {
			d,
			fill: "none",
			stroke: paint.paint,
			...opacityAttr(
				"stroke-opacity",
				paint.opacity * appearance.opacity * elementAlpha,
			),
			"stroke-width": (settings?.properties.size?.base ?? 1) * strokeScale,
			"stroke-linecap": stroking?.lineCap ?? "round",
			"stroke-linejoin": stroking?.lineJoin ?? "round",
			// 4 is the SVG default
			...(miterLimit !== 4 ? { "stroke-miterlimit": miterLimit } : {}),
			...(stroking?.dashArray?.length
				? {
						"stroke-dasharray": stroking.dashArray
							.map((v) => v * strokeScale)
							.join(" "),
					}
				: {}),
			...(stroking?.dashOffset
				? { "stroke-dashoffset": stroking.dashOffset * strokeScale }
				: {}),
		},
	};
}

// --- Group ---

async function serializeGroup(
	group: Group,
	ctx: SerializeContext,
	ancestorTransform?: ElementTransform,
): Promise<SvgNode | null> {
	const composed = composeAncestor(ancestorTransform, getTransform(group));
	const childIds = group.childIds.filter((id) => id !== group.clipPathId);
	const children = await serializePlanItems(childIds, ctx, composed);
	if (children.length === 0) return null;

	const attrs: Record<string, string | number> = {};
	if (group.clipPathId) {
		const clipSource = ctx.document.objects[group.clipPathId];
		if (clipSource) {
			const clipId = await registerClipPath(clipSource, ctx, composed);
			if (clipId) attrs["clip-path"] = `url(#${clipId})`;
		}
	}

	return wrapElement(children, group, ctx, composed, attrs);
}

async function registerClipPath(
	clipSource: AnyArtObject,
	ctx: SerializeContext,
	ancestorTransform: ElementTransform | undefined,
): Promise<string | null> {
	const dList = await collectClipPathData(clipSource, ctx, ancestorTransform);
	if (dList.length === 0) return null;

	const id = ctx.builder.allocId("clip");
	ctx.builder.addDef({
		tag: "clipPath",
		attrs: { id, clipPathUnits: "userSpaceOnUse" },
		children: dList.map((d) => ({ tag: "path", attrs: { d } })),
	});
	return id;
}

async function collectClipPathData(
	clipSource: AnyArtObject,
	ctx: SerializeContext,
	ancestorTransform: ElementTransform | undefined,
): Promise<string[]> {
	const bakeToD = (
		localSegments: CubicBezierSegment[],
		transformOrigin?: { x: number; y: number },
	): string | null => {
		const geometry = resolveElementGeometry(
			localSegments,
			clipSource.filters,
			ctx.filterResolver,
		);
		if (geometry.length === 0) return null;
		const composed = composeAncestor(
			ancestorTransform,
			getTransform(clipSource),
		);
		const origin = transformOrigin ??
			segmentsBoundsCenter(localSegments) ?? { x: 0, y: 0 };
		const d = segmentsToPathData(
			bakeSegmentsToWorld(geometry, composed, origin),
			ctx.mapper,
		);
		return d || null;
	};

	if (clipSource.type === "path") {
		const d = bakeToD(clipSource.segments);
		return d ? [d] : [];
	}
	if (clipSource.type === "compound-path") {
		const d = bakeToD(
			bakeCompoundPathSegments(clipSource, (id) => ctx.document.objects[id]),
			compoundTransformOrigin(clipSource, ctx),
		);
		return d ? [d] : [];
	}
	if (clipSource.type === "text") {
		const outline = await ctx.outlineText(clipSource);
		const composed = composeAncestor(
			ancestorTransform,
			getTransform(clipSource),
		);
		const origin = boundsCenter(outline.bounds);
		return outline.outlinedPaths.flatMap(({ path }) => {
			const d = segmentsToPathData(
				transformWorldGlyph(path.segments, composed, origin),
				ctx.mapper,
			);
			return d ? [d] : [];
		});
	}
	return [];
}

// --- Image ---

async function serializeImage(
	image: ImageObject,
	ctx: SerializeContext,
	ancestorTransform?: ElementTransform,
): Promise<SvgNode | null> {
	const file = ctx.document.files.find((f) => f.uid === image.fileUid);
	if (!file) return null;

	const composed = composeAncestor(ancestorTransform, getTransform(image));
	// Image content space (origin top-left, Y down) → pre-transform world.
	const contentToLocal = {
		m00: 1,
		m01: 0,
		m10: 0,
		m11: -1,
		tx: image.x - image.width / 2,
		ty: image.y + image.height / 2,
	};
	const worldAffine = composeWorldAffine(
		elementTransformToWorldAffine(composed, { x: image.x, y: image.y }),
		contentToLocal,
	);

	const cornerBounds = affineRectBounds(worldAffine, image.width, image.height);
	if (!boundsIntersect(cornerBounds, ctx.cullBounds)) return null;

	const node: SvgNode = {
		tag: "image",
		attrs: {
			x: 0,
			y: 0,
			width: image.width,
			height: image.height,
			preserveAspectRatio: "none",
			transform: svgMatrixToString(ctx.mapper.composeWorld(worldAffine)),
			href: bytesToDataUrl(file.bin, file.type),
		},
	};
	return wrapElement([node], image, ctx, composed);
}

// --- Text ---

async function serializeText(
	element: TextElement,
	ctx: SerializeContext,
	ancestorTransform?: ElementTransform,
): Promise<SvgNode | null> {
	const outline = await ctx.outlineText(element);
	if (outline.outlinedPaths.length === 0) return null;

	const paintSource = ctx.getTextPaintSource(element);
	const composed = composeAncestor(ancestorTransform, getTransform(element));
	const origin = boundsCenter(outline.bounds);
	const localToWorld = elementTransformToWorldAffine(composed, origin);
	const strokeScale = uniformTransformScale(composed) ?? 1;
	const elementAlpha = element.opacity;

	const glyphNodes: SvgNode[] = [];
	for (const { path, runIndex, paragraphIndex } of outline.outlinedPaths) {
		const worldSegments = transformWorldGlyph(path.segments, composed, origin);
		const d = segmentsToPathData(worldSegments, ctx.mapper);
		if (!d) continue;

		const style =
			paintSource.content.paragraphs[paragraphIndex]?.runs[runIndex]?.style ??
			paintSource.defaultStyle;
		const fill = style.fill ?? paintSource.defaultStyle.fill ?? null;
		const stroke = style.stroke ?? paintSource.defaultStyle.stroke ?? null;
		const strokeWidth =
			(style.strokeWidth ?? paintSource.defaultStyle.strokeWidth ?? 1) *
			strokeScale;

		// Per-glyph culling: glyphs that cannot reach the visible region are
		// dropped; glyphs crossing the edge are kept whole.
		const glyphWorldBounds = calculateSegmentListBounds(worldSegments);
		if (
			!glyphWorldBounds ||
			!boundsIntersect(
				stroke ? expandBounds(glyphWorldBounds, strokeWidth) : glyphWorldBounds,
				ctx.cullBounds,
			)
		) {
			continue;
		}

		if (fill) {
			// Gradients are evaluated per glyph in the glyph's pre-transform
			// bounds, matching the renderer's per-glyph fill passes.
			const glyphLocalBounds = calculateSegmentListBounds(path.segments);
			if (glyphLocalBounds) {
				const paint = await resolveFillPaint(
					fill,
					{ localBounds: glyphLocalBounds, localToWorld },
					ctx,
				);
				if (paint.paint !== "none") {
					glyphNodes.push({
						tag: "path",
						attrs: {
							d,
							fill: paint.paint,
							...opacityAttr("fill-opacity", paint.opacity * elementAlpha),
						},
					});
				}
			}
		}
		if (stroke?.type === "solid") {
			const paint = colorToSvgPaint(stroke.color);
			if (paint.opacity > 0) {
				glyphNodes.push({
					tag: "path",
					attrs: {
						d,
						fill: "none",
						stroke: paint.paint,
						...opacityAttr("stroke-opacity", paint.opacity * elementAlpha),
						"stroke-width": strokeWidth,
						"stroke-linecap": "round",
						"stroke-linejoin": "round",
					},
				});
			}
		}
	}
	if (glyphNodes.length === 0) return null;

	// Element opacity rides each glyph shape (see serializePathLike).
	return wrapElement(glyphNodes, element, ctx, composed, {}, false);
}

/** Glyph outlines are already world-positioned; apply only a non-identity element transform. */
function transformWorldGlyph(
	segments: PathSegment[],
	composed: ElementTransform,
	origin: { x: number; y: number },
): PathSegment[] {
	if (isIdentityTransform(composed)) return segments;
	return reconstructSegmentsFromWorld(
		transformSegmentsToWorld(segments, composed, origin),
		segments,
	);
}

// --- Paint resolution ---

/**
 * The space a textured paint is evaluated in: the element's pre-transform
 * bounds plus the map carrying that local space into world coordinates —
 * mirroring the renderer, which samples gradient/pattern uv before the
 * element transform applies.
 */
interface PaintSpace {
	localBounds: BoundingBox;
	localToWorld: WorldAffine;
}

async function resolveFillPaint(
	fill: FillColor,
	space: PaintSpace,
	ctx: SerializeContext,
): Promise<SvgPaint> {
	switch (fill.type) {
		case "solid":
			return colorToSvgPaint(fill.color);
		case "linear":
		case "radial":
			return gradientToSvgPaint(
				fill,
				composeWorldAffine(
					space.localToWorld,
					boundsUnitAffine(space.localBounds),
				),
				ctx.mapper,
				ctx.builder,
			);
		case "pattern":
			return patternToSvgPaint(fill, space, ctx);
		default:
			// free / mesh gradients are classified as raster and never reach here.
			return { paint: "none", opacity: 1 };
	}
}

async function patternToSvgPaint(
	fill: PatternFill,
	space: PaintSpace,
	ctx: SerializeContext,
): Promise<SvgPaint> {
	if (!fill.defId) return { paint: "none", opacity: 1 };
	const baseId = await registerPatternBase(fill.defId, ctx);
	if (!baseId) return { paint: "none", opacity: 1 };

	// Forward tile map mirroring the unified shader's inverse sampling: tile
	// coords (Y down) → rotate → scale → offset in Y-down LOCAL space anchored
	// at the element's local-bbox top-left, then through the element transform.
	const sx = fill.scaleX || 1;
	const sy = fill.scaleY || 1;
	const cos = Math.cos(fill.rotation);
	const sin = Math.sin(fill.rotation);
	const tileToLocal = {
		m00: cos * sx,
		m01: -sin * sy,
		m10: -sin * sx,
		m11: -cos * sy,
		tx: space.localBounds.minX + fill.offsetX,
		ty: space.localBounds.maxY - fill.offsetY,
	};
	const tileToWorld = composeWorldAffine(space.localToWorld, tileToLocal);

	const id = ctx.builder.allocId("pat");
	ctx.builder.addDef({
		tag: "pattern",
		attrs: {
			id,
			href: `#${baseId}`,
			"xlink:href": `#${baseId}`,
			patternTransform: svgMatrixToString(ctx.mapper.composeWorld(tileToWorld)),
		},
	});
	return { paint: `url(#${id})`, opacity: 1 };
}

async function registerPatternBase(
	defId: string,
	ctx: SerializeContext,
): Promise<string | null> {
	const cached = ctx.patternBaseIds.get(defId);
	if (cached !== undefined) return cached;

	const def = ctx.document.defs?.[defId];
	if (!def?.tile || def.tile.width <= 0 || def.tile.height <= 0) {
		ctx.patternBaseIds.set(defId, null);
		return null;
	}

	// Register the id before serializing the tile so cyclic def references
	// resolve to the already-allocated pattern instead of recursing forever.
	const id = ctx.builder.allocId("pat");
	ctx.patternBaseIds.set(defId, id);

	// Def-local space (origin at tile center, Y up) → tile content space
	// (origin top-left, Y down) is exactly the artboard mapping.
	const tileMapper = createCoordMapper({
		id: defId,
		name: def.name ?? defId,
		x: 0,
		y: 0,
		width: def.tile.width,
		height: def.tile.height,
	});
	const halfW = def.tile.width / 2;
	const halfH = def.tile.height / 2;
	const children = await serializePlanItems(def.rootElementIds, {
		...ctx,
		mapper: tileMapper,
		cullBounds: {
			minX: -halfW,
			minY: -halfH,
			maxX: halfW,
			maxY: halfH,
			width: def.tile.width,
			height: def.tile.height,
		},
	});

	ctx.builder.addDef({
		tag: "pattern",
		attrs: {
			id,
			patternUnits: "userSpaceOnUse",
			width: def.tile.width,
			height: def.tile.height,
		},
		children,
	});
	return id;
}

// --- Element wrapper (opacity / blend / mask) ---

async function wrapElement(
	nodes: SvgNode[],
	element: AnyArtObject,
	ctx: SerializeContext,
	composedTransform: ElementTransform,
	extraAttrs: Record<string, string | number> = {},
	includeOpacity = true,
): Promise<SvgNode | null> {
	const attrs: Record<string, string | number> = { ...extraAttrs };
	if (includeOpacity && element.opacity < 1) attrs.opacity = element.opacity;
	if (element.blendMode !== "normal") {
		attrs.style = `mix-blend-mode:${element.blendMode}`;
	}
	if (element.mask && element.mask.enabled !== false) {
		const maskId = await registerMask(element.mask, ctx, composedTransform);
		if (maskId) {
			attrs.mask = `url(#${maskId})`;
		} else if (!element.mask.inverted) {
			// An enabled mask with no visible content is all-black luminance:
			// the owner is fully hidden (schema: "Empty = fully hidden").
			// An empty INVERTED mask is all-white and hides nothing.
			return null;
		}
	}

	if (Object.keys(attrs).length === 0) {
		return nodes.length === 1
			? nodes[0]
			: { tag: "g", attrs: {}, children: nodes };
	}
	return { tag: "g", attrs, children: nodes };
}

async function registerMask(
	mask: ObjectMask,
	ctx: SerializeContext,
	ownerTransform: ElementTransform,
): Promise<string | null> {
	// Mask element transforms are owner-local: the owner acts as their parent.
	// Mask content must NOT be culled against the artboard: a mask shape
	// moved off-artboard still drives the owner's alpha (absence = hidden).
	let content = await serializePlanItems(
		mask.elementIds,
		{ ...ctx, cullBounds: UNBOUNDED_CULL },
		ownerTransform,
	);
	if (content.length === 0) return null;

	if (mask.inverted) {
		// Keep = where the content is dark/absent: a white backdrop with the
		// content's luminance inverted on top (alpha preserved).
		content = [
			{
				tag: "rect",
				attrs: {
					x: 0,
					y: 0,
					width: ctx.viewBox.width,
					height: ctx.viewBox.height,
					fill: "#ffffff",
				},
			},
			{
				tag: "g",
				attrs: { filter: `url(#${ensureInvertFilter(ctx)})` },
				children: content,
			},
		];
	}

	const id = ctx.builder.allocId("mask");
	ctx.builder.addDef({
		tag: "mask",
		attrs: {
			id,
			maskUnits: "userSpaceOnUse",
			x: 0,
			y: 0,
			width: ctx.viewBox.width,
			height: ctx.viewBox.height,
		},
		children: content,
	});
	return id;
}

function ensureInvertFilter(ctx: SerializeContext): string {
	if (ctx.state.invertFilterId) return ctx.state.invertFilterId;
	const id = ctx.builder.allocId("filter");
	ctx.state.invertFilterId = id;
	ctx.builder.addDef({
		tag: "filter",
		attrs: { id },
		children: [
			{
				tag: "feColorMatrix",
				attrs: {
					// The renderer inverts sRGB-encoded values directly; the SVG
					// filter default (linearRGB) would diverge on midtones.
					"color-interpolation-filters": "sRGB",
					type: "matrix",
					values: "-1 0 0 0 1 0 -1 0 0 1 0 0 -1 0 1 0 0 0 1 0",
				},
			},
		],
	});
	return id;
}

// --- Shared helpers ---

function composeAncestor(
	ancestorTransform: ElementTransform | undefined,
	elementTransform: ElementTransform,
): ElementTransform {
	return ancestorTransform
		? composeTransforms(ancestorTransform, elementTransform)
		: elementTransform;
}

/** Cull rect used where nothing may be culled (mask content). */
const UNBOUNDED_CULL: BoundingBox = {
	minX: Number.NEGATIVE_INFINITY,
	minY: Number.NEGATIVE_INFINITY,
	maxX: Number.POSITIVE_INFINITY,
	maxY: Number.POSITIVE_INFINITY,
	width: Number.POSITIVE_INFINITY,
	height: Number.POSITIVE_INFINITY,
};

/**
 * Bake local geometry into identity-transform world segments, transforming
 * around `origin` — the ORIGINAL (pre-filter) geometry's bbox center for
 * paths, the source-union center for compound paths, matching the renderer's
 * transform origin.
 */
function bakeSegmentsToWorld(
	geometry: CubicBezierSegment[],
	composed: ElementTransform,
	origin: { x: number; y: number },
): PathSegment[] {
	return reconstructSegmentsFromWorld(
		transformSegmentsToWorld(geometry, composed, origin),
		geometry,
	);
}

function segmentsBoundsCenter(
	segments: CubicBezierSegment[],
): { x: number; y: number } | null {
	const bounds = calculateSegmentListBounds(segments);
	return bounds ? boundsCenter(bounds) : null;
}

/** Widest visible stroke of the element, as the geometry-bounds cull margin. */
function maxStrokeWidth(element: AnyArtObject): number {
	let width = 0;
	for (const filter of element.filters ?? []) {
		if (!isFilterEnabled(filter)) continue;
		if (filter.processor !== "stroke") continue;
		if (!isVisibleStroke(filter as StrokeAppearance)) continue;
		const params = (filter as StrokeAppearance).paramData.params;
		const settings = params.brushSettings
			? resolveBrushRenderRoute(params.brushSettings).settings
			: null;
		width = Math.max(width, settings?.properties.size?.base ?? 1);
	}
	return width;
}

/** World bbox of a w×h rect at the origin of `affine`'s input space. */
function affineRectBounds(
	affine: WorldAffine,
	width: number,
	height: number,
): BoundingBox {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const [u, v] of [
		[0, 0],
		[width, 0],
		[width, height],
		[0, height],
	]) {
		const x = affine.m00 * u + affine.m01 * v + affine.tx;
		const y = affine.m10 * u + affine.m11 * v + affine.ty;
		minX = Math.min(minX, x);
		minY = Math.min(minY, y);
		maxX = Math.max(maxX, x);
		maxY = Math.max(maxY, y);
	}
	return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

function boundsCenter(bounds: BoundingBox): { x: number; y: number } {
	return {
		x: (bounds.minX + bounds.maxX) / 2,
		y: (bounds.minY + bounds.maxY) / 2,
	};
}

function opacityAttr(
	name: "fill-opacity" | "stroke-opacity",
	value: number,
): Record<string, number> {
	return value < 1 ? { [name]: value } : {};
}
