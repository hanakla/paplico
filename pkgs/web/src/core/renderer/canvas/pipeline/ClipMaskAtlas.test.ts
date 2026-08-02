import type { BoundingBox } from "../../../schema";
import { computeMaskCoverage } from "./ClipMaskAtlas";

describe("computeMaskCoverage", () => {
	it("allocates only the part of the mask inside the render target", () => {
		const coverage = computeMaskCoverage(
			box(-4_000, -4_000, 4_000, 4_000),
			box(-100, -50, 100, 50),
			2,
			16_384,
		);

		expect(coverage).toMatchObject({
			logicalWidth: 400,
			logicalHeight: 200,
			effectiveZoom: 2,
			coverageBounds: box(-100, -50, 100, 50),
		});
	});

	it("returns null when the mask does not intersect the render target", () => {
		expect(
			computeMaskCoverage(
				box(100, 100, 200, 200),
				box(-50, -50, 50, 50),
				1,
				16_384,
			),
		).toBeNull();
	});

	it("reduces one uniform scale when export coverage exceeds the GPU limit", () => {
		const coverage = computeMaskCoverage(
			box(0, 0, 40_000, 10_000),
			null,
			1,
			10_000,
		);

		expect(coverage).toMatchObject({
			logicalWidth: 10_000,
			logicalHeight: 2_500,
			effectiveZoom: 0.25,
			coverageBounds: box(0, 0, 40_000, 10_000),
		});
		expect(coverage?.texWidth).toBeLessThanOrEqual(10_000);
		expect(coverage?.texHeight).toBeLessThanOrEqual(10_000);
	});
});

function box(
	minX: number,
	minY: number,
	maxX: number,
	maxY: number,
): BoundingBox {
	return {
		minX,
		minY,
		maxX,
		maxY,
		width: maxX - minX,
		height: maxY - minY,
	};
}
