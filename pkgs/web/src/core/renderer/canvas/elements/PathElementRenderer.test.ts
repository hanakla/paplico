import { describe, expect, it, vi } from "vitest";
import {
	createDefaultBrushSettings,
	createDefaultTransform,
	createStrokeBrushSettings,
} from "../../../document/factory";
import type {
	BrushSettingsV2,
	Path,
	PathSegment,
	StrokeAppearance,
} from "../../../schema";
import { StrokeCache } from "../caches/StrokeCache";
import { PathElementRenderer } from "./PathElementRenderer";

describe("PathElementRenderer", () => {
	it("should flush pending solid runs before an immediate textured brush draw", () => {
		const calls: string[] = [];
		const renderer = new PathElementRenderer({
			assetState: { currentFiles: [] },
			ensureBrushTexture: () => true,
			filterRenderer: { getHandler: () => undefined },
			getStrokeRegistry: () => ({
				getBrushTextureManager: () => undefined,
				render: vi.fn(() => calls.push("textured")),
			}),
			getTransformsBindGroup: () => ({}) as GPUBindGroup,
			renderState: { currentTransformIndex: 0 },
			runBatcher: { flush: vi.fn(() => calls.push("flush")) },
		} as never);
		Reflect.set(
			renderer,
			"renderGeometricStroke",
			vi.fn(() => calls.push("solid")),
		);

		renderer.renderPath({} as GPURenderPassEncoder, appearanceOrderPath());

		expect(calls).toEqual(["solid", "flush", "textured", "solid"]);
	});

	it("should re-bake the vertex alpha when a stroke appearance's opacity changes", () => {
		const { renderer, allocatedAlphas } = createStrokeAlphaProbe();
		const path = singleStrokePath();

		renderer.renderPath(passEncoderStub(), path);
		renderer.renderPath(passEncoderStub(), {
			...path,
			filters: [{ ...(path.filters![0] as StrokeAppearance), opacity: 0.5 }],
		});

		expect(allocatedAlphas).toEqual([1, 0.5]);
	});

	it("should re-bake the vertex alpha when the element's own opacity changes", () => {
		const { renderer, allocatedAlphas } = createStrokeAlphaProbe();
		const path = singleStrokePath();

		renderer.renderPath(passEncoderStub(), path);
		renderer.renderPath(passEncoderStub(), path, 0.25);

		expect(allocatedAlphas).toEqual([1, 0.25]);
	});
});

function appearanceOrderPath(): Path {
	return {
		id: "appearance-order",
		type: "path",
		opacity: 1,
		blendMode: "normal",
		transform: createDefaultTransform(),
		segments: [lineSegment()],
		filters: [
			stroke("solid-before", createStrokeBrushSettings(4)),
			stroke("textured", { ...createDefaultBrushSettings(), randomSeed: 1 }),
			stroke("solid-after", createStrokeBrushSettings(4)),
		],
	};
}

function stroke(uid: string, brushSettings: BrushSettingsV2): StrokeAppearance {
	return {
		uid,
		processor: "stroke",
		opacity: 1,
		blendMode: "normal",
		paramData: {
			version: "1",
			params: {
				strokeColor: {
					type: "solid",
					color: { type: "rgb", r: 0, g: 0, b: 0, a: 1 },
				},
				brushSettings,
			},
		},
	};
}

/**
 * Renderer wired to a real StrokeCache, reporting the alpha each tessellation
 * baked into its vertices. UNIFIED_VERTEX_FLOATS = 9 with alpha at index 5.
 */
function createStrokeAlphaProbe(): {
	renderer: PathElementRenderer;
	allocatedAlphas: number[];
} {
	const allocatedAlphas: number[] = [];
	const renderer = new PathElementRenderer({
		device: { queue: { writeBuffer: vi.fn() } },
		filterRenderer: { getHandler: () => undefined },
		renderState: { currentTransformIndex: 0 },
		strokeCache: new StrokeCache(),
		geometryStore: {
			alloc: (data: Float32Array) => {
				allocatedAlphas.push(data[5]);
				return { byteOffset: 0, firstVertex: 0, release: vi.fn() };
			},
			buffer: () => ({}),
		},
		runBatcher: { flush: vi.fn(), append: vi.fn() },
		getBindGroup: () => ({}),
		getTransformsBindGroup: () => ({}),
		getMaskBindGroup: () => ({}),
		dummyGradientBindGroup: {},
		pulledGeometryPipeline: {},
		strokeUnionPipeline: {},
		stencilZeroPipeline: {},
	} as never);
	return { renderer, allocatedAlphas };
}

function passEncoderStub(): GPURenderPassEncoder {
	return {
		setPipeline: vi.fn(),
		setBindGroup: vi.fn(),
		setVertexBuffer: vi.fn(),
		draw: vi.fn(),
	} as never;
}

function singleStrokePath(): Path {
	return {
		id: "single-stroke",
		type: "path",
		opacity: 1,
		blendMode: "normal",
		transform: createDefaultTransform(),
		segments: [lineSegment()],
		filters: [stroke("stroke-1", createStrokeBrushSettings(4))],
	};
}

function lineSegment(): PathSegment {
	return {
		start: { x: 0, y: 0 },
		cp1: { x: 0, y: 0 },
		cp2: { x: 0, y: 0 },
		end: { x: 10, y: 0 },
		startPressure: 1,
		endPressure: 1,
		startTiltX: 0,
		startTiltY: 0,
		endTiltX: 0,
		endTiltY: 0,
		startDeltaTime: 0,
		endDeltaTime: 0,
		isMoved: true,
	};
}
