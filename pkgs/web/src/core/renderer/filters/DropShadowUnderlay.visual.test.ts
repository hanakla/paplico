import { beforeAll, describe, expect, it } from "vitest";
import type { Filter } from "../../schema";
import {
	captureTexturePixels,
	ensureWebGPUGlobals,
} from "../../testUtils/visualRegression";
import {
	AppearanceCache,
	type AppearanceCacheEntry,
} from "../canvas/caches/AppearanceCache";
import type {
	UnderlayProcessorContext,
	UnderlayResult,
} from "../canvas/pipeline/FilterRenderer";
import {
	type DropShadowFilter,
	DropShadowFilterProcessor,
	PYRAMID_BLUR_MIN_RADIUS,
} from "./DropShadowFilterProcessor";

/** World size of the square coverage mask every case starts from. */
const COVERAGE_SIZE = 40;
/** Texels per world px — stands in for the document rasterization scale. */
const RASTER_SCALE = 2;

let device: GPUDevice;

beforeAll(async () => {
	const gpu = await ensureWebGPUGlobals();
	const adapter = await gpu.requestAdapter();
	if (!adapter) throw new Error("No GPU adapter");
	device = await adapter.requestDevice();
});

describe("drop shadow coverage underlay", () => {
	describe("cross-frame cache", () => {
		it("should reuse the cached shadow when nothing about the solid changed", async () => {
			const scene = await createScene();

			const first = scene.run();
			const second = scene.run();

			expect(first).not.toBeNull();
			expect(second).not.toBeNull();
			expect(second?.texture.texture).toBe(first?.texture.texture);
			expect(scene.createdShadowTextures()).toBe(1);
			scene.destroy();
		});

		it("should encode no passes at all on a frame that only panned or zoomed", async () => {
			// Panning and zooming change nothing postProcessUnderlay reads: its
			// inputs are world-space and rasterization-scale-based, so the second
			// frame is a pure cache hit — no blur, no colorize, no placement.
			const scene = await createScene();

			scene.run();
			expect(scene.passLabels().length).toBeGreaterThan(0);

			scene.run();

			expect(scene.passLabels()).toEqual([]);
			scene.destroy();
		});

		it("should re-render exactly once after a drop shadow parameter changes", async () => {
			const scene = await createScene();

			scene.run();
			scene.run({ filterOverrides: { blurRadius: 12 } });
			scene.run({ filterOverrides: { blurRadius: 12 } });

			expect(scene.createdShadowTextures()).toBe(2);
			scene.destroy();
		});

		it("should re-render exactly once after the solid's bake generation changes", async () => {
			// coverageHash carries the 3D bake's content hash — rotating the
			// solid, changing its material or its DPI all land here.
			const scene = await createScene();

			scene.run();
			scene.run({ coverageHash: "bake-2" });
			scene.run({ coverageHash: "bake-2" });

			expect(scene.createdShadowTextures()).toBe(2);
			scene.destroy();
		});

		it("should re-render exactly once after the rasterization scale changes", async () => {
			const scene = await createScene();

			scene.run();
			scene.run({ rasterScale: RASTER_SCALE * 2 });
			scene.run({ rasterScale: RASTER_SCALE * 2 });

			expect(scene.createdShadowTextures()).toBe(2);
			scene.destroy();
		});

		it("should re-render exactly once after the solid's projected quad moves", async () => {
			const scene = await createScene();

			scene.run();
			scene.run({ quadOffsetX: 5 });
			scene.run({ quadOffsetX: 5 });

			expect(scene.createdShadowTextures()).toBe(2);
			scene.destroy();
		});
	});

	describe("wide-radius routing", () => {
		it("should resolve a wide radius through the blur pyramid", async () => {
			const scene = await createScene();

			scene.run({
				filterOverrides: {
					blurRadius: (PYRAMID_BLUR_MIN_RADIUS / RASTER_SCALE) * 4,
				},
			});

			expect(scene.passLabels()).toContain("Blur Pyramid Pass");
			expect(scene.passLabels()).toContain(
				"Drop Shadow Pass (Pyramid Resolve)",
			);
			expect(scene.passLabels()).not.toContain(
				"Drop Shadow Pass (Underlay Horizontal Blur)",
			);
			scene.destroy();
		});

		it("should keep a small radius on the direct separable kernel", async () => {
			const scene = await createScene();

			scene.run({
				filterOverrides: {
					blurRadius: (PYRAMID_BLUR_MIN_RADIUS / RASTER_SCALE) * 0.25,
				},
			});

			expect(scene.passLabels()).toContain(
				"Drop Shadow Pass (Underlay Horizontal Blur)",
			);
			expect(scene.passLabels()).toContain(
				"Drop Shadow Pass (Underlay Vertical Blur)",
			);
			expect(scene.passLabels()).not.toContain("Blur Pyramid Pass");
			scene.destroy();
		});

		it("should not jump across the direct/pyramid crossover", async () => {
			// Two radii a hair apart but on opposite sides of the threshold. The
			// two routes size their textures differently (the expansion margin
			// follows the radius), so compare the thing a viewer would notice:
			// how far the shadow's edge fades, in world px.
			const belowScene = await createScene();
			const below = await belowScene.measureEdgeSpread({
				blurRadius: (PYRAMID_BLUR_MIN_RADIUS - 0.2) / RASTER_SCALE,
			});
			belowScene.destroy();

			const aboveScene = await createScene();
			const above = await aboveScene.measureEdgeSpread({
				blurRadius: (PYRAMID_BLUR_MIN_RADIUS + 0.2) / RASTER_SCALE,
			});
			aboveScene.destroy();

			expect(Math.abs(above - below)).toBeLessThan(1);
		});
	});

	describe("texture size clamp", () => {
		it("should keep both axes at one scale when only the long side hits the limit", async () => {
			// The blur and the spread step in TEXELS along each axis, so a texture
			// whose two axes carry different texel densities blurs a different
			// world distance along each. Clamping only the long side of a very wide
			// solid would do exactly that.
			const scene = await createScene();

			const result = scene.run({
				quadWidth: 8000,
				rasterScale: 4,
				filterOverrides: { blurRadius: 6 },
			});
			if (!result) throw new Error("no underlay produced");
			const { width, height } = result.texture.texture;
			const texelsPerWorldX = width / result.bounds.width;
			const texelsPerWorldY = height / result.bounds.height;

			// The clamp really engaged (8000 world px x 4 would be 32000 texels).
			expect(width).toBe(4096);
			expect(width).toBeLessThan(result.bounds.width * 4);
			// …and it took the other axis down with it.
			expect(Math.abs(texelsPerWorldX - texelsPerWorldY)).toBeLessThan(
				texelsPerWorldX * 0.02,
			);
			scene.destroy();
		});

		it("should keep the full requested scale when neither axis hits the limit", async () => {
			const scene = await createScene();

			const result = scene.run();
			if (!result) throw new Error("no underlay produced");
			const { width } = result.texture.texture;

			expect(width).toBe(Math.ceil(result.bounds.width * RASTER_SCALE));
			scene.destroy();
		});
	});

	describe("shadow appearance", () => {
		it("should place the shadow at the offset and let it spread past the solid", async () => {
			const scene = await createScene();
			const result = scene.run();
			if (!result) throw new Error("no underlay produced");
			const alpha = await scene.readAlphaOf(result);
			const { width, height } = result.texture.texture;

			// The mask is a square offset by (+8, -8) world px, i.e. right and
			// down in texture space. Sample the two opposite corners of the
			// expansion margin: the shadow must have moved into the lower-right
			// one and left the upper-left one clear.
			const at = (fx: number, fy: number) =>
				alpha[
					(Math.floor(fy * (height - 1)) * width +
						Math.floor(fx * (width - 1))) *
						4 +
						3
				];

			expect(at(0.5, 0.5)).toBeGreaterThan(100);
			expect(at(0.08, 0.08)).toBeLessThan(8);
			// Bounds are the coverage AABB plus the filter's expansion margin, so
			// the blurred edge lives strictly inside the texture.
			expect(at(0.5, 0.99)).toBeLessThan(20);
			scene.destroy();
		});

		it("should tint the shadow with its color and opacity", async () => {
			const scene = await createScene();
			const result = scene.run({
				filterOverrides: {
					shadowColor: { type: "rgb", r: 1, g: 0, b: 0, a: 1 },
					shadowOpacity: 0.5,
					blurRadius: 0.5,
				},
			});
			if (!result) throw new Error("no underlay produced");
			const pixels = await scene.readAlphaOf(result);
			const { width, height } = result.texture.texture;
			const center =
				(Math.floor(height / 2) * width + Math.floor(width / 2)) * 4;

			// Premultiplied red at half opacity: alpha ≈ 0.5, rgb ≈ (a, 0, 0).
			expect(pixels[center + 3]).toBeGreaterThan(110);
			expect(pixels[center + 3]).toBeLessThan(145);
			expect(pixels[center]).toBeGreaterThan(110);
			expect(pixels[center + 1]).toBeLessThan(8);
			expect(pixels[center + 2]).toBeLessThan(8);
			scene.destroy();
		});
	});
});

// Helpers

interface RunOptions {
	filterOverrides?: Partial<DropShadowFilter["paramData"]["params"]>;
	coverageHash?: string;
	rasterScale?: number;
	quadOffsetX?: number;
	/** World width of the coverage quad (default: a COVERAGE_SIZE square). */
	quadWidth?: number;
}

/**
 * One processor + one coverage mask, driven the way the glass driver drives
 * it. `run` performs a whole "frame": encode, submit, and hand back the
 * underlay. The command encoder is proxied so each frame's render-pass labels
 * are observable without touching the processor's internals.
 */
async function createScene() {
	const processor = new DropShadowFilterProcessor();
	await processor.initialize(device, "rgba8unorm");

	const coverageTexture = createCoverageTexture();
	const cache = new AppearanceCache();
	const appearanceCache = {
		get: (uid: string) => cache.get("element-1", uid),
		set: (uid: string, entry: AppearanceCacheEntry) =>
			cache.set("element-1", uid, entry),
	};
	let labels: string[] = [];
	const shadowTextures = new Set<GPUTexture>();

	const run = (options: RunOptions = {}): UnderlayResult | null => {
		processor.flushPendingDestroy();
		labels = [];
		const encoder = device.createCommandEncoder();
		const proxy = new Proxy(encoder, {
			get(target, prop, receiver) {
				const value = Reflect.get(target, prop, receiver);
				if (prop !== "beginRenderPass" || typeof value !== "function") {
					return typeof value === "function" ? value.bind(target) : value;
				}
				return (descriptor: GPURenderPassDescriptor) => {
					if (descriptor.label) labels.push(descriptor.label);
					return target.beginRenderPass(descriptor);
				};
			},
		}) as GPUCommandEncoder;

		const offsetX = options.quadOffsetX ?? 0;
		const halfX = (options.quadWidth ?? COVERAGE_SIZE) / 2;
		const half = COVERAGE_SIZE / 2;
		const ctx: UnderlayProcessorContext = {
			device,
			commandEncoder: proxy,
			coverage: {
				texture: coverageTexture,
				uvRect: { minU: 0, minV: 0, maxU: 1, maxV: 1 },
				quad: [
					{ x: -halfX + offsetX, y: half },
					{ x: halfX + offsetX, y: half },
					{ x: halfX + offsetX, y: -half },
					{ x: -halfX + offsetX, y: -half },
				],
			},
			rasterScale: options.rasterScale ?? RASTER_SCALE,
			appearanceCache,
			coverageHash: options.coverageHash ?? "bake-1",
		};
		const result = processor.postProcessUnderlay(
			ctx,
			createDropShadow(options.filterOverrides),
		);
		device.queue.submit([encoder.finish()]);
		if (result) shadowTextures.add(result.texture.texture);
		return result;
	};

	const readAlphaOf = async (result: UnderlayResult) =>
		captureTexturePixels(
			device,
			result.texture.texture,
			result.texture.texture.width,
			result.texture.texture.height,
		);

	return {
		run,
		passLabels: () => labels,
		createdShadowTextures: () => shadowTextures.size,
		readAlphaOf,
		/**
		 * How far the shadow's right edge fades from 90% to 10% alpha, in world
		 * px. Size- and bounds-independent, so two shadows built at different
		 * radii (and therefore different texture sizes) stay comparable.
		 */
		measureEdgeSpread: async (
			overrides: Partial<DropShadowFilter["paramData"]["params"]>,
		) => {
			const result = run({ filterOverrides: overrides });
			if (!result) throw new Error("no underlay produced");
			const pixels = await readAlphaOf(result);
			const { width, height } = result.texture.texture;
			const row = Math.floor(height / 2);
			const alphaAt = (x: number) => pixels[(row * width + x) * 4 + 3] / 255;
			let peak = 0;
			for (let x = 0; x < width; x++) peak = Math.max(peak, alphaAt(x));
			const crossing = (level: number): number => {
				for (let x = Math.floor(width / 2); x < width - 1; x++) {
					const current = alphaAt(x);
					const next = alphaAt(x + 1);
					if (current >= level && next < level) {
						return x + (current - level) / Math.max(current - next, 1e-6);
					}
				}
				return width - 1;
			};
			const texelsPerWorld = width / result.bounds.width;
			return (crossing(peak * 0.1) - crossing(peak * 0.9)) / texelsPerWorld;
		},
		destroy: () => {
			cache.clear();
			processor.destroy();
			coverageTexture.destroy();
		},
	};
}

/** A filled square mask: alpha 1 inside, 0 in a one-texel border. */
function createCoverageTexture(): GPUTexture {
	const size = 32;
	const texture = device.createTexture({
		label: "Test Coverage",
		size: { width: size, height: size },
		format: "rgba8unorm",
		usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
	});
	const data = new Uint8Array(size * size * 4);
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			const inside = x > 0 && y > 0 && x < size - 1 && y < size - 1;
			data[(y * size + x) * 4 + 3] = inside ? 255 : 0;
		}
	}
	device.queue.writeTexture(
		{ texture },
		data,
		{ bytesPerRow: size * 4 },
		{ width: size, height: size },
	);
	return texture;
}

function createDropShadow(
	overrides: Partial<DropShadowFilter["paramData"]["params"]> = {},
): Filter {
	return {
		uid: "shadow-1",
		processor: "drop-shadow",
		opacity: 1,
		blendMode: "normal",
		paramData: {
			version: "1",
			params: {
				offsetX: 8,
				offsetY: -8,
				blurRadius: 4,
				shadowOpacity: 1,
				shadowColor: { type: "rgb", r: 0, g: 0, b: 0, a: 1 },
				...overrides,
			},
		},
	} satisfies DropShadowFilter;
}
