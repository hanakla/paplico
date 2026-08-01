import { describe, expect, it, vi } from "vitest";
import { createIdentityTransform } from "../../../document/factory";
import type {
	Reference3DRenderRequest,
	Reference3DServiceApi,
} from "../../../reference3d/types";
import type {
	Document,
	Reference3DDef,
	Reference3DElement,
} from "../../../schema";
import type { AssetState } from "../CanvasLayerTypes";
import {
	clampReference3DRasterScale,
	computeReference3DTextureSize,
	Reference3DElementRenderer,
	type Reference3DRenderContext,
} from "./Reference3DElementRenderer";

describe("Reference3DElementRenderer", () => {
	describe("renderReference3D", () => {
		it("should skip rendering entirely while the Reference3D context is not wired", () => {
			const { renderer, deps } = createRenderer({ context: null });

			renderer.renderReference3D(makePassEncoder(), makeElement(), new Map());

			expect(deps.blitTextureToCanvas).not.toHaveBeenCalled();
		});

		it("should skip rendering when the referenced scene def is missing", () => {
			const { renderer, deps, service } = createRenderer();
			const element = makeElement({ sceneId: "unknown-scene" });

			renderer.renderReference3D(makePassEncoder(), element, new Map());

			expect(service.renderScene).not.toHaveBeenCalled();
			expect(deps.blitTextureToCanvas).not.toHaveBeenCalled();
		});

		it("should kick an async scene render on first sight and blit it on the next frame", async () => {
			const { renderer, deps, service } = createRenderer();
			const element = makeElement();

			renderer.renderReference3D(makePassEncoder(), element, new Map());
			// Nothing cached yet — first frame draws nothing for this element.
			expect(deps.blitTextureToCanvas).not.toHaveBeenCalled();

			await flushAsync();
			expect(service.renderScene).toHaveBeenCalledOnce();
			const request = service.renderScene.mock.calls[0][0];
			expect(request.sceneId).toBe("scene-1");
			expect(request.width).toBe(400);
			expect(request.height).toBe(300);
			// Figure nodes resolve their VRM bytes through the request.
			expect(typeof request.getFileBytes).toBe("function");
			// Async completion asks the scheduler for a follow-up frame.
			expect(deps.assetState.onRequestRender).toHaveBeenCalled();

			renderer.renderReference3D(makePassEncoder(), element, new Map());
			expect(deps.blitTextureToCanvas).toHaveBeenCalledOnce();
			const bounds = deps.blitTextureToCanvas.mock.calls[0][2];
			expect(bounds).toEqual({
				minX: -200,
				minY: -150,
				maxX: 200,
				maxY: 150,
				width: 400,
				height: 300,
			});
		});

		it("should serve repeated frames from the cache without re-rendering", async () => {
			const { renderer, service } = createRenderer();
			const element = makeElement();

			renderer.renderReference3D(makePassEncoder(), element, new Map());
			await flushAsync();
			renderer.renderReference3D(makePassEncoder(), element, new Map());
			renderer.renderReference3D(makePassEncoder(), element, new Map());

			expect(service.renderScene).toHaveBeenCalledOnce();
		});

		it("should re-render when scene nodes change, blitting the stale texture meanwhile", async () => {
			const { renderer, deps, service, references3d } = createRenderer();
			const element = makeElement();

			renderer.renderReference3D(makePassEncoder(), element, new Map());
			await flushAsync();

			// Mutate the shared scene definition (e.g. a node was moved).
			references3d["scene-1"] = makeSceneDef({
				nodes: [
					{
						id: "node-box",
						kind: "primitive",
						shape: "box",
						transform: {
							position: [2, 0.5, 0],
							rotation: [0, 0, 0, 1],
							scale: [1, 1, 1],
						},
					},
				],
			});

			renderer.renderReference3D(makePassEncoder(), element, new Map());
			// Stale texture is still blitted (no flicker) while the new render runs.
			expect(deps.blitTextureToCanvas).toHaveBeenCalledOnce();
			await flushAsync();
			expect(service.renderScene).toHaveBeenCalledTimes(2);
		});

		it("should blit through the rotation-exact quad path for transformed elements", async () => {
			const { renderer, deps } = createRenderer();
			// 90° CCW rotation around the element center (0,0).
			const element = makeElement({
				transform: { x: 0, y: 0, rotation: Math.PI / 2, scaleX: 1, scaleY: 1 },
			});

			renderer.renderReference3D(makePassEncoder(), element, new Map());
			await flushAsync();
			renderer.renderReference3D(makePassEncoder(), element, new Map());

			expect(deps.blitTextureToCanvas).not.toHaveBeenCalled();
			expect(deps.blitQuadToCanvas).toHaveBeenCalledOnce();
			const corners = deps.blitQuadToCanvas.mock.calls[0][2];
			// Local TL(-200,150) rotated 90° CCW → (-150,-200); order TL→TR→BR→BL.
			expect(corners[0].x).toBeCloseTo(-150, 6);
			expect(corners[0].y).toBeCloseTo(-200, 6);
			expect(corners[1].x).toBeCloseTo(-150, 6);
			expect(corners[1].y).toBeCloseTo(200, 6);
			expect(corners[2].x).toBeCloseTo(150, 6);
			expect(corners[2].y).toBeCloseTo(200, 6);
			expect(corners[3].x).toBeCloseTo(150, 6);
			expect(corners[3].y).toBeCloseTo(-200, 6);
		});

		it("should re-render after a GL context epoch bump", async () => {
			const { renderer, service } = createRenderer();
			const element = makeElement();

			renderer.renderReference3D(makePassEncoder(), element, new Map());
			await flushAsync();

			service.bumpEpoch();
			renderer.renderReference3D(makePassEncoder(), element, new Map());
			await flushAsync();

			expect(service.renderScene).toHaveBeenCalledTimes(2);
		});
	});

	describe("ensureTextures", () => {
		it("should pre-warm export-flagged textures at the document rasterization scale", async () => {
			const { renderer, deps, service } = createRenderer();
			deps.getRasterScale.mockReturnValue(2);
			const element = makeElement({ includeInExport: true });
			const document = makeDocument(element);

			await renderer.ensureTextures(document, undefined);

			expect(service.renderScene).toHaveBeenCalledOnce();
			const request = service.renderScene.mock.calls[0][0];
			expect(request.rasterScale).toBe(2);
			expect(request.width).toBe(800);
			expect(request.height).toBe(600);
			expect(deps.assetState.reference3dTextureCache?.size).toBe(1);
		});

		it("should skip scenes not flagged for export (excluded by default)", async () => {
			const { renderer, service } = createRenderer();
			const document = makeDocument(makeElement());

			await renderer.ensureTextures(document, undefined);

			expect(service.renderScene).not.toHaveBeenCalled();
		});

		it("should respect the element filter", async () => {
			const { renderer, service } = createRenderer();
			const element = makeElement({ includeInExport: true });
			const document = makeDocument(element);

			await renderer.ensureTextures(document, new Set(["other-id"]));

			expect(service.renderScene).not.toHaveBeenCalled();
		});
	});

	describe("destroyTextures", () => {
		it("should destroy every cached texture and clear the cache", async () => {
			const { renderer, deps } = createRenderer();
			const element = makeElement({ includeInExport: true });

			await renderer.ensureTextures(makeDocument(element), undefined);
			const cache = deps.assetState.reference3dTextureCache!;
			const texture = cache.get(element.id)!.texture;

			renderer.destroyTextures();

			expect(texture.destroy).toHaveBeenCalled();
			expect(cache.size).toBe(0);
		});
	});
});

describe("clampReference3DRasterScale", () => {
	it("should clamp the raster scale to [0.25, 4] without quantizing", () => {
		expect(clampReference3DRasterScale(1)).toBe(1);
		expect(clampReference3DRasterScale(1.3)).toBe(1.3);
		// 300dpi / 72 exceeds the texture-size sanity cap.
		expect(clampReference3DRasterScale(300 / 72)).toBe(4);
		expect(clampReference3DRasterScale(0.1)).toBe(0.25);
		expect(clampReference3DRasterScale(16)).toBe(4);
	});
});

describe("computeReference3DTextureSize", () => {
	it("should scale the element rect by the raster scale", () => {
		expect(computeReference3DTextureSize(400, 300, 2)).toEqual({
			width: 800,
			height: 600,
		});
	});

	it("should shrink uniformly so no side exceeds 2048", () => {
		const size = computeReference3DTextureSize(4000, 1000, 4);
		expect(size.width).toBe(2048);
		expect(size.height).toBe(512);
	});

	it("should never collapse below 1px", () => {
		expect(computeReference3DTextureSize(1, 1, 0.25)).toEqual({
			width: 1,
			height: 1,
		});
	});
});

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

type FakeService = Reference3DServiceApi & {
	renderScene: ReturnType<
		typeof vi.fn<(req: Reference3DRenderRequest) => Promise<ImageBitmap>>
	>;
	bumpEpoch: () => void;
};

function createFakeService(): FakeService {
	let epoch = 0;
	return {
		renderScene: vi.fn(async (request: Reference3DRenderRequest) => {
			return {
				width: request.width,
				height: request.height,
				close: vi.fn(),
			} as unknown as ImageBitmap;
		}),
		raycastNode: vi.fn(() => null),
		getContextEpoch: () => epoch,
		getAssetsEpoch: () => 0,
		getFigureRig: vi.fn(() => null),
		disposeScene: vi.fn(),
		destroy: vi.fn(),
		bumpEpoch: () => {
			epoch++;
		},
	};
}

function createRenderer(options: { context?: null } = {}) {
	const service = createFakeService();
	const references3d: Record<string, Reference3DDef> = {
		"scene-1": makeSceneDef(),
	};
	const context: Reference3DRenderContext = { service, references3d };

	const assetState: AssetState = {
		textureCache: new Map(),
		imageTextureCache: new Map(),
		pendingImageLoads: new Map(),
		currentFiles: [],
		pendingBrushTextureLoads: new Set(),
		onRequestRender: vi.fn(),
	};
	const deps = {
		device: {
			createTexture: vi.fn(
				() => ({ destroy: vi.fn() }) as unknown as GPUTexture,
			),
			queue: {
				copyExternalImageToTexture: vi.fn(),
			} as unknown as GPUQueue,
		} as unknown as GPUDevice,
		strokePipeline: {} as GPURenderPipeline,
		dummyGradientBindGroup: {} as GPUBindGroup,
		getMaskBindGroup: vi.fn(() => ({}) as GPUBindGroup),
		assetState,
		getRasterScale: vi.fn(() => 1),
		blitTextureToCanvas: vi.fn(),
		blitQuadToCanvas: vi.fn(),
		getBindGroup: vi.fn(() => ({}) as GPUBindGroup),
		getTransformsBindGroup: vi.fn(() => ({}) as GPUBindGroup),
		getParentGroupMap: vi.fn(() => new Map<string, string>()),
		getReference3DContext: vi.fn(() =>
			options.context === null ? null : context,
		),
	};

	return {
		renderer: new Reference3DElementRenderer(deps),
		deps,
		service,
		references3d,
	};
}

function makeSceneDef(overrides: Partial<Reference3DDef> = {}): Reference3DDef {
	return {
		id: "scene-1",
		nodes: [
			{
				id: "node-box",
				kind: "primitive",
				shape: "box",
				transform: {
					position: [0, 0.5, 0],
					rotation: [0, 0, 0, 1],
					scale: [1, 1, 1],
				},
			},
		],
		...overrides,
	};
}

function makeElement(
	overrides: Partial<Reference3DElement> = {},
): Reference3DElement {
	return {
		id: "reference3d-1",
		type: "reference3d",
		opacity: 1,
		blendMode: "normal",
		transform: createIdentityTransform(),
		sceneId: "scene-1",
		camera: {
			projection: "perspective",
			position: [4, 3, 6],
			target: [0, 1, 0],
			fovDeg: 50,
		},
		x: 0,
		y: 0,
		width: 400,
		height: 300,
		displayMode: "lineart",
		...overrides,
	};
}

function makeDocument(element: Reference3DElement): Document {
	return {
		id: "doc-1",
		objects: { [element.id]: element },
		layers: [],
		viewport: { x: 0, y: 0, zoom: 1, rotation: 0 },
		files: [],
		artboards: [],
		brushPresets: [],
		references3d: { "scene-1": makeSceneDef() },
	};
}

function makePassEncoder(): GPURenderPassEncoder {
	return {
		setPipeline: vi.fn(),
		setBindGroup: vi.fn(),
	} as unknown as GPURenderPassEncoder;
}

/** Drain the microtask queue so in-flight ensureSceneTexture promises settle. */
async function flushAsync(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}
