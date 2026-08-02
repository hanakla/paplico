/**
 * Standalone TextDocumentResolver built from a plain Document snapshot, with
 * no live SpatialIndex. Only Paplico wires a resolver onto RenderOrchestrator
 * (see wireTextDocumentResolver); a bare RenderOrchestrator export/VRT call
 * that receives just a Document has none. Without a resolver, TextRenderer
 * treats every flow-chain member and axis-bound text as a standalone element
 * and lays out its own leftover content field literally and unconstrained,
 * instead of resolving the chain/binding — this fills that gap for
 * standalone renders.
 */

import {
	type AnyArtObject,
	type Document,
	type ElementTransform,
	getContainerChildIds,
	getTransform,
	isContainer,
	isIdentityTransform,
	isPath,
	type TextElement,
} from "../schema";
import { calculateLocalElementBounds } from "../utils/geometry/bounds";
import {
	composeTransforms,
	computeTransformOrigin,
} from "../utils/geometry/geometry";
import { toWorldPath } from "../utils/geometry/segmentOps";
import type { TextDocumentResolver } from "./TextRenderer";

export function buildDocumentTextResolver(
	document: Document,
): TextDocumentResolver {
	const objects: Record<string, AnyArtObject> = document.objects;

	const parentOf = new Map<string, string>();
	for (const [id, el] of Object.entries(objects)) {
		if (!isContainer(el)) continue;
		for (const childId of getContainerChildIds(el) ?? []) {
			parentOf.set(childId, id);
		}
	}

	function ancestorTransform(id: string): ElementTransform | null {
		let t: ElementTransform | null = null;
		let ancestorId = parentOf.get(id);
		while (ancestorId) {
			const ancestor = objects[ancestorId];
			if (ancestor) {
				const at = getTransform(ancestor);
				t = t ? composeTransforms(at, t) : at;
			}
			ancestorId = parentOf.get(ancestorId);
		}
		return t;
	}

	return {
		getElementById: (id) => objects[id] ?? null,

		getWorldSegments: (id) => {
			const el = objects[id];
			if (!el || !isPath(el)) return null;
			return toWorldPath(el, ancestorTransform(id) ?? undefined).segments;
		},

		// A single-shot snapshot render has no incremental edits to invalidate
		// the cache against; the cache key's other fields (content/style/
		// layout/x,y) already change on any edit relevant to layout.
		getGeometryRevision: () => 0,

		findFlowSource: (textId) => {
			let source: TextElement | null = null;
			for (const el of Object.values(objects)) {
				if (el.type === "text" && el.flow?.nextTextElementId === textId) {
					if (!source || el.id < source.id) source = el;
				}
			}
			return source;
		},

		getTextTransform: (element) => {
			const ancestorT = ancestorTransform(element.id);
			const t = ancestorT
				? composeTransforms(ancestorT, element.transform)
				: element.transform;
			if (isIdentityTransform(t)) {
				return { t, origin: { x: 0, y: 0 }, isIdentity: true };
			}
			const localBounds = calculateLocalElementBounds(element);
			const origin = computeTransformOrigin(localBounds);
			return { t, origin, isIdentity: false };
		},
	};
}
