import {
	fixedRasterScaleForBrush,
	resolveSimulationDomain,
} from "./rasterizationDomain";

describe("fixedRasterScaleForBrush", () => {
	it("should match the simulation domain's world-per-pixel rule", () => {
		for (const brushSize of [1, 10, 40, 96, 500]) {
			const domain = resolveSimulationDomain(
				{ minX: 0, minY: 0, maxX: 100, maxY: 100, width: 100, height: 100 },
				brushSize,
				8192,
			);
			expect(fixedRasterScaleForBrush(brushSize)).toBeCloseTo(
				1 / domain.worldPerPixel,
				10,
			);
		}
	});

	it("should be independent of any viewport zoom (fixed-R rule)", () => {
		// The scale is a pure function of the brush size: texels per world
		// unit stay identical however far the user zooms.
		expect(fixedRasterScaleForBrush(40)).toBeCloseTo(96 / 40, 10);
		expect(fixedRasterScaleForBrush(1000)).toBeCloseTo(1, 10);
		expect(fixedRasterScaleForBrush(4)).toBeCloseTo(8, 10);
	});
});
