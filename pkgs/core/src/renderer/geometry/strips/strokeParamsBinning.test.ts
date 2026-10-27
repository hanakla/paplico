import { describe, expect, it } from "vitest";
import { layoutStrips, rect } from "../../../testUtils/referenceCoverage";
import {
	type ClipRect,
	type DeviceTransform,
	LOCATION_FIELDS,
	LOCATION_U32S,
	type StripBatch,
} from "./stripTypes";
import { binStrokeParams } from "./strokeParamsBinning";

const CLIP: ClipRect = { x0: 0, y0: 0, x1: 32, y1: 32 };
const IDENTITY: DeviceTransform = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

describe("binStrokeParams", () => {
	it("should give each location the triangles within a pixel of it, in triangle order", () => {
		const batch = layoutStrips([rect(0, 0, 16, 4)], CLIP, true);

		bin(batch, [
			[0, 0, 4, 0, 0, 4],
			[12, 0, 16, 0, 16, 4],
			[1, 1, 3, 1, 1, 3],
		]);

		expect(trianglesByTile(batch)).toEqual(
			new Map([
				[0, [0, 2]],
				[1, [0]],
				[2, [1]],
				[3, [1]],
				[4, [1]],
			]),
		);
	});

	it("should drop triangles without area", () => {
		const batch = layoutStrips([rect(0, 0, 16, 4)], CLIP, true);

		bin(batch, [
			[0, 0, 2, 2, 4, 4],
			[0, 0, 4, 0, 0, 4],
		]);

		expect(batch.params?.triangles.length).toBe(12);
		expect(trianglesByTile(batch).get(0)).toEqual([0]);
	});
});

function bin(batch: StripBatch, triangles: number[][]): void {
	const vertices = new Float32Array(triangles.flat());
	binStrokeParams(
		batch,
		vertices,
		new Float32Array(vertices.length),
		IDENTITY,
		CLIP,
	);
}

/** Triangle indices of each location, keyed by the location's tile column. */
function trianglesByTile(batch: StripBatch): Map<number, number[]> {
	const entries = batch.params?.entries ?? new Uint32Array(0);
	const out = new Map<number, number[]>();
	for (let i = 0; i < batch.locationCount; i++) {
		const at = i * LOCATION_U32S;
		const start = batch.locations[at + LOCATION_FIELDS.triStart];
		const end =
			i + 1 === batch.locationCount
				? entries.length
				: batch.locations[at + LOCATION_U32S + LOCATION_FIELDS.triStart];
		out.set(
			batch.locations[at + LOCATION_FIELDS.tile] & 0xffff,
			Array.from(entries.subarray(start, end)),
		);
	}
	return out;
}
