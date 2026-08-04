import { resolveSimulationDomain } from "./rasterizationDomain";

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
