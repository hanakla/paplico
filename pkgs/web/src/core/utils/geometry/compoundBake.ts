import {
	type AnyArtObject,
	type CompoundPath,
	type CubicBezierSegment,
	isPath,
	type Path,
} from "../../schema";
import { computeBooleanOperation } from "./pathOps";
import { toWorldPath } from "./segmentOps";

/**
 * Bezier sampling tolerance every consumer of a compound path's boolean
 * result uses. A consumer with its own value would drift the baked shape
 * apart from the on-canvas render.
 */
export const COMPOUND_CURVE_TOLERANCE = 0.25;

/**
 * Resolve a compound path's boolean result: sources are world-baked by their
 * own transforms, the result acts as the compound's local geometry under the
 * compound's own transform. Single definition of the sources → pathMap →
 * boolean pipeline, shared by PathElementRenderer, GroupAppearanceCollector
 * and the extrude renderer.
 */
export function bakeCompoundPathSegments(
	compound: CompoundPath,
	resolveElement: (id: string) => AnyArtObject | undefined,
): CubicBezierSegment[] {
	const pathMap = new Map<string, Path>();
	const validSources: CompoundPath["sources"] = [];
	for (const source of compound.sources) {
		const el = resolveElement(source.id);
		if (!el || !isPath(el)) continue;
		pathMap.set(source.id, toWorldPath(el));
		validSources.push(source);
	}
	if (validSources.length === 0) return [];
	return computeBooleanOperation(validSources, pathMap, {
		curveTolerance: COMPOUND_CURVE_TOLERANCE,
	});
}
