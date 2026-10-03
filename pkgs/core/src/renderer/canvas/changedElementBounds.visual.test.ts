import { describe, expect, it } from "vitest";
import type {
	AnyArtObject,
	Document,
	FillAppearance,
	Viewport,
} from "../../schema";
import {
	mockCompoundPath,
	mockDocument,
	mockGroup,
	mockLayer,
	mockPath,
} from "../../testUtils/mockElements";
import { closedRectSegments } from "../../testUtils/segmentFactory";
import {
	captureTexturePixels,
	createTestRenderer,
} from "../../testUtils/visualRegression";
import type { CanvasTarget } from "../CanvasTarget";
import type { BlurFilter } from "../filters/BlurFilter/BlurFilter";
import type { HKGradientMapFilter } from "../filters/HKGradientMapFilter/HKGradientMapFilter";
import type { RenderOrchestrator } from "../RenderOrchestrator";

/**
 * An element grown from ±50 to ±150 between two interactive frames, with its
 * id in the second frame's change set. Screen (500, 300) is world (100, 0):
 * outside the old shape, inside the new one.
 */
const VIEWPORT: Viewport = { x: 0, y: 0, zoom: 1, rotation: 0 };
const RED = { r: 1, g: 0, b: 0, a: 1 };
const WHITE = { r: 1, g: 1, b: 1, a: 1 };
const PROBE = { x: 500, y: 300 };

describe("bounds of an element changed between frames", () => {
	it("should apply a backdrop gradient map over the grown area", async () => {
		const frames = await renderGrowth(RED, (size) => {
			const pane = mockPath("pane-1");
			pane.segments = closedRectSegments(-size, -size, size, size);
			pane.filters = [gradientMap()];
			return { changedId: pane.id, elements: [pane], topIds: [pane.id] };
		});

		expect(colorAt(frames.grown, PROBE)).not.toEqual(RED);
	});

	it("should apply a backdrop gradient map over the grown area inside a group", async () => {
		const frames = await renderGrowth(RED, (size) => {
			const pane = mockPath("pane-1");
			pane.segments = closedRectSegments(-size, -size, size, size);
			pane.filters = [gradientMap()];
			const group = mockGroup("group-1", [pane.id]);
			return {
				changedId: pane.id,
				elements: [pane, group],
				topIds: [group.id],
			};
		});

		expect(colorAt(frames.grown, PROBE)).not.toEqual(RED);
	});

	it("should draw a blurred shape over the grown area", async () => {
		const frames = await renderGrowth(WHITE, (size) => {
			const square = mockPath("square-1");
			square.segments = closedRectSegments(-size, -size, size, size);
			square.filters = [fill(RED), blur()];
			return { changedId: square.id, elements: [square], topIds: [square.id] };
		});

		expect(colorAt(frames.initial, PROBE)).toEqual(WHITE);
		expect(colorAt(frames.grown, PROBE)).toEqual(RED);
	});

	it("should fill a group over the grown source of its compound path", async () => {
		const frames = await renderGrowth(WHITE, (size) => {
			const source = mockPath("source-1");
			source.segments = closedRectSegments(-size, -size, size, size);
			const compound = mockCompoundPath("compound-1", [source.id]);
			const group = mockGroup("group-1", [compound.id]);
			group.filters = [fill(RED)];
			return {
				changedId: source.id,
				elements: [source, compound, group],
				topIds: [group.id],
			};
		});

		expect(colorAt(frames.initial, PROBE)).toEqual(WHITE);
		expect(colorAt(frames.grown, PROBE)).toEqual(RED);
	});
});

/**
 * Draw the scene `build` returns at size 50 over a full-canvas background,
 * then at size 150 through a second interactive frame that reports only
 * `changedId` as changed.
 */
async function renderGrowth(
	backgroundColor: typeof RED,
	build: (size: number) => {
		changedId: string;
		elements: AnyArtObject[];
		topIds: string[];
	},
): Promise<{ initial: Uint8Array; grown: Uint8Array }> {
	const { renderer, canvas } = await createTestRenderer();
	const device = renderer.getDevice();
	if (!device) throw new Error("Test renderer has no GPU device");

	const background = mockPath("background-1");
	background.segments = closedRectSegments(-400, -300, 400, 300);
	background.filters = [fill(backgroundColor)];
	const documentAt = (scene: ReturnType<typeof build>): Document =>
		mockDocument(
			[background, ...scene.elements],
			[mockLayer("layer-1", [background.id, ...scene.topIds])],
		);

	const initial = await renderFrame(
		renderer,
		canvas,
		device,
		documentAt(build(50)),
		new Set(),
	);
	const grownScene = build(150);
	const grown = await renderFrame(
		renderer,
		canvas,
		device,
		documentAt(grownScene),
		new Set([grownScene.changedId]),
	);
	return { initial, grown };
}

async function renderFrame(
	renderer: RenderOrchestrator,
	canvas: CanvasTarget,
	device: GPUDevice,
	document: Document,
	upserted: Set<string>,
): Promise<Uint8Array> {
	renderer.render(
		{
			viewport: VIEWPORT,
			document,
			strategy: "full",
			changedElements: { upserted, deleted: new Set() },
		},
		{},
	);
	await device.queue.onSubmittedWorkDone();
	const texture = (
		canvas as unknown as { _context: GPUCanvasContext }
	)._context.getCurrentTexture();
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

function colorAt(
	pixels: Uint8Array,
	{ x, y }: { x: number; y: number },
): { r: number; g: number; b: number; a: number } {
	const offset = (y * 800 + x) * 4;
	return {
		r: pixels[offset] / 255,
		g: pixels[offset + 1] / 255,
		b: pixels[offset + 2] / 255,
		a: pixels[offset + 3] / 255,
	};
}

function fill(color: typeof RED): FillAppearance {
	return {
		uid: "fill-1",
		processor: "fill",
		opacity: 1,
		blendMode: "normal",
		paramData: {
			version: "1",
			params: { fill: { type: "solid", color: { type: "rgb", ...color } } },
		},
	};
}

function gradientMap(): HKGradientMapFilter {
	return {
		uid: "gradient-map-1",
		processor: "hk:gradient-map",
		opacity: 1,
		blendMode: "normal",
		applyToBackdrop: true,
		paramData: {
			version: "1",
			params: { preset: "duotone", colorStops: "", strength: 1 },
		},
	};
}

function blur(): BlurFilter {
	return {
		uid: "blur-1",
		processor: "blur",
		opacity: 1,
		blendMode: "normal",
		paramData: { version: "1", params: { radius: 4 } },
	};
}
