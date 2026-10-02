import { describe, expect, it } from "vitest";
import { createArtboard } from "../../document/factory";
import type { CanvasTarget } from "../../renderer/CanvasTarget";
import type { BlurFilter } from "../../renderer/filters/BlurFilter/BlurFilter";
import type { RenderOrchestrator } from "../../renderer/RenderOrchestrator";
import type { Document, FillAppearance, Path, RawRGBA } from "../../schema";
import {
	mockDocument,
	mockLayer,
	mockPath,
} from "../../testUtils/mockElements";
import { closedRectSegments } from "../../testUtils/segmentFactory";
import {
	captureTexturePixels,
	createTestRenderer,
} from "../../testUtils/visualRegression";

const ARTBOARD_WIDTH = 1920;
const ARTBOARD_HEIGHT = 1080;
/** Bakes run at R = 300 / 72, so one artboard-sized bake is ~150 MB. */
const RASTERIZATION_DPI = 300;
/** Headroom over the editor's own textures: the export's readback and the
 *  editor frame's pool churn, far below one export-sized bake. */
const ALLOWED_GROWTH_BYTES = 64 * 1024 * 1024;

/**
 * An export renders on the editor's target, whose pools and filter
 * intermediates the idle editor never trims, so its multi-GB working set
 * stayed allocated until the next edit.
 */
describe("artboard export GPU memory", () => {
	it("should release the export's textures once the export resolves", async () => {
		const { renderer } = await createTestRenderer();
		const live = trackLiveTextureBytes(renderer);
		const document = filteredDocument();
		const [artboard] = document.artboards;

		await renderEditorFrame(renderer, document);
		const beforeExport = live.bytes;

		const image = await renderer.renderArtboardToImageData(artboard, document);

		expect(image).not.toBeNull();
		expect(live.bytes).toBeLessThanOrEqual(beforeExport + ALLOWED_GROWTH_BYTES);
	});

	it("should draw the same editor frame after an export", async () => {
		const { renderer, canvas } = await createTestRenderer();
		const document = filteredDocument();
		const [artboard] = document.artboards;

		const before = await renderEditorFrame(renderer, document, canvas);
		await renderer.renderArtboardToImageData(artboard, document);
		const after = await renderEditorFrame(renderer, document, canvas);

		expect(after).toEqual(before);
	});
});

// Helpers

/** Four artboard-sized blurred rects and an artboard-sized pane blurring its
 *  backdrop, over an opaque background. */
function filteredDocument(): Document {
	const halfW = ARTBOARD_WIDTH / 2;
	const halfH = ARTBOARD_HEIGHT / 2;
	const background = filledRect("background", [-halfW, -halfH, halfW, halfH], {
		r: 1,
		g: 1,
		b: 1,
		a: 1,
	});
	const blurred = [0, 1, 2, 3].map((index) => {
		const inset = index * 40;
		const path = filledRect(
			`blurred-${index}`,
			[-halfW + inset, -halfH + inset, halfW - inset, halfH - inset],
			{ r: 0.2 * index, g: 0.5, b: 0.9 - 0.2 * index, a: 0.6 },
		);
		path.filters = [...(path.filters ?? []), blur(`blur-${index}`, false)];
		return path;
	});
	const pane = filledRect("pane", [-halfW, -halfH, halfW, halfH], {
		r: 1,
		g: 1,
		b: 1,
		a: 0.08,
	});
	pane.filters = [...(pane.filters ?? []), blur("pane-blur", true)];

	const elements = [background, ...blurred, pane];
	const document = mockDocument(elements, [
		mockLayer(
			"layer-1",
			elements.map((element) => element.id),
		),
	]);
	document.rasterizationDpi = RASTERIZATION_DPI;
	document.artboards = [
		createArtboard(
			"artboard",
			"Artboard",
			0,
			0,
			ARTBOARD_WIDTH,
			ARTBOARD_HEIGHT,
		),
	];
	return document;
}

function blur(uid: string, applyToBackdrop: boolean): BlurFilter {
	return {
		uid,
		processor: "blur",
		opacity: 1,
		blendMode: "normal",
		enabled: true,
		applyToBackdrop,
		paramData: { version: "1", params: { radius: 24 } },
	};
}

function filledRect(
	id: string,
	[minX, minY, maxX, maxY]: [number, number, number, number],
	color: RawRGBA,
): Path {
	const path = mockPath(id);
	path.segments = closedRectSegments(minX, minY, maxX, maxY);
	const fill: FillAppearance = {
		uid: `${id}-fill`,
		processor: "fill",
		opacity: 1,
		blendMode: "normal",
		paramData: {
			version: "1",
			params: { fill: { type: "solid", color: { type: "rgb", ...color } } },
		},
	};
	path.filters = [fill];
	return path;
}

/** Count the bytes of every texture the device created and has not
 *  destroyed. */
function trackLiveTextureBytes(renderer: RenderOrchestrator): {
	readonly bytes: number;
} {
	const device = renderer.getDevice();
	if (!device) throw new Error("Test renderer has no GPU device");
	const sizes = new Map<GPUTexture, number>();
	const createTexture = device.createTexture.bind(device);
	device.createTexture = ((descriptor: GPUTextureDescriptor) => {
		const texture = createTexture(descriptor);
		sizes.set(
			texture,
			texture.width *
				texture.height *
				texture.depthOrArrayLayers *
				texture.sampleCount *
				bytesPerTexel(texture.format),
		);
		const destroy = texture.destroy.bind(texture);
		texture.destroy = () => {
			sizes.delete(texture);
			destroy();
		};
		return texture;
	}) as typeof device.createTexture;
	return {
		get bytes() {
			let total = 0;
			for (const size of sizes.values()) total += size;
			return total;
		},
	};
}

function bytesPerTexel(format: GPUTextureFormat): number {
	if (format === "rgba32float") return 16;
	if (format === "rgba16float" || format === "rg32float") return 8;
	if (format === "r8unorm") return 1;
	return 4;
}

/** Draw one frame through RenderOrchestrator.render, the path the editor
 *  draws with, and return the presented pixels when `canvas` is given. */
async function renderEditorFrame(
	renderer: RenderOrchestrator,
	document: Document,
	canvas?: CanvasTarget,
): Promise<Uint8Array | null> {
	const device = renderer.getDevice();
	if (!device) throw new Error("Test renderer has no GPU device");
	renderer.render(
		{
			viewport: { x: 0, y: 0, zoom: 1, rotation: 0 },
			document,
			strategy: "full",
			changedElements: { upserted: new Set(), deleted: new Set() },
		},
		{},
	);
	await device.queue.onSubmittedWorkDone();
	if (!canvas) return null;
	const texture = (
		canvas as unknown as { _context: GPUCanvasContext }
	)._context.getCurrentTexture();
	return captureTexturePixels(device, texture, 800, 600);
}
