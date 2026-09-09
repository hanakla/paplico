import { describe, expect, it } from "vitest";
import { extractDocumentFromYDoc } from "../collaboration/extractDocumentFromYDoc";
import { YjsProvider } from "../collaboration/YjsProvider";
import {
	createArtboard,
	createDefaultDocument,
	createDefaultTransform,
	createStrokeBrushSettings,
} from "../document/factory";
import type { AnyArtObject, Artboard, Document, Path } from "../schema";
import {
	captureTexturePixels,
	createTestRenderer,
} from "../testUtils/visualRegression";
import { calculateElementBounds } from "../utils/geometry/bounds";
import { TimelapsePlayer } from "./TimelapsePlayer";
import { TimelapsePreviewSurface } from "./TimelapsePreviewSurface";
import { TimelapseRecorder } from "./TimelapseRecorder";
import type { TimelapseChangeSet } from "./timelapseIndex";

const PREVIEW_WIDTH = 400;
const PREVIEW_HEIGHT = 300;

/**
 * The preview draws straight to a canvas, which is a different code path from
 * the offscreen export render. Nothing else covers it, and a replayed frame
 * that renders fine offscreen can still leave the canvas blank.
 */
describe("TimelapsePreviewSurface", () => {
	it("should end the replay on the picture the session drew", async () => {
		const session = startSession();
		session.addArtboard(createArtboard("ab", "Main", 0, 0, 800, 600));
		session.draw(strokePath("stroke-1", -150, 0, 150, 0));
		session.draw(strokePath("stroke-2", 0, -100, 0, 100));

		const live = session.document();
		const artboard = live.artboards[0];
		const replayed = replayToEnd(session.recording(), artboard);

		const { renderer } = await createTestRenderer();
		const device = renderer.getDevice();
		if (!device) throw new Error("Test renderer has no GPU device");

		// Both frames go through the same surface, so their pixels are directly
		// comparable — the final replayed frame has to be the drawing itself.
		const livePixels = await drawToPreview(renderer, device, live, artboard);
		const replayedPixels = await drawToPreview(
			renderer,
			device,
			{ ...replayed, artboards: live.artboards },
			artboard,
		);

		expect(countInk(livePixels)).toBeGreaterThan(0);
		expectSameImage(replayedPixels, livePixels);
	});
});

/** Render one frame through a real TimelapsePreviewSurface and read it back. */
async function drawToPreview(
	renderer: Awaited<ReturnType<typeof createTestRenderer>>["renderer"],
	device: GPUDevice,
	document: Document,
	artboard: Artboard,
): Promise<Uint8Array> {
	const canvas = createPreviewCanvas(device);
	const surface = await TimelapsePreviewSurface.create(
		renderer,
		canvas.element,
	);
	try {
		surface.render(document, artboard);
		return await captureTexturePixels(
			device,
			canvas.presented(),
			PREVIEW_WIDTH,
			PREVIEW_HEIGHT,
		);
	} finally {
		surface.dispose();
	}
}

/**
 * Compare the images themselves, not a summary of them. A count of dark pixels
 * matches between pictures that look nothing alike, so it cannot stand in for
 * the frame's content.
 */
function expectSameImage(actual: Uint8Array, expected: Uint8Array): void {
	expect(actual.length).toBe(expected.length);

	let differing = 0;
	let firstDifference = -1;
	for (let i = 0; i < expected.length; i++) {
		if (Math.abs(actual[i] - expected[i]) <= 1) continue;
		differing++;
		if (firstDifference < 0) firstDifference = i;
	}

	expect(
		differing,
		firstDifference < 0
			? "images match"
			: `first difference at byte ${firstDifference}: ${actual[firstDifference]} vs ${expected[firstDifference]}`,
	).toBe(0);
}

/**
 * A canvas whose WebGPU context hands out a real texture, so the presented
 * frame can be read back. The mock in visualRegression refuses
 * getCurrentTexture, which is why this path had no coverage.
 */
function createPreviewCanvas(device: GPUDevice) {
	let presented: GPUTexture | null = null;
	let format: GPUTextureFormat = "bgra8unorm";

	const context = {
		configure: (config: GPUCanvasConfiguration) => {
			format = config.format;
		},
		unconfigure: () => {},
		getCurrentTexture: () => {
			presented ??= device.createTexture({
				label: "Preview Canvas Texture",
				size: { width: PREVIEW_WIDTH, height: PREVIEW_HEIGHT },
				format,
				usage:
					GPUTextureUsage.RENDER_ATTACHMENT |
					GPUTextureUsage.TEXTURE_BINDING |
					GPUTextureUsage.COPY_SRC |
					GPUTextureUsage.COPY_DST,
			});
			return presented;
		},
	};

	const element = {
		width: PREVIEW_WIDTH,
		height: PREVIEW_HEIGHT,
		getContext: (type: string) => (type === "webgpu" ? context : null),
		getBoundingClientRect: () => ({
			width: PREVIEW_WIDTH,
			height: PREVIEW_HEIGHT,
			x: 0,
			y: 0,
			top: 0,
			left: 0,
			right: PREVIEW_WIDTH,
			bottom: PREVIEW_HEIGHT,
			toJSON: () => ({}),
		}),
	};

	return {
		element: element as unknown as HTMLCanvasElement,
		presented: () => {
			if (!presented) throw new Error("The surface never acquired a texture");
			return presented;
		},
	};
}

/**
 * A document being edited through the real Yjs write path, with the timelapse
 * recorder wired up the way Paplico wires it.
 */
function startSession() {
	let objects: Record<string, AnyArtObject> = {};
	let pendingChanges: TimelapseChangeSet | null = null;

	const recorder = new TimelapseRecorder((id) => {
		const element = objects[id];
		if (!element) return null;
		return calculateElementBounds(element, new Map(Object.entries(objects)));
	});

	const provider = new YjsProvider({
		callbacks: {
			onDocumentUpdate: (next) => {
				objects = { ...next.objects };
			},
			onObjectsChange: (delta) => {
				for (const [id, obj] of delta.added) objects[id] = obj;
				for (const [id, obj] of delta.updated) objects[id] = obj;
				for (const id of delta.deleted) delete objects[id];
				pendingChanges = {
					upserted: new Set([...delta.added.keys(), ...delta.updated.keys()]),
					deleted: new Set(delta.deleted),
				};
			},
			onLayersUpdate: () => {},
			getCurrentLayerId: () => "layer-0",
			setCurrentLayerId: () => {},
		},
	});

	// Same hookup as Paplico: the provider delivers updates after its own sync.
	provider.on("update", (update) => {
		const changes = pendingChanges;
		pendingChanges = null;
		recorder.onYjsUpdate(update, changes);
	});

	provider.initializeDocument(createDefaultDocument("timelapse-preview"));

	return {
		draw: (element: Path) => provider.addElement("layer-0", element),
		addArtboard: (artboard: Artboard) => provider.addArtboard(artboard),
		document: () => extractDocumentFromYDoc(provider.ydoc),
		recording: () => {
			const data = recorder.getTimelapseData();
			if (!data) throw new Error("The session recorded nothing");
			return data;
		},
	};
}

function replayToEnd(
	data: NonNullable<ReturnType<TimelapseRecorder["getTimelapseData"]>>,
	artboard: Artboard,
): Document {
	let last: Document | null = null;
	const player = new TimelapsePlayer(
		data,
		{
			onFrame: (document) => {
				last = document;
			},
			onStateChange: () => {},
			getCompletedDocument: () => ({}) as Document,
		},
		artboard,
	);

	for (let i = 0; i < player.totalEvents; i++) player.seekTo(i);
	player.dispose();

	if (!last) throw new Error("The player never emitted a frame");
	return last;
}

/** Pixels darker than the white background, i.e. drawn on. */
function countInk(pixels: Uint8Array): number {
	let count = 0;
	for (let i = 0; i < pixels.length; i += 4) {
		if (pixels[i] < 128) count++;
	}
	return count;
}

/** Straight black stroke, 24 units wide. */
function strokePath(
	id: string,
	x1: number,
	y1: number,
	x2: number,
	y2: number,
): Path {
	return {
		id,
		type: "path",
		opacity: 1,
		blendMode: "normal",
		transform: createDefaultTransform(),
		segments: [
			{
				start: { x: x1, y: y1 },
				cp1: { x: x1, y: y1 },
				cp2: { x: x2, y: y2 },
				end: { x: x2, y: y2 },
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
				uid: `${id}-appearance`,
				processor: "stroke",
				opacity: 1,
				blendMode: "normal",
				paramData: {
					version: "1",
					params: {
						strokeColor: {
							type: "solid",
							color: { type: "rgb", r: 0, g: 0, b: 0, a: 1 },
						},
						brushSettings: createStrokeBrushSettings(24),
					},
				},
			},
		],
	};
}
