import type { BoundingBox } from "../../../schema";
import {
	resolveSimulationDomain,
	resolveTransientWashDomain,
} from "./rasterizationDomain";

describe("resolveSimulationDomain", () => {
	it("should derive world-per-pixel from the brush size, zoom-free", () => {
		const bounds = {
			minX: 0,
			minY: 0,
			maxX: 100,
			maxY: 100,
			width: 100,
			height: 100,
		};
		// 96 texels per brush diameter, clamped to [0.125, 1].
		expect(resolveSimulationDomain(bounds, 96, 8192).worldPerPixel).toBeCloseTo(
			1,
			10,
		);
		expect(resolveSimulationDomain(bounds, 48, 8192).worldPerPixel).toBeCloseTo(
			0.5,
			10,
		);
		expect(resolveSimulationDomain(bounds, 4, 8192).worldPerPixel).toBeCloseTo(
			0.125,
			10,
		);
		expect(
			resolveSimulationDomain(bounds, 500, 8192).worldPerPixel,
		).toBeCloseTo(1, 10);
	});

	it("should tile with overlap when the domain outgrows the texture limit", () => {
		const bounds = {
			minX: 0,
			minY: 0,
			maxX: 5000,
			maxY: 5000,
			width: 5000,
			height: 5000,
		};
		const domain = resolveSimulationDomain(bounds, 96, 2048);
		expect(domain.tiles.length).toBeGreaterThan(1);
		for (const tile of domain.tiles) {
			expect(tile.textureSize.width).toBeLessThanOrEqual(2048);
			expect(tile.textureSize.height).toBeLessThanOrEqual(2048);
		}
	});
});

describe("resolveTransientWashDomain", () => {
	const box = (
		minX: number,
		minY: number,
		maxX: number,
		maxY: number,
	): BoundingBox => ({
		minX,
		minY,
		maxX,
		maxY,
		width: maxX - minX,
		height: maxY - minY,
	});

	it("should keep the full bounds and scale when no viewport is known", () => {
		const domain = resolveTransientWashDomain({
			textureBounds: box(-1000, -1000, 1000, 1000),
			viewportBounds: null,
			viewportPixelWidth: 1600,
			rasterScale: 4,
			padWorld: 10,
		});
		expect(domain).toEqual({
			bounds: box(-1000, -1000, 1000, 1000),
			scale: 4,
		});
	});

	it("should clip the bounds to the padded viewport", () => {
		const domain = resolveTransientWashDomain({
			textureBounds: box(-5000, -50, 5000, 50),
			viewportBounds: box(-400, -300, 400, 300),
			viewportPixelWidth: 800,
			rasterScale: 1,
			padWorld: 20,
		});
		expect(domain?.bounds).toEqual(box(-420, -50, 420, 50));
	});

	it("should return null when the stroke is fully outside the viewport", () => {
		const domain = resolveTransientWashDomain({
			textureBounds: box(2000, 2000, 3000, 3000),
			viewportBounds: box(-400, -300, 400, 300),
			viewportPixelWidth: 800,
			rasterScale: 1,
			padWorld: 20,
		});
		expect(domain).toBeNull();
	});

	it("should cap the scale at the on-screen pixel density", () => {
		// 1600 physical px over 800 world units = 2 texels per world unit;
		// a 300 DPI document's rasterScale ~4.17 is wasted on a live preview.
		const domain = resolveTransientWashDomain({
			textureBounds: box(-100, -100, 100, 100),
			viewportBounds: box(-400, -300, 400, 300),
			viewportPixelWidth: 1600,
			rasterScale: 300 / 72,
			padWorld: 0,
		});
		expect(domain?.scale).toBeCloseTo(2, 10);
	});

	it("should never raise the scale above the document rasterScale", () => {
		// Zoomed far in: display density exceeds the document scale.
		const domain = resolveTransientWashDomain({
			textureBounds: box(-10, -10, 10, 10),
			viewportBounds: box(-40, -30, 40, 30),
			viewportPixelWidth: 1600,
			rasterScale: 1,
			padWorld: 0,
		});
		expect(domain?.scale).toBe(1);
	});
});
