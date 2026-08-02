import { describe, expect, it } from "vitest";
import {
	createArtboard,
	createDefaultDocument,
	createDefaultLayer,
	createDefaultTransform,
	createStrokeBrushSettings,
} from "../../document/factory";
import type { Document, Path, StrokeColor } from "../../schema";
import {
	captureTexturePixels,
	createTestRenderer,
	renderWithViewport,
} from "../../testUtils/visualRegression";

/**
 * A geometric stroke bakes its resolved alpha into vertices that are cached per
 * element, so every source of transparency has to reach the cache key. A
 * baseline image cannot catch a regression here — the first render of a
 * see-through stroke is always correct — so each test renders the same element
 * id twice and reads the pixel back after the change.
 *
 * Black stroke on white: opaque reads 0, 30% opaque reads 255 × 0.7 ≈ 178.
 */
describe("Vector stroke opacity", () => {
	it("should dim an already-rendered stroke when its appearance opacity is lowered", async () => {
		expectDimmed(await renderThenReRender({ appearanceOpacity: 0.3 }));
	});

	it("should dim an already-rendered stroke when the element opacity is lowered", async () => {
		expectDimmed(await renderThenReRender({ elementOpacity: 0.3 }));
	});

	it("should dim an already-rendered stroke when the stroke color alpha is lowered", async () => {
		expectDimmed(await renderThenReRender({ colorAlpha: 0.3 }));
	});

	it("should dim an already-rendered gradient stroke when its appearance opacity is lowered", async () => {
		expectDimmed(
			await renderThenReRender({ appearanceOpacity: 0.3, gradient: true }),
		);
	});

	it("should dim an already-rendered gradient stroke when the element opacity is lowered", async () => {
		expectDimmed(
			await renderThenReRender({ elementOpacity: 0.3, gradient: true }),
		);
	});
});

/** Around 178, with room for rounding and any AA that reaches the center. */
function expectDimmed(center: number[]): void {
	for (const channel of center.slice(0, 3)) {
		expect(channel).toBeGreaterThan(160);
		expect(channel).toBeLessThan(196);
	}
}

/**
 * Render the stroke fully opaque, then re-render the same element id with the
 * given transparency applied, and return the center pixel of the second frame.
 */
async function renderThenReRender(
	transparency: StrokeDocOptions,
): Promise<number[]> {
	const { renderer, canvas } = await createTestRenderer();
	const viewport = { x: 0, y: 0, zoom: 1, rotation: 0 };
	const device = renderer.getDevice();
	if (!device) throw new Error("Test renderer has no GPU device");

	const renderCenterPixel = async (doc: Document): Promise<number[]> => {
		const texture = await renderWithViewport(renderer, canvas, doc, viewport);
		const pixels = await captureTexturePixels(
			device,
			texture,
			texture.width,
			texture.height,
		);
		// World (0,0) is the stroke's midpoint, which lands at screen (400,300).
		const offset = (300 * texture.width + 400) * 4;
		const center = [
			pixels[offset],
			pixels[offset + 1],
			pixels[offset + 2],
			pixels[offset + 3],
		];
		texture.destroy();
		return center;
	};

	// Draw the opaque stroke twice before changing anything. One frame is not
	// enough: some cache fingerprints only settle on the second frame, so a
	// single warm-up leaves them mismatched and every cache misses for the
	// wrong reason — which is exactly how a stale-cache bug slipped through
	// this test once already. By the time anyone drags an opacity slider the
	// app has drawn many frames, and that is the state to assert against.
	// Same paint type, fully opaque — warming up with a solid stroke would
	// populate different caches than the gradient one under test.
	const opaqueSource: StrokeDocOptions = { gradient: transparency.gradient };
	await renderCenterPixel(strokeDoc(opaqueSource));
	await renderCenterPixel(strokeDoc(opaqueSource));
	const opaque = await renderCenterPixel(strokeDoc(opaqueSource));
	expect(opaque.slice(0, 3)).toEqual([0, 0, 0]);

	return renderCenterPixel(strokeDoc(transparency));
}

interface StrokeDocOptions {
	appearanceOpacity?: number;
	elementOpacity?: number;
	colorAlpha?: number;
	/** Paint the stroke with a black-to-black gradient instead of a solid. */
	gradient?: boolean;
}

/** Single horizontal black stroke through world origin, 24 units wide. */
function strokeDoc({
	appearanceOpacity = 1,
	elementOpacity = 1,
	colorAlpha = 1,
	gradient = false,
}: StrokeDocOptions): Document {
	const black = { type: "rgb" as const, r: 0, g: 0, b: 0, a: colorAlpha };
	const strokeColor: StrokeColor = gradient
		? {
				type: "stroke-gradient",
				mode: "within",
				gradient: {
					type: "linear",
					x1: -150,
					y1: 0,
					x2: 150,
					y2: 0,
					stops: [
						{ offset: 0, color: black, midpoint: 0.5 },
						{ offset: 1, color: black, midpoint: 0.5 },
					],
				},
			}
		: { type: "solid", color: black };

	const path: Path = {
		id: "opacity-stroke",
		type: "path",
		opacity: elementOpacity,
		blendMode: "normal",
		transform: createDefaultTransform(),
		segments: [
			{
				start: { x: -150, y: 0 },
				cp1: { x: -150, y: 0 },
				cp2: { x: 150, y: 0 },
				end: { x: 150, y: 0 },
				startPressure: 1,
				endPressure: 1,
				startTiltX: 0,
				startTiltY: 0,
				endTiltX: 0,
				endTiltY: 0,
				startDeltaTime: 0,
				endDeltaTime: 0,
				isMoved: true,
			},
		],
		filters: [
			{
				uid: "opacity-stroke-appearance",
				processor: "stroke",
				opacity: appearanceOpacity,
				blendMode: "normal",
				paramData: {
					version: "1",
					params: {
						strokeColor,
						brushSettings: createStrokeBrushSettings(24),
					},
				},
			},
		],
	};

	const doc = createDefaultDocument("stroke-opacity");
	const layer = createDefaultLayer("stroke-opacity-layer", "Strokes");
	layer.elementIds.push(path.id);
	doc.objects[path.id] = path;
	doc.layers.push(layer);
	doc.artboards.push(
		createArtboard("stroke-opacity-ab", "Main", 0, 0, 800, 600),
	);
	return doc;
}
