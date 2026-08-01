import {
	createDefaultDocument,
	createIdentityTransform,
} from "../document/factory";
import type {
	AnyArtObject,
	CompoundPath,
	Document,
	ElementTransform,
	Group,
	Layer,
	Path,
} from "../schema";

/** Build a Document whose objects/layers are the given mock elements. */
export function mockDocument(
	objects: AnyArtObject[],
	layers: Layer[],
): Document {
	const doc = createDefaultDocument("doc");
	doc.objects = Object.fromEntries(objects.map((o) => [o.id, o]));
	doc.layers = layers;
	return doc;
}

export function mockLayer(
	id: string,
	elementIds: string[],
	overrides: Partial<Layer> = {},
): Layer {
	return {
		id,
		name: id,
		visible: true,
		locked: false,
		opacity: 1,
		elementIds,
		...overrides,
	};
}

export function mockPath(id: string): Path {
	return {
		id,
		type: "path",
		segments: [],
		opacity: 1,
		blendMode: "normal",
		transform: createIdentityTransform(),
	};
}

export function mockGroup(
	id: string,
	childIds: string[],
	transform: Partial<ElementTransform> = {},
): Group {
	return {
		id,
		type: "group",
		childIds,
		opacity: 1,
		blendMode: "normal",
		transform: { ...createIdentityTransform(), ...transform },
	};
}

export function mockCompoundPath(
	id: string,
	sourceIds: string[],
): CompoundPath {
	return {
		id,
		type: "compound-path",
		sources: sourceIds.map((sid) => ({ id: sid, op: "union" })),
		opacity: 1,
		blendMode: "normal",
		transform: createIdentityTransform(),
	};
}
