import { describe, expect, it } from "vitest";
import {
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
	Viewport,
} from "../../schema";
import {
	captureTexturePixels,
	createTestRenderer,
} from "../../testUtils/visualRegression";
import type { RenderOrchestrator } from "../RenderOrchestrator";
import type { ChangedElements } from "../types";
import type { DropShadowFilter } from "./DropShadowFilterProcessor";

const WIDTH = 800;
const HEIGHT = 600;
const BACKGROUND: RawRGBA = { r: 0, g: 0, b: 0, a: 0 };
const UNCHANGED: ChangedElements = { upserted: new Set(), deleted: new Set() };

describe("extrude3d multi-frame repro", () => {
	it.each([
		["opaque", undefined],
		["glass", 1.5],
	] as const)("%s extrude stays visible and same-sized across frames (zoom=1)", async (_name, refraction) => {
		const { renderer } = await createTestRenderer();
		const doc = createDocument(refraction, false);
		const f1 = await renderFrame(renderer, doc, {
			x: 0,
			y: 0,
			zoom: 1,
			rotation: 0,
		});
		const f2 = await renderFrame(renderer, doc, {
			x: 0,
			y: 0,
			zoom: 1,
			rotation: 0,
		});
		const b1 = solidBBox(f1.pixels);
		const b2 = solidBBox(f2.pixels);
		expect(b1).not.toBeNull();
		expect(b2).not.toBeNull();
		expect(Math.abs(b2!.w - b1!.w)).toBeLessThanOrEqual(2);
		expect(Math.abs(b2!.h - b1!.h)).toBeLessThanOrEqual(2);
	});

	it.each([
		["opaque", undefined],
		["glass", 1.5],
	] as const)("%s extrude + drop shadow keeps size across frames (zoom=1)", async (_name, refraction) => {
		const { renderer } = await createTestRenderer();
		const doc = createDocument(refraction, true);
		const f1 = await renderFrame(renderer, doc, {
			x: 0,
			y: 0,
			zoom: 1,
			rotation: 0,
		});
		const f2 = await renderFrame(renderer, doc, {
			x: 0,
			y: 0,
			zoom: 1,
			rotation: 0,
		});
		const b1 = anyBBox(f1.pixels);
		const b2 = anyBBox(f2.pixels);
		expect(b1).not.toBeNull();
		expect(b2).not.toBeNull();
		expect(Math.abs(b2!.w - b1!.w)).toBeLessThanOrEqual(2);
		expect(Math.abs(b2!.h - b1!.h)).toBeLessThanOrEqual(2);
	});

	it.each([
		["opaque", undefined],
		["glass", 1.5],
	] as const)("%s extrude is visible at fractional zoom (0.75)", async (_name, refraction) => {
		const { renderer } = await createTestRenderer();
		const doc = createDocument(refraction, true);
		const viewport: Viewport = { x: 0, y: 0, zoom: 0.75, rotation: 0 };
		const f1 = await renderFrame(renderer, doc, viewport);
		const f2 = await renderFrame(renderer, doc, viewport);
		const b1 = anyBBox(f1.pixels);
		const b2 = anyBBox(f2.pixels);
		expect(b1).not.toBeNull();
		expect(b2).not.toBeNull();
	});

	it.each([
		["opaque", undefined],
		["glass", 1.5],
	] as const)("%s extrude solid keeps its size when a drop shadow is appended", async (_name, refraction) => {
		const { renderer: plainRenderer } = await createTestRenderer();
		const plain = await renderFrame(
			plainRenderer,
			createDocument(refraction, false),
			{ x: 0, y: 0, zoom: 1, rotation: 0 },
		);
		const { renderer: shadowRenderer } = await createTestRenderer();
		const withShadow = await renderFrame(
			shadowRenderer,
			createDocument(refraction, true),
			{ x: 0, y: 0, zoom: 1, rotation: 0 },
		);
		const plainBox = solidBBox(plain.pixels);
		const shadowBox = solidBBox(withShadow.pixels);
		expect(plainBox).not.toBeNull();
		expect(shadowBox).not.toBeNull();
		expect(Math.abs(shadowBox!.w - plainBox!.w)).toBeLessThanOrEqual(2);
		expect(Math.abs(shadowBox!.h - plainBox!.h)).toBeLessThanOrEqual(2);
		expect(Math.abs(shadowBox!.x - plainBox!.x)).toBeLessThanOrEqual(2);
		expect(Math.abs(shadowBox!.y - plainBox!.y)).toBeLessThanOrEqual(2);
	});
});

async function renderFrame(
	renderer: RenderOrchestrator,
	doc: Document,
	viewport: Viewport,
): Promise<{ pixels: Uint8Array }> {
	const texture = await renderer.renderViewportToTexture(
		viewport,
		doc,
		WIDTH,
		HEIGHT,
		BACKGROUND,
		UNCHANGED,
		undefined,
		false,
	);
	if (!texture) throw new Error("repro render returned no texture");
	const device = renderer.getDevice();
	if (!device) throw new Error("no GPU device");
	const pixels = await captureTexturePixels(device, texture, WIDTH, HEIGHT);
	texture.destroy();
	return { pixels };
}

/** BBox of near-gray solid pixels (the extruded solid, not the red shadow). */
function solidBBox(pixels: Uint8Array) {
	return bboxOf(
		pixels,
		(r, g, b, a) => a > 8 && Math.abs(r - g) < 24 && Math.abs(r - b) < 24,
	);
}

/** BBox of any visible pixel. */
function anyBBox(pixels: Uint8Array) {
	return bboxOf(pixels, (_r, _g, _b, a) => a > 8);
}

function bboxOf(
	pixels: Uint8Array,
	match: (r: number, g: number, b: number, a: number) => boolean,
) {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (let y = 0; y < HEIGHT; y++) {
		for (let x = 0; x < WIDTH; x++) {
			const i = (y * WIDTH + x) * 4;
			if (match(pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3])) {
				minX = Math.min(minX, x);
				minY = Math.min(minY, y);
				maxX = Math.max(maxX, x);
				maxY = Math.max(maxY, y);
			}
		}
	}
	if (minX === Infinity) return null;
	return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

function createDocument(refraction: number | undefined, withShadow: boolean) {
	const document = createDefaultDocument("extrude-repro-vrt");
	const layer = createDefaultLayer("layer-1", "Layer");
	const bg = backgroundRect();
	document.objects[bg.id] = bg;
	layer.elementIds.push(bg.id);
	const path = createPath(refraction, withShadow);
	document.objects[path.id] = path;
	layer.elementIds.push(path.id);
	document.layers = [layer];
	return document;
}

function backgroundRect(): Path {
	return {
		id: "bg-1",
		type: "path",
		opacity: 1,
		blendMode: "normal",
		transform: createDefaultTransform(),
		segments: createSquareSegments(500),
		filters: [
			{
				uid: "bg-fill",
				processor: "fill",
				opacity: 1,
				blendMode: "normal",
				paramData: {
					version: "1",
					params: {
						fill: {
							type: "solid",
							color: { type: "rgb", r: 0.1, g: 0.2, b: 0.7, a: 1 },
						},
					},
				},
			} satisfies FillAppearance,
		],
	};
}

function createPath(refraction: number | undefined, withShadow: boolean): Path {
	return {
		id: "path-1",
		type: "path",
		opacity: 1,
		blendMode: "normal",
		transform: createDefaultTransform(),
		segments: createSquareSegments(100),
		filters: [
			createFill(),
			createExtrude(refraction),
			...(withShadow ? [createDropShadow()] : []),
		],
	};
}

function createFill(): FillAppearance {
	return {
		uid: "fill-1",
		processor: "fill",
		opacity: 1,
		blendMode: "normal",
		paramData: {
			version: "1",
			params: {
				fill: {
					type: "solid",
					color: { type: "rgb", r: 0.8, g: 0.8, b: 0.8, a: 1 },
				},
			},
		},
	};
}

function createExtrude(refraction?: number): Extrude3DAppearance {
	return {
		uid: "extrude-1",
		processor: "extrude3d",
		opacity: 1,
		blendMode: "normal",
		paramData: {
			version: "1",
			params: {
				depth: 40,
				rotationDeg: [25, -30, 0],
				perspective: 20,
				material: {
					shading: "lambert",
					lightDir: [0, 0, 1],
					...(refraction !== undefined && { refraction }),
				},
			},
		},
	};
}

function createDropShadow(): DropShadowFilter {
	return {
		uid: "shadow-1",
		processor: "drop-shadow",
		opacity: 1,
		blendMode: "normal",
		paramData: {
			version: "1",
			params: {
				offsetX: 24,
				offsetY: -24,
				blurRadius: 8,
				spreadRadius: 0,
				shadowOpacity: 1,
				shadowColor: { type: "rgb", r: 1, g: 0, b: 0, a: 1 },
			},
		},
	};
}

function createSquareSegments(size: number): PathSegment[] {
	const half = size / 2;
	const points = [
		{ x: -half, y: half },
		{ x: half, y: half },
		{ x: half, y: -half },
		{ x: -half, y: -half },
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
