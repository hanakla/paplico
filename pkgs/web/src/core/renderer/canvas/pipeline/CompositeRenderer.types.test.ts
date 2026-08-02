import { describe, expectTypeOf, it } from "vitest";
import type {
	BlendBackdrop,
	CompositeSourceSurface,
	DestinationSnapshotSurface,
	ParentBackdropSurface,
	PremultipliedColorSurface,
} from "./CompositeRenderer";
import type { RenderSurface } from "./RenderSurface";

describe("CompositeRenderer surface types", () => {
	it("accepts only intrinsic premultiplied color as the source", () => {
		expectTypeOf<
			RenderSurface<"coverage", "scalar", "intrinsic">
		>().not.toMatchTypeOf<CompositeSourceSurface>();
		expectTypeOf<
			RenderSurface<"color", "straight", "intrinsic">
		>().not.toMatchTypeOf<CompositeSourceSurface>();
	});

	it("rejects placement opacity that was already baked", () => {
		expectTypeOf<
			PremultipliedColorSurface<"placement-baked">
		>().not.toMatchTypeOf<CompositeSourceSurface>();
	});

	it("requires a parent backdrop for pass-through compositing", () => {
		type MissingParent = {
			isolation: "pass-through";
			destination: DestinationSnapshotSurface;
		};
		type PassThrough = {
			isolation: "pass-through";
			destination: DestinationSnapshotSurface;
			parent: ParentBackdropSurface;
		};

		expectTypeOf<MissingParent>().not.toMatchTypeOf<BlendBackdrop>();
		expectTypeOf<PassThrough>().toMatchTypeOf<BlendBackdrop>();
	});
});
