import { describe, expect, it, vi } from "vitest";
import { createIdentityTransform } from "../../../document/factory";
import type { EmbeddedFile, ImageObject } from "../../../schema";
import { Rotate3DFilterHandler } from "../../filters/Rotate3DFilter/Rotate3DFilter";
import type { FilterRenderer } from "../pipeline/FilterRenderer";
import type { ImageTextures } from "../pipeline/ImageTextureStore";
import { ImageElementRenderer } from "./ImageElementRenderer";

describe("ImageElementRenderer", () => {
	describe("renderImage", () => {
		it("should use normal bounds blit when 3d-rotate angles are zero", () => {
			const { renderer, deps } = createRenderer();
			const image = makeImage({
				rotateX: 0,
				rotateY: 0,
				rotateZ: 0,
				perspective: 45,
			});

			renderer.renderImage(makePassEncoder(), image, [makeFile()], new Map());

			expect(deps.blitTextureToCanvas).toHaveBeenCalledOnce();
			expect(deps.blitQuadToCanvas).not.toHaveBeenCalled();
		});

		it("should pass quad corners in TL, TR, BR, BL order for deformed images", () => {
			const { renderer, deps } = createRenderer();
			const image = makeImage({
				rotateX: 0,
				rotateY: 45,
				rotateZ: 0,
				perspective: 45,
			});

			renderer.renderImage(makePassEncoder(), image, [makeFile()], new Map());

			expect(deps.blitQuadToCanvas).toHaveBeenCalledOnce();
			const corners = deps.blitQuadToCanvas.mock.calls[0][2];
			expect(corners[0].y).toBeGreaterThan(corners[3].y);
			expect(corners[1].y).toBeGreaterThan(corners[2].y);
		});
	});
});

function createRenderer(): {
	renderer: ImageElementRenderer;
	deps: ReturnType<typeof createDeps>;
} {
	const deps = createDeps();
	return {
		renderer: new ImageElementRenderer(deps),
		deps,
	};
}

function createDeps() {
	const texture = {} as GPUTexture;
	const images: ImageTextures = {
		get: (file) => (file.uid === "file-1" ? texture : null),
		has: (file) => file.uid === "file-1",
		ensure: async () => null,
	};

	return {
		strokePipeline: {} as GPURenderPipeline,
		dummyGradientBindGroup: {} as GPUBindGroup,
		getMaskBindGroup: vi.fn(() => ({}) as GPUBindGroup),
		images,
		blitTextureToCanvas: vi.fn(),
		blitQuadToCanvas: vi.fn(),
		blitMeshToCanvas: vi.fn(),
		filterRenderer: {
			getHandler: vi.fn((processor: string) =>
				processor === "3d-rotate" ? new Rotate3DFilterHandler() : undefined,
			),
		} as unknown as FilterRenderer,
		getBindGroup: vi.fn(() => ({}) as GPUBindGroup),
		getTransformsBindGroup: vi.fn(() => ({}) as GPUBindGroup),
		getParentGroupMap: vi.fn(() => new Map<string, string>()),
	};
}

function makePassEncoder(): GPURenderPassEncoder {
	return {
		setPipeline: vi.fn(),
		setBindGroup: vi.fn(),
	} as unknown as GPURenderPassEncoder;
}

function makeImage(params: {
	rotateX: number;
	rotateY: number;
	rotateZ: number;
	perspective: number;
}): ImageObject {
	return {
		id: "image-1",
		type: "image",
		fileUid: "file-1",
		x: 0,
		y: 0,
		width: 100,
		height: 80,
		opacity: 1,
		blendMode: "normal",
		transform: createIdentityTransform(),
		filters: [
			{
				uid: "rotate-3d",
				processor: "3d-rotate",
				opacity: 1,
				blendMode: "normal",
				paramData: {
					version: "1",
					params,
				},
			},
		],
	};
}

function makeFile(): EmbeddedFile {
	return {
		uid: "file-1",
		name: "image.png",
		type: "image/png",
		hash: "hash",
		bin: new Uint8Array(),
	};
}
