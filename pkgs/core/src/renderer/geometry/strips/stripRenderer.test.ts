import { describe, expect, it } from "vitest";
import {
	addPolygon,
	layoutStrips,
	pentagram,
	type ReferencePolygon,
	rect,
} from "../../../testUtils/referenceCoverage";
import { StripRasterizer } from "./stripRenderer";
import {
	type ClipRect,
	LOCATION_FIELDS,
	LOCATION_U32S,
	TILE_SIZE,
} from "./stripTypes";

const SIZE = 32;
const CLIP: ClipRect = { x0: 0, y0: 0, x1: SIZE, y1: SIZE };

describe("StripRasterizer", () => {
	it("should span empty interior tiles with a fill gap instead of alpha slots", () => {
		const batch = layout([rect(0, 4, 28, 4)], false);
		expect(Array.from(batch.strips)).toEqual([0, 4, 28, 4, 28, 4, 4, 4]);
		expect(batch.slotCount).toBe(8);
		expect(batch.locationCount).toBe(2);
	});

	it("should cover up to the clip edge when geometry leaves through it", () => {
		const batch = layout([rect(0, 4, 40, 4)], false);
		expect(Array.from(batch.strips)).toEqual([0, 4, 32, 4]);
		expect(batch.slotCount).toBe(4);
	});

	it("should give every covered pixel a slot in denseOnly mode", () => {
		const batch = layout([rect(0, 4, 32, 4)], true);
		expect(batch.stripCount).toBe(1);
		expect(batch.strips[2]).toBe(32);
		expect(batch.strips[3]).toBe(32);
		expect(batch.slotCount).toBe(32);
		const gapFills = locationsOf(batch).filter((l) => l.entryCount === 0);
		expect(gapFills.map((l) => l.tx)).toEqual([1, 2, 3, 4, 5, 6, 7]);
	});

	it("should keep each band's entries to its own tiles when denseOnly coverage runs to the clip edge", () => {
		const batch = layout([rect(0, 0, 40, 8)], true);
		const locations = locationsOf(batch);
		expect(batch.bandCount).toBe(2);
		expect(locations.every((l) => l.entryCount >= 0)).toBe(true);
		const entriesPerBand = [0, 1].map((ty) =>
			locations
				.filter((l) => l.ty === ty)
				.reduce((sum, l) => sum + l.entryCount, 0),
		);
		expect(entriesPerBand[0]).toBe(entriesPerBand[1]);
	});

	it("should emit strips row-major on tile rows", () => {
		const batch = layout([pentagram(16, 16, 13)], false);
		for (let s = 1; s < batch.stripCount; s++) {
			const y0 = batch.strips[(s - 1) * 4 + 1];
			const x0 = batch.strips[(s - 1) * 4];
			const y1 = batch.strips[s * 4 + 1];
			const x1 = batch.strips[s * 4];
			expect(y1 % TILE_SIZE).toBe(0);
			expect(y1 > y0 || (y1 === y0 && x1 > x0)).toBe(true);
		}
	});

	it("should give each band its own run of locations in tile order", () => {
		const batch = layout([pentagram(16, 16, 13)], false);
		const locations = locationsOf(batch);
		let covered = 0;
		for (let b = 0; b < batch.bandCount; b++) {
			const first = batch.bands[b * 2];
			const count = batch.bands[b * 2 + 1];
			expect(first).toBe(covered);
			const band = locations.slice(first, first + count);
			expect(new Set(band.map((l) => l.ty)).size).toBe(1);
			for (let i = 1; i < band.length; i++) {
				expect(band[i].tx).toBeGreaterThan(band[i - 1].tx);
			}
			covered += count;
		}
		expect(covered).toBe(batch.locationCount);
	});

	it("should give each location four slots and its own entries", () => {
		const batch = layout([rect(4.5, 4.5, 10, 10)], false);
		const locations = locationsOf(batch);
		expect(batch.slotCount).toBe(locations.length * TILE_SIZE);
		const entries = locations.reduce((sum, l) => sum + l.entryCount, 0);
		expect(entries).toBe(batch.entries.length);
		expect(batch.lines.length / 4).toBe(4);
	});

	it("should reuse scratch across rasterize calls without leaking lines", () => {
		const rasterizer = new StripRasterizer();
		addPolygon(rasterizer, rect(4, 4, 8, 8), CLIP);
		rasterizer.rasterize(CLIP, { denseOnly: false });
		addPolygon(rasterizer, rect(20, 20, 4, 4), CLIP);
		const batch = rasterizer.rasterize(CLIP, { denseOnly: false });
		expect(batch.lines.length / 4).toBe(4);
		expect(batch.bounds).toEqual({ minX: 20, minY: 20, maxX: 28, maxY: 24 });
	});
});

function layout(polygons: ReferencePolygon[], denseOnly: boolean) {
	return layoutStrips(polygons, CLIP, denseOnly);
}

function locationsOf(batch: ReturnType<StripRasterizer["rasterize"]>) {
	return Array.from({ length: batch.locationCount }, (_, i) => {
		const at = i * LOCATION_U32S;
		const tile = batch.locations[at + LOCATION_FIELDS.tile];
		const entryEnd =
			i + 1 === batch.locationCount
				? batch.entries.length
				: batch.locations[at + LOCATION_U32S + LOCATION_FIELDS.entryStart];
		return {
			tx: tile & 0xffff,
			ty: tile >>> 16,
			entryCount: entryEnd - batch.locations[at + LOCATION_FIELDS.entryStart],
		};
	});
}
