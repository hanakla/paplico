import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EmbeddedFile } from "../../../schema";
import { ImageTextureStore } from "./ImageTextureStore";

describe("ImageTextureStore", () => {
	describe("ensure", () => {
		beforeEach(() => {
			vi.stubGlobal("createImageBitmap", fakeCreateImageBitmap);
		});

		afterEach(() => {
			vi.unstubAllGlobals();
		});

		it("should upload an image larger than the texture limit at a size that fits it", async () => {
			const device = createDevice(8192);
			const store = new ImageTextureStore(device, () => {});

			await store.forCanvas("canvas-1").ensure(makeFile(5375, 8950));

			const { size } = device.createTexture.mock.calls[0][0];
			expect(size).toEqual({ width: 4919, height: 8192 });
		});

		it("should upload an image within the texture limit at its own size", async () => {
			const device = createDevice(8192);
			const store = new ImageTextureStore(device, () => {});

			await store.forCanvas("canvas-1").ensure(makeFile(1200, 800));

			const { size } = device.createTexture.mock.calls[0][0];
			expect(size).toEqual({ width: 1200, height: 800 });
		});

		it("should not start a load until a view change has passed", async () => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			try {
				const device = createDevice(8192);
				const store = new ImageTextureStore(device, () => {});

				store.holdLoads();
				const texture = store.forCanvas("canvas-1").ensure(makeFile(10, 10));
				await flushPromises();
				expect(device.createTexture).not.toHaveBeenCalled();

				const now = performance.now();
				vi.spyOn(performance, "now").mockReturnValue(now + 1000);
				vi.advanceTimersByTime(1000);
				await texture;
				expect(device.createTexture).toHaveBeenCalledOnce();
			} finally {
				vi.restoreAllMocks();
				vi.useRealTimers();
			}
		});
	});

	describe("get", () => {
		beforeEach(() => {
			vi.stubGlobal("createImageBitmap", fakeCreateImageBitmap);
		});

		afterEach(() => {
			vi.unstubAllGlobals();
		});

		it("should load only a preview for an image drawn small", async () => {
			const device = createDevice(8192);
			const store = new ImageTextureStore(device, () => {});
			const canvas = store.forCanvas("canvas-1", () => 1);
			const file = makeFile(4000, 2000);

			expect(canvas.get(file, span(300))).toBeNull();
			await flushPromises();

			expect(device.createTexture.mock.calls).toHaveLength(1);
			expect(device.createTexture.mock.calls[0][0].size).toEqual({
				width: 512,
				height: 256,
			});
			expect(canvas.get(file, span(300))).not.toBeNull();
			expect(canvas.stateOf(file)).toBe("preview");
		});

		it("should draw the preview while the whole image loads for a larger draw", async () => {
			const device = createDevice(8192);
			const onLoaded = vi.fn();
			const store = new ImageTextureStore(device, onLoaded);
			const canvas = store.forCanvas("canvas-1", () => 1);
			const file = makeFile(4000, 2000);
			canvas.get(file, span(300));
			await flushPromises();
			const preview = canvas.get(file, span(300));

			expect(canvas.get(file, span(3000))).toBe(preview);
			await flushPromises();

			expect(canvas.stateOf(file)).toBe("whole");
			expect(canvas.get(file, span(3000))).not.toBe(preview);
			expect(device.createTexture.mock.calls[1][0].size).toEqual({
				width: 4000,
				height: 2000,
			});
		});

		it("should notify once for images drawn without their texture that finish close together", async () => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			try {
				const onLoaded = vi.fn();
				const store = new ImageTextureStore(createDevice(8192), onLoaded);
				const canvas = store.forCanvas("canvas-1");

				canvas.get(makeFile(10, 10));
				canvas.get(makeFile(20, 20));
				canvas.get(makeFile(30, 30));
				await flushPromises();

				expect(onLoaded).toHaveBeenCalledOnce();
			} finally {
				vi.useRealTimers();
			}
		});

		it("should keep an image no larger than a preview as the whole image", async () => {
			const store = new ImageTextureStore(createDevice(8192), () => {});
			const canvas = store.forCanvas("canvas-1", () => 1);
			const file = makeFile(200, 100);

			canvas.get(file, span(50));
			await flushPromises();

			expect(canvas.stateOf(file)).toBe("whole");
		});
	});

	describe("request", () => {
		beforeEach(() => {
			vi.stubGlobal("createImageBitmap", fakeCreateImageBitmap);
		});

		afterEach(() => {
			vi.unstubAllGlobals();
		});

		it("should have the texture a later draw needs at hand without asking for a redraw", async () => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			try {
				const onLoaded = vi.fn();
				const store = new ImageTextureStore(createDevice(8192), onLoaded);
				const canvas = store.forCanvas("canvas-1", () => 1);
				const file = makeFile(4000, 2000);

				store.holdLoads();
				canvas.request(file, span(3000));
				expect(store.hasLoadsToAwait).toBe(true);

				const now = performance.now();
				vi.spyOn(performance, "now").mockReturnValue(now + 200);
				vi.advanceTimersByTime(200);
				await flushPromises();

				expect(onLoaded).not.toHaveBeenCalled();
				expect(store.hasLoadsToAwait).toBe(false);
				expect(canvas.stateOf(file)).toBe("whole");
			} finally {
				vi.restoreAllMocks();
				vi.useRealTimers();
			}
		});

		it("should stop waiting for loads that outlast the wait", () => {
			const store = new ImageTextureStore(createDevice(8192), () => {});
			const file = makeFile(4000, 2000);
			try {
				store.holdLoads();
				store.forCanvas("canvas-1", () => 1).request(file, span(3000));

				const now = performance.now();
				vi.spyOn(performance, "now").mockReturnValue(now + 1000);

				expect(store.hasLoadsToAwait).toBe(false);
			} finally {
				vi.restoreAllMocks();
				store.destroy();
			}
		});
	});

	describe("beginFrame", () => {
		let now = 0;

		beforeEach(() => {
			vi.stubGlobal("createImageBitmap", fakeCreateImageBitmap);
			now = 1_000;
			vi.spyOn(performance, "now").mockImplementation(() => now);
		});

		afterEach(() => {
			vi.unstubAllGlobals();
			vi.restoreAllMocks();
		});

		/** Two loaded images in a store whose budget holds one of them. */
		async function loadTwoPastBudget() {
			const store = new ImageTextureStore(
				createDevice(8192),
				() => {},
				100 * 100 * 4,
			);
			const canvas = store.forCanvas("canvas-1");
			const first = makeFile(100, 100, "first");
			const second = makeFile(100, 100, "second");
			await canvas.ensure(first);
			await canvas.ensure(second);
			return { store, canvas, first, second };
		}

		it("should free the image used longest ago once the textures pass the budget", async () => {
			const { store, canvas, first, second } = await loadTwoPastBudget();

			now += 10_000;
			store.beginFrame();
			canvas.get(second);
			store.beginFrame();

			expect(canvas.stateOf(first)).toBe("none");
			expect(canvas.stateOf(second)).toBe("whole");
		});

		it("should keep every image the latest frame drew, even past the budget", async () => {
			const { store, canvas, first, second } = await loadTwoPastBudget();

			store.beginFrame();
			canvas.get(first);
			canvas.get(second);
			now += 10_000;
			store.beginFrame();

			expect(canvas.stateOf(first)).toBe("whole");
			expect(canvas.stateOf(second)).toBe("whole");
		});

		it("should keep an image that was loaded a moment ago", async () => {
			const { store, canvas, first, second } = await loadTwoPastBudget();

			store.beginFrame();
			canvas.get(second);
			store.beginFrame();

			expect(canvas.stateOf(first)).toBe("whole");
		});

		it("should keep an image whose state the latest frame asked for", async () => {
			const { store, canvas, first, second } = await loadTwoPastBudget();

			now += 10_000;
			store.beginFrame();
			canvas.get(second);
			canvas.stateOf(first);
			now += 10_000;
			store.beginFrame();

			expect(canvas.stateOf(first)).toBe("whole");
		});

		it("should keep what the latest frame drew through an export of other images", async () => {
			const { store, canvas, first, second } = await loadTwoPastBudget();

			store.beginFrame();
			canvas.get(first);
			now += 10_000;
			store.beginFrame();
			store.beginExport();
			await canvas.ensure(second);
			store.endExport();
			now += 10_000;
			store.beginFrame();

			expect(canvas.stateOf(first)).toBe("whole");
		});

		it("should free nothing while an export is in progress", async () => {
			const { store, canvas, first, second } = await loadTwoPastBudget();

			store.beginExport();
			now += 10_000;
			store.beginFrame();
			canvas.get(second);
			now += 10_000;
			store.beginFrame();

			expect(canvas.stateOf(first)).toBe("whole");
		});

		it("should keep what the frame before drew through a frame that draws part of the view", async () => {
			const { store, canvas, first, second } = await loadTwoPastBudget();

			store.beginFrame();
			canvas.get(first);
			canvas.get(second);
			now += 10_000;
			store.beginFrame();
			canvas.continueLastFrame();
			canvas.get(second);
			now += 10_000;
			store.beginFrame();

			expect(canvas.stateOf(first)).toBe("whole");
		});
	});

	describe("prefetchPreviews", () => {
		beforeEach(() => {
			vi.stubGlobal("createImageBitmap", fakeCreateImageBitmap);
		});

		afterEach(() => {
			vi.unstubAllGlobals();
		});

		it("should have the preview at hand without asking any canvas to redraw", async () => {
			const onLoaded = vi.fn();
			const store = new ImageTextureStore(createDevice(8192), onLoaded);
			const file = makeFile(4000, 2000);

			store.prefetchPreviews([file], "canvas-1");
			await flushPromises();

			expect(onLoaded).not.toHaveBeenCalled();
			expect(
				store.forCanvas("canvas-1", () => 1).get(file, span(300)),
			).not.toBeNull();
		});

		it("should stop loading previews once the textures reach the budget", async () => {
			const device = createDevice(8192);
			const store = new ImageTextureStore(device, () => {}, 512 * 256 * 4);

			store.prefetchPreviews(
				[makeFile(4000, 2000, "first"), makeFile(4000, 2000, "second")],
				"canvas-1",
			);
			await flushPromises();

			expect(device.createTexture).toHaveBeenCalledOnce();
		});

		it("should keep one texture of an image no larger than a preview that two loads bring", async () => {
			const device = createDevice(8192);
			const store = new ImageTextureStore(device, () => {});
			const file = makeFile(200, 100);

			store.prefetchPreviews([file], "canvas-1");
			await store.forCanvas("canvas-1").ensure(file);
			await flushPromises();

			const textures = device.createTexture.mock.results.map(
				(result) => result.value as { destroy: ReturnType<typeof vi.fn> },
			);
			expect(textures).toHaveLength(2);
			expect(
				textures.filter((t) => t.destroy.mock.calls.length > 0),
			).toHaveLength(1);
		});
	});
});

async function flushPromises(): Promise<void> {
	for (let i = 0; i < 30; i++) await Promise.resolve();
}

/** World bounds whose longer side spans `side` units. */
function span(side: number) {
	return {
		minX: 0,
		minY: 0,
		maxX: side,
		maxY: side / 2,
		width: side,
		height: side / 2,
	};
}

function createDevice(maxTextureDimension2D: number) {
	return {
		limits: { maxTextureDimension2D },
		createTexture: vi.fn(
			(descriptor: GPUTextureDescriptor) =>
				({ descriptor, destroy: vi.fn() }) as unknown as GPUTexture,
		),
		queue: { copyExternalImageToTexture: vi.fn() },
	} as unknown as GPUDevice & {
		createTexture: ReturnType<typeof vi.fn>;
	};
}

/** Decodes the size written in the test file, or the requested resize. */
async function fakeCreateImageBitmap(
	source: Blob | ImageBitmap,
	options?: ImageBitmapOptions,
): Promise<ImageBitmap> {
	const own =
		source instanceof Blob
			? (JSON.parse(await source.text()) as { width: number; height: number })
			: source;
	return {
		width: options?.resizeWidth ?? own.width,
		height: options?.resizeHeight ?? own.height,
		close: () => {},
	} as ImageBitmap;
}

function makeFile(
	width: number,
	height: number,
	uid = "image-1",
): EmbeddedFile {
	return {
		uid,
		name: "image.png",
		type: "image/png",
		hash: `${width}x${height}`,
		bin: new TextEncoder().encode(JSON.stringify({ width, height })),
	};
}
