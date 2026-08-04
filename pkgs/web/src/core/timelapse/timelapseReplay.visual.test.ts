import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { objectToStoredFields } from "../collaboration/YjsProvider";
import {
	createArtboard,
	createDefaultDocument,
	createDefaultLayer,
	createDefaultTransform,
	createStrokeBrushSettings,
} from "../document/factory";
import type { AnyArtObject, Artboard, Document, Layer, Path } from "../schema";
import {
	captureTexturePixels,
	createTestRenderer,
	renderArtboardForTest,
} from "../testUtils/visualRegression";
import { TimelapsePlayer } from "./TimelapsePlayer";
import { buildTimelapseIndex } from "./timelapseIndex";
import type { TimelapseData, TimelapseEntry } from "./types";

/**
 * The replayed document has to render the same pixels as the document it was
 * recorded from. A structural comparison is not enough: a field that survives
 * the Yjs round trip but loses its meaning still produces a blank frame.
 */
describe("Timelapse replay rendering", () => {
	it("should render the replayed document the same as the recorded one", async () => {
		const source = strokeDoc();
		const recording = recordDocument(source);

		const replayed = replayToEnd(recording, source.artboards[0]);

		const { renderer } = await createTestRenderer();
		const device = renderer.getDevice();
		if (!device) throw new Error("Test renderer has no GPU device");

		const sourcePixel = await centerPixel(renderer, device, source);
		const replayedPixel = await centerPixel(renderer, device, replayed);

		// Sanity: the recorded document really does paint the center black.
		expect(sourcePixel.slice(0, 3)).toEqual([0, 0, 0]);
		expect(replayedPixel.slice(0, 3)).toEqual(sourcePixel.slice(0, 3));
	});
});

async function centerPixel(
	renderer: Awaited<ReturnType<typeof createTestRenderer>>["renderer"],
	device: GPUDevice,
	document: Document,
): Promise<number[]> {
	const texture = await renderArtboardForTest(
		renderer,
		document.artboards[0],
		document,
	);
	const pixels = await captureTexturePixels(
		device,
		texture,
		texture.width,
		texture.height,
	);
	const offset =
		(Math.floor(texture.height / 2) * texture.width +
			Math.floor(texture.width / 2)) *
		4;
	const pixel = [
		pixels[offset],
		pixels[offset + 1],
		pixels[offset + 2],
		pixels[offset + 3],
	];
	texture.destroy();
	return pixel;
}

function replayToEnd(data: TimelapseData, artboard: Artboard): Document {
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

/** Write a Document into a Y.Doc the way YjsProvider does, capturing updates. */
function recordDocument(document: Document): TimelapseData {
	const ydoc = new Y.Doc();
	const entries: TimelapseEntry[] = [];
	ydoc.on("update", (update: Uint8Array) => {
		entries.push({ t: entries.length * 100, u: update });
	});

	// One transaction per element, so the recording steps like a drawing session.
	ydoc.transact(() => {
		for (const layer of document.layers) writeLayer(ydoc, layer);
		ydoc.getArray<Artboard>("artboards").push(document.artboards);
	});
	for (const element of Object.values(document.objects)) {
		ydoc.transact(() => writeObject(ydoc, element));
	}

	ydoc.destroy();
	return { version: 2, entries, index: buildTimelapseIndex(entries) };
}

function writeLayer(ydoc: Y.Doc, layer: Layer): void {
	const yLayer = new Y.Map<unknown>();
	yLayer.set("id", layer.id);
	yLayer.set("name", layer.name);
	yLayer.set("visible", layer.visible);
	yLayer.set("locked", layer.locked);
	yLayer.set("opacity", layer.opacity);
	yLayer.set("blendMode", layer.blendMode);
	const yElementIds = new Y.Array<string>();
	yElementIds.push([...layer.elementIds]);
	yLayer.set("elementIds", yElementIds);
	ydoc.getArray<Y.Map<unknown>>("layers").push([yLayer]);
}

function writeObject(ydoc: Y.Doc, element: AnyArtObject): void {
	const yMap = new Y.Map<unknown>();
	for (const [key, value] of Object.entries(objectToStoredFields(element))) {
		yMap.set(key, value);
	}
	ydoc.getMap<Y.Map<unknown>>("objects").set(element.id, yMap);
}

/** Single horizontal black stroke through world origin, 24 units wide. */
function strokeDoc(): Document {
	const path: Path = {
		id: "replay-stroke",
		type: "path",
		opacity: 1,
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
				uid: "replay-stroke-appearance",
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

	const document = createDefaultDocument("timelapse-replay");
	const layer = createDefaultLayer("timelapse-replay-layer", "Strokes");
	layer.elementIds.push(path.id);
	document.objects[path.id] = path;
	document.layers.push(layer);
	document.artboards.push(
		createArtboard("timelapse-replay-ab", "Main", 0, 0, 800, 600),
	);
	return document;
}
