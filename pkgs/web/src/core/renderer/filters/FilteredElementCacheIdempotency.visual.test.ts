import { describe, expect, it } from "vitest";
import {
	createDefaultDocument,
	createDefaultLayer,
	createDefaultTransform,
} from "../../document/factory";
import type {
	Document,
	FillAppearance,
	Path,
	PathSegment,
	RawRGBA,
	Viewport,
} from "../../schema";
import {
	captureTexturePixels,
	createTestRenderer,
} from "../../testUtils/visualRegression";
import type { RenderOrchestrator } from "../RenderOrchestrator";
import type { ChangedElements } from "../types";

const CANVAS_WIDTH = 800;
const CANVAS_HEIGHT = 600;
const BLURRED_ID = "blurred-1";
const BACKGROUND: RawRGBA = { r: 1, g: 1, b: 1, a: 1 };
const UNCHANGED: ChangedElements = { upserted: new Set(), deleted: new Set() };
const CACHE_TEXTURE_LABEL = "Filtered Element Cache Texture";

/**
 * The filtered-element cache must be invisible in the output: a pan frame that
 * reuses a cached bake has to produce exactly the pixels a full re-run of the
 * filter chain would. Frames run through the editor path (viewport culling and
 * the interactive bake clamp kept on) — the export path never engages the
 * cache.
 */
describe("filtered-element cache idempotency", () => {
	it("should render a cache-hit pan frame identical to a forced re-render", async () => {
		const doc = createBlurDocument();
		const { renderer } = await createTestRenderer();
		const device = renderer.getDevice();
		if (!device) throw new Error("no GPU device");

		const cacheStores = trackCacheTextureCreations(device);

		// GPU render caches need identical warm frames before measuring
		// (first-frame allocations and async warmups otherwise hide bugs).
		const base: Viewport = { x: 0, y: 0, zoom: 1, rotation: 0 };
		for (let i = 0; i < 3; i++) {
			(await renderFrame(renderer, doc, base, UNCHANGED)).destroy();
		}

		const panned: Viewport = { x: 30, y: 20, zoom: 1, rotation: 0 };
		cacheStores.count = 0;
		const hitTexture = await renderFrame(renderer, doc, panned, UNCHANGED);
		const hitStores = cacheStores.count;
		const hitPixels = await captureTexturePixels(
			device,
			hitTexture,
			CANVAS_WIDTH,
			CANVAS_HEIGHT,
		);
		hitTexture.destroy();

		// Reporting the element as changed push-invalidates its entry, so this
		// frame re-runs the whole chain and re-stores the bake.
		cacheStores.count = 0;
		const missTexture = await renderFrame(renderer, doc, panned, {
			upserted: new Set([BLURRED_ID]),
			deleted: new Set(),
		});
		const missStores = cacheStores.count;
		const missPixels = await captureTexturePixels(
			device,
			missTexture,
			CANVAS_WIDTH,
			CANVAS_HEIGHT,
		);
		missTexture.destroy();

		expect(hitStores).toBe(0);
		expect(missStores).toBeGreaterThan(0);
		expect(countDifferingPixels(hitPixels, missPixels)).toBe(0);
	}, 240_000);
});

// Helpers

async function renderFrame(
	renderer: RenderOrchestrator,
	doc: Document,
	viewport: Viewport,
	changedElements: ChangedElements,
): Promise<GPUTexture> {
	const texture = await renderer.renderViewportToTexture(
		viewport,
		doc,
		CANVAS_WIDTH,
		CANVAS_HEIGHT,
		BACKGROUND,
		changedElements,
		undefined,
		false,
		false,
	);
	if (!texture) throw new Error("render returned no texture");
	return texture;
}

/** Counts createTexture calls for the cache-owned bake copies, proving a
 *  frame hit (0 stores) or re-baked (1+ stores) without reading private state. */
function trackCacheTextureCreations(device: GPUDevice): { count: number } {
	const counter = { count: 0 };
	const original = device.createTexture.bind(device);
	device.createTexture = ((descriptor: GPUTextureDescriptor) => {
		if (descriptor.label === CACHE_TEXTURE_LABEL) counter.count++;
		return original(descriptor);
	}) as typeof device.createTexture;
	return counter;
}

function countDifferingPixels(a: Uint8Array, b: Uint8Array): number {
	let differing = 0;
	for (let i = 0; i < a.length; i += 4) {
		if (
			Math.abs(a[i] - b[i]) > 1 ||
			Math.abs(a[i + 1] - b[i + 1]) > 1 ||
			Math.abs(a[i + 2] - b[i + 2]) > 1 ||
			Math.abs(a[i + 3] - b[i + 3]) > 1
		) {
			differing++;
		}
	}
	return differing;
}

/** One blurred red square over a white background. */
function createBlurDocument(): Document {
	const document = createDefaultDocument("filtered-element-cache-idempotency");
	const layer = createDefaultLayer("layer-1", "Layer");
	const blurred: Path = {
		id: BLURRED_ID,
		type: "path",
		opacity: 1,
		blendMode: "normal",
		transform: createDefaultTransform(),
		segments: rectSegments(-80, 80, -60, 60),
		filters: [
			fill({ r: 0.8, g: 0.1, b: 0.1, a: 1 }),
			{
				uid: "blur-1",
				processor: "blur",
				opacity: 1,
				blendMode: "normal",
				paramData: { version: "1", params: { radius: 8 } },
			},
		],
	};

	document.objects[blurred.id] = blurred;
	layer.elementIds.push(blurred.id);
	document.layers = [layer];
	return document;
}

function fill(color: RawRGBA): FillAppearance {
	return {
		uid: "fill-1",
		processor: "fill",
		opacity: 1,
		blendMode: "normal",
		paramData: {
			version: "1",
			params: {
				fill: { type: "solid", color: { type: "rgb", ...color } },
			},
		},
	};
}

function rectSegments(
	minX: number,
	maxX: number,
	minY: number,
	maxY: number,
): PathSegment[] {
	const points = [
		{ x: minX, y: maxY },
		{ x: maxX, y: maxY },
		{ x: maxX, y: minY },
		{ x: minX, y: minY },
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
