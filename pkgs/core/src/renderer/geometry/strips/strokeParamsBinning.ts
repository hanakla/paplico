import {
	type ClipRect,
	type DeviceTransform,
	LOCATION_FIELDS,
	LOCATION_U32S,
	type StripBatch,
	TILE_SIZE,
} from "./stripTypes";
import { TileArena } from "./tiler";

/**
 * Read once: dev builds and vitest turn each use of an imported binding into
 * a property read, which dominated these loops.
 */
const TILE = TILE_SIZE;

/**
 * Bin stroke triangles to the locations of a batch rasterized with
 * `denseOnly`, so the params kernel can give every covered pixel its
 * gradient params (t along, u across).
 *
 * A triangle reaches every location within one pixel of its bounds: the
 * kernel interpolates params at pixel centres inside a triangle and projects
 * onto the nearest edge for pixels it only partly covers. Each location keeps
 * its triangles in triangle order, because where triangles overlap the last
 * one wins.
 */
export function binStrokeParams(
	batch: StripBatch,
	vertices: Float32Array,
	vertexParams: Float32Array,
	t: DeviceTransform,
	clip: ClipRect,
): void {
	const locationOfTile = new Map<number, number>();
	for (let i = 0; i < batch.locationCount; i++) {
		locationOfTile.set(
			batch.locations[i * LOCATION_U32S + LOCATION_FIELDS.tile],
			i,
		);
	}

	const maxTx = Math.ceil((clip.x1 - clip.x0) / TILE) - 1;
	const maxTy = Math.ceil((clip.y1 - clip.y0) / TILE) - 1;
	const triangles: number[] = [];
	const pairs = new TileArena();
	for (let i = 0; i + 5 < vertices.length; i += 6) {
		const x0 = t.a * vertices[i] + t.c * vertices[i + 1] + t.e - clip.x0;
		const y0 = t.b * vertices[i] + t.d * vertices[i + 1] + t.f - clip.y0;
		const x1 = t.a * vertices[i + 2] + t.c * vertices[i + 3] + t.e - clip.x0;
		const y1 = t.b * vertices[i + 2] + t.d * vertices[i + 3] + t.f - clip.y0;
		const x2 = t.a * vertices[i + 4] + t.c * vertices[i + 5] + t.e - clip.x0;
		const y2 = t.b * vertices[i + 4] + t.d * vertices[i + 5] + t.f - clip.y0;
		const det = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
		if (Math.abs(det) < 1e-9) continue;

		const triangle = triangles.length / 12;
		triangles.push(x0, y0, x1, y1, x2, y2);
		for (let k = 0; k < 6; k++) triangles.push(vertexParams[i + k]);

		const pxStart = Math.floor(Math.min(x0, x1, x2) - 1);
		const pxEnd = Math.ceil(Math.max(x0, x1, x2) + 1);
		const pyStart = Math.floor(Math.min(y0, y1, y2) - 1);
		const pyEnd = Math.ceil(Math.max(y0, y1, y2) + 1);
		const txStart = Math.max(0, Math.floor(pxStart / TILE));
		const txEnd = Math.min(maxTx, Math.floor((pxEnd - 1) / TILE));
		const tyStart = Math.max(0, Math.floor(pyStart / TILE));
		const tyEnd = Math.min(maxTy, Math.floor((pyEnd - 1) / TILE));
		for (let ty = tyStart; ty <= tyEnd; ty++) {
			for (let tx = txStart; tx <= txEnd; tx++) {
				const location = locationOfTile.get(tx | (ty << 16));
				if (location !== undefined) pairs.push(location, triangle);
			}
		}
	}
	pairs.sort();

	let pair = 0;
	for (let location = 0; location < batch.locationCount; location++) {
		batch.locations[location * LOCATION_U32S + LOCATION_FIELDS.triStart] = pair;
		while (pair < pairs.count && pairs.keys[pair] === location) pair++;
	}
	batch.params = {
		triangles: Float32Array.from(triangles),
		entries: pairs.lines.slice(0, pairs.count),
	};
}
