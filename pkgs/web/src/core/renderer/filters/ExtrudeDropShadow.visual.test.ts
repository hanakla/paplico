import { describe, expect, it } from "vitest";
import {
	createDefaultDocument,
	createDefaultLayer,
	createDefaultTransform,
} from "../../document/factory";
import type {
	Extrude3DAppearance,
	FillAppearance,
	Group,
	Path,
	PathSegment,
	RawRGBA,
} from "../../schema";
import {
	captureTexturePixels,
	createTestRenderer,
	renderWithViewport,
} from "../../testUtils/visualRegression";
import type { DropShadowFilter } from "./DropShadowFilterProcessor";

describe("extrude3d with downstream drop-shadow", () => {
	it.each([
		["opaque", undefined],
		["glass", 1.5],
	] as const)("should render shadow pixels after the %s extruded solid", async (_material, refraction) => {
		const { renderer, canvas } = await createTestRenderer();
		const document = createDocument(refraction);
		const texture = await renderWithViewport(
			renderer,
			canvas,
			document,
			{ x: 0, y: 0, zoom: 1, rotation: 0 },
			{ r: 0, g: 0, b: 0, a: 0 },
		);
		const device = renderer.getDevice();
		if (!device) throw new Error("GPU device is unavailable");
		const pixels = await captureTexturePixels(device, texture, 800, 600);
		let shadowPixels = 0;
		for (let i = 0; i < pixels.length; i += 4) {
			if (
				pixels[i + 3] > 2 &&
				pixels[i] > pixels[i + 1] + 10 &&
				pixels[i] > pixels[i + 2] + 10
			) {
				shadowPixels++;
			}
		}

		expect(shadowPixels).toBeGreaterThan(0);
		texture.destroy();
	});

	it("should keep the glass solid visible near the right and bottom edges", async () => {
		const { renderer, canvas } = await createTestRenderer();
		const texture = await renderWithViewport(
			renderer,
			canvas,
			createDocument(1.5, { x: 300, y: -200 }),
			{ x: 0, y: 0, zoom: 1, rotation: 0 },
			{ r: 0, g: 0, b: 0, a: 0 },
		);
		const device = renderer.getDevice();
		if (!device) throw new Error("GPU device is unavailable");
		const pixels = await captureTexturePixels(device, texture, 800, 600);
		let solidPixels = 0;
		for (let y = 500; y < 600; y++) {
			for (let x = 700; x < 800; x++) {
				const index = (y * 800 + x) * 4;
				if (
					pixels[index + 3] > 2 &&
					Math.abs(pixels[index] - pixels[index + 1]) < 10 &&
					Math.abs(pixels[index] - pixels[index + 2]) < 10
				) {
					solidPixels++;
				}
			}
		}

		expect(solidPixels).toBeGreaterThan(0);
		texture.destroy();
	});

	it("should refresh a glass solid's refraction on a background change without redrawing its shadow", async () => {
		// The shadow comes from the solid's coverage, which nothing behind the
		// glass can affect; the refraction reads the live backdrop. Repainting
		// the background must therefore change the glass and leave the shadow
		// byte-identical — the property the cross-frame shadow cache rests on.
		const { renderer, canvas } = await createTestRenderer();
		const device = renderer.getDevice();
		if (!device) throw new Error("GPU device is unavailable");

		const render = async (background: RawRGBA) => {
			const texture = await renderWithViewport(
				renderer,
				canvas,
				createBackgroundedGlassDocument(background),
				{ x: 0, y: 0, zoom: 1, rotation: 0 },
				{ r: 0, g: 0, b: 0, a: 0 },
			);
			const pixels = await captureTexturePixels(device, texture, 800, 600);
			texture.destroy();
			return pixels;
		};

		const first = await render({ r: 0.9, g: 0.1, b: 0.1, a: 1 });
		const second = await render({ r: 0.1, g: 0.1, b: 0.9, a: 1 });

		// Glass interior (screen centre): the refraction followed the backdrop.
		let glassDiff = 0;
		for (let y = 280; y < 320; y++) {
			for (let x = 380; x < 420; x++) {
				const i = (y * 800 + x) * 4;
				glassDiff += Math.abs(first[i] - second[i]);
			}
		}
		expect(glassDiff).toBeGreaterThan(1000);

		// Shadow region: offset far past the background rect, over bare canvas.
		let shadowPixels = 0;
		for (let y = 400; y < 460; y++) {
			for (let x = 500; x < 560; x++) {
				const i = (y * 800 + x) * 4;
				if (first[i + 3] > 2) shadowPixels++;
				for (let c = 0; c < 4; c++) {
					expect(second[i + c]).toBe(first[i + c]);
				}
			}
		}
		expect(shadowPixels).toBeGreaterThan(0);
	});

	it("should preserve the full shadow outside an extruded group", async () => {
		const { renderer, canvas } = await createTestRenderer();
		const texture = await renderWithViewport(
			renderer,
			canvas,
			createGroupDocument(),
			{ x: 0, y: 0, zoom: 1, rotation: 0 },
			{ r: 0, g: 0, b: 0, a: 0 },
		);
		const device = renderer.getDevice();
		if (!device) throw new Error("GPU device is unavailable");
		const pixels = await captureTexturePixels(device, texture, 800, 600);
		let exteriorShadowPixels = 0;
		for (let y = 200; y < 400; y++) {
			for (let x = 480; x < 560; x++) {
				const index = (y * 800 + x) * 4;
				if (
					pixels[index + 3] > 2 &&
					pixels[index] > pixels[index + 1] + 10 &&
					pixels[index] > pixels[index + 2] + 10
				) {
					exteriorShadowPixels++;
				}
			}
		}

		expect(exteriorShadowPixels).toBeGreaterThan(0);
		texture.destroy();
	});
});

/**
 * A glass square over an opaque background rect, with its shadow thrown far
 * enough (+120, −120 world px) to land on bare canvas outside that rect — so
 * the shadow's pixels are unaffected by the background's colour.
 */
function createBackgroundedGlassDocument(background: RawRGBA) {
	const document = createDefaultDocument("glass-background-change");
	const layer = createDefaultLayer("layer-1", "Layer");
	const backdrop: Path = {
		id: "backdrop-1",
		type: "path",
		opacity: 1,
		blendMode: "normal",
		transform: createDefaultTransform(),
		segments: createSquareSegments(160),
		filters: [
			{
				uid: "fill-backdrop",
				processor: "fill",
				opacity: 1,
				blendMode: "normal",
				paramData: {
					version: "1",
					params: {
						fill: { type: "solid", color: { type: "rgb", ...background } },
					},
				},
			} satisfies FillAppearance,
		],
	};
	const glass: Path = {
		id: "path-1",
		type: "path",
		opacity: 1,
		blendMode: "normal",
		transform: createDefaultTransform(),
		segments: createSquareSegments(100),
		filters: [
			createFill(),
			{
				...createExtrude(1.5),
				paramData: {
					version: "1",
					params: {
						depth: 40,
						rotationDeg: [0, 0, 0],
						perspective: 0,
						material: {
							shading: "lambert",
							lightDir: [0, 0, 1],
							refraction: 1.5,
							// Transmissive enough that the backdrop actually shows
							// through — an opaque solid would hide the very thing this
							// case checks changed.
							glass: 0.8,
						},
					},
				},
			},
			{
				...createDropShadow(),
				paramData: {
					version: "1",
					params: {
						offsetX: 120,
						offsetY: -120,
						blurRadius: 6,
						spreadRadius: 0,
						shadowOpacity: 1,
						shadowColor: { type: "rgb", r: 1, g: 0, b: 0, a: 1 },
					},
				},
			},
		],
	};
	for (const element of [backdrop, glass]) {
		document.objects[element.id] = element;
		layer.elementIds.push(element.id);
	}
	document.layers = [layer];
	return document;
}

function createGroupDocument() {
	const document = createDefaultDocument("group-extrude-shadow-vrt");
	const layer = createDefaultLayer("layer-1", "Layer");
	const child: Path = {
		...createPath(undefined, { x: 0, y: 0 }),
		id: "group-child",
		filters: [createFill()],
	};
	const group: Group = {
		id: "group-1",
		type: "group",
		childIds: [child.id],
		opacity: 1,
		blendMode: "normal",
		transform: createDefaultTransform(),
		filters: [createExtrude(), createDropShadow()],
	};
	document.objects[child.id] = child;
	document.objects[group.id] = group;
	layer.elementIds.push(group.id);
	document.layers = [layer];
	return document;
}

function createDocument(
	refraction?: number,
	position: { x: number; y: number } = { x: 0, y: 0 },
) {
	const document = createDefaultDocument("extrude-shadow-vrt");
	const layer = createDefaultLayer("layer-1", "Layer");
	const path = createPath(refraction, position);
	document.objects[path.id] = path;
	layer.elementIds.push(path.id);
	document.layers = [layer];
	return document;
}

function createPath(
	refraction: number | undefined,
	position: { x: number; y: number },
): Path {
	return {
		id: "path-1",
		type: "path",
		opacity: 1,
		blendMode: "normal",
		transform: { ...createDefaultTransform(), ...position },
		segments: createSquareSegments(100),
		filters: [createFill(), createExtrude(refraction), createDropShadow()],
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
