import {
	type BlendBackdrop,
	type CompositeSourceSurface,
	createBlendBackdrop,
	createCompositeSourceSurface,
} from "./CompositeRenderer";
import { createBorrowedTextureRef, type RenderSurface } from "./RenderSurface";

describe("CompositeRenderer typed routes", () => {
	it("keeps an absent parent on the isolated backdrop route", () => {
		const destinationTexture = {} as GPUTexture;
		const source = createCompositeSourceSurface({} as GPUTexture, placement());
		const backdrop = createBlendBackdrop(
			destinationTexture,
			undefined,
			source.placement,
		);

		expectTypeOf(source).toMatchTypeOf<CompositeSourceSurface>();
		expectTypeOf(backdrop).toMatchTypeOf<BlendBackdrop>();
		expect(backdrop).toMatchObject({
			isolation: "isolated",
			destination: {
				role: "destination-snapshot",
				alphaMode: "premultiplied",
				opacityState: "placement-baked",
				texture: { texture: destinationTexture },
			},
		});
		expect("parent" in backdrop).toBe(false);
	});

	it("keeps an explicit parent on the pass-through backdrop route", () => {
		const destinationTexture = {} as GPUTexture;
		const parentTexture = {} as GPUTexture;
		const backdrop = createBlendBackdrop(
			destinationTexture,
			parentTexture,
			placement(),
		);

		expect(backdrop).toMatchObject({
			isolation: "pass-through",
			destination: {
				role: "destination-snapshot",
				texture: { texture: destinationTexture },
			},
			parent: {
				role: "parent-backdrop",
				alphaMode: "premultiplied",
				opacityState: "placement-baked",
				texture: { texture: parentTexture },
			},
		});
	});

	it("requires semantic metadata on constructed surface values", () => {
		const incomplete = {
			texture: createBorrowedTextureRef({} as GPUTexture, "external"),
			placement: placement(),
		};
		// @ts-expect-error RenderSurface values must declare their semantic metadata.
		const surface: RenderSurface = incomplete;

		expect(surface).toBe(incomplete);
	});
});

function placement(): Extract<
	RenderSurface["placement"],
	{ kind: "world-aabb" }
> {
	return {
		kind: "world-aabb",
		bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1, width: 1, height: 1 },
		uvRect: { minU: 0, minV: 0, maxU: 1, maxV: 1 },
	};
}
