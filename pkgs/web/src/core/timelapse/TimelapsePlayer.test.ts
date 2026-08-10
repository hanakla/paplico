import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { objectToStoredFields } from "../collaboration/YjsProvider";
import { createIdentityTransform } from "../document/factory";
import type { AnyArtObject, Artboard, Document, Path } from "../schema";
import { TimelapsePlayer } from "./TimelapsePlayer";
import { buildTimelapseIndex } from "./timelapseIndex";
import type { TimelapseData, TimelapseEntry } from "./types";

describe("TimelapsePlayer", () => {
	const artboard: Artboard = {
		id: "artboard-1",
		name: "Artboard 1",
		x: 0,
		y: 0,
		width: 1000,
		height: 1000,
	};

	it("should keep every entry that draws inside the artboard", () => {
		const { data } = buildRecording([
			(doc) => {
				setLayer(doc, "layer-1", []);
				setArtboard(doc, artboard);
			},
			(doc) => addPath(doc, "layer-1", squarePath("a", 0, 0)),
			(doc) => addPath(doc, "layer-1", squarePath("b", 100, 100)),
		]);

		const { player } = createPlayer(data, artboard);

		expect(player.totalEvents).toBe(data.entries.length);
	});

	it("should hand the first step a document containing the drawn path", () => {
		const { data } = buildRecording([
			(doc) => {
				setLayer(doc, "layer-1", []);
				setArtboard(doc, artboard);
			},
			(doc) => addPath(doc, "layer-1", squarePath("a", 0, 0)),
		]);

		const { player, onFrame } = createPlayer(data, artboard);
		player.seekTo(player.totalEvents - 1);

		const document = lastFrame(onFrame);
		expect(Object.keys(document.objects)).toContain("a");
		expect(document.layers[0]?.elementIds).toContain("a");
	});

	it("should reach the same document as a plain replay after stepping through", () => {
		const { data, finalDoc } = buildRecording([
			(doc) => {
				setLayer(doc, "layer-1", []);
				setArtboard(doc, artboard);
			},
			(doc) => addPath(doc, "layer-1", squarePath("a", 0, 0)),
			(doc) => addPath(doc, "layer-1", squarePath("b", 200, 200)),
			(doc) => addPath(doc, "layer-1", squarePath("c", -200, -200)),
		]);

		const { player, onFrame } = createPlayer(data, artboard);
		for (let i = 0; i < player.totalEvents; i++) player.seekTo(i);

		const document = lastFrame(onFrame);
		expect(Object.keys(document.objects).sort()).toEqual(
			Object.keys(finalDoc.objects).sort(),
		);
		expect(document.layers[0]?.elementIds).toEqual(
			finalDoc.layers[0]?.elementIds,
		);
	});

	it("should drop entries that draw outside the artboard", () => {
		const { data } = buildRecording([
			(doc) => {
				setLayer(doc, "layer-1", []);
				setArtboard(doc, artboard);
			},
			(doc) => addPath(doc, "layer-1", squarePath("inside", 0, 0)),
			(doc) => addPath(doc, "layer-1", squarePath("far", 90_000, 90_000)),
		]);

		const { player } = createPlayer(data, artboard);

		expect(player.totalEvents).toBe(data.entries.length - 1);
	});

	it("should still apply skipped entries so later frames stay complete", () => {
		const { data } = buildRecording([
			(doc) => {
				setLayer(doc, "layer-1", []);
				setArtboard(doc, artboard);
			},
			(doc) => addPath(doc, "layer-1", squarePath("far", 90_000, 90_000)),
			(doc) => addPath(doc, "layer-1", squarePath("inside", 0, 0)),
		]);

		const { player, onFrame } = createPlayer(data, artboard);
		player.seekTo(player.totalEvents - 1);

		const document = lastFrame(onFrame);
		expect(Object.keys(document.objects).sort()).toEqual(["far", "inside"]);
	});
});

function createPlayer(data: TimelapseData, filterArtboard: Artboard) {
	const onFrame = vi.fn<(document: Document) => void>();
	const player = new TimelapsePlayer(
		data,
		{
			onFrame,
			onStateChange: vi.fn(),
			getCompletedDocument: () => ({}) as Document,
		},
		filterArtboard,
	);
	return { player, onFrame };
}

function lastFrame(onFrame: { mock: { calls: unknown[][] } }): Document {
	const call = onFrame.mock.calls.at(-1);
	if (!call) throw new Error("onFrame was never called");
	return call[0] as Document;
}

/** Run each mutation in its own transaction and capture the resulting update. */
function buildRecording(mutations: ((doc: Y.Doc) => void)[]): {
	data: TimelapseData;
	finalDoc: Document;
} {
	const doc = new Y.Doc();
	const entries: TimelapseEntry[] = [];
	doc.on("update", (update: Uint8Array) => {
		entries.push({ t: entries.length * 100, u: update });
	});

	for (const mutate of mutations) doc.transact(() => mutate(doc));

	const finalDoc = {
		objects: Object.fromEntries(
			[...doc.getMap<Y.Map<unknown>>("objects").entries()].map(([id]) => [
				id,
				null,
			]),
		),
		layers: [
			{
				elementIds: (
					doc
						.getArray<Y.Map<unknown>>("layers")
						.get(0)
						?.get("elementIds") as Y.Array<string>
				).toArray(),
			},
		],
	} as unknown as Document;

	return {
		data: { version: 2, entries, index: buildTimelapseIndex(entries) },
		finalDoc,
	};
}

function setLayer(doc: Y.Doc, id: string, elementIds: string[]): void {
	const yLayer = new Y.Map<unknown>();
	yLayer.set("id", id);
	yLayer.set("name", id);
	yLayer.set("visible", true);
	yLayer.set("locked", false);
	yLayer.set("opacity", 1);
	yLayer.set("blendMode", "normal");
	const yElementIds = new Y.Array<string>();
	yElementIds.push(elementIds);
	yLayer.set("elementIds", yElementIds);
	doc.getArray<Y.Map<unknown>>("layers").push([yLayer]);
}

function setArtboard(doc: Y.Doc, artboard: Artboard): void {
	doc.getArray<Artboard>("artboards").push([artboard]);
}

function addPath(doc: Y.Doc, layerId: string, element: AnyArtObject): void {
	const yMap = new Y.Map<unknown>();
	for (const [key, value] of Object.entries(objectToStoredFields(element))) {
		yMap.set(key, value);
	}
	doc.getMap<Y.Map<unknown>>("objects").set(element.id, yMap);

	const yLayers = doc.getArray<Y.Map<unknown>>("layers");
	for (let i = 0; i < yLayers.length; i++) {
		const yLayer = yLayers.get(i);
		if (yLayer?.get("id") !== layerId) continue;
		(yLayer.get("elementIds") as Y.Array<string>).push([element.id]);
	}
}

/** A 10x10 axis-aligned square whose top-left sits at (x, y). */
function squarePath(id: string, x: number, y: number): Path {
	const corners = [
		{ x, y },
		{ x: x + 10, y },
		{ x: x + 10, y: y + 10 },
		{ x, y: y + 10 },
	];

	return {
		id,
		type: "path",
		segments: corners.map((_, i) => ({
			start: i === 0 ? corners[0] : undefined,
			end: corners[(i + 1) % corners.length],
			cp1: { x: 0, y: 0 },
			cp2: { x: 0, y: 0 },
			startTiltX: 0,
			startTiltY: 0,
			endTiltX: 0,
			endTiltY: 0,
			startDeltaTime: 0,
			endDeltaTime: 0,
			isMoved: i === 0,
		})),
		opacity: 1,
		blendMode: "normal",
		transform: createIdentityTransform(),
	};
}
