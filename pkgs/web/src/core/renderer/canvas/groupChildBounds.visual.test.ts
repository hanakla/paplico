import { describe, expect, it } from "vitest";
import type { Document, FillAppearance, Path, Viewport } from "../../schema";
import {
	mockDocument,
	mockGroup,
	mockLayer,
	mockPath,
} from "../../testUtils/mockElements";
import { closedRectSegments } from "../../testUtils/segmentFactory";
import {
	captureTexturePixels,
	createTestRenderer,
	renderWithViewport,
} from "../../testUtils/visualRegression";
import type { CanvasTarget } from "../CanvasTarget";

/**
 * A child square at local 0..40 shifted by x:100 under a group rotated 90°
 * is drawn at x 0..40, y 100..140: the GPU rotates about the child's own
 * centre and adds the rotated offset. Every CPU-side box that sizes or culls
 * that child has to land there too, so the view is zoomed onto the drawn
 * square with the un-rotated position (x 100..140, y 0..40) out of view.
 */
const VIEWPORT: Viewport = { x: 20, y: 120, zoom: 4, rotation: 0 };
const RED = { r: 1, g: 0, b: 0, a: 1 };
const WHITE = { r: 1, g: 1, b: 1, a: 1 };

describe("group child bounds", () => {
	it("should keep a translated child of a rotated group in view on the interactive frame path", async () => {
		const child = filledSquare("child-1");
		child.transform = { ...child.transform, x: 100 };
		// Two corner squares stretch the group's own box over the view, so the
		// only box that can cull the red square is the child's.
		const corners = [
			filledSquare("corner-1", -50, -40),
			filledSquare("corner-2", 140, 150),
		];
		const group = mockGroup(
			"group-1",
			[child.id, ...corners.map((c) => c.id)],
			{ rotation: Math.PI / 2 },
		);
		const document = mockDocument(
			[child, ...corners, group],
			[mockLayer("layer-1", [group.id])],
		);

		const pixels = await renderInteractive(document);
		expect(colorAt(pixels, 400, 300)).toEqual(RED);
	});

	it("should clip a translated inline clip group inside a rotated group at its drawn position", async () => {
		const document = clippedDocument(["content-1"]);

		const pixels = await render(document);
		expect(colorAt(pixels, 400, 300)).toEqual(RED);
		expect(colorAt(pixels, 520, 300)).toEqual(WHITE);
	});

	it("should clip a translated offscreen clip group inside a rotated group at its drawn position", async () => {
		// Two clipped draws keep the group off the inline mask path, so it is
		// baked to a texture sized from its bounds and masked once.
		const document = clippedDocument(["content-1", "content-2"]);

		const pixels = await render(document);
		expect(colorAt(pixels, 400, 300)).toEqual(RED);
		expect(colorAt(pixels, 520, 300)).toEqual(WHITE);
	});
});

/**
 * A clip group shifted by x:100 under a group rotated 90°. The clipped
 * content spills 20 units past the clip square on every side, so a correctly
 * placed clip shows red at the centre and the background 10 units right of
 * the clip square, at world (50, 120).
 */
function clippedDocument(contentIds: string[]): Document {
	const contents = contentIds.map((id) => filledSquare(id, -20, 60));
	const clipPath = mockPath("clip-path-1");
	clipPath.segments = closedRectSegments(0, 0, 40, 40);
	const clipGroup = mockGroup("clip-group-1", [clipPath.id, ...contentIds], {
		x: 100,
	});
	clipGroup.clipPathId = clipPath.id;
	const group = mockGroup("group-1", [clipGroup.id], {
		rotation: Math.PI / 2,
	});
	return mockDocument(
		[...contents, clipPath, clipGroup, group],
		[mockLayer("layer-1", [group.id])],
	);
}

async function render(document: Document): Promise<Uint8Array> {
	const { renderer, canvas } = await createTestRenderer();
	const device = renderer.getDevice();
	if (!device) throw new Error("Test renderer has no GPU device");
	const texture = await renderWithViewport(
		renderer,
		canvas,
		document,
		VIEWPORT,
	);
	const pixels = await captureTexturePixels(
		device,
		texture,
		texture.width,
		texture.height,
	);
	texture.destroy();
	return pixels;
}

/** Render through RenderOrchestrator.render, the path that culls elements
 *  against the viewport, and read back the presented frame. */
async function renderInteractive(document: Document): Promise<Uint8Array> {
	const { renderer, canvas } = await createTestRenderer();
	const device = renderer.getDevice();
	if (!device) throw new Error("Test renderer has no GPU device");
	renderer.render(
		{
			viewport: VIEWPORT,
			document,
			strategy: "full",
			changedElements: { upserted: new Set(), deleted: new Set() },
		},
		{},
	);
	await device.queue.onSubmittedWorkDone();
	const texture = presentedTexture(canvas);
	const pixels = await captureTexturePixels(device, texture, 800, 600);
	if (texture.format.startsWith("bgra")) {
		for (let offset = 0; offset < pixels.length; offset += 4) {
			[pixels[offset], pixels[offset + 2]] = [
				pixels[offset + 2],
				pixels[offset],
			];
		}
	}
	return pixels;
}

function presentedTexture(canvas: CanvasTarget): GPUTexture {
	return (
		canvas as unknown as { _context: GPUCanvasContext }
	)._context.getCurrentTexture();
}

function colorAt(
	pixels: Uint8Array,
	x: number,
	y: number,
): { r: number; g: number; b: number; a: number } {
	const offset = (y * 800 + x) * 4;
	return {
		r: pixels[offset] / 255,
		g: pixels[offset + 1] / 255,
		b: pixels[offset + 2] / 255,
		a: pixels[offset + 3] / 255,
	};
}

function filledSquare(id: string, min = 0, max = 40): Path {
	const path = mockPath(id);
	path.segments = closedRectSegments(min, min, max, max);
	path.filters = [fill()];
	return path;
}

function fill(): FillAppearance {
	return {
		uid: "fill-1",
		processor: "fill",
		opacity: 1,
		blendMode: "normal",
		paramData: {
			version: "1",
			params: {
				fill: { type: "solid", color: { type: "rgb", ...RED } },
			},
		},
	};
}
