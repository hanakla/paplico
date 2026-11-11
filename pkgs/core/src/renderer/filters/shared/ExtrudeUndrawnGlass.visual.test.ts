import { describe, expect, it } from "vitest";
import {
	createDefaultDocument,
	createDefaultLayer,
	createDefaultTransform,
} from "../../../document/factory";
import type {
	Document,
	Extrude3DAppearance,
	FillAppearance,
	Group,
	Path,
} from "../../../schema";
import { closedRectSegments } from "../../../testUtils/segmentFactory";
import {
	captureTexturePixels,
	createTestRenderer,
	renderWithViewport,
} from "../../../testUtils/visualRegression";

/**
 * A glass extrude that no visible layer draws: one in a hidden layer, and one
 * a deleted layer's group left behind in `objects`. The solid spans screen
 * [400,500]x[200,300] over a white ground.
 */
type Scene = "shown" | "hiddenLayer" | "orphaned";

describe("glass extrude no visible layer draws", () => {
	it.each([
		["in a hidden layer", "hiddenLayer", false],
		["in a group in a hidden layer", "hiddenLayer", true],
		["left behind by a deleted layer's group", "orphaned", true],
	] as const)("should not paint a glass solid %s", async (_label, scene, inGroup) => {
		const { renderer, canvas } = await createTestRenderer();
		const ground = await renderTwice(renderer, canvas, createDoc(null, false));
		const shown = await renderTwice(
			renderer,
			canvas,
			createDoc("shown", inGroup),
		);
		const undrawn = await renderTwice(
			renderer,
			canvas,
			createDoc(scene, inGroup),
		);

		expect(countDifferingPixels(shown, ground)).toBeGreaterThan(0);
		expect(countDifferingPixels(undrawn, ground)).toBe(0);
	});
});

/** The extrude mesh bakes asynchronously, so the first frame can miss the
 *  solid; the second one is measured. */
async function renderTwice(
	renderer: Awaited<ReturnType<typeof createTestRenderer>>["renderer"],
	canvas: Awaited<ReturnType<typeof createTestRenderer>>["canvas"],
	document: Document,
): Promise<Uint8Array> {
	const viewport = { x: 0, y: 0, zoom: 1, rotation: 0 };
	(await renderWithViewport(renderer, canvas, document, viewport)).destroy();
	const texture = await renderWithViewport(
		renderer,
		canvas,
		document,
		viewport,
	);
	const device = renderer.getDevice();
	if (!device) throw new Error("GPU device is unavailable");
	const pixels = await captureTexturePixels(device, texture, 800, 600);
	texture.destroy();
	return pixels;
}

function countDifferingPixels(a: Uint8Array, b: Uint8Array): number {
	let count = 0;
	for (let i = 0; i < a.length; i += 4) {
		for (let c = 0; c < 4; c++) {
			if (Math.abs(a[i + c] - b[i + c]) > 2) {
				count++;
				break;
			}
		}
	}
	return count;
}

/** The ground layer, plus the glass as `scene` leaves it; null leaves none.
 *  An orphaned glass is in `objects` with no layer or group reaching it. */
function createDoc(scene: Scene | null, inGroup: boolean): Document {
	const doc = createDefaultDocument("undrawn-glass");
	const groundLayer = createDefaultLayer("layer-1", "Ground");
	const background = filledPath("bg-1", -400, -300, 400, 300, 1);
	doc.objects[background.id] = background;
	groundLayer.elementIds.push(background.id);
	doc.layers = [groundLayer];
	if (scene === null) return doc;

	const glass = glassPath();
	doc.objects[glass.id] = glass;
	if (scene === "orphaned") return doc;

	const group: Group = {
		id: "group-1",
		type: "group",
		opacity: 1,
		blendMode: "normal",
		transform: createDefaultTransform(),
		childIds: [glass.id],
	};
	const top = inGroup ? group : glass;
	doc.objects[top.id] = top;
	const glassLayer = createDefaultLayer("layer-2", "Glass");
	glassLayer.visible = scene === "shown";
	glassLayer.elementIds.push(top.id);
	doc.layers.push(glassLayer);
	return doc;
}

function filledPath(
	id: string,
	minX: number,
	minY: number,
	maxX: number,
	maxY: number,
	gray: number,
): Path {
	const fill: FillAppearance = {
		uid: `${id}-fill`,
		processor: "fill",
		opacity: 1,
		blendMode: "normal",
		paramData: {
			version: "1",
			params: {
				fill: {
					type: "solid",
					color: { type: "rgb", r: gray, g: gray, b: gray, a: 1 },
				},
			},
		},
	};
	return {
		id,
		type: "path",
		opacity: 1,
		blendMode: "normal",
		transform: createDefaultTransform(),
		segments: closedRectSegments(minX, minY, maxX, maxY),
		filters: [fill],
	};
}

function glassPath(): Path {
	const glass: Extrude3DAppearance = {
		uid: "extrude-1",
		processor: "extrude3d",
		opacity: 1,
		blendMode: "normal",
		paramData: {
			version: "1",
			params: {
				depth: 40,
				rotationDeg: [20, 30, 0],
				perspective: 20,
				material: {
					shading: "lambert",
					lightDir: [0, 0, 1],
					refraction: 1.5,
					blur: 4,
				},
			},
		},
	};
	const path = filledPath("glass-1", 0, 0, 100, 100, 0.8);
	return { ...path, filters: [...(path.filters ?? []), glass] };
}
