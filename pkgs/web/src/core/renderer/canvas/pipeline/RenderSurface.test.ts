import {
	combinePlacementOpacity,
	createBorrowedTextureRef,
	createFrameTextureRef,
	createPlacementOpacity,
	createRenderSurface,
	type RenderSurface,
	releaseRenderSurface,
	replaceRenderSurface,
} from "./RenderSurface";

describe("RenderSurface ownership", () => {
	it("releases a replaced frame-owned texture exactly once", () => {
		const released: GPUTexture[] = [];
		const sourceTexture = {} as GPUTexture;
		const replacementTexture = {} as GPUTexture;
		const source = surface(
			createFrameTextureRef(sourceTexture, (texture) => released.push(texture)),
		);
		const replacement = surface(
			createFrameTextureRef(replacementTexture, (texture) =>
				released.push(texture),
			),
		);

		const result = replaceRenderSurface(source, replacement);
		releaseRenderSurface(source);

		expect(result).toEqual(replacement);
		expect(released).toEqual([sourceTexture]);
	});

	it("does not release a borrowed texture when replacing it", () => {
		const source = surface(
			createBorrowedTextureRef({} as GPUTexture, "appearance-cache"),
		);
		const replacement = surface(
			createFrameTextureRef({} as GPUTexture, () => {
				throw new Error("replacement must stay owned by the caller");
			}),
		);

		expect(replaceRenderSurface(source, replacement)).toEqual(replacement);
	});

	it("keeps ownership when only placement changes for the same texture", () => {
		let releaseCount = 0;
		const texture = {} as GPUTexture;
		const textureRef = createFrameTextureRef(texture, () => {
			releaseCount++;
		});
		const source = surface(textureRef);
		const replacement = surface(textureRef);

		replaceRenderSurface(source, replacement);

		expect(releaseCount).toBe(0);
	});
});

describe("RenderSurface metadata", () => {
	it("creates a surface with explicit color semantics", () => {
		const result = createRenderSurface(
			createBorrowedTextureRef({} as GPUTexture, "external"),
			placement(),
			{
				role: "color",
				alphaMode: "premultiplied",
				opacityState: "intrinsic",
			},
		);

		expect(result).toMatchObject({
			role: "color",
			alphaMode: "premultiplied",
			opacityState: "intrinsic",
		});
	});

	it("combines placement opacity multiplicatively", () => {
		expect(
			combinePlacementOpacity(
				createPlacementOpacity(0.5),
				createPlacementOpacity(0.4),
			),
		).toBeCloseTo(0.2);
	});

	it.each([
		-0.1,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		1.1,
	])("rejects invalid placement opacity %s", (value) => {
		expect(() => createPlacementOpacity(value)).toThrow(RangeError);
	});
});

function surface(texture: RenderSurface["texture"]): RenderSurface {
	return createRenderSurface(texture, placement(), {
		role: "color",
		alphaMode: "premultiplied",
		opacityState: "intrinsic",
	});
}

function placement(): RenderSurface["placement"] {
	return {
		kind: "world-aabb",
		bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1, width: 1, height: 1 },
		uvRect: { minU: 0, minV: 0, maxU: 1, maxV: 1 },
	};
}
