import {
	type BoundingBox,
	type Document,
	getContainerChildIds,
	isText,
	type TextElement,
} from "../../schema";
import { buildDocumentTextResolver } from "../../typography/documentTextResolver";
import type { FontManager } from "../../typography/fonts/FontManager";
import { TextLayoutEngine } from "../../typography/TextLayoutEngine";
import { TextRenderer } from "../../typography/TextRenderer";
import { isTranslationOnly } from "../../utils/geometry/geometry";

/** What a migration needs that the document does not carry. */
export interface MigrationContext {
	/**
	 * Layout bounds of texts laid out with their fonts, keyed by element id,
	 * in the space calculateLocalElementBounds reports. A text missing here
	 * is measured by the synchronous estimate instead.
	 */
	textLayoutBounds: ReadonlyMap<string, BoundingBox>;
}

/**
 * Measure what the migrations cannot read off `doc`: the layout bounds of
 * every text whose placement turns or scales, laid out the way the renderer
 * lays it out. An upright text is placed the same under any pivot and a
 * path-bound text pivots on its estimate, so neither is measured. A text
 * whose fonts are out of reach is left to the estimate too.
 */
export async function prepareMigrationContext(
	doc: Document,
	fonts: FontManager,
): Promise<MigrationContext> {
	const textLayoutBounds = new Map<string, BoundingBox>();
	const texts = turnedTexts(doc);
	if (texts.length === 0) return { textLayoutBounds };

	const renderer = new TextRenderer(new TextLayoutEngine(fonts));
	renderer.setDocumentResolver(buildDocumentTextResolver(doc));
	for (const text of texts) {
		try {
			const { bounds } = await renderer.textElementToPaths(text);
			textLayoutBounds.set(text.id, bounds);
		} catch {
			// The estimate stands for a text whose fonts failed to load.
		}
	}
	return { textLayoutBounds };
}

/** Texts not bound to a path whose own transform, or an ancestor's, turns or scales. */
function turnedTexts(doc: Document): TextElement[] {
	const parentOf = new Map<string, string>();
	for (const element of Object.values(doc.objects)) {
		const childIds = [
			...(getContainerChildIds(element) ?? []),
			...(element.mask?.elementIds ?? []),
		];
		for (const childId of childIds) parentOf.set(childId, element.id);
	}
	const isTurned = (id: string): boolean => {
		for (let current: string | undefined = id; current; ) {
			const element = doc.objects[current];
			if (element?.transform && !isTranslationOnly(element.transform)) {
				return true;
			}
			current = parentOf.get(current);
		}
		return false;
	};
	return Object.values(doc.objects).filter(
		(element): element is TextElement =>
			isText(element) && !element.axisBinding && isTurned(element.id),
	);
}
