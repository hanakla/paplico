import pixelmatch from "pixelmatch";
import { beforeAll, describe, expect, it } from "vitest";
import { localAppearances } from "../../document/appearancePresets";
import {
	createArtboard,
	createDefaultDocument,
	createDefaultLayer,
	createDefaultTransform,
} from "../../document/factory";
import {
	type FillAppearance,
	generateUid,
	type Path,
	type PathSegment,
} from "../../schema";
import { loadTestFont } from "../../testUtils/fontSetup";
import {
	captureTexturePixels,
	createTestRenderer,
	expectVisualMatch,
	renderWithViewport,
} from "../../testUtils/visualRegression";
import { getFontManager } from "../../typography/fonts";
import type { BlurFilter } from "./BlurFilterProcessor";
import type { FrostGlassFilter } from "./FrostGlassFilterProcessor";
import type { HKVhsInterlaceFilter } from "./hanakla-kit/HKVhsInterlaceHandler";
import type { PixelateFilter } from "./PixelateFilterProcessor";
import type { SvgFilterGraphFilter } from "./svg/SvgFilterGraphHandler";

beforeAll(() => {
	loadTestFont(getFontManager());
});

// The common Appearance.applyToBackdrop flag reroutes any postProcess filter
// onto the captured backdrop (masked to the element shape) without the filter
// declaring its own backdrop param. The backdrop region comes off the shared
// fixed-R capture, so the filter's spatial parameters stay anchored in world
// px regardless of viewport zoom.

describe("Common applyToBackdrop flag", () => {
	it("should blur the backdrop inside the element shape when the top-level flag is set", async () => {
		const { renderer, canvas } = await createTestRenderer();
		const viewport = { x: 0, y: 0, zoom: 1, rotation: 0 };

		// The same scene without the flag isolates the flag's effect: pixels
		// inside the pane must change (backdrop blurred), pixels outside must
		// not (output is masked to the element shape).
		const flagged = await renderWithViewport(
			renderer,
			canvas,
			createBackdropBlurDoc(),
			viewport,
		);
		const unflagged = await renderWithViewport(
			renderer,
			canvas,
			createBackdropBlurDoc({ applyToBackdrop: false }),
			viewport,
		);

		const device = renderer.getDevice();
		if (!device) throw new Error("Test renderer has no GPU device");
		const flaggedPixels = await captureTexturePixels(
			device,
			flagged,
			flagged.width,
			flagged.height,
		);
		const unflaggedPixels = await captureTexturePixels(
			device,
			unflagged,
			unflagged.width,
			unflagged.height,
		);

		// Pane covers world [-110,110]x[-70,70] → texels [290,510]x[230,370].
		const inside = regionDiffPercentage(
			flaggedPixels,
			unflaggedPixels,
			flagged.width,
			300,
			240,
			500,
			360,
		);
		const outside = regionDiffPercentage(
			flaggedPixels,
			unflaggedPixels,
			flagged.width,
			10,
			10,
			200,
			160,
		);
		expect(inside).toBeGreaterThan(1);
		expect(outside).toBe(0);

		await expectVisualMatch(
			renderer,
			flagged,
			flagged.width,
			flagged.height,
			"backdrop-common-blur",
			{ threshold: 0.1, maxDiffPercentage: 0.5 },
		);

		flagged.destroy();
		unflagged.destroy();
	});

	it("should run an svg:filter graph on the backdrop inside the element shape", async () => {
		const { renderer, canvas } = await createTestRenderer();
		const viewport = { x: 0, y: 0, zoom: 1, rotation: 0 };

		const flagged = await renderWithViewport(
			renderer,
			canvas,
			createBackdropSvgDoc(),
			viewport,
		);
		const unflagged = await renderWithViewport(
			renderer,
			canvas,
			createBackdropSvgDoc({ applyToBackdrop: false }),
			viewport,
		);

		const device = renderer.getDevice();
		if (!device) throw new Error("Test renderer has no GPU device");
		const flaggedPixels = await captureTexturePixels(
			device,
			flagged,
			flagged.width,
			flagged.height,
		);
		const unflaggedPixels = await captureTexturePixels(
			device,
			unflagged,
			unflagged.width,
			unflagged.height,
		);

		const inside = regionDiffPercentage(
			flaggedPixels,
			unflaggedPixels,
			flagged.width,
			300,
			240,
			500,
			360,
		);
		const outside = regionDiffPercentage(
			flaggedPixels,
			unflaggedPixels,
			flagged.width,
			10,
			10,
			200,
			160,
		);
		expect(inside).toBeGreaterThan(1);
		expect(outside).toBe(0);

		await expectVisualMatch(
			renderer,
			flagged,
			flagged.width,
			flagged.height,
			"backdrop-common-svg-filter",
			{ threshold: 0.1, maxDiffPercentage: 0.5 },
		);

		flagged.destroy();
		unflagged.destroy();
	});

	// Rasterization stability: the zoom-2 render shows the central quarter of
	// the zoom-1 world region at 2x magnification. Area-averaging it back to
	// 1 texel per world px must match the zoom-1 render's central crop — if
	// the backdrop chain rasterized at viewport zoom instead of fixed R, the
	// blur footprint would halve/double in world px and whole regions would
	// shift past the phase-noise blur.
	it("should keep the backdrop blur world-px-stable across viewport zoom", async () => {
		const { renderer, canvas } = await createTestRenderer();
		const doc = createBackdropBlurDoc();

		const tex1 = await renderWithViewport(renderer, canvas, doc, {
			x: 0,
			y: 0,
			zoom: 1,
			rotation: 0,
		});
		const tex2 = await renderWithViewport(renderer, canvas, doc, {
			x: 0,
			y: 0,
			zoom: 2,
			rotation: 0,
		});

		const device = renderer.getDevice();
		if (!device) throw new Error("Test renderer has no GPU device");

		const pixels1 = await captureTexturePixels(
			device,
			tex1,
			tex1.width,
			tex1.height,
		);
		const pixels2 = await captureTexturePixels(
			device,
			tex2,
			tex2.width,
			tex2.height,
		);

		const cropW = tex1.width / 2;
		const cropH = tex1.height / 2;
		const cropped = cropCenter(pixels1, tex1.width, tex1.height, cropW, cropH);
		const downscaled = downscaleByArea(
			pixels2,
			tex2.width,
			tex2.height,
			cropW,
			cropH,
		);

		const diffPixels = pixelmatch(
			boxBlur3(cropped, cropW, cropH),
			boxBlur3(downscaled, cropW, cropH),
			undefined,
			cropW,
			cropH,
			{ threshold: 0.3 },
		);
		const diffPercentage = (diffPixels / (cropW * cropH)) * 100;

		expect(diffPercentage).toBeLessThan(0.5);

		tex1.destroy();
		tex2.destroy();
	});

	it("should keep VHS backdrop coordinates stable when viewport edges clip the pane", async () => {
		const { renderer, canvas } = await createTestRenderer();
		const doc = createBackdropVhsDoc();
		const reference = await renderWithViewport(renderer, canvas, doc, {
			x: 0,
			y: 0,
			zoom: 1,
			rotation: 0,
		});
		const device = renderer.getDevice();
		if (!device) throw new Error("Test renderer has no GPU device");
		const referencePixels = await captureTexturePixels(
			device,
			reference,
			reference.width,
			reference.height,
		);

		for (const viewport of [
			{ x: -160, y: -120, zoom: 1, rotation: 0 },
			{ x: 160, y: 120, zoom: 1, rotation: 0 },
		]) {
			const clipped = await renderWithViewport(renderer, canvas, doc, viewport);
			const clippedPixels = await captureTexturePixels(
				device,
				clipped,
				clipped.width,
				clipped.height,
			);

			expect(
				translatedDiffPercentage(
					referencePixels,
					clippedPixels,
					clipped.width,
					clipped.height,
					-viewport.x,
					viewport.y,
					16,
				),
			).toBeLessThan(0.5);

			clipped.destroy();
		}

		reference.destroy();
	});

	for (const { name, createDocument, blurComparison } of [
		{
			name: "Pixelate",
			createDocument: createBackdropPixelateDoc,
			blurComparison: false,
		},
		{
			name: "Frost Glass scatter",
			createDocument: () =>
				createBackdropFrostGlassDoc({ radius: 0, scatter: 1, scatterGrain: 1 }),
			blurComparison: false,
		},
		{
			name: "Frost Glass pyramid",
			createDocument: () =>
				createBackdropFrostGlassDoc({ radius: 8, scatter: 0, scatterGrain: 1 }),
			blurComparison: true,
		},
	]) {
		it(`should keep ${name} backdrop coordinates stable when viewport edges clip the pane`, async () => {
			const { renderer, canvas } = await createTestRenderer();
			const doc = createDocument();
			const reference = await renderWithViewport(renderer, canvas, doc, {
				x: 0,
				y: 0,
				zoom: 1,
				rotation: 0,
			});
			const device = renderer.getDevice();
			if (!device) throw new Error("Test renderer has no GPU device");
			const referencePixels = await captureTexturePixels(
				device,
				reference,
				reference.width,
				reference.height,
			);
			const comparableReference = blurComparison
				? boxBlur3(referencePixels, reference.width, reference.height)
				: referencePixels;

			for (const viewport of [
				{ x: -160, y: -120, zoom: 1, rotation: 0 },
				{ x: 160, y: 120, zoom: 1, rotation: 0 },
			]) {
				const clipped = await renderWithViewport(
					renderer,
					canvas,
					doc,
					viewport,
				);
				const clippedPixels = await captureTexturePixels(
					device,
					clipped,
					clipped.width,
					clipped.height,
				);
				const comparableClipped = blurComparison
					? boxBlur3(clippedPixels, clipped.width, clipped.height)
					: clippedPixels;

				expect(
					translatedDiffPercentage(
						comparableReference,
						comparableClipped,
						clipped.width,
						clipped.height,
						-viewport.x,
						viewport.y,
						32,
					),
				).toBeLessThan(0.5);

				clipped.destroy();
			}

			reference.destroy();
		});
	}
});

// Export background equivalence: the PNG route renders with a transparent
// background while the JPEG route renders with an opaque one, so flattening
// the transparent render over white must reproduce the opaque render.
// Backdrop compositing that keys on the blurred backdrop's alpha instead of
// the mask leaks the sharp backdrop wherever blur softens an alpha edge,
// which only opaque backgrounds hide.
describe("Backdrop export background equivalence", () => {
	it("should flatten a transparent-background export over white to match the opaque-white export", async () => {
		const { renderer } = await createTestRenderer();
		const doc = createDefaultDocument("backdrop-export-bg-equivalence");
		const layer = createDefaultLayer("layer-bg", "Background");

		// No opaque backing rect: the backdrop must carry alpha edges for the
		// two exports to be distinguishable.
		const star = createFilledPath(starSegments(-180, 80, 150, 60, 9), {
			r: 0.95,
			g: 0.2,
			b: 0.1,
			a: 1,
		});
		const block = createFilledPath(rectSegments(170, -90, 300, 170), {
			r: 0.1,
			g: 0.65,
			b: 0.95,
			a: 1,
		});
		// Radius-only frost glass keeps the effect linear in the premultiplied
		// backdrop (saturation/tint un-premultiply would break exact
		// flatten-equivalence).
		const frostGlass: FrostGlassFilter = {
			uid: generateUid("filter"),
			processor: "frost-glass",
			opacity: 1,
			blendMode: "normal",
			enabled: true,
			applyToBackdrop: true,
			paramData: { version: "1", params: { radius: 12 } },
		};
		const pane = createFilledPath(
			rectSegments(0, 0, 700, 500),
			{ r: 1, g: 1, b: 1, a: 0.05 },
			[frostGlass],
		);

		for (const element of [star, block, pane]) {
			doc.objects[element.id] = element;
			layer.elementIds.push(element.id);
		}
		doc.layers = [layer];
		const artboard = createArtboard(
			"artboard-export",
			"Export",
			0,
			0,
			800,
			600,
		);
		doc.artboards.push(artboard);

		const transparent = await renderer.renderArtboardToImageData(
			artboard,
			doc,
			1,
			{ r: 0, g: 0, b: 0, a: 0 },
		);
		const opaque = await renderer.renderArtboardToImageData(artboard, doc, 1, {
			r: 1,
			g: 1,
			b: 1,
			a: 1,
		});
		if (!transparent || !opaque) throw new Error("Artboard render failed");

		const { width, height } = opaque;
		const flattened = flattenOverWhite(transparent.data);

		const diffPixels = pixelmatch(
			flattened,
			new Uint8Array(opaque.data.buffer, opaque.data.byteOffset),
			undefined,
			width,
			height,
			{ threshold: 0.1 },
		);
		const diffPercentage = (diffPixels / (width * height)) * 100;
		expect(diffPercentage).toBeLessThan(0.5);
	});
});

function createBackdropBlurDoc({ applyToBackdrop = true } = {}) {
	const doc = createDefaultDocument("backdrop-common-vrt");
	const layer = createDefaultLayer("layer-bg", "Background");

	// High-frequency backdrop content: a star and offset rects, so an
	// unblurred backdrop is clearly distinguishable from a blurred one.
	const star = createFilledPath(starSegments(-60, 0, 90, 40, 7), {
		r: 0.9,
		g: 0.3,
		b: 0.15,
		a: 1,
	});
	const rectA = createFilledPath(rectSegments(80, 40, 120, 80), {
		r: 0.15,
		g: 0.45,
		b: 0.9,
		a: 1,
	});
	const rectB = createFilledPath(rectSegments(30, -60, 140, 50), {
		r: 0.2,
		g: 0.75,
		b: 0.35,
		a: 1,
	});

	// Foreground pane: a nearly-transparent fill (it must still produce the
	// mask shape) carrying a plain blur with the COMMON top-level flag.
	const blur: BlurFilter = {
		uid: generateUid("filter"),
		processor: "blur",
		opacity: 1,
		blendMode: "normal",
		enabled: true,
		applyToBackdrop,
		paramData: { version: "1", params: { radius: 10 } },
	};
	const pane = createFilledPath(
		rectSegments(0, 0, 220, 140),
		{ r: 1, g: 1, b: 1, a: 0.08 },
		[blur],
	);

	for (const el of [star, rectA, rectB, pane]) {
		doc.objects[el.id] = el;
		layer.elementIds.push(el.id);
	}
	doc.layers = [layer];
	return doc;
}

/** The blur scene with the pane carrying an `svg:filter` graph instead:
 *  with the flag, SourceGraphic is the captured backdrop. */
function createBackdropSvgDoc({ applyToBackdrop = true } = {}) {
	const doc = createBackdropBlurDoc({ applyToBackdrop });
	const pane = Object.values(doc.objects).find(
		(el) =>
			el.type === "path" &&
			localAppearances(el.filters).some((f) => f.processor === "blur"),
	) as Path;
	const graph: SvgFilterGraphFilter = {
		uid: generateUid("filter"),
		processor: "svg:filter",
		opacity: 1,
		blendMode: "normal",
		enabled: true,
		applyToBackdrop,
		paramData: {
			version: "1",
			params: {
				nodes: [
					{
						id: "blur",
						processor: "svg:gaussian-blur",
						params: { in: "SourceGraphic", stdDeviationX: 4, stdDeviationY: 4 },
					},
					{
						id: "hue",
						processor: "svg:hue-rotate",
						params: { in: "previous", amount: 180 },
					},
					{
						id: "edge",
						processor: "svg:morphology",
						params: {
							in: "SourceAlpha",
							operator: "erode",
							radiusX: 6,
							radiusY: 6,
						},
					},
					{
						id: "out",
						processor: "svg:composite",
						params: {
							in: "ref:hue",
							in2: "ref:edge",
							operator: "in",
							k1: 0,
							k2: 0,
							k3: 0,
							k4: 0,
						},
					},
				],
			},
		},
	};
	pane.filters = [
		...localAppearances(pane.filters).filter((f) => f.processor !== "blur"),
		graph,
	];
	return doc;
}

function createBackdropVhsDoc() {
	const doc = createDefaultDocument("backdrop-vhs-clipping-vrt");
	const layer = createDefaultLayer("layer-bg", "Background");
	const background = createFilledPath(rectSegments(0, 0, 1_200, 900), {
		r: 0.08,
		g: 0.1,
		b: 0.16,
		a: 1,
	});
	const star = createFilledPath(starSegments(-180, 80, 150, 60, 9), {
		r: 0.95,
		g: 0.2,
		b: 0.1,
		a: 1,
	});
	const block = createFilledPath(rectSegments(170, -90, 300, 170), {
		r: 0.1,
		g: 0.65,
		b: 0.95,
		a: 1,
	});
	const vhs: HKVhsInterlaceFilter = {
		uid: generateUid("filter"),
		processor: "hk:vhs-interlace",
		opacity: 1,
		blendMode: "normal",
		enabled: true,
		applyToBackdrop: true,
		paramData: {
			version: "1",
			params: {
				intensity: 1,
				generation: 2,
				chromaBleed: 0.5,
				colorShift: 0.01,
				lumaSoftness: 0.3,
				ringing: 0.3,
				lineJitter: 0.3,
				verticalJitter: 0.02,
				trackingError: 0.3,
				headSwitching: 0.35,
				headSwitchingHeight: 10,
				noise: 0.3,
				noiseDistortion: 0.2,
				chromaNoise: 0.3,
				dropouts: 0.4,
				dropoutLength: 0.4,
				brightnessJitter: 0.05,
				scanlines: 0.4,
				interlaceGap: 2,
				combing: 0.3,
				tilt: 0,
				blackLift: 0.2,
				desaturation: 0.15,
				randomSeed: 42,
				enableVHSColor: false,
				vhsColor: { type: "rgb", r: 1, g: 0, b: 0, a: 1 },
				applyToTransparent: false,
			},
		},
	};
	const pane = createFilledPath(
		rectSegments(0, 0, 700, 500),
		{ r: 1, g: 1, b: 1, a: 0.05 },
		[vhs],
	);

	for (const element of [background, star, block, pane]) {
		doc.objects[element.id] = element;
		layer.elementIds.push(element.id);
	}
	doc.layers = [layer];
	return doc;
}

function createBackdropPixelateDoc() {
	const pixelate: PixelateFilter = {
		uid: generateUid("filter"),
		processor: "pixelate",
		opacity: 1,
		blendMode: "normal",
		enabled: true,
		applyToBackdrop: true,
		paramData: {
			version: "1",
			params: {
				blockWidth: 24,
				blockHeight: 24,
				linkAxes: true,
				mode: "bilinear",
			},
		},
	};
	return createBackdropEffectDoc("backdrop-pixelate-clipping-vrt", pixelate);
}

function createBackdropFrostGlassDoc({
	radius,
	scatter,
	scatterGrain,
}: {
	radius: number;
	scatter: number;
	scatterGrain: number;
}) {
	const frostGlass: FrostGlassFilter = {
		uid: generateUid("filter"),
		processor: "frost-glass",
		opacity: 1,
		blendMode: "normal",
		enabled: true,
		applyToBackdrop: true,
		paramData: {
			version: "1",
			params: { radius, scatter, scatterGrain },
		},
	};
	return createBackdropEffectDoc(
		`backdrop-frost-glass-${scatter > 0 ? "scatter" : "pyramid"}-clipping-vrt`,
		frostGlass,
	);
}

function createBackdropEffectDoc(
	id: string,
	filter: NonNullable<Path["filters"]>[number],
) {
	const doc = createDefaultDocument(id);
	const layer = createDefaultLayer("layer-bg", "Background");
	const background = createFilledPath(rectSegments(0, 0, 1_200, 900), {
		r: 0.08,
		g: 0.1,
		b: 0.16,
		a: 1,
	});
	const star = createFilledPath(starSegments(-180, 80, 150, 60, 9), {
		r: 0.95,
		g: 0.2,
		b: 0.1,
		a: 1,
	});
	const block = createFilledPath(rectSegments(170, -90, 300, 170), {
		r: 0.1,
		g: 0.65,
		b: 0.95,
		a: 1,
	});
	const pane = createFilledPath(
		rectSegments(0, 0, 700, 500),
		{ r: 1, g: 1, b: 1, a: 0.05 },
		[filter],
	);

	for (const element of [background, star, block, pane]) {
		doc.objects[element.id] = element;
		layer.elementIds.push(element.id);
	}
	doc.layers = [layer];
	return doc;
}

function createFilledPath(
	segments: PathSegment[],
	fill: { r: number; g: number; b: number; a: number },
	filters: Path["filters"] = [],
): Path {
	const fillApp: FillAppearance = {
		uid: generateUid("fill"),
		processor: "fill",
		opacity: 1,
		blendMode: "normal",
		paramData: {
			version: "1",
			params: {
				fill: { type: "solid", color: { type: "rgb", ...fill } },
			},
		},
	};

	return {
		type: "path",
		id: generateUid("path"),
		opacity: 1,
		blendMode: "normal",
		segments,
		filters: [fillApp, ...(filters ?? [])],
		transform: createDefaultTransform(),
	};
}

function lineSegment(
	sx: number,
	sy: number,
	ex: number,
	ey: number,
	moved: boolean,
	closed?: boolean,
): PathSegment {
	return {
		start: moved ? { x: sx, y: sy } : undefined,
		cp1: { x: 0, y: 0 },
		cp2: { x: 0, y: 0 },
		end: { x: ex, y: ey },
		startPressure: 1,
		endPressure: 1,
		startTiltX: 0,
		startTiltY: 0,
		endTiltX: 0,
		endTiltY: 0,
		startDeltaTime: 0,
		endDeltaTime: 0,
		isMoved: moved,
		isClosed: closed,
	};
}

function rectSegments(
	x: number,
	y: number,
	w: number,
	h: number,
): PathSegment[] {
	return [
		lineSegment(x - w / 2, y + h / 2, x + w / 2, y + h / 2, true),
		lineSegment(x + w / 2, y + h / 2, x + w / 2, y - h / 2, false),
		lineSegment(x + w / 2, y - h / 2, x - w / 2, y - h / 2, false),
		lineSegment(x - w / 2, y - h / 2, x - w / 2, y + h / 2, false, true),
	];
}

function starSegments(
	cx: number,
	cy: number,
	outer: number,
	inner: number,
	points: number,
): PathSegment[] {
	const vertices: { x: number; y: number }[] = [];
	for (let i = 0; i < points * 2; i++) {
		const radius = i % 2 === 0 ? outer : inner;
		const angle = (i / (points * 2)) * Math.PI * 2 - Math.PI / 2;
		vertices.push({
			x: cx + Math.cos(angle) * radius,
			y: cy + Math.sin(angle) * radius,
		});
	}
	return vertices.map((v, i) => {
		const next = vertices[(i + 1) % vertices.length];
		return lineSegment(
			v.x,
			v.y,
			next.x,
			next.y,
			i === 0,
			i === vertices.length - 1 ? true : undefined,
		);
	});
}

/** Straight-alpha src-over onto opaque white, as a 2D canvas fill would do. */
function flattenOverWhite(src: Uint8ClampedArray): Uint8Array {
	const out = new Uint8Array(src.length);
	for (let i = 0; i < src.length; i += 4) {
		const a = src[i + 3] / 255;
		out[i] = Math.round(src[i] * a + 255 * (1 - a));
		out[i + 1] = Math.round(src[i + 1] * a + 255 * (1 - a));
		out[i + 2] = Math.round(src[i + 2] * a + 255 * (1 - a));
		out[i + 3] = 255;
	}
	return out;
}

/** Percentage of pixels that differ (any channel, >2/255) inside a rect. */
function regionDiffPercentage(
	a: Uint8Array,
	b: Uint8Array,
	width: number,
	x0: number,
	y0: number,
	x1: number,
	y1: number,
): number {
	let diff = 0;
	for (let y = y0; y < y1; y++) {
		for (let x = x0; x < x1; x++) {
			const i = (y * width + x) * 4;
			if (
				Math.abs(a[i] - b[i]) > 2 ||
				Math.abs(a[i + 1] - b[i + 1]) > 2 ||
				Math.abs(a[i + 2] - b[i + 2]) > 2 ||
				Math.abs(a[i + 3] - b[i + 3]) > 2
			) {
				diff++;
			}
		}
	}
	return (diff / ((x1 - x0) * (y1 - y0))) * 100;
}

/** Central crop of a row-packed RGBA buffer. */
function cropCenter(
	src: Uint8Array,
	srcWidth: number,
	srcHeight: number,
	cropWidth: number,
	cropHeight: number,
): Uint8Array {
	const x0 = Math.floor((srcWidth - cropWidth) / 2);
	const y0 = Math.floor((srcHeight - cropHeight) / 2);
	const out = new Uint8Array(cropWidth * cropHeight * 4);
	for (let y = 0; y < cropHeight; y++) {
		const src0 = ((y0 + y) * srcWidth + x0) * 4;
		out.set(src.subarray(src0, src0 + cropWidth * 4), y * cropWidth * 4);
	}
	return out;
}

/** Exact area-average downscale (same as the DPI-invariance tests). */
function downscaleByArea(
	src: Uint8Array,
	srcWidth: number,
	srcHeight: number,
	destWidth: number,
	destHeight: number,
): Uint8Array {
	const ratioX = srcWidth / destWidth;
	const ratioY = srcHeight / destHeight;
	const out = new Uint8Array(destWidth * destHeight * 4);

	for (let dy = 0; dy < destHeight; dy++) {
		const y0 = dy * ratioY;
		const y1 = Math.min(y0 + ratioY, srcHeight);
		for (let dx = 0; dx < destWidth; dx++) {
			const x0 = dx * ratioX;
			const x1 = Math.min(x0 + ratioX, srcWidth);
			let r = 0;
			let g = 0;
			let b = 0;
			let a = 0;
			let weightSum = 0;

			for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy++) {
				const weightY = Math.min(sy + 1, y1) - Math.max(sy, y0);
				for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx++) {
					const weight = (Math.min(sx + 1, x1) - Math.max(sx, x0)) * weightY;
					const s = (sy * srcWidth + sx) * 4;
					r += src[s] * weight;
					g += src[s + 1] * weight;
					b += src[s + 2] * weight;
					a += src[s + 3] * weight;
					weightSum += weight;
				}
			}

			const o = (dy * destWidth + dx) * 4;
			out[o] = Math.round(r / weightSum);
			out[o + 1] = Math.round(g / weightSum);
			out[o + 2] = Math.round(b / weightSum);
			out[o + 3] = Math.round(a / weightSum);
		}
	}
	return out;
}

/** 3×3 edge-clamped box blur to suppress sub-pixel phase noise. */
function boxBlur3(src: Uint8Array, width: number, height: number): Uint8Array {
	const out = new Uint8Array(src.length);

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			let r = 0;
			let g = 0;
			let b = 0;
			let a = 0;
			let count = 0;

			for (let dy = -1; dy <= 1; dy++) {
				const sy = y + dy;
				if (sy < 0 || sy >= height) continue;
				for (let dx = -1; dx <= 1; dx++) {
					const sx = x + dx;
					if (sx < 0 || sx >= width) continue;
					const s = (sy * width + sx) * 4;
					r += src[s];
					g += src[s + 1];
					b += src[s + 2];
					a += src[s + 3];
					count++;
				}
			}

			const o = (y * width + x) * 4;
			out[o] = Math.round(r / count);
			out[o + 1] = Math.round(g / count);
			out[o + 2] = Math.round(b / count);
			out[o + 3] = Math.round(a / count);
		}
	}
	return out;
}

function translatedDiffPercentage(
	reference: Uint8Array,
	shifted: Uint8Array,
	width: number,
	height: number,
	shiftX: number,
	shiftY: number,
	margin: number,
): number {
	const minX = Math.max(0, shiftX) + margin;
	const maxX = Math.min(width, width + shiftX) - margin;
	const minY = Math.max(0, shiftY) + margin;
	const maxY = Math.min(height, height + shiftY) - margin;
	let different = 0;
	let compared = 0;

	for (let y = minY; y < maxY; y++) {
		for (let x = minX; x < maxX; x++) {
			const shiftedIndex = (y * width + x) * 4;
			const referenceIndex = ((y - shiftY) * width + x - shiftX) * 4;
			compared++;
			if (
				Math.abs(shifted[shiftedIndex] - reference[referenceIndex]) > 2 ||
				Math.abs(shifted[shiftedIndex + 1] - reference[referenceIndex + 1]) >
					2 ||
				Math.abs(shifted[shiftedIndex + 2] - reference[referenceIndex + 2]) >
					2 ||
				Math.abs(shifted[shiftedIndex + 3] - reference[referenceIndex + 3]) > 2
			) {
				different++;
			}
		}
	}

	return (different / compared) * 100;
}
