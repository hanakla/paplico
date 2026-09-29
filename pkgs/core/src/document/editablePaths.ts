import {
	type Document,
	type ElementTransform,
	getContainerChildIds,
	isContainer,
	isIdentityTransform,
	isMesh,
	isPath,
	type Path,
} from "../schema";
import { placeElement } from "../utils/geometry/geometry";

type EditablePath = {
	path: Path;
	ancestorTransform: ElementTransform | null;
};

/**
 * Collect every editable Path in the document, paired with the composed
 * transform of its ancestors (null when the chain is identity).
 *
 * When `editingScopeId` is set (editing scope active), the walk is scoped to
 * that element's subtree so paths outside the scope are excluded; otherwise
 * all visible/unlocked layers are walked.
 */
export function collectEditablePaths(
	document: Document,
	editingScopeId: string | null,
): EditablePath[] {
	const results: EditablePath[] = [];
	const objects = document.objects;

	/** `parentMatrix` is the chain the element's ancestors place it under. */
	const collectPaths = (
		elementId: string,
		parentMatrix: ElementTransform | null,
		inEditingScope: boolean,
	) => {
		const obj = objects[elementId];
		if (!obj) return;
		const scoped = inEditingScope || elementId === editingScopeId;
		if (isPath(obj)) {
			if (!scoped) return;
			results.push({
				path: obj,
				ancestorTransform:
					parentMatrix && !isIdentityTransform(parentMatrix)
						? parentMatrix
						: null,
			});
		} else if (isContainer(obj)) {
			// A mesh warp container renders its children warped; their stored
			// (unwarped) vertices are only editable after entering the mesh's own
			// editing scope. A scope on an ancestor must not expose them, so the
			// walk only passes through a mesh while still searching for the scope
			// target (scoped=false) or when the mesh itself is the scope.
			if (isMesh(obj) && scoped && elementId !== editingScopeId) return;
			const childIds = getContainerChildIds(obj);
			if (!childIds) return;
			const childrenMatrix = placeElement(parentMatrix, obj);
			for (const childId of childIds) {
				collectPaths(childId, childrenMatrix, scoped);
			}
		}
	};

	const seedScope = editingScopeId == null;
	for (const layer of document.layers) {
		if (!layer.visible || layer.locked) continue;
		// Layer-scoped editing (e.g. pattern-edit drops a transient layer at
		// the top of the document and pushes its id onto editingScopeStack)
		// also enters the scope so every element inside that layer is
		// editable without needing a wrapping group container.
		const layerScope = seedScope || layer.id === editingScopeId;
		for (const elementId of layer.elementIds) {
			collectPaths(elementId, null, layerScope);
		}
	}
	return results;
}
