import { describe, expect, it } from "vitest";
import {
	createArtboard,
	createDefaultDocument,
	createDefaultLayer,
	createDefaultTransform,
} from "../../document/factory";
import type {
	Document,
	Extrude3DAppearance,
	FillAppearance,
	Path,
	PathSegment,
	RawRGBA,
} from "../../schema";
import {
	captureTexturePixels,
	createTestRenderer,
	renderWithViewport,
} from "../../testUtils/visualRegression";

const CANVAS_WIDTH = 800;
const CANVAS_HEIGHT = 600;
/** Glass blur in WORLD px — the value the user types into the panel. */
const GLASS_BLUR_WORLD = 6;
/** Side of the glass square in world px. */
const GLASS_SIZE = 90;
const TRANSPARENT: RawRGBA = { r: 0, g: 0, b: 0, a: 0 };

describe("glass blur scale", () => {
	it("should keep the blur the same world size across editor zoom levels", async () => {
		// Same scene, three zooms. Once normalized by the zoom, the blurred
		// seam under the glass must cover the same distance on the artboard —
		// that is what "material.blur is in world px" means.
		const spreads = await Promise.all(
			[1, 2, 4].map((zoom) => measureEditorSpread(zoom)),
		);

		expectAllClose(spreads, 0.25);
	});

	it("should blur an export by the same world size as the editor at that scale", async () => {
		// The export path drives the same CanvasLayer with viewport.zoom = the
		// export scale, so the two must agree scale for scale — otherwise a
		// 4× PNG would not look like the canvas at 400%.
		for (const scale of [1, 2]) {
			const editor = await measureEditorSpread(scale);
			const exported = await measureExportSpread(scale);

			expect(Math.abs(editor - exported)).toBeLessThan(
				Math.max(editor, exported) * 0.25,
			);
		}
	});

	it("should not shift the blur between the pre-zoom frame, the zoom blit and the settled render", async () => {
		// A viewport-only zoom frame blits the cached composite and rescales it
		// (CanvasLayer.renderViewportBlit) instead of re-rendering, so its edge
		// spread is exactly the pre-zoom frame's spread times the zoom ratio.
		// Model the three states in device px: before the gesture, during it,
		// and after it settles into a fresh render. With a screen-fixed blur the
		// blitted state would overshoot the settled one by the zoom ratio.
		const before = await measureDeviceSpread(1);
		const settled = await measureDeviceSpread(4);
		const duringBlit = before * 4;

		expect(Math.abs(duringBlit - settled)).toBeLessThan(settled * 0.25);
		expect(Math.abs(before - settled / 4)).toBeLessThan((settled / 4) * 0.25);
	});
});

// Helpers

/** The blurred seam's 10%→90% width under the glass, in WORLD px. */
async function measureEditorSpread(zoom: number): Promise<number> {
	const { renderer, canvas } = await createTestRenderer();
	return renderAndMeasure(renderer, canvas, createGlassDocument(), zoom);
}

/** The same measurement left in device px (what a frame actually shows). */
async function measureDeviceSpread(zoom: number): Promise<number> {
	return (await measureEditorSpread(zoom)) * zoom;
}

async function renderAndMeasure(
	renderer: Awaited<ReturnType<typeof createTestRenderer>>["renderer"],
	canvas: Awaited<ReturnType<typeof createTestRenderer>>["canvas"],
	document: Document,
	zoom: number,
): Promise<number> {
	const texture = await renderWithViewport(
		renderer,
		canvas,
		document,
		{ x: 0, y: 0, zoom, rotation: 0 },
		TRANSPARENT,
	);
	const device = renderer.getDevice();
	if (!device) throw new Error("GPU device is unavailable");
	const pixels = await captureTexturePixels(
		device,
		texture,
		CANVAS_WIDTH,
		CANVAS_HEIGHT,
	);
	texture.destroy();
	return (
		measureSeamSpread(pixels, CANVAS_WIDTH, CANVAS_HEIGHT / 2, zoom) / zoom
	);
}

async function measureExportSpread(scale: number): Promise<number> {
	const { renderer } = await createTestRenderer();
	const document = createGlassDocument();
	const artboard = createArtboard(
		"artboard-1",
		"Artboard",
		0,
		0,
		CANVAS_WIDTH,
		CANVAS_HEIGHT,
	);
	document.artboards = [artboard];
	const result = await renderer.renderArtboardToTexture(
		artboard,
		document,
		scale,
		{ r: 0, g: 0, b: 0, a: 0 },
	);
	if (!result) throw new Error("export render failed");
	const device = renderer.getDevice();
	if (!device) throw new Error("GPU device is unavailable");
	const pixels = await captureTexturePixels(
		device,
		result.texture,
		result.width,
		result.height,
	);
	result.texture.destroy();
	return (
		measureSeamSpread(pixels, result.width, result.height / 2, scale) / scale
	);
}

/**
 * How wide the backdrop's black→white seam is where the glass blurs it, in
 * device px. Scans outward from the canvas centre (the seam sits at world
 * x = 0) and returns the distance between the 10% and 90% luminance
 * crossings.
 */
function measureSeamSpread(
	pixels: Uint8Array,
	width: number,
	rowFloat: number,
	zoom: number,
): number {
	const row = Math.floor(rowFloat);
	const centre = Math.floor(width / 2);
	// Stay well inside the glass square so the solid's own edge never enters
	// the scan window.
	const halfWindow = Math.floor(((GLASS_SIZE / 2) * zoom) / 2);
	const luminance = (x: number): number => {
		const i = (row * width + x) * 4;
		return (
			(pixels[i] * 0.2126 + pixels[i + 1] * 0.7152 + pixels[i + 2] * 0.0722) /
			255
		);
	};
	let low = Number.POSITIVE_INFINITY;
	let high = Number.NEGATIVE_INFINITY;
	for (let x = centre - halfWindow; x <= centre + halfWindow; x++) {
		low = Math.min(low, luminance(x));
		high = Math.max(high, luminance(x));
	}
	if (!(high - low > 0.05)) {
		throw new Error("no measurable seam under the glass");
	}
	const crossing = (level: number): number => {
		for (let x = centre - halfWindow; x < centre + halfWindow; x++) {
			const current = luminance(x);
			const next = luminance(x + 1);
			if (current <= level && next > level) {
				return x + (level - current) / Math.max(next - current, 1e-6);
			}
		}
		throw new Error(`no crossing at ${level}`);
	};
	return (
		crossing(low + (high - low) * 0.9) - crossing(low + (high - low) * 0.1)
	);
}

function expectAllClose(values: number[], relativeTolerance: number): void {
	const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
	for (const value of values) {
		expect(Math.abs(value - mean)).toBeLessThan(mean * relativeTolerance);
	}
}

/**
 * A hard black→white seam at world x = 0, with a fully transmissive glass
 * square centred on it: everything visible inside the square is the blurred
 * backdrop, so the seam's softness measures the glass blur directly.
 */
function createGlassDocument(): Document {
	const document = createDefaultDocument("glass-blur-scale");
	const layer = createDefaultLayer("layer-1", "Layer");

	const dark = backgroundPath("bg-dark", -2000, 0, { r: 0, g: 0, b: 0, a: 1 });
	const light = backgroundPath("bg-light", 0, 2000, {
		r: 1,
		g: 1,
		b: 1,
		a: 1,
	});
	const glass: Path = {
		id: "glass-1",
		type: "path",
		opacity: 1,
		blendMode: "normal",
		transform: createDefaultTransform(),
		segments: rectSegments(
			-GLASS_SIZE / 2,
			GLASS_SIZE / 2,
			-GLASS_SIZE / 2,
			GLASS_SIZE / 2,
		),
		filters: [
			fill({ r: 0.5, g: 0.5, b: 0.5, a: 1 }),
			{
				uid: "extrude-1",
				processor: "extrude3d",
				opacity: 1,
				blendMode: "normal",
				paramData: {
					version: "1",
					params: {
						depth: 10,
						rotationDeg: [0, 0, 0],
						perspective: 0,
						material: {
							shading: "flat",
							lightDir: [0, 0, 1],
							// glass 1 = fully transmissive, so the composite under the
							// solid is purely the blurred backdrop.
							glass: 1,
							blur: GLASS_BLUR_WORLD,
						},
					},
				},
			} satisfies Extrude3DAppearance,
		],
	};

	for (const element of [dark, light, glass]) {
		document.objects[element.id] = element;
		layer.elementIds.push(element.id);
	}
	document.layers = [layer];
	return document;
}

function backgroundPath(
	id: string,
	minX: number,
	maxX: number,
	color: RawRGBA,
): Path {
	return {
		id,
		type: "path",
		opacity: 1,
		blendMode: "normal",
		transform: createDefaultTransform(),
		segments: rectSegments(minX, maxX, -2000, 2000),
		filters: [fill(color)],
	};
}

function fill(color: RawRGBA): FillAppearance {
	return {
		uid: `fill-${color.r}-${color.g}-${color.b}`,
		processor: "fill",
		opacity: 1,
		blendMode: "normal",
		paramData: {
			version: "1",
			params: {
				fill: { type: "solid", color: { type: "rgb", ...color } },
			},
		},
	};
}

function rectSegments(
	minX: number,
	maxX: number,
	minY: number,
	maxY: number,
): PathSegment[] {
	const points = [
		{ x: minX, y: maxY },
		{ x: maxX, y: maxY },
		{ x: maxX, y: minY },
		{ x: minX, y: minY },
	];
	return points.map((point, index) => ({
		start: index === 0 ? point : undefined,
		cp1: { x: 0, y: 0 },
		cp2: { x: 0, y: 0 },
		end: points[(index + 1) % points.length],
		startPressure: 1,
		endPressure: 1,
		startTiltX: 0,
		startTiltY: 0,
		endTiltX: 0,
		endTiltY: 0,
		startDeltaTime: 0,
		endDeltaTime: 0,
		isMoved: index === 0,
		isClosed: index === points.length - 1,
	}));
}
