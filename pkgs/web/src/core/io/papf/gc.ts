/**
 * GC for papf documents.
 *
 * Removes:
 *  - Orphaned ArtObjects: entries in `doc.objects` unreachable from
 *    `layer.elementIds` roots and `doc.defs[].rootElementIds` roots, walked
 *    through container/reference edges (Group.childIds/clipPathId,
 *    BlendObject.objectIds/spineSourceId, CompoundPath.sources[].id,
 *    RepeatObject.sourceIds,
 *    TextElement.axisBinding.pathObjectId/clipPathId/flow.nextTextElementId).
 *  - Orphaned embedded files: `doc.files` entries whose `uid` is not
 *    referenced by any `fileUid` field reachable from the surviving objects,
 *    `doc.brushPresets`, `doc.colorProfile`, or `doc.references3d`.
 *
 * Never reads or writes `doc.timelapse` — timelapse entries are raw Yjs CRDT
 * updates that don't reference `doc.objects`, so they pass through untouched.
 */
import {
	type AnyArtObject,
	type Document,
	getContainerChildIds,
} from "../../schema";
import { neverReached } from "../../utils/lang";

export interface GcResult {
	document: Document;
	deletedObjectIds: string[];
	deletedFileUids: string[];
}

export function gcDocument(doc: Document): GcResult {
	// 1. Sweep unreachable ArtObjects.
	const reachableIds = collectReachableObjectIds(doc);
	const survivingObjects: Record<string, AnyArtObject> = {};
	const deletedObjectIds: string[] = [];

	for (const [id, obj] of Object.entries(doc.objects)) {
		if (reachableIds.has(id)) {
			survivingObjects[id] = obj;
		} else {
			deletedObjectIds.push(id);
		}
	}

	// 2. Sweep unreferenced embedded files.
	const usedFileUids = collectUsedFileUids(doc, survivingObjects);
	const survivingFiles = doc.files.filter((f) => usedFileUids.has(f.uid));
	const deletedFileUids = doc.files
		.filter((f) => !usedFileUids.has(f.uid))
		.map((f) => f.uid);

	return {
		document: { ...doc, objects: survivingObjects, files: survivingFiles },
		deletedObjectIds,
		deletedFileUids,
	};
}

/**
 * BFS over container/reference edges starting from layer.elementIds and
 * doc.defs[].rootElementIds roots.
 */
function collectReachableObjectIds(doc: Document): Set<string> {
	const roots: string[] = [
		...doc.layers.flatMap((l) => l.elementIds),
		...Object.values(doc.defs ?? {}).flatMap((d) => d.rootElementIds),
	];

	const reachable = new Set<string>();
	const stack = [...roots];

	for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
		if (reachable.has(id)) continue;
		reachable.add(id);

		const obj = doc.objects[id];
		if (!obj) continue;
		for (const edgeId of getObjectEdges(obj)) stack.push(edgeId);
	}

	return reachable;
}

/**
 * Returns the IDs an ArtObject references (children + single-target refs).
 * Reuses `getContainerChildIds` for the container-child portion (covers
 * Group.childIds, BlendObject.objectIds+spineSourceId, CompoundPath.sources)
 * and adds the single-target reference fields it doesn't cover.
 */
function getObjectEdges(obj: AnyArtObject): string[] {
	// Mask content belongs to no layer, so this edge is the only thing keeping
	// it reachable.
	const edges = [
		...(getContainerChildIds(obj) ?? []),
		...(obj.mask?.elementIds ?? []),
	];

	switch (obj.type) {
		case "group":
			if (obj.clipPathId) edges.push(obj.clipPathId);
			break;
		case "text":
			if (obj.axisBinding) edges.push(obj.axisBinding.pathObjectId);
			if (obj.clipPathId) edges.push(obj.clipPathId);
			if (obj.flow?.nextTextElementId) edges.push(obj.flow.nextTextElementId);
			break;
		case "blend":
		case "compound-path":
		case "repeat":
		case "mesh":
			// Their members come from getContainerChildIds above.
			break;
		case "path":
		case "image":
		case "reference3d":
			// No references of their own beyond the mask handled above.
			break;
		default:
			neverReached(obj, "unhandled element type in GC reachability walk");
	}

	return edges;
}

/**
 * Recursively collects every string value stored under a `fileUid` key,
 * scanning the surviving objects plus brushPresets/appearancePresets/colorProfile/references3d.
 * Binary payloads (typed arrays / ArrayBuffers) are not descended into.
 */
function collectUsedFileUids(
	doc: Document,
	survivingObjects: Record<string, AnyArtObject>,
): Set<string> {
	const used = new Set<string>();
	for (const source of [
		Object.values(survivingObjects),
		doc.brushPresets,
		doc.appearancePresets,
		doc.colorProfile,
		doc.references3d,
	]) {
		collectFileUids(source, used);
	}
	return used;
}

function collectFileUids(value: unknown, used: Set<string>): void {
	if (value == null) return;
	if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return;

	if (Array.isArray(value)) {
		for (const item of value) collectFileUids(item, used);
		return;
	}

	if (typeof value === "object") {
		for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
			if (key === "fileUid" && typeof v === "string") {
				used.add(v);
				continue;
			}
			collectFileUids(v, used);
		}
	}
}
