import { describe, expect, it, vi } from "vitest";
import type { AnyArtObject, Filter } from "../../../schema";
import {
	type FilterHandler,
	type FilterProcessorContext,
	FilterRenderer,
	hoistBlendInstanceAppearances,
	isElementRenderReplaced,
	type RegisterableFilterHandler,
} from "./FilterRenderer";
import { createBorrowedTextureRef, createRenderSurface } from "./RenderSurface";

type CopyCall = {
	source: GPUTexture;
	destination: GPUTexture;
};

function getExtentValue(
	size: GPUExtent3D,
	key: "width" | "height" | "depthOrArrayLayers",
): number {
	if (typeof size === "number") return size;
	if (Array.isArray(size)) {
		if (key === "width") return size[0] ?? 1;
		if (key === "height") return size[1] ?? 1;
		return size[2] ?? 1;
	}
	return size[key] ?? 1;
}

function createMockTexture(
	label: string,
	width: number,
	height: number,
	format: GPUTextureFormat,
): GPUTexture {
	return {
		label,
		width,
		height,
		format,
		createView: vi.fn(() => ({}) as GPUTextureView),
		destroy: vi.fn(),
	} as unknown as GPUTexture;
}

function createMockDevice(): GPUDevice {
	return {
		createSampler: vi.fn(() => ({}) as GPUSampler),
		createTexture: vi.fn((descriptor: GPUTextureDescriptor) =>
			createMockTexture(
				descriptor.label ?? "Temp Texture",
				getExtentValue(descriptor.size, "width"),
				getExtentValue(descriptor.size, "height"),
				descriptor.format,
			),
		),
	} as unknown as GPUDevice;
}

function createMockEncoder(copies: CopyCall[]): GPUCommandEncoder {
	return {
		copyTextureToTexture: vi.fn((source, destination) => {
			copies.push({
				source: source.texture,
				destination: destination.texture,
			});
		}),
	} as unknown as GPUCommandEncoder;
}

function createMockPostHandler(
	postProcess: NonNullable<FilterHandler["postProcess"]>,
): RegisterableFilterHandler {
	return {
		initialize: async () => {},
		onScaleFilter: (filter: Filter) => filter,
		getExpansionMargin: () => 0,
		postProcess,
	};
}

/** A handler shaped like extrude3d: ignores sourceTexture and produces its
 *  own self-sized output (or void when there's nothing to draw). */
function createMockGeometryHandler(
	postProcess: NonNullable<FilterHandler["postProcess"]>,
): RegisterableFilterHandler {
	return {
		initialize: async () => {},
		onScaleFilter: (filter: Filter) => filter,
		getExpansionMargin: () => 0,
		getRenderConfigure: () => ({
			needsBackdrop: false,
			needsSourceTexture: false,
		}),
		postProcess,
	};
}

describe("FilterRenderer.applyFilters", () => {
	it("calls handler.postProcess with its original this binding", () => {
		const device = createMockDevice();
		const renderer = new FilterRenderer(device);
		let observedThis: unknown = null;
		const handler = {
			initialize: async () => {},
			onScaleFilter: (filter: Filter) => filter,
			getExpansionMargin: () => 0,
			postProcess(this: unknown) {
				observedThis = this;
			},
		} satisfies RegisterableFilterHandler;
		renderer.registerHandler("blur", handler);

		const sourceTexture = createMockTexture(
			"Offscreen Element Texture",
			240,
			180,
			"rgba8unorm",
		);
		const encoder = createMockEncoder([]);
		const filters: Filter[] = [
			{
				uid: "test-uid-0",
				processor: "blur",
				opacity: 1,
				blendMode: "normal" as const,
				paramData: { version: "1", params: { radius: 4 } },
			},
		];
		renderer.applyFilters(sourceTexture, filters, encoder);

		expect(observedThis).toBe(handler);
	});

	it("avoids self-copy when skipped filters exist after an active post-filter", () => {
		const device = createMockDevice();
		const renderer = new FilterRenderer(device);
		const postProcess = vi.fn();
		renderer.registerHandler("blur", createMockPostHandler(postProcess));

		const sourceTexture = createMockTexture(
			"Offscreen Element Texture",
			240,
			180,
			"rgba8unorm",
		);
		const copies: CopyCall[] = [];
		const encoder = createMockEncoder(copies);

		const filters: Filter[] = [
			{
				uid: "test-uid-1",
				processor: "blur",
				opacity: 1,
				blendMode: "normal" as const,
				paramData: { version: "1", params: { radius: 4 } },
			},
			{
				uid: "test-uid-2",
				processor: "zigzag",
				opacity: 1,
				blendMode: "normal" as const,
				paramData: {
					version: "1",
					params: { frequency: 1, amplitude: 1 },
				},
			},
		];
		renderer.applyFilters(sourceTexture, filters, encoder);

		expect(postProcess).toHaveBeenCalledTimes(1);
		const ctx = postProcess.mock.calls[0][0] as FilterProcessorContext;
		expect(ctx.sourceTexture).toBe(sourceTexture);
		expect(ctx.targetTexture).not.toBe(sourceTexture);
		expect(copies.every((copy) => copy.source !== copy.destination)).toBe(true);
	});

	it("keeps ping-pong sources valid across multiple active post-filters", () => {
		const device = createMockDevice();
		const renderer = new FilterRenderer(device);
		const postProcess = vi.fn();
		renderer.registerHandler("blur", createMockPostHandler(postProcess));

		const sourceTexture = createMockTexture(
			"Offscreen Element Texture",
			240,
			180,
			"rgba8unorm",
		);
		const copies: CopyCall[] = [];
		const encoder = createMockEncoder(copies);

		const filters: Filter[] = [
			{
				uid: "test-uid-3",
				processor: "blur",
				opacity: 1,
				blendMode: "normal" as const,
				paramData: { version: "1", params: { radius: 2 } },
			},
			{
				uid: "test-uid-4",
				processor: "blur",
				opacity: 1,
				blendMode: "normal" as const,
				paramData: { version: "1", params: { radius: 8 } },
			},
			{
				uid: "test-uid-5",
				processor: "zigzag",
				opacity: 1,
				blendMode: "normal" as const,
				paramData: {
					version: "1",
					params: { frequency: 1, amplitude: 1 },
				},
			},
		];
		renderer.applyFilters(sourceTexture, filters, encoder);

		expect(postProcess).toHaveBeenCalledTimes(2);
		const firstContext = postProcess.mock.calls[0][0] as FilterProcessorContext;
		const secondContext = postProcess.mock
			.calls[1][0] as FilterProcessorContext;
		expect(firstContext.sourceTexture).toBe(sourceTexture);
		expect(secondContext.sourceTexture).not.toBe(sourceTexture);
		expect(copies.every((copy) => copy.source !== copy.destination)).toBe(true);
	});

	describe("a source-ignoring leading handler (e.g. extrude3d)", () => {
		function geometryFilter(uid: string): Filter {
			return {
				uid,
				processor: "extrude3d",
				opacity: 1,
				blendMode: "normal" as const,
				paramData: { version: "1", params: {} },
			};
		}

		it("never copies into or out of a placeholder-sized sourceTexture", () => {
			const device = createMockDevice();
			const renderer = new FilterRenderer(device);
			const resultTexture = createMockTexture(
				"Extrude Output",
				512,
				512,
				"rgba8unorm",
			);
			renderer.registerHandler(
				"extrude3d",
				createMockGeometryHandler(() =>
					createRenderSurface(
						createBorrowedTextureRef(resultTexture, "external"),
						{
							kind: "world-aabb",
							bounds: {
								minX: 0,
								minY: 0,
								maxX: 1,
								maxY: 1,
								width: 1,
								height: 1,
							},
							uvRect: { minU: 0, minV: 0, maxU: 1, maxV: 1 },
						},
						{
							role: "color",
							alphaMode: "premultiplied",
							opacityState: "intrinsic",
						},
					),
				),
			);

			// A 1x1 placeholder, wildly mismatched against contentBounds — a real
			// render would treat this as heavily "padded" and try to strip it.
			const placeholder = createMockTexture("Placeholder", 1, 1, "rgba8unorm");
			const copies: CopyCall[] = [];
			const encoder = createMockEncoder(copies);

			const result = renderer.applyFilters(
				placeholder,
				[geometryFilter("app-1")],
				encoder,
				undefined,
				1,
				{ width: 400, height: 400 },
			);

			expect(copies).toHaveLength(0);
			expect(result.texture).toBe(resultTexture);
			expect(result.overrides).toHaveLength(1);
			expect(result.overrides![0].texture.texture).toBe(resultTexture);
		});

		it("returns the placeholder untouched when the handler produces nothing", () => {
			const device = createMockDevice();
			const renderer = new FilterRenderer(device);
			renderer.registerHandler(
				"extrude3d",
				createMockGeometryHandler(() => undefined),
			);

			const placeholder = createMockTexture("Placeholder", 1, 1, "rgba8unorm");
			const copies: CopyCall[] = [];
			const encoder = createMockEncoder(copies);

			const result = renderer.applyFilters(
				placeholder,
				[geometryFilter("app-1")],
				encoder,
				undefined,
				1,
				{ width: 400, height: 400 },
			);

			expect(copies).toHaveLength(0);
			expect(result.texture).toBe(placeholder);
			expect(result.overrides).toBeUndefined();
		});

		it("still receives sourceTexture (unused) in its context without throwing", () => {
			const device = createMockDevice();
			const renderer = new FilterRenderer(device);
			let observedSource: GPUTexture | null = null;
			renderer.registerHandler(
				"extrude3d",
				createMockGeometryHandler((ctx) => {
					observedSource = ctx.sourceTexture;
					return undefined;
				}),
			);

			const placeholder = createMockTexture("Placeholder", 1, 1, "rgba8unorm");
			const encoder = createMockEncoder([]);

			expect(() =>
				renderer.applyFilters(
					placeholder,
					[geometryFilter("app-1")],
					encoder,
					undefined,
					1,
					{ width: 400, height: 400 },
				),
			).not.toThrow();
			expect(observedSource).toBe(placeholder);
		});
	});
});

describe("hoistBlendInstanceAppearances", () => {
	const extrude: Filter = {
		uid: "ex",
		processor: "extrude3d",
		enabled: true,
	} as unknown as Filter;
	const rendererWithExtrude = {
		getHandler: (p: string) =>
			p === "extrude3d"
				? ({ replacesElementRender: () => true } as unknown as FilterHandler)
				: undefined,
	};

	const key = (id: string, filters: Filter[]): AnyArtObject =>
		({ id, type: "path", filters }) as unknown as AnyArtObject;
	const blend = (
		id: string,
		objectIds: string[],
		filters: Filter[],
	): AnyArtObject =>
		({ id, type: "blend", objectIds, filters }) as unknown as AnyArtObject;

	it("copies a key's render-replacing appearance onto a blend that lacks one", () => {
		const map = new Map<string, AnyArtObject>([
			["k1", key("k1", [extrude])],
			["b1", blend("b1", ["k1", "k2"], [])],
		]);

		hoistBlendInstanceAppearances(map, rendererWithExtrude);

		expect(isElementRenderReplaced(map.get("b1")!, rendererWithExtrude)).toBe(
			true,
		);
	});

	it("is a no-op when the blend already has a render-replacing appearance", () => {
		const original = blend("b1", ["k1"], [extrude]);
		const map = new Map<string, AnyArtObject>([
			["k1", key("k1", [extrude])],
			["b1", original],
		]);

		hoistBlendInstanceAppearances(map, rendererWithExtrude);

		// Unchanged reference — not replaced with a hoisted copy.
		expect(map.get("b1")).toBe(original);
	});

	it("is a no-op when no key has a render-replacing appearance", () => {
		const original = blend("b1", ["k1"], []);
		const map = new Map<string, AnyArtObject>([
			["k1", key("k1", [])],
			["b1", original],
		]);

		hoistBlendInstanceAppearances(map, rendererWithExtrude);

		expect(map.get("b1")).toBe(original);
	});

	it("prefers a backdrop-needing (glass) key's appearance over an earlier opaque one", () => {
		const opaque: Filter = {
			uid: "op",
			processor: "extrude3d",
			enabled: true,
		} as unknown as Filter;
		const glass: Filter = {
			uid: "gl",
			processor: "extrude3d",
			enabled: true,
		} as unknown as Filter;
		// needsBackdrop follows the filter identity, mirroring how the real
		// handler derives it from the material params.
		const renderer = {
			getHandler: (p: string) =>
				p === "extrude3d"
					? ({
							replacesElementRender: () => true,
							getRenderConfigure: (f: Filter) => ({
								needsBackdrop: f.uid === "gl",
							}),
						} as unknown as FilterHandler)
					: undefined,
		};
		// Opaque key first: order must not decide the blend's render route.
		const map = new Map<string, AnyArtObject>([
			["k1", key("k1", [opaque])],
			["k2", key("k2", [glass])],
			["b1", blend("b1", ["k1", "k2"], [])],
		]);

		hoistBlendInstanceAppearances(map, renderer);

		expect(map.get("b1")!.filters?.map((f) => f.uid)).toEqual(["gl"]);
	});
});
