import { describe, expect, it } from "vitest";
import * as Y from "yjs";
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
	renderArtboardForTest,
} from "../testUtils/visualRegression";
import { calculateElementBounds } from "../utils/geometry/bounds";
import { TimelapsePlayer } from "./TimelapsePlayer";
import { TimelapseRecorder } from "./TimelapseRecorder";
import type { TimelapseChangeSet } from "./timelapseIndex";

/**
 * End to end: create a document, draw into it, then play the recording back.
 *
 * The recording has to come out of a real YjsProvider. A hand-written Y.Doc
 * proves nothing — it skips the write path, the delta observers and the
 * ordering between them, which is where playback actually broke.
 */
describe("Timelapse end to end", () => {
	it("should replay a drawing session back to the picture it recorded", async () => {
		const session = startSession();
		session.addArtboard(createArtboard("ab", "Main", 0, 0, 800, 600));
		session.draw(strokePath("stroke-1", -150, 0, 150, 0));
		session.draw(strokePath("stroke-2", 0, -100, 0, 100));

		const live = session.document();
		const replayed = replayToEnd(session.recording(), live.artboards[0]);

		const { renderer } = await createTestRenderer();
		const device = renderer.getDevice();
		if (!device) throw new Error("Test renderer has no GPU device");

		const livePixels = await renderPixels(renderer, device, live);
		const replayedPixels = await renderPixels(renderer, device, {
			...replayed,
			// The replay carries its own cache-scope id; framing must use the
			// artboard the session actually drew into.
			artboards: live.artboards,
		});

		expect(countInk(livePixels)).toBeGreaterThan(0);
		expectSameImage(replayedPixels, livePixels);
	});

	it("should replay a session whose artboard is created after the drawing", async () => {
		const session = startSession();
		session.draw(strokePath("stroke-1", -150, 0, 150, 0));
		session.addArtboard(createArtboard("ab", "Main", 0, 0, 800, 600));

		const live = session.document();
		const replayed = replayToEnd(session.recording(), live.artboards[0]);

		const { renderer } = await createTestRenderer();
		const device = renderer.getDevice();
		if (!device) throw new Error("Test renderer has no GPU device");

		const livePixels = await renderPixels(renderer, device, live);
		const replayedPixels = await renderPixels(renderer, device, {
			...replayed,
			artboards: live.artboards,
		});

		expect(countInk(livePixels)).toBeGreaterThan(0);
		expectSameImage(replayedPixels, livePixels);
	});

	it("should keep every entry when the whole drawing is inside the artboard", () => {
		const session = startSession();
		session.addArtboard(createArtboard("ab", "Main", 0, 0, 800, 600));
		session.draw(strokePath("stroke-1", -150, 0, 150, 0));

		const recording = session.recording();
		const player = createPlayer(recording, session.document().artboards[0]);

		expect(player.totalEvents).toBe(recording.entries.length);
	});

	it("should replay a session that started by switching documents", async () => {
		const session = startSession();
		session.addArtboard(createArtboard("old", "Old", 0, 0, 800, 600));
		session.draw(strokePath("old-stroke", -300, -200, 300, 200));

		// Everything above belongs to the document being left behind.
		const incoming = createDefaultDocument("timelapse-switched");
		incoming.artboards.push(createArtboard("ab", "Main", 0, 0, 800, 600));
		session.switchTo(incoming);

		session.draw(strokePath("stroke-1", -150, 0, 150, 0));
		session.draw(strokePath("stroke-2", 0, -100, 0, 100));

		const live = session.document();
		const replayed = replayToEnd(session.recording(), live.artboards[0]);

		// Structure first: it says whether a mismatch is the document or the draw.
		expect(Object.keys(replayed.objects).sort()).toEqual(
			Object.keys(live.objects).sort(),
		);
		expect(replayed.layers.map((layer) => layer.elementIds)).toEqual(
			live.layers.map((layer) => layer.elementIds),
		);

		const { renderer } = await createTestRenderer();
		const device = renderer.getDevice();
		if (!device) throw new Error("Test renderer has no GPU device");

		const livePixels = await renderPixels(renderer, device, live);
		const replayedPixels = await renderPixels(renderer, device, {
			...replayed,
			artboards: live.artboards,
		});

		expect(countInk(livePixels)).toBeGreaterThan(0);
		expectSameImage(replayedPixels, livePixels);
	});

	it("should draw a stroke on across frames instead of popping it in", async () => {
		const session = startSession();
		session.addArtboard(createArtboard("ab", "Main", 0, 0, 800, 600));
		session.draw(
			polylinePath(
				"long-stroke",
				Array.from({ length: 12 }, (_, i) => ({
					x: -330 + i * 60,
					y: i % 2 === 0 ? -120 : 120,
				})),
			),
		);

		const live = session.document();
		const player = createPlayer(session.recording(), live.artboards[0]);

		const { renderer } = await createTestRenderer();
		const device = renderer.getDevice();
		if (!device) throw new Error("Test renderer has no GPU device");

		// Walk the export's frame clock and measure how much of the stroke is
		// down on each frame it produces.
		const frameDurationMs = 1000 / 30;
		player.restart();
		const inkPerFrame: number[] = [];
		const segmentsPerFrame: number[] = [];
		while (!player.hasFinished) {
			const frame = player.advanceBy(frameDurationMs);
			if (!frame) continue;
			const drawn = frame.objects["long-stroke"];
			segmentsPerFrame.push(drawn?.type === "path" ? drawn.segments.length : 0);
			inkPerFrame.push(
				countInk(
					await renderPixels(renderer, device, {
						...frame,
						artboards: live.artboards,
					}),
				),
			);
		}

		// Isolates the player from the renderer: if the segment counts ramp but
		// the ink does not, the frames are right and the drawing is not.
		expect(
			segmentsPerFrame.filter((count) => count > 0 && count < 11).length,
			`segments per frame: ${segmentsPerFrame.join(", ")}`,
		).toBeGreaterThan(0);

		const finished = inkPerFrame.at(-1) ?? 0;
		expect(finished).toBeGreaterThan(0);
		// A frame showing part of the stroke is what makes it a timelapse.
		expect(
			inkPerFrame.filter((ink) => ink > 0 && ink < finished).length,
			inkPerFrame
				.map((ink, i) => `${segmentsPerFrame[i]}seg=${ink}`)
				.join(", "),
		).toBeGreaterThan(0);
	});

	it("should draw less of a stroke when it has fewer segments", async () => {
		// The draw-on animation is nothing but a shortened segment list, so this
		// is the property it rests on.
		const points = Array.from({ length: 12 }, (_, i) => ({
			x: -330 + i * 60,
			y: i % 2 === 0 ? -120 : 120,
		}));
		const full = documentWith(polylinePath("s", points));
		const partial = documentWith(polylinePath("s", points.slice(0, 3)));

		const { renderer } = await createTestRenderer();
		const device = renderer.getDevice();
		if (!device) throw new Error("Test renderer has no GPU device");

		const fullInk = countInk(await renderPixels(renderer, device, full));
		const partialInk = countInk(await renderPixels(renderer, device, partial));

		expect(fullInk).toBeGreaterThan(0);
		expect(partialInk).toBeGreaterThan(0);
		expect(partialInk).toBeLessThan(fullInk);
	});

	it("should start over when the incoming document carries its own recording", async () => {
		// A recording made elsewhere, as a loaded .papf would carry. It cannot be
		// continued: its items and the items the switch creates are different
		// objects, so replaying both in a row duplicates every layer.
		const earlier = startSession();
		earlier.addArtboard(createArtboard("ab", "Main", 0, 0, 800, 600));
		earlier.draw(strokePath("earlier-stroke", -300, -150, 300, 150));
		const carried = earlier.recording();
		const carriedDocument = earlier.document();

		const session = startSession();
		session.switchTo({ ...carriedDocument, timelapse: carried });
		session.draw(strokePath("stroke-1", -150, 0, 150, 0));

		// The baseline plus the one stroke drawn after the switch.
		expect(session.recording().entries).toHaveLength(2);

		const live = session.document();
		const recording = session.recording();
		const replayed = replayToEnd(recording, live.artboards[0]);

		expect(Object.keys(replayed.objects).sort()).toEqual(
			Object.keys(live.objects).sort(),
		);
		expect(replayed.layers.map((layer) => layer.elementIds)).toEqual(
			live.layers.map((layer) => layer.elementIds),
		);

		const { renderer } = await createTestRenderer();
		const device = renderer.getDevice();
		if (!device) throw new Error("Test renderer has no GPU device");

		const livePixels = await renderPixels(renderer, device, live);
		const replayedPixels = await renderPixels(renderer, device, {
			...replayed,
			artboards: live.artboards,
		});

		expect(countInk(livePixels)).toBeGreaterThan(0);
		expectSameImage(replayedPixels, livePixels);
	});
});

/**
 * A document being edited through the real Yjs write path, with the timelapse
 * recorder wired up exactly the way Paplico wires it.
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

	// Registered after the provider's own update listener, as Paplico does.
	provider.ydoc.on("update", (update: Uint8Array) => {
		const changes = pendingChanges;
		pendingChanges = null;
		recorder.onYjsUpdate(update, changes);
	});

	provider.initializeDocument(createDefaultDocument("timelapse-e2e"));

	return {
		draw: (element: Path) => provider.addElement("layer-0", element),
		addArtboard: (artboard: Artboard) => provider.addArtboard(artboard),
		/** Same order as Paplico.importDocument. */
		switchTo: (incoming: Document) => {
			provider.replaceDocument(incoming);
			recorder.restartFrom(Y.encodeStateAsUpdate(provider.ydoc));
			recorder.seedBounds(Object.keys(incoming.objects));
		},
		document: () => extractLiveDocument(provider),
		recording: () => {
			const data = recorder.getTimelapseData();
			if (!data) throw new Error("The session recorded nothing");
			return data;
		},
	};
}

function extractLiveDocument(provider: YjsProvider): Document {
	// The provider is the source of truth here; read it back the same way the
	// app does after a full sync.
	return extractDocumentFromYDoc(provider.ydoc);
}

function createPlayer(
	data: ReturnType<TimelapseRecorder["getTimelapseData"]> & object,
	artboard: Artboard,
): TimelapsePlayer {
	return new TimelapsePlayer(
		data,
		{
			onFrame: () => {},
			onStateChange: () => {},
			getCompletedDocument: () => ({}) as Document,
		},
		artboard,
	);
}

function replayToEnd(
	data: ReturnType<TimelapseRecorder["getTimelapseData"]> & object,
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

async function renderPixels(
	renderer: Awaited<ReturnType<typeof createTestRenderer>>["renderer"],
	device: GPUDevice,
	document: Document,
): Promise<Uint8Array> {
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
	texture.destroy();
	return pixels;
}

/** Pixels darker than the white background, i.e. drawn on. */
function countInk(pixels: Uint8Array): number {
	let count = 0;
	for (let i = 0; i < pixels.length; i += 4) {
		if (pixels[i] < 128) count++;
	}
	return count;
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

/** A one-layer document holding a single element, framed by one artboard. */
function documentWith(element: Path): Document {
	const document = createDefaultDocument("segment-count-probe");
	document.objects[element.id] = element;
	document.layers[0].elementIds.push(element.id);
	document.artboards.push(createArtboard("ab", "Main", 0, 0, 800, 600));
	return document;
}

/** Black polyline through the given points, one segment per leg. */
function polylinePath(id: string, points: { x: number; y: number }[]): Path {
	const stroke = strokePath(id, 0, 0, 0, 0);
	return {
		...stroke,
		segments: points.slice(0, -1).map((start, i) => ({
			start: i === 0 ? start : undefined,
			end: points[i + 1],
			cp1: { x: 0, y: 0 },
			cp2: { x: 0, y: 0 },
			startPressure: 1,
			endPressure: 1,
			startTiltX: 0,
			startTiltY: 0,
			endTiltX: 0,
			endTiltY: 0,
			startDeltaTime: 0,
			endDeltaTime: 0,
			isMoved: i === 0,
		})),
	};
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
