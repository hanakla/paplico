import { describe, expect, it } from "vitest";
import {
	createDefaultDocument,
	createDefaultTransform,
} from "../../document/factory";
import type {
	BrushSettings,
	Document,
	Path,
	StrokeAppearance,
	Viewport,
} from "../../schema";
import { rectPath, solidFillAppearance } from "../../testUtils/svgFixtures";
import {
	captureTexturePixels,
	createTestRenderer,
	renderWithViewport,
} from "../../testUtils/visualRegression";

/**
 * A brush can take its tip or its grain from a def. The stroke has to paint
 * with the def's artwork, not with the built-in texture that stands in when
 * no def texture exists.
 */
describe("Brush with a def source", () => {
	it("should stamp the def's shape when the image tip comes from a def", async () => {
		// The def is white over one half of its tile, so its dabs cover one
		// side of the stroke's centre line. A round tip would cover both sides.
		const above = await alphaAt(tipFromDef(), WHITE, STROKE_ROW - 10);
		const below = await alphaAt(tipFromDef(), WHITE, STROKE_ROW + 10);

		expect(Math.min(above, below)).toBeLessThan(30);
		expect(Math.max(above, below)).toBeGreaterThan(200);
	});

	it("should apply the def's grain when the grain comes from a def", async () => {
		// The def is black, so a full-strength multiply grain erases every
		// dab. Without the def texture the grain stays a no-op.
		expect(await alphaAt(grainFromDef(), BLACK, STROKE_ROW)).toBeLessThan(30);
	});
});

const VIEWPORT: Viewport = { x: 0, y: 0, zoom: 1, rotation: 0 };
/** Screen row the stroke runs along at world y 0. */
const STROKE_ROW = 300;
const STROKE_CENTER_X = 400;
const DEF_ID = "def-half";
const WHITE = 1;
const BLACK = 0;

function tipFromDef(): BrushSettings {
	return {
		...dabBrush(),
		tip: {
			kind: "image",
			sources: [{ kind: "def", defId: DEF_ID }],
			selection: "sequence",
			angleMode: "fixed",
		},
	};
}

function grainFromDef(): BrushSettings {
	return {
		...dabBrush(),
		grain: {
			source: { kind: "def", defId: DEF_ID },
			scale: 40,
			mode: "multiply",
			randomOffsetPerStroke: false,
		},
	};
}

function dabBrush(): BrushSettings {
	return {
		version: 2,
		engine: "dab",
		strokeOpacity: 1,
		paintMode: "buildup",
		properties: {
			size: { base: 40 },
			spacing: { base: 0.05 },
			flow: { base: 1 },
			hardness: { base: 1 },
		},
		tip: { kind: "procedural", hardness: 1, angleMode: "fixed" },
		randomSeed: 7,
	};
}

/** Alpha of the rendered stroke at the stroke's middle column. */
async function alphaAt(
	brushSettings: BrushSettings,
	defGray: number,
	screenY: number,
): Promise<number> {
	const { renderer, canvas } = await createTestRenderer();
	const device = renderer.getDevice();
	if (!device) throw new Error("Test renderer has no GPU device");

	const doc = strokeDocument(brushSettings, defGray);
	// Transparent ground, so alpha reads the stroke alone.
	const ground = { r: 0, g: 0, b: 0, a: 0 };
	const texture = await renderWithViewport(
		renderer,
		canvas,
		doc,
		VIEWPORT,
		ground,
	);
	const pixels = await captureTexturePixels(
		device,
		texture,
		texture.width,
		texture.height,
	);
	texture.destroy();
	return pixels[(screenY * texture.width + STROKE_CENTER_X) * 4 + 3];
}

/**
 * A horizontal stroke through the origin, beside a 40×40 pattern def whose
 * artwork is a gray rectangle over the top half of its tile.
 */
function strokeDocument(
	brushSettings: BrushSettings,
	defGray: number,
): Document {
	const half = rectPath("def-half-rect", { x: 0, y: 10 }, 40, 20, [
		solidFillAppearance(defGray, defGray, defGray),
	]);
	const stroke: Path = {
		id: "stroke",
		type: "path",
		opacity: 1,
		blendMode: "normal",
		transform: createDefaultTransform(),
		segments: [
			{
				start: { x: -100, y: 0 },
				cp1: { x: 0, y: 0 },
				cp2: { x: 0, y: 0 },
				end: { x: 100, y: 0 },
				startPressure: 1,
				endPressure: 1,
				startTiltX: 0,
				startTiltY: 0,
				endTiltX: 0,
				endTiltY: 0,
				startDeltaTime: 0,
				endDeltaTime: 300,
				isMoved: true,
			},
		],
		filters: [strokeAppearance(brushSettings)],
	};

	const doc = createDefaultDocument("doc-brush-def");
	doc.objects[half.id] = half;
	doc.objects[stroke.id] = stroke;
	doc.layers[0].elementIds = [stroke.id];
	doc.defs = {
		[DEF_ID]: {
			id: DEF_ID,
			kind: "pattern",
			rootElementIds: [half.id],
			tile: { width: 40, height: 40 },
		},
	};
	return doc;
}

function strokeAppearance(brushSettings: BrushSettings): StrokeAppearance {
	return {
		uid: "stroke-appearance",
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
				brushSettings,
			},
		},
	};
}
