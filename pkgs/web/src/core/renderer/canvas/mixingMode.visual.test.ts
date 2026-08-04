import { describe, expect, it } from "vitest";
import { normalizeBrushSettingsV2 } from "../../brush/migrate";
import {
	createArtboard,
	createDefaultDocument,
	createDefaultLayer,
	createDefaultTransform,
} from "../../document/factory";
import type {
	BrushSettingsV2,
	Document,
	Filter,
	Path,
	StrokeGradient,
	Viewport,
} from "../../schema";
import { closedRectSegments } from "../../testUtils/segmentFactory";
import {
	captureTexturePixels,
	createTestRenderer,
	renderWithViewport,
} from "../../testUtils/visualRegression";

/**
 * Color mixing (design §10): a mixing stroke reads the composite below it at
 * its own z-order and blends the sampled color toward the brush color by
 * colorRate². With colorRate 0 the stroke paints what it picked up, so a red
 * brush dragged across a green field comes out green — the end-to-end proof
 * that the backdrop capture, the chunked resolve and the mixed dab draw are
 * all wired together.
 */
describe("Mixing strokes", () => {
	it("should paint the picked-up backdrop color when colorRate is 0", async () => {
		const pixel = await renderStrokePixel(mixingBrush({ colorRate: 0 }));

		// Sampled from the green field, not the red brush.
		expect(pixel[1]).toBeGreaterThan(120);
		expect(pixel[0]).toBeLessThan(pixel[1] - 40);
	});

	it("should paint the brush color when colorRate is 1", async () => {
		const pixel = await renderStrokePixel(mixingBrush({ colorRate: 1 }));

		expect(pixel[0]).toBeGreaterThan(180);
		expect(pixel[1]).toBeLessThan(pixel[0] - 40);
	});

	it("should resolve an along-path gradient per dab before mixing", async () => {
		// Blue at the start, white at the end; colorRate 1 keeps the brush
		// color, so the two ends must differ along the stroke.
		const { left, right } = await renderStrokeEnds(
			mixingBrush({ colorRate: 1 }),
			alongGradient(),
		);

		expect(left[2]).toBeGreaterThan(left[0] + 60);
		expect(right[0]).toBeGreaterThan(right[2] - 30);
	});

	it("should route a gradient stroke through mixing too", async () => {
		// colorRate 0 paints purely what was picked up: a gradient stroke that
		// still renders blue/white here never reached the mix pass.
		const { left, right } = await renderStrokeEnds(
			mixingBrush({ colorRate: 0 }),
			alongGradient(),
		);

		for (const pixel of [left, right]) {
			expect(pixel[1]).toBeGreaterThan(120);
			expect(pixel[0]).toBeLessThan(pixel[1] - 40);
			expect(pixel[2]).toBeLessThan(pixel[1] - 40);
		}
	});

	it("should re-resolve when the backdrop below it changes", async () => {
		// The result is cached across frames (§10-2), so a backdrop edit has to
		// invalidate it — otherwise the stroke keeps painting the old pickup.
		const { before, after } = await renderAcrossBackdropEdit(
			mixingBrush({ colorRate: 0 }),
		);

		expect(before[1]).toBeGreaterThan(before[2] + 40);
		expect(after[2]).toBeGreaterThan(after[1] + 40);
	});

	it("should re-resolve a stroke that mixed from another mixing stroke", async () => {
		// Chain: patch → stroke B (mixes the patch) → stroke C (mixes B). The
		// patch does not overlap C at all, so only a transitively propagated
		// key can invalidate C when the patch changes (appendix A).
		const { before, after } = await renderChainAcrossPatchEdit();

		expect(before[1]).toBeGreaterThan(before[2] + 40);
		expect(after[2]).toBeGreaterThan(after[1] + 40);
	});

	it("should resolve the same color at any viewport zoom", async () => {
		// Fixed-R rule (appendix B-2): the mix domain follows the document's
		// rasterization grid, never the viewport, so zooming must not change
		// what the brush picks up.
		const brush = mixingBrush({ colorRate: 0.5 });
		const atZoom1 = await renderStrokePixel(brush);
		const atZoom2 = await renderStrokePixel(brush, {
			x: 0,
			y: 0,
			zoom: 2,
			rotation: 0,
		});

		for (let channel = 0; channel < 3; channel++) {
			expect(Math.abs(atZoom1[channel] - atZoom2[channel])).toBeLessThanOrEqual(
				4,
			);
		}
	});

	it("should resolve identically on a second independent render", async () => {
		// Determinism (appendix A): same backdrop + same dab list, same result.
		const brush = mixingBrush({ colorRate: 0.5, smudgeLength: 0.7 });
		const first = await renderStrokePixel(brush);
		const second = await renderStrokePixel(brush);

		expect(second).toEqual(first);
	});

	it("should keep the brush color when mixing is disabled (control)", async () => {
		const pixel = await renderStrokePixel(
			mixingBrush({ colorRate: 0, enabled: false }),
		);

		// Without the explicit gate the stroke never reaches the mix pass, so
		// colorRate is inert and the brush color survives.
		expect(pixel[0]).toBeGreaterThan(180);
		expect(pixel[1]).toBeLessThan(pixel[0] - 40);
	});
});

function mixingBrush(overrides: {
	colorRate: number;
	enabled?: boolean;
	smudgeLength?: number;
}): BrushSettingsV2 {
	return normalizeBrushSettingsV2({
		version: 2,
		engine: "dab",
		strokeOpacity: 1,
		paintMode: "buildup",
		properties: {
			size: { base: 30 },
			spacing: { base: 0.1 },
			flow: { base: 1 },
			colorRate: { base: overrides.colorRate },
			alphaRate: { base: 1 },
			smudgeLength: { base: overrides.smudgeLength ?? 0 },
		},
		tip: { kind: "procedural", hardness: 1, angleMode: "fixed" },
		mixing: {
			enabled: overrides.enabled ?? true,
			mode: "dulling",
			sampleRadius: 0.5,
			sampleTrail: 0,
			blendStyle: 1,
		},
		randomSeed: 1,
	});
}

/**
 * Render the chained document, recolor the patch (green → blue) through an
 * immutable update, and render again. Returns stroke C's pixel each time.
 */
async function renderChainAcrossPatchEdit(): Promise<{
	before: number[];
	after: number[];
}> {
	const { renderer, canvas } = await createTestRenderer();
	const viewport = { x: 0, y: 0, zoom: 1, rotation: 0 };
	const device = renderer.getDevice();
	if (!device) throw new Error("Test renderer has no GPU device");

	const doc = chainedDoc();
	// Stroke C spans world x 140..200, overlapping B up to 170; read world
	// x 150 (screen 550), where B lies underneath.
	const readC = async (): Promise<number[]> => {
		const texture = await renderWithViewport(renderer, canvas, doc, viewport);
		const pixels = await captureTexturePixels(
			device,
			texture,
			texture.width,
			texture.height,
		);
		const offset = (300 * texture.width + 550) * 4;
		const pixel = [
			pixels[offset],
			pixels[offset + 1],
			pixels[offset + 2],
			pixels[offset + 3],
		];
		texture.destroy();
		return pixel;
	};

	await readC();
	const before = await readC();

	const patch = doc.objects["chain-patch"];
	doc.objects = { ...doc.objects };
	doc.objects["chain-patch"] = {
		...patch,
		filters: [
			{
				...patch.filters![0],
				paramData: {
					version: "1",
					params: {
						fill: {
							type: "solid",
							color: { type: "rgb", r: 0, g: 0, b: 0.75, a: 1 },
						},
					},
				},
			} as unknown as Filter,
		],
	} as Path;
	const after = await readC();
	return { before, after };
}

/**
 * A green patch on the left, stroke B running across it and out to the right,
 * and stroke C sitting only on B's right end. Both strokes use smudgeLength 1,
 * which freezes the bucket at its first sample: B paints the patch's color
 * along its whole length, and C paints what B laid down.
 */
function chainedDoc(): Document {
	const patch: Path = {
		id: "chain-patch",
		type: "path",
		opacity: 1,
		blendMode: "normal",
		transform: createDefaultTransform(),
		segments: closedRectSegments(-200, -60, 20, 60),
		filters: [
			{
				uid: "chain-patch-fill",
				processor: "fill",
				opacity: 1,
				blendMode: "normal",
				paramData: {
					version: "1",
					params: {
						fill: {
							type: "solid",
							color: { type: "rgb", r: 0, g: 0.75, b: 0, a: 1 },
						},
					},
				},
			} as unknown as Filter,
		],
	};

	const doc = createDefaultDocument("mixing-chain");
	const layer = createDefaultLayer("mixing-chain-layer", "Strokes");
	const strokeB = chainStroke("chain-b", -170, 170);
	const strokeC = chainStroke("chain-c", 140, 200);
	layer.elementIds.push(patch.id, strokeB.id, strokeC.id);
	doc.objects[patch.id] = patch;
	doc.objects[strokeB.id] = strokeB;
	doc.objects[strokeC.id] = strokeC;
	doc.layers.push(layer);
	doc.artboards.push(createArtboard("mixing-chain-ab", "Main", 0, 0, 800, 600));
	return doc;
}

function chainStroke(id: string, fromX: number, toX: number): Path {
	return {
		id,
		type: "path",
		opacity: 1,
		blendMode: "normal",
		transform: createDefaultTransform(),
		segments: [
			{
				start: { x: fromX, y: 0 },
				cp1: { x: 0, y: 0 },
				cp2: { x: 0, y: 0 },
				end: { x: toX, y: 0 },
				startPressure: 1,
				endPressure: 1,
				startTiltX: 0,
				startTiltY: 0,
				endTiltX: 0,
				endTiltY: 0,
				startDeltaTime: 0,
				endDeltaTime: 150,
				isMoved: true,
			},
		],
		filters: [
			{
				uid: `${id}-appearance`,
				processor: "stroke",
				opacity: 1,
				blendMode: "normal",
				paramData: {
					version: "1",
					params: {
						strokeColor: {
							type: "solid",
							color: { type: "rgb", r: 1, g: 0, b: 0, a: 1 },
						},
						brushSettings: mixingBrush({ colorRate: 0, smudgeLength: 1 }),
					},
				},
			} as unknown as Filter,
		],
	};
}

/**
 * Render the green-field document, swap the field for a blue one (a new
 * object, as an immutable document update produces), and render again on the
 * same renderer. Returns the stroke pixel from each pass.
 */
async function renderAcrossBackdropEdit(
	brushSettings: BrushSettingsV2,
): Promise<{ before: number[]; after: number[] }> {
	const { renderer, canvas } = await createTestRenderer();
	const viewport = { x: 0, y: 0, zoom: 1, rotation: 0 };
	const device = renderer.getDevice();
	if (!device) throw new Error("Test renderer has no GPU device");

	const doc = mixingDoc(brushSettings);
	const readStrokePixel = async (): Promise<number[]> => {
		const texture = await renderWithViewport(renderer, canvas, doc, viewport);
		const pixels = await captureTexturePixels(
			device,
			texture,
			texture.width,
			texture.height,
		);
		const offset = (300 * texture.width + 400) * 4;
		const pixel = [
			pixels[offset],
			pixels[offset + 1],
			pixels[offset + 2],
			pixels[offset + 3],
		];
		texture.destroy();
		return pixel;
	};

	await readStrokePixel();
	const before = await readStrokePixel();

	// Immutable update, as a document edit produces: a new objects map with a
	// new element object. Mutating in place would leave the frame plan (keyed
	// on the objects map's identity) reused and prove nothing.
	const field = doc.objects["mixing-field"];
	doc.objects = { ...doc.objects };
	doc.objects["mixing-field"] = {
		...field,
		filters: [
			{
				...field.filters![0],
				paramData: {
					version: "1",
					params: {
						fill: {
							type: "solid",
							color: { type: "rgb", r: 0, g: 0, b: 0.75, a: 1 },
						},
					},
				},
			} as unknown as Filter,
		],
	} as Path;
	const after = await readStrokePixel();
	return { before, after };
}

/** Blue-to-white gradient running along the stroke. */
function alongGradient(): StrokeGradient {
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
				{
					offset: 0,
					color: { type: "rgb", r: 0, g: 0, b: 1, a: 1 },
					midpoint: 0.5,
				},
				{
					offset: 1,
					color: { type: "rgb", r: 1, g: 1, b: 1, a: 1 },
					midpoint: 0.5,
				},
			],
		},
	};
}

/** Pixels near both ends of the stroke: screen x 280 and 520 at y 300. */
async function renderStrokeEnds(
	brushSettings: BrushSettingsV2,
	strokeColor: StrokeGradient,
): Promise<{ left: number[]; right: number[] }> {
	const pixels = await renderPixels(
		brushSettings,
		[
			[280, 300],
			[520, 300],
		],
		strokeColor,
	);
	return { left: pixels[0], right: pixels[1] };
}

/**
 * Render a green field with a red mixing stroke across its middle and read
 * the pixel at world (0,0) → screen (400,300), inside both.
 */
async function renderStrokePixel(
	brushSettings: BrushSettingsV2,
	viewport?: Viewport,
): Promise<number[]> {
	return (
		await renderPixels(brushSettings, [[400, 300]], undefined, viewport)
	)[0];
}

async function renderPixels(
	brushSettings: BrushSettingsV2,
	points: [number, number][],
	strokeColor?: StrokeGradient,
	viewportOverride?: Viewport,
): Promise<number[][]> {
	const { renderer, canvas } = await createTestRenderer();
	const viewport = viewportOverride ?? { x: 0, y: 0, zoom: 1, rotation: 0 };
	const device = renderer.getDevice();
	if (!device) throw new Error("Test renderer has no GPU device");

	const doc = mixingDoc(brushSettings, strokeColor);
	// Warm caches on identical frames before asserting (render cache rule).
	await renderWithViewport(renderer, canvas, doc, viewport);
	await renderWithViewport(renderer, canvas, doc, viewport);
	const texture = await renderWithViewport(renderer, canvas, doc, viewport);
	const pixels = await captureTexturePixels(
		device,
		texture,
		texture.width,
		texture.height,
	);
	const read = points.map(([x, y]) => {
		const offset = (y * texture.width + x) * 4;
		return [
			pixels[offset],
			pixels[offset + 1],
			pixels[offset + 2],
			pixels[offset + 3],
		];
	});
	texture.destroy();
	return read;
}

function mixingDoc(
	brushSettings: BrushSettingsV2,
	strokeColor?: StrokeGradient,
): Document {
	const field: Path = {
		id: "mixing-field",
		type: "path",
		opacity: 1,
		blendMode: "normal",
		transform: createDefaultTransform(),
		segments: closedRectSegments(-200, -120, 200, 120),
		filters: [
			{
				uid: "mixing-field-fill",
				processor: "fill",
				opacity: 1,
				blendMode: "normal",
				paramData: {
					version: "1",
					params: {
						fill: {
							type: "solid",
							color: { type: "rgb", r: 0, g: 0.75, b: 0, a: 1 },
						},
					},
				},
			} as unknown as Filter,
		],
	};

	const stroke: Path = {
		id: "mixing-stroke",
		type: "path",
		opacity: 1,
		blendMode: "normal",
		transform: createDefaultTransform(),
		segments: [
			{
				start: { x: -150, y: 0 },
				cp1: { x: 0, y: 0 },
				cp2: { x: 0, y: 0 },
				end: { x: 150, y: 0 },
				startPressure: 1,
				endPressure: 1,
				startTiltX: 0,
				startTiltY: 0,
				endTiltX: 0,
				endTiltY: 0,
				startDeltaTime: 0,
				endDeltaTime: 150,
				isMoved: true,
			},
		],
		filters: [
			{
				uid: "mixing-stroke-appearance",
				processor: "stroke",
				opacity: 1,
				blendMode: "normal",
				paramData: {
					version: "1",
					params: {
						strokeColor: strokeColor ?? {
							type: "solid",
							color: { type: "rgb", r: 1, g: 0, b: 0, a: 1 },
						},
						brushSettings,
					},
				},
			} as unknown as Filter,
		],
	};

	const doc = createDefaultDocument("mixing-mode");
	const layer = createDefaultLayer("mixing-mode-layer", "Strokes");
	layer.elementIds.push(field.id, stroke.id);
	doc.objects[field.id] = field;
	doc.objects[stroke.id] = stroke;
	doc.layers.push(layer);
	doc.artboards.push(createArtboard("mixing-ab", "Main", 0, 0, 800, 600));
	return doc;
}
