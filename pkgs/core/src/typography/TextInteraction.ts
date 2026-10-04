import type { SpatialIndex } from "../document/SpatialIndex";
import type { TextDependencyIndex } from "../document/TextDependencyIndex";
import {
	type AnyArtObject,
	type Document,
	type ElementTransform,
	getContainerChildIds,
	isContainer,
	isIdentityTransform,
	type TextElement,
} from "../schema";
import {
	applyTransformToPoint,
	composeTransforms,
	cursorLocalToWorld,
	inverseTransform,
} from "../utils/geometry/geometry";
import type { TextGlyphQuad } from "./glyphQuad";
import type { TextRenderer } from "./TextRenderer";

interface TextInteractionOptions {
	getDocument: () => Document;
	getSpatialIndex: () => SpatialIndex;
	textDepIndex: TextDependencyIndex;
	getTextRenderer: () => TextRenderer | null;
	/** World-space distance within which the pointer still picks a glyph. */
	getHitTolerance: () => number;
}

type WorldRect = { x: number; y: number; width: number; height: number };

/**
 * World-space queries on laid-out text for the text tool and its overlays:
 * pointer hit tests, carets, selection rects and glyph quads. Each query
 * resolves the flow-chain region involved and maps between that region's
 * local layout space and world space. It never writes the document.
 */
export class TextInteraction {
	private readonly options: TextInteractionOptions;

	public constructor(options: TextInteractionOptions) {
		this.options = options;
	}

	/** The text's transform with every ancestor composed in. */
	public transformOf(text: TextElement): {
		t: ElementTransform;
		isIdentity: boolean;
	} {
		const ancestorT = this.options
			.getSpatialIndex()
			.getAncestorTransform(text.id);
		const t = ancestorT
			? composeTransforms(ancestorT, text.transform)
			: text.transform;
		return { t, isIdentity: isIdentityTransform(t) };
	}

	/** A mapping from the text's layout space to world space. */
	public localToWorld(
		text: TextElement,
	): (local: { x: number; y: number }) => { x: number; y: number } {
		const { t, isIdentity } = this.transformOf(text);
		return (local) => {
			const wx = local.x + text.x;
			const wy = local.y + text.y;
			return isIdentity ? { x: wx, y: wy } : applyTransformToPoint(wx, wy, t);
		};
	}

	/** The region whose flow link points at textId. */
	public findFlowSource(textId: string): TextElement | null {
		const sourceId = this.options.textDepIndex.findFlowSourceId(textId);
		if (!sourceId) return null;
		const source = this.options.getDocument().objects[sourceId];
		return source?.type === "text" ? source : null;
	}

	/** Flow chain members containing textId, head first. */
	public chainMembers(textId: string): TextElement[] {
		return this.resolveTexts(this.options.textDepIndex.chainMemberIds(textId));
	}

	/** The topmost text under the world point, reaching into containers. */
	public findTextAtPoint(worldX: number, worldY: number): TextElement | null {
		for (const layer of this.options.getDocument().layers) {
			const el = this.options
				.getSpatialIndex()
				.findElementAtPoint(layer.id, worldX, worldY, 5);
			if (el?.type === "text") return el;
			// Grouped texts resolve to their top-level container; drill
			// into it so the text tool still targets them through groups
			if (el && isContainer(el)) {
				const inner = this.findTextInContainerAtPoint(el, worldX, worldY, 5);
				if (inner) return inner;
			}
		}
		return null;
	}

	/** Content index of the glyph under the world point, or null. */
	public async hitTestGlyph(
		text: TextElement,
		worldX: number,
		worldY: number,
	): Promise<number | null> {
		const textRenderer = this.options.getTextRenderer();
		if (!textRenderer) return null;

		// Flow chains: pick within the region under the pointer
		const region = this.resolveRegionAtPoint(text, worldX, worldY);
		const local = this.toRegionLocal(region, worldX, worldY);
		return textRenderer.hitTestGlyph(
			region,
			local.x,
			local.y,
			this.options.getHitTolerance(),
		);
	}

	/** Caret index nearest to the world point, or null. */
	public async hitTestCharacter(
		text: TextElement,
		worldX: number,
		worldY: number,
	): Promise<number | null> {
		const textRenderer = this.options.getTextRenderer();
		if (!textRenderer) return null;

		// Flow chains: hit the region under the pointer, not the edited one
		const region = this.resolveRegionAtPoint(text, worldX, worldY);
		const local = this.toRegionLocal(region, worldX, worldY);
		return textRenderer.hitTestCharacter(region, local.x, local.y);
	}

	/**
	 * World-space glyph quads plus the text's own rotation and scale, which
	 * convert world drag deltas into element-local override values.
	 */
	public async glyphQuads(
		text: TextElement,
		charIndices: number[],
	): Promise<{
		quads: TextGlyphQuad[];
		elementTransform: { rotation: number; scaleX: number; scaleY: number };
	}> {
		const identityT = { rotation: 0, scaleX: 1, scaleY: 1 };
		const textRenderer = this.options.getTextRenderer();
		if (!textRenderer) return { quads: [], elementTransform: identityT };

		// Flow chains: glyphs live in the member regions' layouts, each
		// worldized with its own position/transform
		const memberQuads = await Promise.all(
			this.layoutMembers(text).map(async (member) => {
				const quads = await textRenderer.getGlyphQuads(member, charIndices);
				if (quads.length === 0) return [];
				const { t, isIdentity } = this.transformOf(member);
				const toWorld = this.localToWorld(member);
				return quads.map((q) => ({
					...q,
					pivot: toWorld(q.pivot),
					rotation: q.rotation + (isIdentity ? 0 : t.rotation),
					corners: q.corners.map(toWorld) as typeof q.corners,
				}));
			}),
		);

		// Drag deltas convert through the session (head) element's transform
		const head = this.transformOf(text);
		return {
			quads: memberQuads.flat(),
			elementTransform: head.isIdentity
				? identityT
				: {
						rotation: head.t.rotation,
						scaleX: head.t.scaleX,
						scaleY: head.t.scaleY,
					},
		};
	}

	/**
	 * World-space rects covering the selected range across every flow-chain
	 * member. Empty when the range is empty or the layout fails.
	 */
	public async selectionRects(
		text: TextElement,
		startIndex: number,
		endIndex: number,
	): Promise<WorldRect[]> {
		if (startIndex >= endIndex) return [];
		const textRenderer = this.options.getTextRenderer();
		if (!textRenderer) return [];

		try {
			const worldRects: WorldRect[] = [];
			for (const member of this.layoutMembers(text)) {
				const localRects = await textRenderer.getSelectionRects(
					member,
					startIndex,
					endIndex,
				);
				const { t, isIdentity } = this.transformOf(member);
				const toWorld = this.localToWorld(member);
				for (const r of localRects) {
					const anchor = toWorld(r);
					worldRects.push(
						isIdentity
							? { ...anchor, width: r.width, height: r.height }
							: {
									...anchor,
									width: r.width * Math.abs(t.scaleX),
									height: r.height * Math.abs(t.scaleY),
								},
					);
				}
			}
			return worldRects;
		} catch {
			return [];
		}
	}

	/** World position, height and tilt of the caret before charIndex. */
	public async cursorWorldPosition(
		text: TextElement,
		charIndex: number,
	): Promise<{ x: number; y: number; height: number; rotation?: number }> {
		const textRenderer = this.options.getTextRenderer();
		if (!textRenderer) {
			return { x: text.x, y: text.y, height: text.defaultStyle.fontSize };
		}

		// Flow chains: the caret may live in a downstream region
		let region = text;
		const regionId = await textRenderer.findRegionForCharIndex(text, charIndex);
		if (regionId !== text.id) {
			const candidate = this.options.getDocument().objects[regionId];
			if (candidate?.type === "text") region = candidate;
		}

		const localPos = await textRenderer.getCursorPosition(region, charIndex);
		const { t } = this.transformOf(region);
		const world = cursorLocalToWorld(
			localPos,
			region.x,
			region.y,
			t,
			region.layout.writingMode,
		);
		// On-path carets tilt with the glyph tangent (plus element rotation)
		return localPos.rotation != null
			? { ...world, rotation: localPos.rotation + t.rotation }
			: world;
	}

	/**
	 * The regions whose layouts hold the text's glyphs: every flow-chain
	 * member, or the given text itself (which may be an unsaved preview)
	 * when it is not chained.
	 */
	private layoutMembers(text: TextElement): TextElement[] {
		const memberIds = this.options.textDepIndex.chainMemberIds(text.id);
		return memberIds.length > 1 ? this.resolveTexts(memberIds) : [text];
	}

	private resolveTexts(ids: string[]): TextElement[] {
		const { objects } = this.options.getDocument();
		return ids.flatMap((id) => {
			const obj = objects[id];
			return obj?.type === "text" ? [obj] : [];
		});
	}

	/**
	 * The flow-chain member whose world bounds contain the point (nearest
	 * bounds center as fallback). Non-chained elements map to themselves.
	 */
	private resolveRegionAtPoint(
		element: TextElement,
		worldX: number,
		worldY: number,
	): TextElement {
		const memberIds = this.options.textDepIndex.chainMemberIds(element.id);
		if (memberIds.length <= 1) return element;

		let nearest: TextElement | null = null;
		let nearestDist = Number.POSITIVE_INFINITY;
		for (const member of this.resolveTexts(memberIds)) {
			const bounds = this.options.getSpatialIndex().getWorldBounds(member.id);
			if (!bounds) continue;
			if (
				worldX >= bounds.minX &&
				worldX <= bounds.maxX &&
				worldY >= bounds.minY &&
				worldY <= bounds.maxY
			) {
				return member;
			}
			const cx = (bounds.minX + bounds.maxX) / 2;
			const cy = (bounds.minY + bounds.maxY) / 2;
			const dist = (worldX - cx) ** 2 + (worldY - cy) ** 2;
			if (dist < nearestDist) {
				nearestDist = dist;
				nearest = member;
			}
		}
		return nearest ?? element;
	}

	/** Map a world point into the region's layout space. */
	private toRegionLocal(
		region: TextElement,
		worldX: number,
		worldY: number,
	): { x: number; y: number } {
		const { t, isIdentity } = this.transformOf(region);
		const p = isIdentity
			? { x: worldX, y: worldY }
			: inverseTransform(worldX, worldY, t);
		return { x: p.x - region.x, y: p.y - region.y };
	}

	/**
	 * Depth-first, front-to-back search for a text element under the pointer
	 * inside a container. findElementAtPoint promotes hits to their top-level
	 * container, so the text tool needs this to reach grouped texts.
	 */
	private findTextInContainerAtPoint(
		container: AnyArtObject,
		worldX: number,
		worldY: number,
		tolerance: number,
	): TextElement | null {
		const { objects } = this.options.getDocument();
		const childIds = getContainerChildIds(container) ?? [];
		for (let i = childIds.length - 1; i >= 0; i--) {
			const child = objects[childIds[i]];
			if (!child || child.visible === false) continue;
			if (child.type === "text") {
				if (this.hitTestTextForPointer(child, worldX, worldY, tolerance)) {
					return child;
				}
				continue;
			}
			if (isContainer(child)) {
				const inner = this.findTextInContainerAtPoint(
					child,
					worldX,
					worldY,
					tolerance,
				);
				if (inner) return inner;
			}
		}
		return null;
	}

	/**
	 * Pointer hit test for a single text element: axis-bound texts hit on
	 * their path/region/glyph ink (same predicate SpatialIndex uses), plain
	 * texts on their world AABB.
	 */
	private hitTestTextForPointer(
		text: TextElement,
		worldX: number,
		worldY: number,
		tolerance: number,
	): boolean {
		const textRenderer = this.options.getTextRenderer();
		if (text.axisBinding && textRenderer) {
			const { t, isIdentity } = this.transformOf(text);
			const local = isIdentity
				? { x: worldX, y: worldY }
				: inverseTransform(worldX, worldY, t);
			const hit = textRenderer.hitTestBoundTextSync(
				text,
				local.x,
				local.y,
				tolerance,
			);
			if (hit !== null) return hit;
		}
		const bounds = this.options.getSpatialIndex().getWorldBounds(text.id);
		return (
			bounds != null &&
			worldX >= bounds.minX - tolerance &&
			worldX <= bounds.maxX + tolerance &&
			worldY >= bounds.minY - tolerance &&
			worldY <= bounds.maxY + tolerance
		);
	}
}
