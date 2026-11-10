import {
	buildImageQuadSegments,
	imageLocalBounds,
} from "../../document/elementGeometry/imageGeometry";
import {
	type AnyArtObject,
	type Document,
	type ElementTransform,
	getContainerChildIds,
	type PathSegment,
	type TextElement,
} from "../../schema";
import { bakeCompoundPathSegments } from "../../utils/geometry/generate/compoundBake";
import {
	placeElement,
	type WorldBezierSegment,
} from "../../utils/geometry/space/coordinates";
import {
	toWorldPath,
	transformSegmentsToWorld,
} from "../../utils/geometry/space/worldSegments";
import type { UIOverlay } from "./primitives";
import { OVERLAY_Z, UI_THEME } from "./theme";

/**
 * Builds the overlay that draws guides: the outline of every visible element
 * marked isGuide, and of everything inside one, as a cyan line above the
 * artboards. The document renderer skips guides, so this is the only place
 * they appear.
 *
 * A text guide is outlined by its glyphs. Laying them out is asynchronous, so
 * a text guide shows up once `onTextOutlined` reports its glyphs are ready.
 */
export class GuideOverlay {
	private readonly outlineText: (
		text: TextElement,
	) => Promise<PathSegment[][] | null>;
	private readonly onTextOutlined: () => void;
	/**
	 * Glyph outlines by the text object they were laid out for, so an edited
	 * text, which is a new object, is laid out again. null while pending.
	 */
	private readonly textOutlines = new WeakMap<
		TextElement,
		PathSegment[][] | null
	>();

	/**
	 * @param options.outlineText resolves to null when glyphs cannot be laid
	 *   out yet; the next build asks again.
	 */
	public constructor(options: {
		outlineText: (text: TextElement) => Promise<PathSegment[][] | null>;
		onTextOutlined: () => void;
	}) {
		this.outlineText = options.outlineText;
		this.onTextOutlined = options.onTextOutlined;
	}

	/** The guide overlay for `document`, or null when it shows no guide. */
	public build(document: Document): UIOverlay | null {
		const outlines: WorldBezierSegment[][] = [];
		const visit = (
			id: string,
			matrix: ElementTransform | null,
			inGuide: boolean,
		) => {
			const element = document.objects[id];
			if (!element || element.visible === false) return;
			const guide = inGuide || element.isGuide === true;
			const placed = placeElement(matrix, element);
			if (guide) {
				for (const segments of this.localOutlines(element)) {
					outlines.push(transformSegmentsToWorld(segments, placed));
				}
			}
			// A compound path's sources are drawn only as its boolean result.
			if (element.type === "compound-path") {
				const segments = guide
					? bakeCompoundPathSegments(
							element,
							(sourceId) => document.objects[sourceId],
							toWorldPath,
						)
					: [];
				if (segments.length > 0) {
					outlines.push(transformSegmentsToWorld(segments, placed));
				}
				return;
			}
			for (const childId of getContainerChildIds(element) ?? []) {
				visit(childId, placed, guide);
			}
		};
		for (const layer of document.layers) {
			if (!layer.visible) continue;
			for (const id of layer.elementIds) visit(id, null, false);
		}
		if (outlines.length === 0) return null;

		const stroke = {
			color: UI_THEME.colors.guide,
			width: UI_THEME.strokeWidth.guide,
		};
		return {
			zIndex: OVERLAY_Z.guide,
			primitives: outlines.map((segments) => ({
				kind: "bezierPath",
				segments,
				stroke,
			})),
		};
	}

	/**
	 * The outlines an element draws itself, in its local space. A container
	 * draws none; the elements inside it draw theirs.
	 */
	private localOutlines(element: AnyArtObject): PathSegment[][] {
		switch (element.type) {
			case "path":
				return element.segments.length > 0 ? [element.segments] : [];
			case "image":
				return [
					buildImageQuadSegments(imageLocalBounds(element), element.corners),
				];
			case "text":
				return this.glyphOutlines(element);
			default:
				return [];
		}
	}

	private glyphOutlines(text: TextElement): PathSegment[][] {
		const cached = this.textOutlines.get(text);
		if (cached !== undefined) return cached ?? [];

		this.textOutlines.set(text, null);
		this.outlineText(text)
			.catch((error: unknown) => {
				console.error("Failed to outline a text guide:", error);
				return [];
			})
			.then((outlines) => {
				if (!outlines) {
					this.textOutlines.delete(text);
					return;
				}
				this.textOutlines.set(text, outlines);
				this.onTextOutlined();
			});
		return [];
	}
}
