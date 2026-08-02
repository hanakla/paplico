import { beforeAll, describe, expect, it } from "vitest";
import type { Filter } from "../../schema";
import {
	captureTexturePixels,
	ensureWebGPUGlobals,
} from "../../testUtils/visualRegression";
import type { FilterProcessorContext } from "../canvas/pipeline/FilterRenderer";
import {
	type DropShadowFilter,
	DropShadowFilterProcessor,
	PYRAMID_BLUR_MIN_RADIUS,
} from "./DropShadowFilterProcessor";

/** Side of the square texture every case filters. */
const SIZE = 160;
/** Side of the opaque green element sitting in the middle of it. */
const ELEMENT_SIZE = 48;
const ELEMENT_MIN = (SIZE - ELEMENT_SIZE) / 2;
const ELEMENT_MAX = ELEMENT_MIN + ELEMENT_SIZE;
/** Shadow offset in world px; +X/−Y lands it right and down in texture space. */
const OFFSET = 20;

let device: GPUDevice;

beforeAll(async () => {
	const gpu = await ensureWebGPUGlobals();
	const adapter = await gpu.requestAdapter();
	if (!adapter) throw new Error("No GPU adapter");
	device = await adapter.requestDevice();
});

/**
 * The in-place chain — `postProcess`, the route every non-glass element takes.
 * It gained the wide-radius pyramid branch alongside the underlay work, and
 * unlike the underlay it must still composite the untouched element on top.
 */
describe("drop shadow in-place chain", () => {
	describe("wide-radius routing", () => {
		it("should resolve a wide radius through the blur pyramid", async () => {
			const run = await filter({ blurRadius: PYRAMID_BLUR_MIN_RADIUS * 2 });

			expect(run.passLabels).toContain("Blur Pyramid Pass");
			expect(run.passLabels).toContain("Drop Shadow Pass (Pyramid Resolve)");
			expect(run.passLabels).not.toContain(
				"Drop Shadow Pass (Vertical Blur + Composite)",
			);
		});

		it("should keep a small radius on the direct separable kernel", async () => {
			const run = await filter({ blurRadius: PYRAMID_BLUR_MIN_RADIUS / 4 });

			expect(run.passLabels).toContain("Drop Shadow Pass (Horizontal Blur)");
			expect(run.passLabels).toContain(
				"Drop Shadow Pass (Vertical Blur + Composite)",
			);
			expect(run.passLabels).not.toContain("Blur Pyramid Pass");
		});
	});

	describe("compositing", () => {
		it("should leave the element itself untouched over a wide shadow", async () => {
			// The pyramid branch owns the colorize AND the "element over shadow"
			// composite; losing the composite would tint the element.
			const run = await filter({ blurRadius: PYRAMID_BLUR_MIN_RADIUS * 2 });
			const centre = run.at(SIZE / 2, SIZE / 2);

			expect(centre[1]).toBeGreaterThan(200);
			expect(centre[0]).toBeLessThan(40);
			expect(centre[3]).toBeGreaterThan(250);
		});

		it("should cast the wide shadow at the offset, outside the element", async () => {
			const run = await filter({ blurRadius: PYRAMID_BLUR_MIN_RADIUS * 2 });
			// Just past the element's lower-right corner, where only the shadow is.
			const shadow = run.at(ELEMENT_MAX + OFFSET / 2, ELEMENT_MAX + OFFSET / 2);
			// The opposite corner is beyond the offset shadow's reach.
			const clear = run.at(ELEMENT_MIN - OFFSET, ELEMENT_MIN - OFFSET);

			expect(shadow[3]).toBeGreaterThan(40);
			expect(shadow[1]).toBeLessThan(60);
			expect(clear[3]).toBeLessThan(12);
		});

		it("should keep the shadow's colour and opacity on the wide path", async () => {
			const run = await filter({
				blurRadius: PYRAMID_BLUR_MIN_RADIUS * 2,
				shadowColor: { type: "rgb", r: 1, g: 0, b: 0, a: 1 },
				shadowOpacity: 0.5,
			});
			const shadow = run.at(ELEMENT_MAX + OFFSET / 2, ELEMENT_MAX + OFFSET / 2);

			// Premultiplied red: red rides with alpha, the other channels stay put.
			expect(shadow[0]).toBeGreaterThan(shadow[2] + 20);
			expect(shadow[3]).toBeGreaterThan(20);
			expect(shadow[3]).toBeLessThan(160);
		});

		it("should not jump across the direct/pyramid crossover", async () => {
			const below = await filter({ blurRadius: PYRAMID_BLUR_MIN_RADIUS - 0.2 });
			const above = await filter({ blurRadius: PYRAMID_BLUR_MIN_RADIUS + 0.2 });

			expect(
				Math.abs(above.shadowEdgeSpread() - below.shadowEdgeSpread()),
			).toBeLessThan(1.5);
		});

		it("should widen the shadow when spread is stacked on a wide blur", async () => {
			const plain = await filter({ blurRadius: PYRAMID_BLUR_MIN_RADIUS * 2 });
			const spread = await filter({
				blurRadius: PYRAMID_BLUR_MIN_RADIUS * 2,
				spreadRadius: 10,
			});

			expect(spread.shadowExtent()).toBeGreaterThan(plain.shadowExtent() + 4);
			// The element still survives on top of the dilated shadow.
			expect(spread.at(SIZE / 2, SIZE / 2)[1]).toBeGreaterThan(200);
		});
	});
});

// Helpers

/** Run one whole postProcess chain and hand back readable results. */
async function filter(
	overrides: Partial<DropShadowFilter["paramData"]["params"]>,
) {
	const processor = new DropShadowFilterProcessor();
	await processor.initialize(device, "rgba8unorm");

	const usage =
		GPUTextureUsage.RENDER_ATTACHMENT |
		GPUTextureUsage.TEXTURE_BINDING |
		GPUTextureUsage.COPY_SRC |
		GPUTextureUsage.COPY_DST;
	const source = device.createTexture({
		label: "Element",
		size: { width: SIZE, height: SIZE },
		format: "rgba8unorm",
		usage,
	});
	const target = device.createTexture({
		label: "Filtered",
		size: { width: SIZE, height: SIZE },
		format: "rgba8unorm",
		usage,
	});
	device.queue.writeTexture(
		{ texture: source },
		elementPixels(),
		{ bytesPerRow: SIZE * 4 },
		{ width: SIZE, height: SIZE },
	);

	const passLabels: string[] = [];
	const encoder = device.createCommandEncoder();
	const proxy = new Proxy(encoder, {
		get(inner, prop, receiver) {
			const value = Reflect.get(inner, prop, receiver);
			if (prop !== "beginRenderPass" || typeof value !== "function") {
				return typeof value === "function" ? value.bind(inner) : value;
			}
			return (descriptor: GPURenderPassDescriptor) => {
				if (descriptor.label) passLabels.push(descriptor.label);
				return inner.beginRenderPass(descriptor);
			};
		},
	}) as GPUCommandEncoder;

	const context: FilterProcessorContext = {
		device,
		sourceTexture: source,
		targetTexture: target,
		commandEncoder: proxy,
		sceneInfo: { textureSize: { width: SIZE, height: SIZE }, dpiScale: 1 },
	};
	processor.postProcess(context, createDropShadow(overrides));
	device.queue.submit([encoder.finish()]);

	const pixels = await captureTexturePixels(device, target, SIZE, SIZE);
	source.destroy();
	target.destroy();
	processor.destroy();

	const alphaAt = (x: number, y: number) =>
		pixels[(Math.round(y) * SIZE + Math.round(x)) * 4 + 3] / 255;

	return {
		passLabels,
		at: (x: number, y: number): [number, number, number, number] => {
			const i = (Math.round(y) * SIZE + Math.round(x)) * 4;
			return [pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3]];
		},
		/** 90%→10% fade width of the shadow's right edge, in texels. */
		shadowEdgeSpread: (): number => {
			const row = Math.round(ELEMENT_MAX + OFFSET / 2);
			let peak = 0;
			for (let x = SIZE / 2; x < SIZE; x++)
				peak = Math.max(peak, alphaAt(x, row));
			const crossing = (level: number): number => {
				for (let x = Math.round(ELEMENT_MAX); x < SIZE - 1; x++) {
					const current = alphaAt(x, row);
					const next = alphaAt(x + 1, row);
					if (current >= level && next < level) {
						return x + (current - level) / Math.max(current - next, 1e-6);
					}
				}
				return SIZE - 1;
			};
			return crossing(peak * 0.1) - crossing(peak * 0.9);
		},
		/** How far right the shadow still registers along its own row. */
		shadowExtent: (): number => {
			const row = Math.round(ELEMENT_MAX + OFFSET / 2);
			let last = SIZE / 2;
			for (let x = SIZE / 2; x < SIZE; x++) {
				if (alphaAt(x, row) > 0.05) last = x;
			}
			return last;
		},
	};
}

/** Opaque green square in the middle, transparent everywhere else. */
function elementPixels(): Uint8Array {
	const data = new Uint8Array(SIZE * SIZE * 4);
	for (let y = ELEMENT_MIN; y < ELEMENT_MAX; y++) {
		for (let x = ELEMENT_MIN; x < ELEMENT_MAX; x++) {
			const i = (y * SIZE + x) * 4;
			data[i + 1] = 255;
			data[i + 3] = 255;
		}
	}
	return data;
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
				offsetX: OFFSET,
				offsetY: -OFFSET,
				blurRadius: 4,
				shadowOpacity: 1,
				shadowColor: { type: "rgb", r: 0, g: 0, b: 0, a: 1 },
				...overrides,
			},
		},
	} satisfies DropShadowFilter;
}
