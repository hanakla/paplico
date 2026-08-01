import { describe, expect, it } from "vitest";
import {
	createRasterSpace,
	expandRegion,
	maskTouchedEdges,
	rasterToWorld,
	type WorldRegion,
	worldToRaster,
} from "./rasterSpace";

describe("rasterSpace coordinate mapping", () => {
	const space = createRasterSpace(
		{ centerX: 10, centerY: -20, worldWidth: 200, worldHeight: 100 },
		2,
	);

	it("should round-trip world → raster → world", () => {
		const p = worldToRaster(space, 35, -60);
		const w = rasterToWorld(space, p.x, p.y);
		expect(w.x).toBeCloseTo(35);
		expect(w.y).toBeCloseTo(-60);
	});

	it("should map the region center to the raster center with Y flipped", () => {
		const c = worldToRaster(space, 10, -20);
		expect(c.x).toBeCloseTo(space.width / 2);
		expect(c.y).toBeCloseTo(space.height / 2);
		// World +Y is raster up (smaller y)
		const up = worldToRaster(space, 10, -10);
		expect(up.y).toBeLessThan(c.y);
	});
});

describe("maskTouchedEdges", () => {
	it("should report only the edges the mask touches", () => {
		const w = 4;
		const h = 3;
		const mask = new Uint8Array(w * h);
		mask[0 * w + 2] = 1; // top edge
		mask[1 * w + 0] = 1; // left edge

		const touched = maskTouchedEdges(mask, w, h);
		expect(touched).toEqual({
			left: true,
			right: false,
			top: true,
			bottom: false,
		});
	});
});

describe("expandRegion", () => {
	const current: WorldRegion = {
		centerX: 0,
		centerY: 0,
		worldWidth: 100,
		worldHeight: 100,
	};
	const maxRegion: WorldRegion = {
		centerX: 0,
		centerY: 0,
		worldWidth: 1000,
		worldHeight: 1000,
	};

	it("should double toward touched edges only", () => {
		const next = expandRegion(
			current,
			{ left: false, right: true, top: false, bottom: false },
			maxRegion,
		);
		expect(next).not.toBeNull();
		// Right edge moved from +50 to +150, left edge unchanged
		expect(next!.centerX + next!.worldWidth / 2).toBeCloseTo(150);
		expect(next!.centerX - next!.worldWidth / 2).toBeCloseTo(-50);
		expect(next!.worldHeight).toBeCloseTo(100);
	});

	it("should expand world +Y when the raster top edge is touched", () => {
		const next = expandRegion(
			current,
			{ left: false, right: false, top: true, bottom: false },
			maxRegion,
		);
		expect(next!.centerY + next!.worldHeight / 2).toBeCloseTo(150);
		expect(next!.centerY - next!.worldHeight / 2).toBeCloseTo(-50);
	});

	it("should clamp expansion to maxRegion", () => {
		const wide: WorldRegion = { ...current, worldWidth: 900 };
		const next = expandRegion(
			wide,
			{ left: true, right: true, top: false, bottom: false },
			maxRegion,
		);
		expect(next!.worldWidth).toBeCloseTo(1000);
	});

	it("should return null when a touched edge is already at maxRegion", () => {
		const atLimit: WorldRegion = { ...maxRegion };
		const next = expandRegion(
			atLimit,
			{ left: true, right: false, top: false, bottom: false },
			maxRegion,
		);
		expect(next).toBeNull();
	});
});
