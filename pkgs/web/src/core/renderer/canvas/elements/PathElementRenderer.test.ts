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
	StrokeAlign,
	StrokeAppearance,
} from "../../../schema";
import { IDENTITY_GPU_TRANSFORM } from "../../../utils/geometry/geometry";
import {
	type LocalBounds,
	OutlineCache,
	type OutlineEntry,
} from "../caches/OutlineCache";
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

describe("PathElementRenderer stroke alignment", () => {
	function strokeBoundsFor(path: Path): LocalBounds {
		const { renderer, outlines } = createProbe();
		renderer.renderPath(passEncoderStub(), path);
		const outline = outlines.find((entry) => entry.kind === "stroke");
		if (!outline) throw new Error("no stroke outline was tessellated");
		return outline.localBounds;
	}

	it("should leave an open subpath centered even when aligned outside", () => {
		expect(
			strokeBoundsFor(squarePath({ align: "outside", closed: false })),
		).toEqual(strokeBoundsFor(squarePath({ closed: false })));
	});

	it("should push a closed ring's band outside the path", () => {
		expect(strokeBoundsFor(squarePath({ align: "outside" }))).toEqual([
			-4, -4, 14, 14,
		]);
	});

	it("should pull a closed ring's band inside the path", () => {
		expect(strokeBoundsFor(squarePath({ align: "inside" }))).toEqual([
			0, 0, 10, 10,
		]);
	});

	it("should keep aligning a closed ring that a dash pattern splits into fragments", () => {
		const dashArray = [3, 3];

		expect(
			strokeBoundsFor(squarePath({ align: "outside", dashArray })),
		).toEqual([-4, -4, 14, 14]);
	});

	it("should read the winding of each subpath separately", () => {
		// One counter-clockwise ring and one clockwise ring. Resolving the sign
		// once for the whole element would shrink the second one instead.
		const twoRings = squarePath({ align: "outside" });
		twoRings.segments = [
			...twoRings.segments,
			...squareSegments(20, 30, "clockwise"),
		];

		expect(strokeBoundsFor(twoRings)).toEqual([-4, -4, 34, 34]);
	});

	it("should reuse the cached outline for center and an absent alignment", () => {
		const { renderer, outlines } = createProbe();
		const absent = squarePath();
		renderer.renderPath(passEncoderStub(), absent);
		renderer.renderPath(passEncoderStub(), squarePath({ align: "center" }));

		const hashes = outlines
			.filter((entry) => entry.kind === "stroke")
			.map((entry) => entry.geometryHash);
		expect(new Set(hashes).size).toBe(1);
	});

	it("should tessellate a separate outline for inside and outside", () => {
		const { renderer, outlines } = createProbe();
		renderer.renderPath(passEncoderStub(), squarePath({ align: "inside" }));
		renderer.renderPath(passEncoderStub(), squarePath({ align: "outside" }));

		const hashes = outlines
			.filter((entry) => entry.kind === "stroke")
			.map((entry) => entry.geometryHash);
		expect(new Set(hashes).size).toBe(2);
	});
});

/** Axis-aligned square ring in world px, as one closed subpath. */
function squareSegments(
	min: number,
	max: number,
	winding: "counter-clockwise" | "clockwise" = "counter-clockwise",
	closed = true,
): PathSegment[] {
	const ring =
		winding === "counter-clockwise"
			? [
					[min, min],
					[max, min],
					[max, max],
					[min, max],
				]
			: [
					[min, min],
					[min, max],
					[max, max],
					[max, min],
				];
	return ring.map(([x, y], index) => {
		const [nextX, nextY] = ring[(index + 1) % ring.length];
		return {
			start: { x, y },
			cp1: { x: 0, y: 0 },
			cp2: { x: 0, y: 0 },
			end: { x: nextX, y: nextY },
			startPressure: 1,
			endPressure: 1,
			startTiltX: 0,
			startTiltY: 0,
			endTiltX: 0,
			endTiltY: 0,
			startDeltaTime: 0,
			endDeltaTime: 0,
			isMoved: index === 0,
			isClosed: closed && index === ring.length - 1,
		};
	});
}

function squarePath(
	options: {
		align?: StrokeAlign;
		dashArray?: readonly number[];
		closed?: boolean;
	} = {},
): Path {
	return {
		id: "square",
		type: "path",
		opacity: 1,
		blendMode: "normal",
		transform: createDefaultTransform(),
		segments: squareSegments(
			0,
			10,
			"counter-clockwise",
			options.closed ?? true,
		),
		filters: [
			stroke(
				"aligned",
				createStrokeBrushSettings(4, {
					lineCap: "butt",
					lineJoin: "miter",
					miterLimit: 4,
					align: options.align,
					dashArray: options.dashArray,
				}),
			),
		],
	};
}

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
	const outlines: OutlineEntry[] = [];
	const outlineCache = new OutlineCache();
	const originalOutlineSet = outlineCache.set.bind(outlineCache);
	outlineCache.set = (id, variant, entry) => {
		outlines.push(entry);
		originalOutlineSet(id, variant, entry);
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
		outlineCache,
		stripCache,
		ensureBrushTexture: () => true,
	} as never);
	return { renderer, calls, colors, rasterized, transform, outlines };
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
