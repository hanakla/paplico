import { describe, expect, it } from "vitest";
import type { Filter, Revolve3DParams } from "../../schema";
import { Revolve3DFilterHandler } from "./Revolve3DFilterHandler";

describe("Revolve3DFilterHandler", () => {
	describe("onScaleFilter", () => {
		it("should scale the offset uniformly by √(sx·sy) and keep the angle", () => {
			const handler = new Revolve3DFilterHandler();
			const scaled = handler.onScaleFilter(
				revolveFilter({ angleDeg: 270, offset: 10 }),
				[4, 1],
			);
			expect(params(scaled).offset).toBeCloseTo(20);
			expect(params(scaled).angleDeg).toBe(270);
		});

		it("should return the filter unchanged for identity scale", () => {
			const handler = new Revolve3DFilterHandler();
			const filter = revolveFilter({ offset: 10 });
			expect(handler.onScaleFilter(filter, [1, 1])).toBe(filter);
		});

		it("should not mutate the original params", () => {
			const handler = new Revolve3DFilterHandler();
			const filter = revolveFilter({ offset: 10 });
			handler.onScaleFilter(filter, [2, 2]);
			expect(params(filter).offset).toBe(10);
		});
	});

	describe("getExpansionMargin", () => {
		it("should cover the profile allowance plus the offset mirror under orthographic projection", () => {
			const handler = new Revolve3DFilterHandler();
			expect(handler.getExpansionMargin(revolveFilter({ offset: 0 }))).toBe(
				256 + 16,
			);
			expect(handler.getExpansionMargin(revolveFilter({ offset: 10 }))).toBe(
				2 * 10 + 256 + 16,
			);
		});

		it("should amplify the margin under perspective, capped at 4×", () => {
			const handler = new Revolve3DFilterHandler();
			// FOV=60° → amplification 1/cos(30°).
			expect(
				handler.getExpansionMargin(
					revolveFilter({ offset: 0, perspective: 60 }),
				),
			).toBeCloseTo(256 * (1 / Math.cos(Math.PI / 6)) + 16);
			// Near-180° FOV amplification is capped at 4.
			expect(
				handler.getExpansionMargin(
					revolveFilter({ offset: 0, perspective: 179 }),
				),
			).toBeCloseTo(256 * 4 + 16);
		});
	});

	describe("getRenderConfigure", () => {
		it("should never need the source texture (it builds its own from geometry)", () => {
			const handler = new Revolve3DFilterHandler();
			expect(
				handler.getRenderConfigure(revolveFilter()).needsSourceTexture,
			).toBe(false);
		});

		it("should not need the backdrop for an opaque material", () => {
			const handler = new Revolve3DFilterHandler();
			expect(handler.getRenderConfigure(revolveFilter()).needsBackdrop).toBe(
				false,
			);
		});

		it("should need the backdrop for a glass material (ior > 1)", () => {
			const handler = new Revolve3DFilterHandler();
			const glass = revolveFilter({
				material: {
					shading: "lambert",
					lightDir: [0, 0, 1],
					refraction: 1.5,
				} as Revolve3DParams["material"],
			});
			expect(handler.getRenderConfigure(glass).needsBackdrop).toBe(true);
		});
	});

	describe("onInterpolate", () => {
		it("should lerp angle/offset/rotation/perspective and the material", () => {
			const handler = new Revolve3DFilterHandler();
			const a = baseParams({
				angleDeg: 360,
				offset: 0,
				perspective: 0,
				rotationDeg: [0, 0, 0],
			});
			const b = baseParams({
				angleDeg: 180,
				offset: 20,
				perspective: 60,
				rotationDeg: [0, 90, 0],
				material: {
					shading: "lambert",
					lightDir: [0, 0, 1],
					refraction: 2,
				} as Revolve3DParams["material"],
			});
			const mid = handler.onInterpolate(a, b, 0.5) as Revolve3DParams;
			expect(mid.angleDeg).toBeCloseTo(270);
			expect(mid.offset).toBeCloseTo(10);
			expect(mid.perspective).toBeCloseTo(30);
			expect(mid.rotationDeg[1]).toBeCloseTo(45);
			// Material glass ior ramps (default 1 on the a-side).
			expect(mid.material.refraction).toBeCloseTo(1.5);
		});

		it("should keep the discrete axis/cap fields from the source key", () => {
			const handler = new Revolve3DFilterHandler();
			const a = baseParams({ axis: "left", cap: true });
			const b = baseParams({ axis: "right", cap: false });
			const mid = handler.onInterpolate(a, b, 0.75) as Revolve3DParams;
			expect(mid.axis).toBe("left");
			expect(mid.cap).toBe(true);
		});
	});

	it("should replace the element's flat render", () => {
		expect(new Revolve3DFilterHandler().replacesElementRender()).toBe(true);
	});
});

// Helpers

function baseParams(overrides: Partial<Revolve3DParams> = {}): Revolve3DParams {
	return {
		angleDeg: 360,
		offset: 0,
		axis: "left",
		cap: true,
		rotationDeg: [0, 0, 0],
		perspective: 0,
		material: {
			shading: "lambert",
			lightDir: [0, 0, 1],
		},
		...overrides,
	};
}

function revolveFilter(
	overrides: Partial<Revolve3DParams> = {},
): Filter<Revolve3DParams> {
	return {
		uid: "app-r",
		processor: "revolve3d",
		opacity: 1,
		blendMode: "normal",
		paramData: { version: "1", params: baseParams(overrides) },
	};
}

function params(filter: Filter): Revolve3DParams {
	return filter.paramData.params as Revolve3DParams;
}
