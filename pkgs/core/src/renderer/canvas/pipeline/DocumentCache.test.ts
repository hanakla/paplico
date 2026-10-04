import type { CompositeState } from "../CanvasLayerTypes";
import { DocumentCache } from "./DocumentCache";

describe("DocumentCache composite textures", () => {
	it("reuses every composite texture while the size stays the same", () => {
		const { cache, device } = createCache();

		cache.ensureCompositeTextures(64, 32);
		cache.ensureCompositeTextures(64, 32);

		expect(device.created).toHaveLength(4);
	});

	it("defers destroying the replaced composite textures when the size changes", () => {
		const { cache, device, deferred } = createCache();

		cache.ensureCompositeTextures(64, 32);
		const first = [...device.created];
		cache.ensureCompositeTextures(128, 32);

		expect(deferred).toEqual(first);
		expect(device.created).toHaveLength(8);
	});

	it("reuses the previous-frame texture and reports no reallocation at the same size", () => {
		const { cache, device } = createCache();

		expect(cache.ensureCompositeFrameTexture(64, 32)).toBe(true);
		expect(cache.ensureCompositeFrameTexture(64, 32)).toBe(false);

		expect(device.created).toHaveLength(1);
	});

	it("defers destroying the previous-frame texture when the size changes", () => {
		const { cache, deferred } = createCache();

		cache.ensureCompositeFrameTexture(64, 32);
		const first = cache.compositeFrameTexture;
		expect(cache.ensureCompositeFrameTexture(128, 32)).toBe(true);

		expect(deferred).toEqual([first]);
		expect(cache.compositeFrameTexture).not.toBe(first);
	});

	it("destroys all five textures and resets the composite state on destroy", () => {
		const { cache, device, compositeState } = createCache();
		cache.ensureCompositeTextures(64, 32);
		cache.ensureCompositeFrameTexture(64, 32);

		cache.destroy();

		expect(device.created.every((texture) => texture.destroyed)).toBe(true);
		expect(device.created).toHaveLength(5);
		expect(cache.compositeFrameTexture).toBeNull();
		expect(compositeState).toEqual({
			captureTexture: null,
			layerTexture: null,
			prebufTexture: null,
			canvasBaseTexture: null,
			width: 0,
			height: 0,
		});
	});
});

type FakeTexture = GPUTexture & { destroyed: boolean };

function createCache() {
	const created: FakeTexture[] = [];
	const deferred: GPUTexture[] = [];
	const device = {
		created,
		createTexture: (descriptor: GPUTextureDescriptor) => {
			const size = descriptor.size as GPUExtent3DDictStrict;
			const texture = {
				width: size.width,
				height: size.height,
				destroyed: false,
				destroy() {
					this.destroyed = true;
				},
			} as unknown as FakeTexture;
			created.push(texture);
			return texture;
		},
	};
	const compositeState: CompositeState = {
		captureTexture: null,
		layerTexture: null,
		prebufTexture: null,
		canvasBaseTexture: null,
		width: 0,
		height: 0,
	};
	const cache = new DocumentCache({
		device: device as unknown as GPUDevice,
		canvasFormat: "rgba8unorm",
		compositeState,
		viewportState: { width: 0, height: 0, current: null },
		deferDestroy: (texture) => {
			if (texture) deferred.push(texture);
		},
	});
	return { cache, device, deferred, compositeState };
}
