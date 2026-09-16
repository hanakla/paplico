import { describe, it } from "vitest";
import {
	createArtboard,
	createDefaultDocument,
	createDefaultLayer,
} from "../../document/factory";
import { type Filter, generateUid } from "../../schema";
import { rectPath, solidFillAppearance } from "../../testUtils/svgFixtures";
import {
	createTestRenderer,
	expectVisualMatch,
	renderWithViewport,
} from "../../testUtils/visualRegression";
import type { BlurFilter } from "./BlurFilterProcessor";
import type { ClipToShapeFilter } from "./ClipToShapeFilterProcessor";

// A blurred square spreads a halo past its edges; clipping trims the halo
// back to the square, and the inverted clip keeps only the halo.

describe("clip-to-shape filter", () => {
	it("should trim a blur halo back to the element's shape", async () => {
		await expectFilterBaseline("clip-to-shape-blur", [
			blur(12),
			clipToShape(false),
		]);
	});

	it("should keep only the halo when inverted", async () => {
		await expectFilterBaseline("clip-to-shape-blur-inverted", [
			blur(12),
			clipToShape(true),
		]);
	});
});

async function expectFilterBaseline(
	baselineName: string,
	filters: Filter[],
): Promise<void> {
	const { renderer, canvas } = await createTestRenderer();
	const doc = createSquareDoc(baselineName, filters);
	const viewport = { x: 0, y: 0, zoom: 1, rotation: 0 };

	const texture = await renderWithViewport(renderer, canvas, doc, viewport);

	await expectVisualMatch(
		renderer,
		texture,
		texture.width,
		texture.height,
		baselineName,
		{ threshold: 0.1, maxDiffPercentage: 0.5 },
	);

	texture.destroy();
}

function createSquareDoc(id: string, filters: Filter[]) {
	const doc = createDefaultDocument(id);
	const layer = createDefaultLayer("layer-bg", "Background");

	const square = rectPath("square", { x: 0, y: 0 }, 140, 140, [
		solidFillAppearance(1, 0.55, 0.1),
		...filters,
	]);
	doc.objects[square.id] = square;
	layer.elementIds.push(square.id);
	doc.layers = [layer];
	doc.artboards.push(createArtboard("ab-clip", "Clip", 0, 0, 320, 240));
	return doc;
}

function blur(radius: number): BlurFilter {
	return {
		...filterBase(),
		processor: "blur",
		paramData: { version: "1", params: { radius } },
	};
}

function clipToShape(invert: boolean): ClipToShapeFilter {
	return {
		...filterBase(),
		processor: "clip-to-shape",
		paramData: { version: "1", params: { invert } },
	};
}

function filterBase() {
	return {
		uid: generateUid("filter"),
		opacity: 1,
		blendMode: "normal" as const,
		enabled: true,
	};
}
