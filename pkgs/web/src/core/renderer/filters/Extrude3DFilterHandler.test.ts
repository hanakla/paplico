import { describe, expect, it } from "vitest";
import type { Extrude3DParams, Filter } from "../../schema";
import { Extrude3DFilterHandler } from "./Extrude3DFilterHandler";

describe("Extrude3DFilterHandler", () => {
	describe("onScaleFilter", () => {
		it("should scale depth uniformly by √(sx·sy)", () => {
			const handler = new Extrude3DFilterHandler();
			const scaled = handler.onScaleFilter(extrudeFilter(10), [4, 1]);
			expect(params(scaled).depth).toBeCloseTo(20);
		});

		it("should scale the bevel radius together with the depth", () => {
			const handler = new Extrude3DFilterHandler();
			const filter = extrudeFilter(10, { bevel: { size: 3 } });
			const scaled = handler.onScaleFilter(filter, [2, 2]);
			expect(params(scaled).bevel?.size).toBeCloseTo(6);
		});

		it("should return the filter unchanged for identity scale", () => {
			const handler = new Extrude3DFilterHandler();
			const filter = extrudeFilter(10);
			expect(handler.onScaleFilter(filter, [1, 1])).toBe(filter);
		});

		it("should not mutate the original params", () => {
			const handler = new Extrude3DFilterHandler();
			const filter = extrudeFilter(10, { bevel: { size: 3 } });
			handler.onScaleFilter(filter, [2, 2]);
			expect(params(filter).depth).toBe(10);
			expect(params(filter).bevel?.size).toBe(3);
		});
	});

	describe("getExpansionMargin", () => {
		it("should return depth·1.5 plus the fixed pad under orthographic projection", () => {
			const handler = new Extrude3DFilterHandler();
			expect(handler.getExpansionMargin(extrudeFilter(10))).toBe(31);
			expect(handler.getExpansionMargin(extrudeFilter(0))).toBe(16);
		});

		it("should amplify the margin under perspective, capped at 4×", () => {
			const handler = new Extrude3DFilterHandler();
			// FOV=60° → amplification 1/cos(30°).
			expect(
				handler.getExpansionMargin(extrudeFilter(100, { perspective: 60 })),
			).toBeCloseTo(100 * 1.5 * (1 / Math.cos(Math.PI / 6)) + 16);
			// Near-180° FOV amplification is capped at 4.
			expect(
				handler.getExpansionMargin(extrudeFilter(500, { perspective: 179 })),
			).toBeCloseTo(500 * 1.5 * 4 + 16);
		});
	});

	describe("getRenderConfigure", () => {
		it("should never need the source texture (it builds its own from geometry)", () => {
			const handler = new Extrude3DFilterHandler();
			expect(
				handler.getRenderConfigure(extrudeFilter(10)).needsSourceTexture,
			).toBe(false);
		});

		it("should not need the backdrop for an opaque material", () => {
			const handler = new Extrude3DFilterHandler();
			expect(handler.getRenderConfigure(extrudeFilter(10)).needsBackdrop).toBe(
				false,
			);
		});

		it("should need the backdrop for a glass material (ior > 1)", () => {
			const handler = new Extrude3DFilterHandler();
			const glass = extrudeFilter(10, {
				material: {
					shading: "lambert",
					lightDir: [0, 0, 1],
					refraction: 1.5,
				} as Extrude3DParams["material"],
			});
			expect(handler.getRenderConfigure(glass).needsBackdrop).toBe(true);
		});
	});
});

// Helpers

function extrudeFilter(
	depth: number,
	overrides: Partial<Extrude3DParams> = {},
): Filter<Extrude3DParams> {
	return {
		uid: "app-x",
		processor: "extrude3d",
		opacity: 1,
		blendMode: "normal",
		paramData: {
			version: "1",
			params: {
				depth,
				rotationDeg: [0, 0, 0],
				perspective: 0,
				material: {
					shading: "lambert",
					lightDir: [0, 0, 1],
				},
				...overrides,
			} satisfies Extrude3DParams,
		},
	};
}

function params(filter: Filter): Extrude3DParams {
	return filter.paramData.params as Extrude3DParams;
}
