import { describe, expect, it } from "vitest";
import {
	createArtboard,
	createDefaultDocument,
	createDefaultLayer,
	createDefaultTransform,
} from "../../document/factory";
import type {
	BrushSettings,
	Document,
	FillAppearance,
	Path,
	PathSegment,
	RawRGBA,
	StrokeAppearance,
	StrokeColor,
} from "../../schema";
import { BUILTIN_BRUSH_IDS } from "../../schema";
import {
	captureTexturePixels,
	createTestRenderer,
	renderWithViewport,
} from "../../testUtils/visualRegression";

/**
 * Ribbon strokes batch through RibbonRenderer.enqueue/flush. The batch must
 * never reorder paint against fills, other textures or isolated strokes, and
 * every ribbon in a shared batch must read its own PathMeta.
 *
 * Every stroke is a horizontal hard-circle ribbon stretched over its own
 * length, so the stroke's centreline is opaque end to end and a pixel on it
 * reads the stroke's own colour.
 */
describe("Ribbon batching", () => {
	it("should keep paint order across a fill between two ribbons", async () => {
		const pixels = await renderPixels(
			[
				ribbonPath("under", -150, 150, 0, RED),
				fillPath("bar", -40, 40, -150, 150, BLUE),
				ribbonPath("over", -150, -50, 0, GREEN),
			],
			[
				[0, 0],
				[-100, 0],
				[100, 0],
			],
		);
		expectColor(pixels[0], BLUE);
		expectColor(pixels[1], GREEN);
		expectColor(pixels[2], RED);
	});

	it("should keep paint order when the ribbon texture changes", async () => {
		const pixels = await renderPixels(
			[
				ribbonPath("soft", -150, 150, 0, RED, BUILTIN_BRUSH_IDS.softCircle),
				ribbonPath("hard", -150, -50, 0, GREEN),
			],
			[[-100, 0]],
		);
		expectColor(pixels[0], GREEN);
	});

	it("should keep each ribbon's gradient and transform in a shared batch", async () => {
		const pixels = await renderPixels(
			[
				ribbonPath(
					"upper",
					-150,
					150,
					0,
					gradient(RED),
					undefined,
					{},
					{ y: 60 },
				),
				ribbonPath(
					"lower",
					-150,
					150,
					0,
					gradient(BLUE),
					undefined,
					{},
					{ y: -60 },
				),
			],
			[
				[0, 60],
				[0, -60],
			],
		);
		expectColor(pixels[0], RED);
		expectColor(pixels[1], BLUE);
	});

	it("should draw ribbons at the same place before and after an isolated wash stroke", async () => {
		const pixels = await renderPixels(
			[
				ribbonPath("before", -150, 150, 100, RED),
				ribbonPath("wash", -150, 150, 0, BLUE, BUILTIN_BRUSH_IDS.hardCircle, {
					paintMode: "wash",
					strokeOpacity: 0.5,
				}),
				ribbonPath("after", -150, 150, -100, GREEN),
			],
			[
				[0, 100],
				[0, -100],
				[0, 0],
			],
		);
		expectColor(pixels[0], RED);
		expectColor(pixels[1], GREEN);
		// The isolated stroke landed too: blue over white, under its cap.
		expect(pixels[2][2]).toBeGreaterThan(240);
		expect(pixels[2][0]).toBeLessThan(247);
		expect(pixels[2][0]).toBeGreaterThan(119);
	});
});

const RED: RawRGBA = { r: 1, g: 0, b: 0, a: 1 };
const GREEN: RawRGBA = { r: 0, g: 1, b: 0, a: 1 };
const BLUE: RawRGBA = { r: 0, g: 0, b: 1, a: 1 };

function expectColor(pixel: number[], color: RawRGBA): void {
	for (const [i, channel] of (["r", "g", "b"] as const).entries()) {
		const expected = color[channel] * 255;
		expect(Math.abs(pixel[i] - expected)).toBeLessThanOrEqual(8);
	}
}

/** Render the paths in order on a white 800×600 canvas and read the pixels
 *  at the given world points. World 0,0 is screen 400,300 and y points up. */
async function renderPixels(
	paths: Path[],
	worldPoints: [number, number][],
): Promise<number[][]> {
	const { renderer, canvas } = await createTestRenderer();
	const viewport = { x: 0, y: 0, zoom: 1, rotation: 0 };
	const device = renderer.getDevice();
	if (!device) throw new Error("Test renderer has no GPU device");
	try {
		const doc = documentOf(paths);
		await renderWithViewport(renderer, canvas, doc, viewport);
		const texture = await renderWithViewport(renderer, canvas, doc, viewport);
		const pixels = await captureTexturePixels(
			device,
			texture,
			texture.width,
			texture.height,
		);
		texture.destroy();
		return worldPoints.map(([wx, wy]) => {
			const offset = ((300 - wy) * texture.width + (400 + wx)) * 4;
			return [
				pixels[offset],
				pixels[offset + 1],
				pixels[offset + 2],
				pixels[offset + 3],
			];
		});
	} finally {
		renderer.destroy();
	}
}

function documentOf(paths: Path[]): Document {
	const doc = createDefaultDocument("ribbon-batch");
	const layer = createDefaultLayer("ribbon-batch-layer", "Strokes");
	for (const path of paths) {
		doc.objects[path.id] = path;
		layer.elementIds.push(path.id);
	}
	doc.layers.push(layer);
	doc.artboards.push(createArtboard("ribbon-batch-ab", "Main", 0, 0, 800, 600));
	return doc;
}

function ribbonPath(
	id: string,
	x1: number,
	x2: number,
	y: number,
	color: RawRGBA | StrokeColor,
	textureUid: string = BUILTIN_BRUSH_IDS.hardCircle,
	overrides: Partial<Pick<BrushSettings, "paintMode" | "strokeOpacity">> = {},
	translate: { y: number } = { y: 0 },
): Path {
	const brushSettings: BrushSettings = {
		version: 2,
		engine: "ribbon",
		strokeOpacity: 1,
		paintMode: "buildup",
		properties: { size: { base: 40 }, flow: { base: 1 } },
		ribbon: {
			source: { kind: "file", fileUid: textureUid },
			uvMode: "stretch",
			tileScale: 1,
			tileSpacing: 0,
		},
		randomSeed: 1,
		...overrides,
	};
	const stroke: StrokeAppearance = {
		uid: `${id}-stroke`,
		processor: "stroke",
		opacity: 1,
		blendMode: "normal",
		paramData: {
			version: "1",
			params: {
				strokeColor:
					"type" in color
						? color
						: { type: "solid", color: { type: "rgb", ...color } },
				brushSettings,
			},
		},
	};
	return {
		id,
		type: "path",
		opacity: 1,
		blendMode: "normal",
		transform: { ...createDefaultTransform(), y: translate.y },
		segments: [lineSegment(x1, y, x2, y)],
		filters: [stroke],
	};
}

function fillPath(
	id: string,
	minX: number,
	maxX: number,
	minY: number,
	maxY: number,
	color: RawRGBA,
): Path {
	const fill: FillAppearance = {
		uid: `${id}-fill`,
		processor: "fill",
		opacity: 1,
		blendMode: "normal",
		paramData: {
			version: "1",
			params: { fill: { type: "solid", color: { type: "rgb", ...color } } },
		},
	};
	const points = [
		{ x: minX, y: maxY },
		{ x: maxX, y: maxY },
		{ x: maxX, y: minY },
		{ x: minX, y: minY },
	];
	return {
		id,
		type: "path",
		opacity: 1,
		blendMode: "normal",
		transform: createDefaultTransform(),
		segments: points.map((point, index) => ({
			...lineSegment(
				point.x,
				point.y,
				points[(index + 1) % 4].x,
				points[(index + 1) % 4].y,
			),
			start: index === 0 ? point : undefined,
			isMoved: index === 0,
			isClosed: index === 3,
		})),
		filters: [fill],
	};
}

/** A two-stop gradient of one colour along the path: the stroke reads the
 *  colour only through its own colour stops. */
function gradient(color: RawRGBA): StrokeColor {
	return {
		type: "stroke-gradient",
		mode: "along",
		gradient: {
			type: "linear",
			x1: 0,
			y1: 0,
			x2: 1,
			y2: 0,
			stops: [
				{ offset: 0, color: { type: "rgb", ...color }, midpoint: 0.5 },
				{ offset: 1, color: { type: "rgb", ...color }, midpoint: 0.5 },
			],
		},
	};
}

function lineSegment(
	x1: number,
	y1: number,
	x2: number,
	y2: number,
): PathSegment {
	return {
		start: { x: x1, y: y1 },
		cp1: { x: 0, y: 0 },
		cp2: { x: 0, y: 0 },
		end: { x: x2, y: y2 },
		startPressure: 1,
		endPressure: 1,
		startTiltX: 0,
		startTiltY: 0,
		endTiltX: 0,
		endTiltY: 0,
		startDeltaTime: 0,
		endDeltaTime: 150,
		isMoved: true,
	};
}
