import { describe, expect, it, vi } from "vitest";
import type { Filter } from "../../../schema";
import type {
	FilterHandler,
	FilterProcessorContext,
} from "../../canvas/pipeline/FilterRenderer";
import { SvgFilterGraphHandler } from "./SvgFilterGraphHandler";
import type { SvgNodeProcessorContext } from "./svgFilterInput";

const texture = (label: string) =>
	({
		label,
		width: 8,
		height: 8,
		format: "rgba8unorm",
		destroy: vi.fn(),
	}) as unknown as GPUTexture;

const device = {
	createTexture: vi.fn(({ label }: GPUTextureDescriptor) =>
		texture(label ?? ""),
	),
} as unknown as GPUDevice;

const primitive = (postProcess = vi.fn()): FilterHandler => ({
	initialize: async () => {},
	onScaleFilter: (filter: Filter) => filter,
	getExpansionMargin: () => 2,
	postProcess,
});

const graph = (nodes: object[]): Filter => ({
	uid: "graph",
	processor: "svg:filter",
	opacity: 1,
	blendMode: "normal",
	paramData: { version: "1", params: { nodes } },
});

function context(): FilterProcessorContext {
	return {
		device,
		sourceTexture: texture("source"),
		targetTexture: texture("target"),
		sourceGraphicTexture: texture("graphic"),
		commandEncoder: {
			copyTextureToTexture: vi.fn(),
		} as unknown as GPUCommandEncoder,
		sceneInfo: { textureSize: { width: 8, height: 8 }, dpiScale: 1 },
	};
}

describe("SvgFilterGraphHandler", () => {
	it("should run nodes in order, chaining outputs and exposing them by id", async () => {
		const first = vi.fn();
		const second = vi.fn();
		const handler = new SvgFilterGraphHandler(
			new Map([
				["svg:offset", primitive(first)],
				["svg:composite", primitive(second)],
			]),
		);
		await handler.initialize(device);
		const ctx = context();

		handler.postProcess(
			ctx,
			graph([
				{ id: "a", processor: "svg:offset", params: { in: "previous" } },
				{
					id: "b",
					processor: "svg:composite",
					params: { in: "SourceGraphic", in2: "ref:a" },
				},
			]),
		);

		const firstCtx = first.mock.calls[0][0] as SvgNodeProcessorContext;
		const secondCtx = second.mock.calls[0][0] as SvgNodeProcessorContext;
		expect(firstCtx.sourceTexture).toBe(ctx.sourceTexture);
		expect(firstCtx.targetTexture).not.toBe(ctx.targetTexture);
		expect(secondCtx.sourceTexture).toBe(firstCtx.targetTexture);
		expect(secondCtx.targetTexture).toBe(ctx.targetTexture);
		expect(secondCtx.nodeOutputs?.get("a")).toBe(firstCtx.targetTexture);
		expect(secondCtx.sourceGraphicTexture).toBe(ctx.sourceGraphicTexture);
		expect((first.mock.calls[0][1] as Filter).processor).toBe("svg:offset");
	});

	it("should ask for the chain input only when a node reads it", () => {
		const handler = new SvgFilterGraphHandler(new Map());
		expect(
			handler.getRenderConfigure(
				graph([{ id: "a", processor: "svg:offset", params: { in: "ref:x" } }]),
			).needsSourceGraphic,
		).toBe(false);
		expect(
			handler.getRenderConfigure(
				graph([
					{ id: "a", processor: "svg:offset", params: { in: "SourceAlpha" } },
				]),
			).needsSourceGraphic,
		).toBe(true);
	});

	it("should reuse a node's texture once its last reader has run", async () => {
		const targets: GPUTexture[] = [];
		const record = vi.fn((ctx: SvgNodeProcessorContext) => {
			targets.push(ctx.targetTexture);
		});
		const handler = new SvgFilterGraphHandler(
			new Map([["svg:offset", primitive(record)]]),
		);
		await handler.initialize(device);
		const ctx = context();
		const createdBefore = vi.mocked(device.createTexture).mock.calls.length;

		handler.postProcess(
			ctx,
			graph([
				{ id: "a", processor: "svg:offset", params: { in: "previous" } },
				{ id: "b", processor: "svg:offset", params: { in: "previous" } },
				{ id: "c", processor: "svg:offset", params: { in: "ref:a" } },
				{ id: "d", processor: "svg:offset", params: { in: "previous" } },
				{ id: "e", processor: "svg:offset", params: { in: "previous" } },
			]),
		);

		// "a" stays alive until "c" reads it, so "b" and "c" need textures of
		// their own; from "d" on the freed ones are recycled.
		expect(new Set(targets.slice(0, 3)).size).toBe(3);
		expect(targets.slice(0, 3)).toContain(targets[3]);
		expect(targets[4]).toBe(ctx.targetTexture);
		expect(
			vi.mocked(device.createTexture).mock.calls.length - createdBefore,
		).toBe(3);
	});

	it("should forward a disabled node's input to its readers and skip its margin", async () => {
		const targets: GPUTexture[] = [];
		const record = vi.fn((ctx: SvgNodeProcessorContext) => {
			targets.push(ctx.targetTexture);
		});
		const handler = new SvgFilterGraphHandler(
			new Map([["svg:offset", primitive(record)]]),
		);
		await handler.initialize(device);
		const ctx = context();
		const nodes = [
			{ id: "a", processor: "svg:offset", params: { in: "previous" } },
			{
				id: "b",
				processor: "svg:offset",
				params: { in: "previous" },
				enabled: false,
			},
			{ id: "c", processor: "svg:offset", params: { in: "ref:b" } },
		];

		handler.postProcess(ctx, graph(nodes));

		expect(record).toHaveBeenCalledTimes(2);
		const readerCtx = record.mock.calls[1][0] as SvgNodeProcessorContext;
		expect(readerCtx.nodeOutputs?.get("b")).toBe(targets[0]);
		expect(readerCtx.sourceTexture).toBe(targets[0]);
		expect(targets[1]).toBe(ctx.targetTexture);
		expect(handler.getExpansionMargin(graph(nodes))).toBe(4);
	});

	it("should copy the input through when the last node is disabled", async () => {
		const handler = new SvgFilterGraphHandler(
			new Map([["svg:offset", primitive()]]),
		);
		await handler.initialize(device);
		const ctx = context();
		handler.postProcess(
			ctx,
			graph([
				{
					id: "a",
					processor: "svg:offset",
					params: { in: "previous" },
					enabled: false,
				},
			]),
		);
		expect(ctx.commandEncoder.copyTextureToTexture).toHaveBeenCalledWith(
			{ texture: ctx.sourceTexture },
			{ texture: ctx.targetTexture },
			{ width: 8, height: 8 },
		);
	});

	it("should hand every node's colors to its primitive's onAdjustColor", () => {
		const flood: FilterHandler = {
			...primitive(),
			onAdjustColor: (params, adjust) => ({
				...(params as object),
				color: adjust({ type: "rgb", r: 1, g: 0, b: 0, a: 1 }),
			}),
		};
		const handler = new SvgFilterGraphHandler(
			new Map([
				["svg:flood", flood],
				["svg:offset", primitive()],
			]),
		);
		const adjusted = handler.onAdjustColor(
			{
				nodes: [
					{ id: "f", processor: "svg:flood", params: { opacity: 1 } },
					{ id: "o", processor: "svg:offset", params: { dx: 1 } },
				],
			},
			() => ({ type: "rgb", r: 0, g: 0, b: 1, a: 1 }),
		) as { nodes: { params: Record<string, unknown> }[] };
		expect(adjusted.nodes[0].params.color).toEqual({
			type: "rgb",
			r: 0,
			g: 0,
			b: 1,
			a: 1,
		});
		expect(adjusted.nodes[1].params).toEqual({ dx: 1 });
	});

	it("should count a dangling reference as the previous result in the margin", async () => {
		const handler = new SvgFilterGraphHandler(
			new Map([["svg:offset", primitive()]]),
		);
		await handler.initialize(device);
		expect(
			handler.getExpansionMargin(
				graph([
					{ id: "a", processor: "svg:offset", params: { in: "previous" } },
					{ id: "b", processor: "svg:offset", params: { in: "ref:removed" } },
				]),
			),
		).toBe(4);
	});

	it("should take the margin of the longest input path and pass an empty graph through", async () => {
		const handler = new SvgFilterGraphHandler(
			new Map([["svg:offset", primitive()]]),
		);
		await handler.initialize(device);
		expect(
			handler.getExpansionMargin(
				graph([
					{ id: "a", processor: "svg:offset", params: { in: "previous" } },
					{ id: "b", processor: "svg:offset", params: { in: "previous" } },
					{ id: "c", processor: "svg:offset", params: { in: "ref:a" } },
					{ id: "d", processor: "svg:offset", params: { in: "SourceAlpha" } },
					{
						id: "e",
						processor: "svg:offset",
						params: { in: "ref:c", in2: "ref:b" },
					},
				]),
			),
		).toBe(6);

		const ctx = context();
		handler.postProcess(ctx, graph([]));
		expect(ctx.commandEncoder.copyTextureToTexture).toHaveBeenCalledWith(
			{ texture: ctx.sourceTexture },
			{ texture: ctx.targetTexture },
			{ width: 8, height: 8 },
		);
	});
});
