/**
 * Free-gradient cell topology, shared by the editor, the deform pipeline and
 * (implicitly) the renderer: cells are the Delaunay triangles of the stops,
 * and each cell edge is a cubic whose two control points live in the endpoint
 * stops' `edgeCPs`. A missing entry means the straight 1/3 default, which
 * GradientTextureGenerator regenerates from the stop positions.
 */

import Delaunator from "delaunator";
import type { FreeGradientStop } from "../../schema";

/**
 * Delaunay adjacency: for each stop index, the set of stop indices it shares a
 * cell edge with. Under 3 stops there is no triangulation, so every pair is a
 * neighbor.
 */
export function freeGradientAdjacency(
	stops: readonly FreeGradientStop[],
): Map<number, Set<number>> {
	const adj = new Map<number, Set<number>>();
	for (let i = 0; i < stops.length; i++) adj.set(i, new Set());

	if (stops.length < 3) {
		for (let i = 0; i < stops.length; i++) {
			for (let j = i + 1; j < stops.length; j++) {
				adj.get(i)?.add(j);
				adj.get(j)?.add(i);
			}
		}
		return adj;
	}

	const coords = new Float64Array(stops.length * 2);
	for (let i = 0; i < stops.length; i++) {
		coords[i * 2] = stops[i].x;
		coords[i * 2 + 1] = stops[i].y;
	}
	const delaunay = new Delaunator(coords);
	for (let i = 0; i < delaunay.triangles.length; i += 3) {
		const a = delaunay.triangles[i];
		const b = delaunay.triangles[i + 1];
		const c = delaunay.triangles[i + 2];
		adj.get(a)?.add(b);
		adj.get(b)?.add(a);
		adj.get(b)?.add(c);
		adj.get(c)?.add(b);
		adj.get(a)?.add(c);
		adj.get(c)?.add(a);
	}
	return adj;
}

/**
 * Default edge-CP position (1/3 of the way from stop toward neighbor), used
 * whenever a stop has no explicit `edgeCPs` entry for that neighbor yet.
 */
export function defaultEdgeCP(
	stop: FreeGradientStop,
	neighbor: FreeGradientStop,
): { x: number; y: number } {
	return {
		x: stop.x + (neighbor.x - stop.x) / 3,
		y: stop.y + (neighbor.y - stop.y) / 3,
	};
}
