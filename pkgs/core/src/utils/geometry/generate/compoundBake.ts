import {
	type AnyArtObject,
	type CompoundPath,
	type CubicBezierSegment,
	getTransform,
	isPath,
	type Path,
} from "../../../schema";
import { computeBooleanOperation } from "./pathOps";

/**
 * How many compounds keep a remembered boolean result. A deleted compound's
 * entry ages out instead of needing a deletion hook.
 */
const MAX_REMEMBERED_RESULTS = 512;

/** The last boolean result of each compound id, least recently used first. */
const resultsById = new Map<
	string,
	{ fingerprint: string; segments: CubicBezierSegment[] }
>();

/**
 * Resolve a compound path's boolean result: sources are world-baked by their
 * own transforms, the result acts as the compound's local geometry under the
 * compound's own transform. `toSourceWorldPath` turns a source into the
 * world-space outline it is drawn with.
 */
export function bakeCompoundPathSegments(
	compound: CompoundPath,
	resolveElement: (id: string) => AnyArtObject | undefined,
	toSourceWorldPath: (path: Path) => Path,
): CubicBezierSegment[] {
	const { sources, pathMap } = collectCompoundSources(
		compound,
		resolveElement,
		toSourceWorldPath,
	);
	if (sources.length === 0) return [];
	return resolveCompoundBoolean({ ...compound, sources }, pathMap);
}

/**
 * The boolean result of `compound` over the world-space source outlines in
 * `pathMap`. Every caller shares one remembered result per compound id,
 * reused while the inputs' fingerprint matches, so moving the compound by
 * its own transform does not combine the sources again.
 */
export function resolveCompoundBoolean(
	compound: CompoundPath,
	pathMap: Map<string, Path>,
): CubicBezierSegment[] {
	const fingerprint = createCompoundPathFingerprint(compound, pathMap);
	const cached = resultsById.get(compound.id);
	// Map iteration order doubles as the LRU order.
	resultsById.delete(compound.id);
	if (cached?.fingerprint === fingerprint) {
		resultsById.set(compound.id, cached);
		return cached.segments;
	}

	const segments = computeBooleanOperation(compound.sources, pathMap);
	resultsById.set(compound.id, { fingerprint, segments });
	if (resultsById.size > MAX_REMEMBERED_RESULTS) {
		resultsById.delete(resultsById.keys().next().value!);
	}
	return segments;
}

/** The inputs a compound path's boolean result depends on, as JSON. */
export function createCompoundPathFingerprint(
	compoundPath: CompoundPath,
	pathMap: ReadonlyMap<string, Path>,
): string {
	const fingerprintSources = compoundPath.sources.map((source) => {
		const path = pathMap.get(source.id);
		if (!path || path.visible === false) {
			return { id: source.id, op: source.op, excluded: true };
		}
		return {
			id: source.id,
			op: source.op,
			filters: path.filters,
			transform: getTransform(path),
			segments: path.segments,
		};
	});
	return JSON.stringify({ id: compoundPath.id, sources: fingerprintSources });
}

/**
 * The sources of a compound path that resolve to a path, each as its
 * world-space outline. Sources that are missing or not paths are left out.
 */
export function collectCompoundSources(
	compound: CompoundPath,
	resolveElement: (id: string) => AnyArtObject | undefined,
	toSourceWorldPath: (path: Path) => Path,
): { sources: CompoundPath["sources"]; pathMap: Map<string, Path> } {
	const pathMap = new Map<string, Path>();
	const sources: CompoundPath["sources"] = [];
	for (const source of compound.sources) {
		const el = resolveElement(source.id);
		if (!el || !isPath(el)) continue;
		pathMap.set(source.id, toSourceWorldPath(el));
		sources.push(source);
	}
	return { sources, pathMap };
}
