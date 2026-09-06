/**
 * TextRenderer
 * Renders TextElement through the existing WebGPU path rendering pipeline.
 * Glyph bezier paths are converted into regular path objects.
 */

import { createIdentityTransform } from "../document/factory";
import {
	type AnyArtObject,
	type BoundingBox,
	type CubicBezierSegment,
	type ElementTransform,
	type FillAppearance,
	generateUid,
	type Path,
	type TextElement,
} from "../schema";
import {
	brandWorldBBox,
	distanceToSegment,
	type WorldBBox,
} from "../utils/geometry/bounds";
import {
	inverseTransformPoint,
	inverseTransformVector,
} from "../utils/geometry/geometry";
import {
	getGlyphQuad,
	hitTestGlyphQuad,
	type TextGlyphQuad,
} from "./glyphQuad";
import {
	flattenClosedSubpaths,
	pointInPolygonsEvenOdd,
} from "./regionGeometry";

import type {
	LayoutedChar,
	LayoutResult,
	ResolvedTextRegionGeometry,
	TextLayoutEngine,
} from "./TextLayoutEngine";

/** Approximate ascent ratio within one fontSize for vertical character cells.
 *  Matches the horizontal line.baseline heuristic (lineHeight × 0.8). */
const VERTICAL_ASCENT_RATIO = 0.8;

/**
 * Document access injected by the engine facade. Keeps TextRenderer free of a
 * direct document dependency (tests can run without a document).
 */
export interface TextDocumentResolver {
	getElementById(id: string): AnyArtObject | null;
	/** World-space segments of the element (ancestor transforms applied) */
	getWorldSegments(id: string): CubicBezierSegment[] | null;
	/** Monotonic revision of the element's geometry, used in cache keys */
	getGeometryRevision(id: string): number;
	/**
	 * The text element whose flow.nextTextElementId === textId.
	 * With concurrent duplicate inflows (collaborative editing), the
	 * implementation must resolve deterministically (smallest element id wins).
	 */
	findFlowSource(textId: string): TextElement | null;
	/**
	 * Render-side affine of a text element (own ∘ ancestor transform with the
	 * renderer's rotation origin). resolveGeometry pulls world geometry back
	 * through its inverse so layout space matches the drawn glyph space for
	 * transformed texts.
	 */
	getTextTransform?(element: TextElement): {
		t: ElementTransform;
		origin: { x: number; y: number };
		isIdentity: boolean;
	};
}

/** Resolved flow chain: head holds the content, members are in flow order */
interface ResolvedFlowChain {
	head: TextElement;
	members: TextElement[];
}

/**
 * TextRenderer
 */
export class TextRenderer {
	private layoutEngine: TextLayoutEngine;
	private layoutCache = new Map<
		string,
		{ key: string; layout?: LayoutResult }
	>();
	private documentResolver: TextDocumentResolver | null = null;

	public constructor(layoutEngine: TextLayoutEngine) {
		this.layoutEngine = layoutEngine;
	}

	public setDocumentResolver(resolver: TextDocumentResolver | null): void {
		this.documentResolver = resolver;
	}

	/**
	 * Converts text layout output into path objects that CanvasLayer can render.
	 * Path geometry stays in local coordinates; bounds are returned in world space.
	 */
	public async textElementToPaths(element: TextElement): Promise<{
		paths: Path[];
		bounds: WorldBBox;
	}> {
		const layout = await this.getOrComputeLayout(element);
		const paths: Path[] = [];

		for (const char of layout.chars) {
			if (char.glyphPath.length === 0) continue; // spaces etc.

			const path = this.charToPath(char, element);
			paths.push(path);
		}

		// Brand boundary: translating local text layout bounds by element position produces world-space bounds
		const bounds: WorldBBox = brandWorldBBox({
			minX: layout.bounds.minX + element.x,
			minY: layout.bounds.minY + element.y,
			maxX: layout.bounds.maxX + element.x,
			maxY: layout.bounds.maxY + element.y,
			width: layout.bounds.width,
			height: layout.bounds.height,
		});

		return { paths, bounds };
	}

	/**
	 * Converts text glyphs into standalone Path objects in world coordinates,
	 * preserving the source Run mapping for per-character paint resolution.
	 */
	public async textElementToOutlinedPaths(element: TextElement): Promise<{
		outlinedPaths: Array<{
			path: Path;
			runIndex: number;
			paragraphIndex: number;
		}>;
		bounds: BoundingBox;
	}> {
		const layout = await this.getOrComputeLayout(element);
		const outlinedPaths: Array<{
			path: Path;
			runIndex: number;
			paragraphIndex: number;
		}> = [];

		const ox = element.x;
		const oy = element.y;

		for (const char of layout.chars) {
			if (char.glyphPath.length === 0) continue;

			// Offset anchor points by element position to produce world coordinates.
			// cp1/cp2 are relative offsets and remain unchanged.
			const worldSegments = char.glyphPath.map((seg) => ({
				...seg,
				start: seg.start
					? { ...seg.start, x: seg.start.x + ox, y: seg.start.y + oy }
					: undefined,
				end: { ...seg.end, x: seg.end.x + ox, y: seg.end.y + oy },
			}));

			outlinedPaths.push({
				path: {
					type: "path",
					id: generateUid("obj"),
					segments: worldSegments,
					opacity: 1,
					blendMode: "normal",
					transform: createIdentityTransform(),
				},
				runIndex: char.runIndex,
				paragraphIndex: char.paragraphIndex,
			});
		}

		const bounds: BoundingBox = {
			minX: layout.bounds.minX + ox,
			minY: layout.bounds.minY + oy,
			maxX: layout.bounds.maxX + ox,
			maxY: layout.bounds.maxY + oy,
			width: layout.bounds.width,
			height: layout.bounds.height,
		};

		return { outlinedPaths, bounds };
	}

	/**
	 * Get layout result with cache. Elements in a flow chain are laid out
	 * together via layoutFlow (one computation fills the cache for every
	 * member region).
	 */
	private async getOrComputeLayout(
		element: TextElement,
	): Promise<LayoutResult> {
		const key = this.computeTextCacheKey(element);
		const cached = this.layoutCache.get(element.id);
		if (cached?.key === key && cached.layout) return cached.layout;

		const chain = this.resolveFlowChain(element);
		const members = chain?.members ?? [element];
		const entries = members.map((member) => {
			const entry: { key: string; layout?: LayoutResult } = {
				key: this.computeTextCacheKey(member),
			};
			this.layoutCache.set(member.id, entry);
			return { member, entry };
		});
		const results = chain
			? await this.layoutEngine.layoutFlow(
					chain.head,
					members.map((member) => ({
						element: member,
						geometry: this.resolveGeometry(member),
					})),
				)
			: new Map([
					[
						element.id,
						await this.layoutEngine.layout(
							element,
							this.resolveGeometry(element),
						),
					],
				]);
		for (const { member, entry } of entries) {
			// Invalidations and newer requests supersede in-flight layout work.
			if (this.layoutCache.get(member.id) !== entry) continue;
			if (this.computeTextCacheKey(member) !== entry.key) continue;
			entry.layout = results.get(member.id);
		}
		const own = results.get(element.id);
		if (own) return own;
		return this.layoutEngine.layout(element, this.resolveGeometry(element));
	}

	/**
	 * Resolve the axisBinding path reference into element-local geometry.
	 * Returns undefined when there is no binding, no resolver, or the path is
	 * gone (dangling reference) — layout then falls back to plain text.
	 */
	private resolveGeometry(
		element: TextElement,
	): ResolvedTextRegionGeometry | undefined {
		const binding = element.axisBinding;
		if (!binding || !this.documentResolver) return undefined;
		const worldSegments = this.documentResolver.getWorldSegments(
			binding.pathObjectId,
		);
		if (!worldSegments || worldSegments.length === 0) return undefined;
		// The renderer draws glyphs at transform(x/y + local); invert the same
		// affine here so layout space and drawn space stay symmetric for
		// transformed texts (e.g. scope-compensated pastes, grouped texts)
		const tr = this.documentResolver.getTextTransform?.(element);
		const inv = tr && !tr.isIdentity ? tr : null;
		const ox = element.x;
		const oy = element.y;
		const toLocal = (p: { x: number; y: number }) => {
			const q = inv
				? inverseTransformPoint(p.x, p.y, inv.t, inv.origin.x, inv.origin.y)
				: p;
			return { x: q.x - ox, y: q.y - oy };
		};
		const segments = worldSegments.map((seg) => ({
			...seg,
			start: seg.start ? { ...seg.start, ...toLocal(seg.start) } : undefined,
			end: { ...seg.end, ...toLocal(seg.end) },
			// cp1/cp2 are anchor-relative vectors: linear part only
			...(inv
				? {
						cp1: {
							...seg.cp1,
							...inverseTransformVector(seg.cp1.x, seg.cp1.y, inv.t),
						},
						cp2: {
							...seg.cp2,
							...inverseTransformVector(seg.cp2.x, seg.cp2.y, inv.t),
						},
					}
				: {}),
		}));
		return { kind: binding.mode, segments };
	}

	/**
	 * Resolve the flow chain the element belongs to. Returns null when the
	 * element is not part of a chain (or no resolver is attached).
	 * Cycles (possible under concurrent collaborative linking) are cut by
	 * visited sets.
	 */
	private resolveFlowChain(element: TextElement): ResolvedFlowChain | null {
		const resolver = this.documentResolver;
		if (!resolver) return null;
		if (
			!element.flow?.nextTextElementId &&
			!resolver.findFlowSource(element.id)
		) {
			return null;
		}

		// Walk upstream to the head
		let head = element;
		const visitedUp = new Set<string>([element.id]);
		for (;;) {
			const source = resolver.findFlowSource(head.id);
			if (!source || visitedUp.has(source.id)) break;
			visitedUp.add(source.id);
			head = source;
		}

		// Walk downstream from the head
		const members: TextElement[] = [head];
		const visitedDown = new Set<string>([head.id]);
		let current = head;
		while (current.flow?.nextTextElementId) {
			const next = resolver.getElementById(current.flow.nextTextElementId);
			if (!next || next.type !== "text" || visitedDown.has(next.id)) break;
			visitedDown.add(next.id);
			members.push(next);
			current = next;
		}

		if (members.length <= 1) return null;
		return { head, members };
	}

	private geometryRevisionOf(element: TextElement): number {
		if (!element.axisBinding || !this.documentResolver) return 0;
		return this.documentResolver.getGeometryRevision(
			element.axisBinding.pathObjectId,
		);
	}

	/**
	 * Compute layout cache key.
	 * Includes all fields that affect layout. Plain text lays out in local
	 * coordinates, so x/y stay out of the key; axis-bound layout subtracts
	 * x/y from world path geometry (and inverts the render transform), so
	 * bound texts key on position and transform too.
	 */
	public computeTextCacheKey(element: TextElement): string {
		const s = element.defaultStyle;
		const base = `${element.id}:${JSON.stringify(element.content)}:${s.fontFamily}:${JSON.stringify(s.fontSource)}:${JSON.stringify(s.fontVariationSettings ?? {})}:${s.fontSize}:${s.fontWeight}:${s.fontStyle}:${s.letterSpacing}:${s.lineHeight ?? ""}:${JSON.stringify(element.layout)}:${this.boundGeometryKeyOf(element)}`;
		const chain = this.resolveFlowChain(element);
		if (!chain) return base;
		const signature = [
			JSON.stringify(chain.head.content),
			JSON.stringify(chain.head.defaultStyle),
			...chain.members.map(
				(member) =>
					`${member.id}|${JSON.stringify(member.layout)}|${this.boundGeometryKeyOf(member)}`,
			),
		].join(";");
		return `${base}:flow[${signature}]`;
	}

	/** Axis-binding portion of the cache key: binding, path revision, and the
	 *  layout inputs specific to bound texts (x/y and the render transform). */
	private boundGeometryKeyOf(element: TextElement): string {
		if (!element.axisBinding) return ":0";
		const tr = this.documentResolver?.getTextTransform?.(element);
		const t = tr && !tr.isIdentity ? tr : null;
		const transformKey = t
			? `${t.t.x},${t.t.y},${t.t.rotation},${t.t.scaleX},${t.t.scaleY}@${t.origin.x},${t.origin.y}`
			: "id";
		return `${JSON.stringify(element.axisBinding)}:${this.geometryRevisionOf(element)}:${element.x},${element.y}:${transformKey}`;
	}

	/**
	 * The chain head owning this element's rendered content (styles included),
	 * or the element itself when it is not part of a flow chain. Content-derived
	 * paint must resolve through this — flow targets have empty content.
	 */
	public getFlowHead(element: TextElement): TextElement {
		return this.resolveFlowChain(element)?.head ?? element;
	}

	/** Ordered chain members (head first) this element belongs to, or null */
	public getFlowChainMembers(element: TextElement): TextElement[] | null {
		return this.resolveFlowChain(element)?.members ?? null;
	}

	/** The axis path element this text is bound to, or null */
	public getAxisPathObject(element: TextElement): Path | null {
		const binding = element.axisBinding;
		if (!binding || !this.documentResolver) return null;
		const path = this.documentResolver.getElementById(binding.pathObjectId);
		return path?.type === "path" ? path : null;
	}

	/**
	 * Axis geometry in the text's layout-local space (world pulled back
	 * through the render transform and the x/y offset — same space as the
	 * glyph paths), or null when unbound / unresolvable.
	 */
	public getAxisLocalSegments(
		element: TextElement,
	): CubicBezierSegment[] | null {
		return this.resolveGeometry(element)?.segments ?? null;
	}

	/**
	 * First content-global char index laid out in this flow-target member,
	 * or null when the element is not a flow target or nothing flowed in.
	 */
	public async getFlowedRangeStart(
		element: TextElement,
	): Promise<number | null> {
		if (!this.documentResolver?.findFlowSource(element.id)) return null;
		const layout = await this.getOrComputeLayout(element);
		let min: number | null = null;
		for (const char of layout.chars) {
			if (char.synthetic) continue;
			if (min === null || char.charIndex < min) min = char.charIndex;
		}
		return min;
	}

	private charToPath(char: LayoutedChar, element: TextElement): Path {
		// Mostly geometry; run-level fill rides along as a per-glyph appearance
		// so per-character coloring survives into CanvasLayer.renderText
		// (element-level appearance overrides / defaults resolve there).
		// char run indices reference the chain head's content, so the fill
		// lookup must too — flow targets carry no runs of their own.
		const paintSource = this.getFlowHead(element);
		const runFill =
			paintSource.content.paragraphs[char.paragraphIndex]?.runs[char.runIndex]
				?.style?.fill;
		return {
			type: "path",
			id: `${element.id}-char-${char.charIndex}`,
			segments: char.glyphPath,
			opacity: 1,
			blendMode: "normal",
			transform: createIdentityTransform(),
			...(runFill
				? {
						filters: [
							{
								processor: "fill",
								opacity: 1,
								blendMode: "normal",
								paramData: { version: "1", params: { fill: runFill } },
							} as FillAppearance,
						],
					}
				: {}),
		};
	}

	/**
	 * Clear all layout cache entries.
	 */
	public clearLayoutCache(): void {
		this.layoutCache.clear();
	}

	/**
	 * Invalidate layout cache for a specific element.
	 */
	public invalidateLayout(elementId: string): void {
		this.layoutCache.delete(elementId);
	}

	/**
	 * Get text selection range as rectangles (one rect per line, using line height).
	 */
	public async getSelectionRects(
		element: TextElement,
		startIndex: number,
		endIndex: number,
	): Promise<
		Array<{
			x: number;
			y: number;
			width: number;
			height: number;
			rotation?: number;
		}>
	> {
		const layout = await this.getOrComputeLayout(element);
		const isVertical =
			element.layout.writingMode === "vertical-rl" ||
			element.layout.writingMode === "vertical-lr";

		// On-path text: one rotated quad per glyph
		if (layout.lines.length === 0 && layout.chars.length > 0) {
			return getOnPathSelectionRects(layout.chars, startIndex, endIndex);
		}

		const rects: Array<{
			x: number;
			y: number;
			width: number;
			height: number;
			rotation?: number;
		}> = [];

		for (const line of layout.lines) {
			const selected = line.chars.filter(
				(c) => c.charIndex >= startIndex && c.charIndex < endIndex,
			);
			if (selected.length === 0) continue;

			// Touch-type-adjusted chars get their own rotated quad; the
			// axis-aligned line span only covers runs of untouched chars
			const pushSpan = (from: number, to: number) => {
				if (from >= to) return;
				const first = selected[from];
				const last = selected[to - 1];
				if (isVertical) {
					const selTop = first.y + first.fontSize * VERTICAL_ASCENT_RATIO;
					const selBottom =
						last.y - last.fontSize * (1 - VERTICAL_ASCENT_RATIO);
					rects.push({
						x: line.x,
						y: selBottom,
						width: line.width,
						height: selTop - selBottom,
					});
				} else {
					rects.push({
						x: first.x,
						y: line.y + line.baseline - line.height,
						width: last.x + last.advanceWidth - first.x,
						height: line.height,
					});
				}
			};

			let spanStart = 0;
			for (let i = 0; i < selected.length; i++) {
				const char = selected[i];
				const isTateChuYoko = isVertical && char.tateChuYoko === true;
				if (!hasVisualOverride(char) && !isTateChuYoko) continue;
				pushSpan(spanStart, i);
				if (hasVisualOverride(char)) {
					const quad = getGlyphQuad(char, "baselineLeft");
					rects.push({
						x: quad.corners[0].x,
						y: quad.corners[0].y,
						width: quad.width,
						height: quad.height,
						rotation: quad.rotation,
					});
				} else {
					// Tate-chu-yoko: per-glyph horizontal rect inside the cell
					// (the column-wide span would highlight the whole cell width)
					rects.push({
						x: char.x,
						y: char.y - char.fontSize * (1 - VERTICAL_ASCENT_RATIO),
						width: char.advanceWidth,
						height: char.fontSize,
					});
				}
				spanStart = i + 1;
			}
			pushSpan(spanStart, selected.length);
		}
		return rects;
	}

	/** Rotated glyph quads (element-local) for the given content indices */
	public async getGlyphQuads(
		element: TextElement,
		charIndices: number[],
	): Promise<TextGlyphQuad[]> {
		const layout = await this.getOrComputeLayout(element);
		const onPath = layout.lines.length === 0 && layout.chars.length > 0;
		const wanted = new Set(charIndices);
		const quads: TextGlyphQuad[] = [];
		for (const char of layout.chars) {
			if (char.synthetic || !wanted.has(char.charIndex)) continue;
			quads.push(getGlyphQuad(char, onPath ? "center" : "baselineLeft"));
		}
		return quads;
	}

	/**
	 * Glyph hit test (touch-type char picking): returns the content index of
	 * the glyph whose rotated quad contains the point, else the nearest glyph
	 * within tolerance, else null. Unlike hitTestCharacter this identifies a
	 * glyph, not a caret insertion position.
	 */
	/**
	 * Synchronous hit test for axis-bound texts: hits near the axis spine
	 * (onPath), inside the region (inShape), or on a glyph quad from the
	 * cached layout. `localX`/`localY` are element-local including the x/y
	 * offset (SpatialIndex's pre-transform space). Returns null when the
	 * element has no binding or the binding doesn't resolve — callers fall
	 * back to their bounds test.
	 */
	public hitTestBoundTextSync(
		element: TextElement,
		localX: number,
		localY: number,
		tolerance: number,
	): boolean | null {
		if (!element.axisBinding) return null;
		const geometry = this.resolveGeometry(element);
		if (!geometry) return null;
		const px = localX - element.x;
		const py = localY - element.y;

		if (geometry.kind === "inShape") {
			const polygons = flattenClosedSubpaths(geometry.segments);
			if (pointInPolygonsEvenOdd(polygons, px, py)) return true;
		} else {
			let prevEnd: CubicBezierSegment["end"] | null = null;
			for (const seg of geometry.segments) {
				const { distance } = distanceToSegment(px, py, seg, prevEnd);
				if (distance <= tolerance) return true;
				prevEnd = seg.end;
			}
		}

		// Glyph ink from the cached layout only — pointer hit tests are sync,
		// so an uncached layout just means the path/region test decides
		const cached = this.layoutCache.get(element.id);
		const layout =
			cached?.key === this.computeTextCacheKey(element)
				? cached.layout
				: undefined;
		if (layout) {
			const onPath = layout.lines.length === 0 && layout.chars.length > 0;
			const anchor = onPath ? ("center" as const) : ("baselineLeft" as const);
			for (const char of layout.chars) {
				if (char.synthetic) continue;
				const quad = getGlyphQuad(char, anchor);
				if (hitTestGlyphQuad(quad, px, py, tolerance)) return true;
			}
		}
		return false;
	}

	public async hitTestGlyph(
		element: TextElement,
		localX: number,
		localY: number,
		tolerance = 0,
	): Promise<number | null> {
		const layout = await this.getOrComputeLayout(element);
		const onPath = layout.lines.length === 0 && layout.chars.length > 0;
		const anchor = onPath ? ("center" as const) : ("baselineLeft" as const);
		let nearest: number | null = null;
		let nearestDist = Number.POSITIVE_INFINITY;
		for (const char of layout.chars) {
			if (char.synthetic) continue;
			const quad = getGlyphQuad(char, anchor);
			if (hitTestGlyphQuad(quad, localX, localY)) return char.charIndex;
			if (tolerance > 0 && hitTestGlyphQuad(quad, localX, localY, tolerance)) {
				const d = (localX - quad.pivot.x) ** 2 + (localY - quad.pivot.y) ** 2;
				if (d < nearestDist) {
					nearestDist = d;
					nearest = char.charIndex;
				}
			}
		}
		return nearest;
	}

	public async getCursorPosition(
		element: TextElement,
		charIndex: number,
	): Promise<{ x: number; y: number; height: number; rotation?: number }> {
		const layout = await this.getOrComputeLayout(element);
		const isVertical =
			element.layout.writingMode === "vertical-rl" ||
			element.layout.writingMode === "vertical-lr";

		// On-path text has no line concept: caret follows the glyph tangent.
		if (layout.lines.length === 0 && layout.chars.length > 0) {
			return getOnPathCursorPosition(layout.chars, charIndex);
		}

		// Find the glyph containing the index (ligatures span multiple chars;
		// a mid-ligature caret snaps to the ligature start)
		const char = layout.chars.find(
			(c) => charIndex >= c.charIndex && charIndex < charEndIndex(c),
		);
		if (char) {
			const line = layout.lines.find((candidate) =>
				candidate.chars.some(
					(lineChar) => lineChar.charIndex === char.charIndex,
				),
			);

			if (isVertical) {
				if (char.tateChuYoko) {
					return tateChuYokoCaret(char, "before");
				}
				return {
					x: line ? line.x : char.x,
					y: char.y + char.fontSize * VERTICAL_ASCENT_RATIO,
					height: line?.width ?? char.fontSize,
				};
			}
			return {
				x: char.x,
				y: line ? line.y + line.baseline - line.height : char.y - char.fontSize,
				height: line?.height ?? char.fontSize,
			};
		}

		// No direct matching character:
		// compute caret position for empty paragraphs or line-end positions.
		for (let lineIdx = 0; lineIdx < layout.lines.length; lineIdx++) {
			const line = layout.lines[lineIdx];

			if (line.chars.length === 0) {
				const emptyLineCharIndex = this.getEmptyLineCharIndex(
					layout.lines,
					lineIdx,
				);

				if (charIndex === emptyLineCharIndex) {
					if (isVertical) {
						return {
							x: line.x,
							y: line.y,
							height: line.width || element.defaultStyle.fontSize,
						};
					}
					return {
						x: line.x,
						y: line.y + line.baseline - line.height,
						height: line.height,
					};
				}
				continue;
			}

			const lastChar = line.chars.at(-1)!;

			// For line-end caret (after the last glyph), defer if the same index
			// is the next line head.
			if (charIndex === charEndIndex(lastChar)) {
				const nextLine = layout.lines[lineIdx + 1];
				if (
					nextLine?.chars.length &&
					nextLine.chars[0].charIndex === charIndex
				) {
					continue; // process on next line
				}
				if (isVertical) {
					if (lastChar.tateChuYoko) {
						return tateChuYokoCaret(lastChar, "after");
					}
					return {
						x: line.x,
						y: lastChar.y - lastChar.fontSize * (1 - VERTICAL_ASCENT_RATIO),
						height: line.width,
					};
				}
				return {
					x: lastChar.x + lastChar.advanceWidth,
					y: line.y + line.baseline - line.height,
					height: line.height,
				};
			}
		}

		// End of full text.
		const lastChar = layout.chars.at(-1);
		if (lastChar) {
			const line = layout.lines.findLast(
				(candidate) => candidate.chars.at(-1)?.charIndex === lastChar.charIndex,
			);
			if (isVertical) {
				if (lastChar.tateChuYoko) {
					return tateChuYokoCaret(lastChar, "after");
				}
				return {
					x: line ? line.x : lastChar.x,
					y: lastChar.y - lastChar.fontSize * (1 - VERTICAL_ASCENT_RATIO),
					height: line?.width ?? lastChar.fontSize,
				};
			}
			return {
				x: lastChar.x + lastChar.advanceWidth,
				y: line
					? line.y + line.baseline - line.height
					: lastChar.y - lastChar.fontSize,
				height: line?.height ?? lastChar.fontSize,
			};
		}

		// Empty text fallback — return local coordinates (0-based),
		// consistent with the rest of this method. The caller adds element.x/y.
		const defaultLineHeight =
			element.defaultStyle.fontSize *
			(element.defaultStyle.lineHeight ??
				element.content.paragraphs[0]?.lineHeight ??
				1.5);
		return {
			x: 0,
			y: -defaultLineHeight,
			height: defaultLineHeight,
		};
	}

	/**
	 * Get target charIndex for up/down line navigation.
	 * Chooses the closest character in target line by preserving visual X.
	 */
	public async getLineNavigationTarget(
		element: TextElement,
		charIndex: number,
		direction: "up" | "down",
	): Promise<number | null> {
		const chain = this.resolveFlowChain(element);
		if (!chain) {
			const layout = await this.getOrComputeLayout(element);
			return this.lineNavigationInLayout(layout, charIndex, direction);
		}

		// Chain: navigate within the region first, then cross into the
		// adjacent region carrying the caret X in world space (goal column).
		const regionIndex = await this.findRegionIndexForCharIndex(
			chain,
			charIndex,
		);
		const member = chain.members[regionIndex];
		const layout = await this.getOrComputeLayout(member);
		const within = this.lineNavigationInLayout(layout, charIndex, direction);
		if (within !== null) return within;

		const worldX = caretLocalX(layout, charIndex) + member.x;
		const step = direction === "down" ? 1 : -1;
		for (
			let i = regionIndex + step;
			i >= 0 && i < chain.members.length;
			i += step
		) {
			const target = chain.members[i];
			const targetLayout = await this.getOrComputeLayout(target);
			const localX = worldX - target.x;
			if (targetLayout.lines.length > 0) {
				const lineIndex =
					direction === "down" ? 0 : targetLayout.lines.length - 1;
				const line = targetLayout.lines[lineIndex];
				if (line.chars.length === 0) {
					return this.getEmptyLineCharIndex(targetLayout.lines, lineIndex);
				}
				return nearestInsertionInChars(line.chars, localX);
			}
			if (targetLayout.chars.length > 0) {
				// On-path region behaves as a single traversable line
				return nearestInsertionInChars(targetLayout.chars, localX);
			}
			// Empty region: keep skipping in the same direction
		}
		return null;
	}

	/**
	 * Up/down navigation within a single layout. Returns null when the move
	 * crosses the first/last line (caller may continue into adjacent regions).
	 */
	private lineNavigationInLayout(
		layout: LayoutResult,
		charIndex: number,
		direction: "up" | "down",
	): number | null {
		if (layout.lines.length === 0) return null;

		const currentLineIndex = this.findLineIndexForCharIndex(
			layout.lines,
			charIndex,
		);

		// Select target line by direction.
		const targetLineIndex =
			direction === "up" ? currentLineIndex - 1 : currentLineIndex + 1;
		if (targetLineIndex < 0 || targetLineIndex >= layout.lines.length) {
			return null;
		}

		// Empty target line maps to its inferred start index.
		const targetLine = layout.lines[targetLineIndex];
		if (targetLine.chars.length === 0) {
			return this.getEmptyLineCharIndex(layout.lines, targetLineIndex);
		}

		// Resolve current visual cursor X.
		const currentLine = layout.lines[currentLineIndex];
		let cursorX: number;
		if (currentLine.chars.length === 0) {
			cursorX = currentLine.x;
		} else {
			const charInLine = currentLine.chars.find(
				(c) => c.charIndex === charIndex,
			);
			if (charInLine) {
				cursorX = charInLine.x;
			} else {
				const lastChar = currentLine.chars.at(-1);
				cursorX = lastChar ? lastChar.x + lastChar.advanceWidth : currentLine.x;
			}
		}

		return nearestInsertionInChars(targetLine.chars, cursorX);
	}

	/**
	 * Which flow-chain region the charIndex belongs to. Non-chained elements
	 * map to themselves; indices past the visible end clamp to the last
	 * region holding content.
	 */
	public async findRegionForCharIndex(
		element: TextElement,
		charIndex: number,
	): Promise<string> {
		const chain = this.resolveFlowChain(element);
		if (!chain) return element.id;
		const index = await this.findRegionIndexForCharIndex(chain, charIndex);
		return chain.members[index].id;
	}

	private async findRegionIndexForCharIndex(
		chain: ResolvedFlowChain,
		charIndex: number,
	): Promise<number> {
		let lastWithContent = 0;
		for (let i = 0; i < chain.members.length; i++) {
			const layout = await this.getOrComputeLayout(chain.members[i]);
			if (layout.chars.length === 0) continue;
			lastWithContent = i;
			const first = layout.chars[0].charIndex;
			const lastChar = layout.chars.at(-1)!;
			if (charIndex < first) return i;
			if (charIndex < charEndIndex(lastChar)) return i;
			if (charIndex === charEndIndex(lastChar)) {
				// Boundary index: prefer the next region when it starts with it
				const next = chain.members[i + 1];
				if (next) {
					const nextLayout = await this.getOrComputeLayout(next);
					if (nextLayout.chars[0]?.charIndex === charIndex) continue;
				}
				return i;
			}
		}
		return lastWithContent;
	}

	/**
	 * Overflow state of the element (chain members report their own region's
	 * state; the chain-final overflow lives on the last region).
	 * anchorLocal is the bottom-right of the laid-out bounds in local space.
	 */
	public async getOverflowState(element: TextElement): Promise<{
		hasOverflow: boolean;
		anchorLocal: { x: number; y: number };
	}> {
		const layout = await this.getOrComputeLayout(element);
		// On-path text has no region box: anchor at the last placed glyph so
		// the badge sits at the visible end of the text instead of an
		// ink-AABB corner (far away on curved spines). char.x is the glyph
		// center on the spine, so the trailing edge is half an advance away.
		if (layout.lines.length === 0 && layout.chars.length > 0) {
			const last = layout.chars.at(-1)!;
			return {
				hasOverflow: layout.hasOverflow,
				anchorLocal: { x: last.x + last.advanceWidth / 2, y: last.y },
			};
		}
		return {
			hasOverflow: layout.hasOverflow,
			anchorLocal: { x: layout.bounds.maxX, y: layout.bounds.minY },
		};
	}

	private getEmptyLineCharIndex(
		lines: import("./TextLayoutEngine").LayoutedLine[],
		lineIndex: number,
	): number {
		// Walk backward to the nearest non-empty line and count paragraph breaks
		// (not line breaks — soft-wrapped lines share a paragraph) in between.
		const target = lines[lineIndex];
		for (let i = lineIndex - 1; i >= 0; i--) {
			const prevLine = lines[i];
			if (prevLine.chars.length > 0) {
				const lastChar = prevLine.chars.at(-1)!;
				return (
					charEndIndex(lastChar) +
					(target.paragraphIndex - prevLine.paragraphIndex)
				);
			}
		}
		// All prior lines empty: one newline per preceding paragraph.
		return target.paragraphIndex;
	}

	private findLineIndexForCharIndex(
		lines: import("./TextLayoutEngine").LayoutedLine[],
		charIndex: number,
	): number {
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (line.chars.length === 0) {
				if (charIndex === this.getEmptyLineCharIndex(lines, i)) {
					return i;
				}
				continue;
			}
			const firstChar = line.chars[0].charIndex;
			const lineLast = line.chars.at(-1);
			if (
				lineLast != null &&
				charIndex >= firstChar &&
				charIndex <= charEndIndex(lineLast)
			) {
				return i;
			}
		}
		return lines.length - 1;
	}

	/**
	 * Get the charIndex at the start or end of the line containing charIndex.
	 */
	public async getLineStartEnd(
		element: TextElement,
		charIndex: number,
		which: "start" | "end",
	): Promise<number | null> {
		const layout = await this.getOrComputeLayout(element);
		if (layout.lines.length === 0) return null;

		const lineIndex = this.findLineIndexForCharIndex(layout.lines, charIndex);

		const line = layout.lines[lineIndex];
		if (line.chars.length === 0) {
			return this.getEmptyLineCharIndex(layout.lines, lineIndex);
		}

		if (which === "start") {
			return line.chars[0].charIndex;
		}
		return charEndIndex(line.chars.at(-1)!);
	}

	/**
	 * Resolve insertion index from local coordinates using a 2-stage approach:
	 * Stage 1: Find which line was clicked (Y for horizontal, X for vertical)
	 * Stage 2: Find which character within that line (X for horizontal, Y for vertical)
	 */
	public async hitTestCharacter(
		element: TextElement,
		localX: number,
		localY: number,
	): Promise<number | null> {
		const layout = await this.getOrComputeLayout(element);
		const isVertical =
			element.layout.writingMode === "vertical-rl" ||
			element.layout.writingMode === "vertical-lr";

		if (layout.lines.length === 0) {
			// On-path text: nearest glyph center, split along the tangent
			if (layout.chars.length > 0) {
				return hitTestOnPathChar(layout.chars, localX, localY);
			}
			return 0;
		}

		// Stage 1: Find line
		const lineIndex = this.findLineAtPosition(
			layout.lines,
			isVertical,
			localX,
			localY,
		);
		const line = layout.lines[lineIndex];

		// Empty line
		if (line.chars.length === 0) {
			return this.getEmptyLineCharIndex(layout.lines, lineIndex);
		}

		// Stage 2: Find character within line
		return this.findCharInLine(line, isVertical, localX, localY);
	}

	/**
	 * Stage 1: Find the line containing the click position.
	 * For horizontal text, uses localY against line vertical extents.
	 * For vertical text, uses localX against column horizontal extents.
	 */
	private findLineAtPosition(
		lines: import("./TextLayoutEngine").LayoutedLine[],
		isVertical: boolean,
		localX: number,
		localY: number,
	): number {
		const pos = isVertical ? localX : localY;

		// Horizontal: line.y is the baseline. Shift hit-test up by line.baseline
		// so each band covers the visible glyph area.
		// Vertical: glyphs are placed starting at line.x (left edge) extending
		// rightward to line.x + line.width. Columns progress right-to-left.

		// Clamp: above/right of first line
		const first = lines[0];
		const firstStart = isVertical
			? first.x + first.width
			: first.y + first.baseline;
		if (pos > firstStart) return 0;

		// Clamp: below/left of last line
		const last = lines[lines.length - 1];
		const lastEnd = isVertical ? last.x : last.y + last.baseline - last.height;
		if (pos <= lastEnd) return lines.length - 1;

		// Scan for containing line
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const lineStart = isVertical
				? line.x + line.width
				: line.y + line.baseline;
			const lineEnd = isVertical
				? line.x
				: line.y + line.baseline - line.height;
			if (pos <= lineStart && pos > lineEnd) return i;
		}

		// Gap fallback: nearest line by center distance
		let bestIndex = 0;
		let bestDist = Number.POSITIVE_INFINITY;
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const center = isVertical
				? line.x + line.width / 2
				: line.y + line.baseline - line.height / 2;
			const dist = Math.abs(pos - center);
			if (dist < bestDist) {
				bestDist = dist;
				bestIndex = i;
			}
		}
		return bestIndex;
	}

	/**
	 * Stage 2: Find the character insertion index within a line.
	 * For horizontal text, uses localX against char.x + advanceWidth.
	 * For vertical text, uses localY against char.y - fontSize.
	 */
	private findCharInLine(
		line: import("./TextLayoutEngine").LayoutedLine,
		isVertical: boolean,
		localX: number,
		localY: number,
	): number {
		const { chars } = line;

		// Touch-type overrides break the monotonic axis walk below: fall back
		// to the nearest glyph pivot with the usual half-split
		if (chars.some(hasVisualOverride)) {
			let best = chars[0];
			let bestDist = Number.POSITIVE_INFINITY;
			for (const char of chars) {
				const px = char.x + char.advanceWidth / 2;
				const dist = (localX - px) ** 2 + (localY - char.y) ** 2;
				if (dist < bestDist) {
					bestDist = dist;
					best = char;
				}
			}
			if (isVertical) {
				return verticalCaretHalfSplit(best, localX, localY);
			}
			const along =
				(localX - (best.x + best.advanceWidth / 2)) * Math.cos(best.rotation) +
				(localY - best.y) * Math.sin(best.rotation);
			return along < 0 ? best.charIndex : charEndIndex(best);
		}

		if (isVertical) {
			// Characters progress top-to-bottom (Y decreasing).
			// char.y is the glyph baseline; the visual top extends above
			// by ascent (~0.8 × fontSize). Shift boundaries accordingly.
			const firstTop = chars[0].y + chars[0].fontSize * VERTICAL_ASCENT_RATIO;
			if (localY > firstTop) return chars[0].charIndex;

			const lastChar = chars[chars.length - 1];
			const lastBottom =
				lastChar.y - lastChar.fontSize * (1 - VERTICAL_ASCENT_RATIO);
			if (localY <= lastBottom) return charEndIndex(lastChar);

			for (const char of chars) {
				const charTop = char.y + char.fontSize * VERTICAL_ASCENT_RATIO;
				const charBottom = charTop - char.fontSize;
				if (localY <= charTop && localY > charBottom) {
					// Tate-chu-yoko cell: cluster members share the band, so
					// resolve the caret along the horizontal axis instead
					if (char.tateChuYoko) {
						return hitTestTateChuYokoCell(chars, char, localX);
					}
					const midY = charTop - char.fontSize / 2;
					return localY > midY ? char.charIndex : charEndIndex(char);
				}
			}
		} else {
			// Characters progress left-to-right (X increasing)
			if (localX < chars[0].x) return chars[0].charIndex;

			const lastChar = chars[chars.length - 1];
			if (localX >= lastChar.x + lastChar.advanceWidth)
				return charEndIndex(lastChar);

			for (const char of chars) {
				const charLeft = char.x;
				const charRight = char.x + char.advanceWidth;
				if (localX >= charLeft && localX < charRight) {
					const midX = char.x + char.advanceWidth / 2;
					return localX < midX ? char.charIndex : charEndIndex(char);
				}
			}
		}

		// Fallback: nearest char by secondary axis distance
		let bestIndex = chars[0].charIndex;
		let bestDist = Number.POSITIVE_INFINITY;
		for (const char of chars) {
			const center = isVertical
				? char.y + char.fontSize * VERTICAL_ASCENT_RATIO - char.fontSize / 2
				: char.x + char.advanceWidth / 2;
			const dist = Math.abs((isVertical ? localY : localX) - center);
			if (dist < bestDist) {
				bestDist = dist;
				bestIndex = char.charIndex;
			}
		}
		// Apply half-split on nearest char
		const nearest = chars.find((c) => c.charIndex === bestIndex);
		if (nearest) {
			if (isVertical) {
				if (nearest.tateChuYoko) {
					return hitTestTateChuYokoCell(chars, nearest, localX);
				}
				return verticalCaretHalfSplit(nearest, localX, localY);
			}
			const midX = nearest.x + nearest.advanceWidth / 2;
			return localX < midX ? nearest.charIndex : charEndIndex(nearest);
		}
		return bestIndex;
	}
}

/**
 * Half-split caret decision for a glyph in vertical flow. Tate-chu-yoko
 * glyphs are horizontally composed, so their split axis is X instead of Y.
 */
function verticalCaretHalfSplit(
	char: import("./TextLayoutEngine").LayoutedChar,
	localX: number,
	localY: number,
): number {
	if (char.tateChuYoko) {
		const midX = char.x + char.advanceWidth / 2;
		return localX < midX ? char.charIndex : charEndIndex(char);
	}
	const midY =
		char.y + char.fontSize * VERTICAL_ASCENT_RATIO - char.fontSize / 2;
	return localY > midY ? char.charIndex : charEndIndex(char);
}

/**
 * Resolve the caret index inside a tate-chu-yoko cell along the horizontal
 * axis. `member` is any glyph of the cell; the cell spans the consecutive
 * tate-chu-yoko glyphs around it (matching the layout engine's clustering).
 */
function hitTestTateChuYokoCell(
	chars: import("./TextLayoutEngine").LayoutedChar[],
	member: import("./TextLayoutEngine").LayoutedChar,
	localX: number,
): number {
	const at = chars.indexOf(member);
	let first = at;
	while (first > 0 && chars[first - 1].tateChuYoko) first--;
	let last = at;
	while (last + 1 < chars.length && chars[last + 1].tateChuYoko) last++;

	if (localX < chars[first].x) return chars[first].charIndex;
	const lastChar = chars[last];
	if (localX >= lastChar.x + lastChar.advanceWidth) {
		return charEndIndex(lastChar);
	}
	for (let i = first; i <= last; i++) {
		const c = chars[i];
		if (localX >= c.x && localX < c.x + c.advanceWidth) {
			const midX = c.x + c.advanceWidth / 2;
			return localX < midX ? c.charIndex : charEndIndex(c);
		}
	}
	return member.charIndex;
}

/**
 * Caret for a glyph inside a tate-chu-yoko cell: an upright bar like
 * horizontal text, expressed as anchor(bottom) + rotation because the overlay
 * builder renders vertical-writing carets as horizontal bars by default.
 */
function tateChuYokoCaret(
	char: import("./TextLayoutEngine").LayoutedChar,
	side: "before" | "after",
): { x: number; y: number; height: number; rotation: number } {
	return {
		x: side === "before" ? char.x : char.x + char.advanceWidth,
		y: char.y - char.fontSize * (1 - VERTICAL_ASCENT_RATIO),
		height: char.fontSize,
		rotation: Math.PI / 2,
	};
}

// --- On-path caret/selection helpers ---
// On-path layouts have no lines; glyph anchors sit on the path with a tangent
// rotation. LayoutedChar.x/y is the glyph center along the advance direction.

const ON_PATH_DESCENT_RATIO = 1 - VERTICAL_ASCENT_RATIO;

function getOnPathCursorPosition(
	chars: LayoutedChar[],
	charIndex: number,
): { x: number; y: number; height: number; rotation: number } {
	const char = chars.find((c) => charEndIndex(c) > charIndex);
	if (char) {
		// Caret before the glyph: half an advance back along the tangent
		const half = char.advanceWidth / 2;
		return {
			x: char.x - Math.cos(char.rotation) * half,
			y: char.y - Math.sin(char.rotation) * half,
			height: char.fontSize,
			rotation: char.rotation,
		};
	}
	// End of (or beyond) the visible text: clamp to after the last glyph
	const last = chars.at(-1)!;
	const half = last.advanceWidth / 2;
	return {
		x: last.x + Math.cos(last.rotation) * half,
		y: last.y + Math.sin(last.rotation) * half,
		height: last.fontSize,
		rotation: last.rotation,
	};
}

function getOnPathSelectionRects(
	chars: LayoutedChar[],
	startIndex: number,
	endIndex: number,
): Array<{
	x: number;
	y: number;
	width: number;
	height: number;
	rotation?: number;
}> {
	const rects: Array<{
		x: number;
		y: number;
		width: number;
		height: number;
		rotation?: number;
	}> = [];
	for (const char of chars) {
		if (char.charIndex < startIndex || char.charIndex >= endIndex) continue;
		const cos = Math.cos(char.rotation);
		const sin = Math.sin(char.rotation);
		const halfAdv = char.advanceWidth / 2;
		const descent = char.fontSize * ON_PATH_DESCENT_RATIO;
		// Rect origin = baseline-left-bottom corner, rotated around itself
		rects.push({
			x: char.x + (-halfAdv * cos + descent * sin),
			y: char.y + (-halfAdv * sin - descent * cos),
			width: char.advanceWidth,
			height: char.fontSize,
			rotation: char.rotation,
		});
	}
	return rects;
}

function hitTestOnPathChar(
	chars: LayoutedChar[],
	localX: number,
	localY: number,
): number {
	let best = chars[0];
	let bestDist = Number.POSITIVE_INFINITY;
	for (const char of chars) {
		const dx = localX - char.x;
		const dy = localY - char.y;
		const dist = dx * dx + dy * dy;
		if (dist < bestDist) {
			bestDist = dist;
			best = char;
		}
	}
	// Split before/after by projecting the click onto the glyph tangent
	const along =
		(localX - best.x) * Math.cos(best.rotation) +
		(localY - best.y) * Math.sin(best.rotation);
	return along > 0 ? charEndIndex(best) : best.charIndex;
}

// --- Shared caret helpers ---

/** Nearest insertion index within a char sequence by X distance */
function nearestInsertionInChars(
	chars: LayoutedChar[],
	cursorX: number,
): number {
	let closestCharIndex = chars[0].charIndex;
	let closestDistance = Math.abs(chars[0].x - cursorX);

	for (const char of chars) {
		const dist = Math.abs(char.x - cursorX);
		if (dist < closestDistance) {
			closestDistance = dist;
			closestCharIndex = char.charIndex;
		}
		const rightEdge = char.x + char.advanceWidth;
		const distRight = Math.abs(rightEdge - cursorX);
		if (distRight < closestDistance) {
			closestDistance = distRight;
			closestCharIndex = charEndIndex(char);
		}
	}

	return closestCharIndex;
}

/** Content index just after the glyph (ligatures span multiple chars) */
function charEndIndex(char: LayoutedChar): number {
	return char.charIndex + (char.charLength ?? 1);
}

/** Local X of the caret at charIndex within a layout (for goal-column carry) */
function caretLocalX(layout: LayoutResult, charIndex: number): number {
	const char = layout.chars.find((c) => c.charIndex === charIndex);
	if (char) return char.x;
	const last = layout.chars.at(-1);
	if (last) return last.x + last.advanceWidth;
	return 0;
}

/** Whether a touch-type override visually displaced or rotated the glyph */
function hasVisualOverride(char: LayoutedChar): boolean {
	const o = char.override;
	return (
		o != null &&
		((o.offsetX ?? 0) !== 0 ||
			(o.offsetY ?? 0) !== 0 ||
			(o.rotation ?? 0) !== 0 ||
			(o.baselineShift ?? 0) !== 0)
	);
}
