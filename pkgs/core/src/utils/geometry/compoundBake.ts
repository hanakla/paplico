import {
	type AnyArtObject,
	type CompoundPath,
	type CubicBezierSegment,
	isPath,
	type Path,
} from "../../schema";
import { computeBooleanOperation } from "./pathOps";

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
	return computeBooleanOperation(sources, pathMap);
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
