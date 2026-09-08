import { describe, expect, it, vi } from "vitest";
import {
	createDefaultBrushSettings,
	createDefaultTransform,
	createStrokeBrushSettings,
} from "../../../document/factory";
import type {
	BrushSettings,
	Path,
	PathSegment,
	StrokeAppearance,
} from "../../../schema";
import { IDENTITY_GPU_TRANSFORM } from "../../../utils/geometry/geometry";
import { OutlineCache } from "../caches/OutlineCache";
import { StripCache } from "../caches/StripCache";
import { PathElementRenderer } from "./PathElementRenderer";

describe("PathElementRenderer", () => {
	it("should draw appearances in array order across strip and brush routes", () => {
		const { renderer, calls } = createProbe();

		renderer.renderPath(passEncoderStub(), appearanceOrderPath());

		expect(calls).toEqual(["strip", "textured", "strip"]);
	});

	it("should carry an opacity change into the instance colour without re-rasterizing", () => {
		const { renderer, colors, rasterized } = createProbe();
		const path = singleStrokePath();

		renderer.renderPath(passEncoderStub(), path);
		renderer.renderPath(passEncoderStub(), {
			...path,
			filters: [{ ...(path.filters![0] as StrokeAppearance), opacity: 0.5 }],
		});
		renderer.renderPath(passEncoderStub(), path, 0.25);

		expect(colors.map((c) => c[3])).toEqual([1, 0.5, 0.25]);
		expect(rasterized.value).toBe(1);
	});

	it("should re-rasterize when the element moves by a fraction of a pixel", () => {
		const { renderer, rasterized, transform } = createProbe();
		const path = singleStrokePath();

		renderer.renderPath(passEncoderStub(), path);
		transform.tx = 3;
		renderer.renderPath(passEncoderStub(), path);
		transform.tx = 3.5;
		renderer.renderPath(passEncoderStub(), path);

		expect(rasterized.value).toBe(2);
	});
});

function createProbe() {
	const calls: string[] = [];
	const colors: (readonly number[])[] = [];
	const rasterized = { value: 0 };
	const transform = { ...IDENTITY_GPU_TRANSFORM };
	const stripCache = new StripCache();
	const originalSet = stripCache.set.bind(stripCache);
	stripCache.set = (id, variant, entry) => {
		rasterized.value++;
		originalSet(id, variant, entry);
	};
	const renderer = new PathElementRenderer({
		stripFrame: {
			append: vi.fn((_batch, _ax, _ay, _w, _h, _slot, color) => {
				calls.push("strip");
				colors.push(color);
				return [{}];
			}),
			draw: vi.fn(),
		},
		dummyGradientBindGroup: {},
		getBindGroup: () => ({}),
		getTransformsBuffer: () => ({}),
		getMaskBindGroup: () => ({}),
		getRasterFrame: () => ({
			viewport: { x: 0, y: 0, zoom: 1, rotation: 0 },
			width: 64,
			height: 64,
		}),
		getGpuTransform: () => transform,
		renderState: { currentTransformIndex: 0 },
		assetState: { currentFiles: [] },
		filterRenderer: { getHandler: () => undefined },
		brushRenderer: {
			render: vi.fn(() => calls.push("textured")),
			textures: undefined,
		},
		getBrushDrawBindings: () => ({}),
		outlineCache: new OutlineCache(),
		stripCache,
		ensureBrushTexture: () => true,
	} as never);
	return { renderer, calls, colors, rasterized, transform };
}

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

function stroke(uid: string, brushSettings: BrushSettings): StrokeAppearance {
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
