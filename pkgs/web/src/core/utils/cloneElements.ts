import type {
	AnyArtObject,
	BlendObject,
	CompoundPath,
	Group,
	MeshArtObject,
	RepeatObject,
	TextElement,
} from "../schema";
import { generateUid } from "../schema";
import { deepClone, neverReached } from "./lang";

/**
 * Options for {@link cloneElementsWithIdRemap}.
 */
export interface CloneElementsOptions {
	/**
	 * When provided, used to mint new IDs for each input element. Receives the
	 * source element and must return a fresh unique ID. Defaults to
	 * `generateUid(element.type)`.
	 */
	mintId?: (element: AnyArtObject) => string;
}

/**
 * Result of {@link cloneElementsWithIdRemap}.
 */
export interface CloneElementsResult {
	/** Deeply cloned elements in input order, with new IDs and remapped internal refs. */
	cloned: AnyArtObject[];
	/** Mapping from old element ID → new element ID. */
	idMap: Map<string, string>;
}

/**
 * Deep-clones a set of ArtObjects, regenerating each ID and remapping every
 * internal ID reference (Group.childIds / Group.clipPathId / BlendObject.objectIds
 * & spineSourceId / CompoundPath.sources[].id / RepeatObject.sourceIds
 * / TextElement.axisBinding.pathObjectId
 * & TextElement.flow.nextTextElementId
 * & clipPathId / ArtObject.mask.elementIds) so the resulting elements form a
 * self-contained subgraph independent of the originals.
 *
 * References to elements outside the input set are passed through unchanged,
 * except `flow.nextTextElementId`: flow implies exclusive content ownership
 * along a chain, so a cloned head whose tail is not part of the set becomes
 * an unconnected text instead of feeding the original tail a second head.
 *
 * This is the general form of the remap pass that PaplicoCommands.pasteElements
 * implements inline. Callers in pasteElements / cloneElementWithOffset /
 * PaplicoCommands.createPatternDefFromSelection share this implementation so
 * adding a new ID-bearing reference field only needs to be handled here.
 */
export function cloneElementsWithIdRemap(
	elements: readonly AnyArtObject[],
	options: CloneElementsOptions = {},
): CloneElementsResult {
	const mintId = options.mintId ?? defaultMintId;

	const idMap = new Map<string, string>();
	for (const el of elements) {
		idMap.set(el.id, mintId(el));
	}

	const remapId = (oldId: string): string => idMap.get(oldId) ?? oldId;

	const cloned: AnyArtObject[] = elements.map((element) => {
		const newId = idMap.get(element.id)!;

		switch (element.type) {
			case "group": {
				const next: Group = {
					...deepClone(element),
					id: newId,
					childIds: element.childIds.map(remapId),
					clipPathId:
						element.clipPathId != null ? remapId(element.clipPathId) : null,
				};
				return next;
			}
			case "blend": {
				const next: BlendObject = {
					...deepClone(element),
					id: newId,
					objectIds: element.objectIds.map(remapId),
					renderOrder: element.renderOrder?.map(remapId),
					spineSourceId:
						element.spineSourceId != null
							? remapId(element.spineSourceId)
							: undefined,
				};
				return next;
			}
			case "compound-path": {
				const next: CompoundPath = {
					...deepClone(element),
					id: newId,
					sources: element.sources.map((s) => ({
						...s,
						id: remapId(s.id),
					})),
				};
				return next;
			}
			case "repeat": {
				const next: RepeatObject = {
					...deepClone(element),
					id: newId,
					sourceIds: element.sourceIds.map(remapId),
				};
				return next;
			}
			case "text": {
				const next: TextElement = {
					...deepClone(element),
					id: newId,
				};
				if (next.axisBinding && element.axisBinding) {
					next.axisBinding = {
						...next.axisBinding,
						pathObjectId: remapId(element.axisBinding.pathObjectId),
					};
				}
				if (next.flow?.nextTextElementId != null) {
					const mapped = idMap.get(next.flow.nextTextElementId);
					next.flow =
						mapped != null
							? { ...next.flow, nextTextElementId: mapped }
							: undefined;
				}
				if (next.clipPathId != null) {
					next.clipPathId = remapId(next.clipPathId);
				}
				return next;
			}
			case "mesh": {
				const next: MeshArtObject = {
					...deepClone(element),
					id: newId,
					childIds: element.childIds.map(remapId),
				};
				return next;
			}
			case "path":
			case "image":
			case "reference3d":
				// Reference3DElement.sceneId points at a shared scene, not at an
				// element, so it stays as-is; the rest hold no nested ids at all.
				return { ...deepClone(element), id: newId };
			default:
				return neverReached(
					element,
					"unhandled element type in clone id remap",
				);
		}
	});

	// Object masks hang off the ArtObject base rather than any one element type,
	// so they are remapped in a single pass instead of once per branch above.
	for (const el of cloned) {
		if (!el.mask) continue;
		el.mask = { ...el.mask, elementIds: el.mask.elementIds.map(remapId) };
	}

	return { cloned, idMap };
}

// Helpers

function defaultMintId(element: AnyArtObject): string {
	return generateUid(element.type);
}
