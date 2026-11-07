import { encode } from "cbor-x";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { objectToStoredFields } from "../collaboration/YjsProvider";
import { createIdentityTransform } from "../document/factory";
import { compressDeflate } from "../io/binaryUtils";
import { LATEST_SCHEMA_VERSION } from "../io/migrations";
import { migSplitStrokeErasure } from "../io/migrations/20260925_mig_split_stroke_erasure";
import { migTransformOrigin } from "../io/migrations/20260929_mig_transform_origin";
import { decodeTimelapseBlock } from "../io/papf/reader";
import { Codec } from "../io/papf/types";
import {
	type AnyArtObject,
	type Artboard,
	type Document,
	getTransform,
	type Path,
} from "../schema";
import { legacyPlace } from "../testUtils/legacyPlacement";
import {
	applyTransformToPoint,
	composeTransforms,
} from "../utils/geometry/space/coordinates";
import { TimelapsePlayer } from "./TimelapsePlayer";
import { buildTimelapseIndex } from "./timelapseIndex";
import type {
	TimelapseData,
	TimelapseEntry,
	TimelapseFrame,
	TimelapsePackedBlock,
} from "./types";

// Spied on to see which packed blocks playback expands, and when.
vi.mock("../io/papf/reader", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../io/papf/reader")>();
	return {
		...actual,
		decodeTimelapseBlock: vi.fn(actual.decodeTimelapseBlock),
	};
});

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
			(doc) => addElement(doc, "layer-1", squarePath("a", 0, 0)),
			(doc) => addElement(doc, "layer-1", squarePath("b", 100, 100)),
		]);

		const { player } = createPlayer(data, artboard);

		expect(player.totalEvents).toBe(data.entries.length);
	});

	it("should hand the first step a document containing the drawn path", async () => {
		const { data } = buildRecording([
			(doc) => {
				setLayer(doc, "layer-1", []);
				setArtboard(doc, artboard);
			},
			(doc) => addElement(doc, "layer-1", squarePath("a", 0, 0)),
		]);

		const { player, onFrame } = createPlayer(data, artboard);
		await player.seekTo(player.totalEvents - 1);

		const document = lastFrame(onFrame);
		expect(Object.keys(document.objects)).toContain("a");
		expect(document.layers[0]?.elementIds).toContain("a");
	});

	it("should reach the same document as a plain replay after stepping through", async () => {
		const { data, finalDoc } = buildRecording([
			(doc) => {
				setLayer(doc, "layer-1", []);
				setArtboard(doc, artboard);
			},
			(doc) => addElement(doc, "layer-1", squarePath("a", 0, 0)),
			(doc) => addElement(doc, "layer-1", squarePath("b", 200, 200)),
			(doc) => addElement(doc, "layer-1", squarePath("c", -200, -200)),
		]);

		const { player, onFrame } = createPlayer(data, artboard);
		for (let i = 0; i < player.totalEvents; i++) await player.seekTo(i);

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
			(doc) => addElement(doc, "layer-1", squarePath("inside", 0, 0)),
			(doc) => addElement(doc, "layer-1", squarePath("far", 90_000, 90_000)),
		]);

		const { player } = createPlayer(data, artboard);

		expect(player.totalEvents).toBe(data.entries.length - 1);
	});

	it("should still apply skipped entries so later frames stay complete", async () => {
		const { data } = buildRecording([
			(doc) => {
				setLayer(doc, "layer-1", []);
				setArtboard(doc, artboard);
			},
			(doc) => addElement(doc, "layer-1", squarePath("far", 90_000, 90_000)),
			(doc) => addElement(doc, "layer-1", squarePath("inside", 0, 0)),
		]);

		const { player, onFrame } = createPlayer(data, artboard);
		await player.seekTo(player.totalEvents - 1);

		const document = lastFrame(onFrame);
		expect(Object.keys(document.objects).sort()).toEqual(["far", "inside"]);
	});

	it("should show a path that undo brought back after editing and deleting it", async () => {
		const original = squarePath("a", 0, 0);
		let undoManager: Y.UndoManager | undefined;
		const { data } = buildRecording([
			(doc) => {
				setLayer(doc, "layer-1", []);
				setArtboard(doc, artboard);
				addElement(doc, "layer-1", original);
				undoManager = new Y.UndoManager(doc.getMap("objects"), {
					captureTimeout: 0,
				});
			},
			(doc) => {
				const yObjects = doc.getMap<Y.Map<unknown>>("objects");
				yObjects.get("a")?.set("segments", "[]");
				yObjects.delete("a");
			},
			() => undoManager?.undo(),
		]);

		const { player, onFrame } = createPlayer(data, artboard);
		await player.seekTo(player.totalEvents - 1);

		const path = lastFrame(onFrame).objects.a as Path;
		expect(path.segments).toEqual(original.segments);
	});

	it("should replay a path recorded with its segments and stroke widths as JSON", async () => {
		const recorded: Path = {
			...squarePath("a", 0, 0),
			strokeWidths: [{ t: 0.5, side1: 1, side2: 0.5 }],
		};
		const { data } = buildRecording([
			(doc) => {
				setLayer(doc, "layer-1", []);
				setArtboard(doc, artboard);
			},
			(doc) => {
				addElement(doc, "layer-1", recorded);
				const yPath = doc.getMap<Y.Map<unknown>>("objects").get("a");
				yPath?.set("segments", JSON.stringify(recorded.segments));
				yPath?.set("strokeWidths", JSON.stringify(recorded.strokeWidths));
			},
		]);

		const { player, onFrame } = createPlayer(data, artboard);
		await player.seekTo(player.totalEvents - 1);

		const path = lastFrame(onFrame).objects.a as Path;
		expect(path.segments).toEqual(recorded.segments);
		expect(path.strokeWidths).toEqual(recorded.strokeWidths);
	});

	it("should keep playing past an object that cannot be decoded", async () => {
		const { data } = buildRecording([
			(doc) => {
				setLayer(doc, "layer-1", []);
				setArtboard(doc, artboard);
			},
			(doc) => addElement(doc, "layer-1", squarePath("a", 0, 0)),
			(doc) =>
				doc.getMap<Y.Map<unknown>>("objects").get("a")?.delete("segments"),
			(doc) => addElement(doc, "layer-1", squarePath("b", 100, 100)),
		]);

		const { player, onFrame } = createPlayer(data, artboard);
		await player.seekTo(player.totalEvents - 1);

		expect(Object.keys(lastFrame(onFrame).objects)).toEqual(["b"]);
	});

	describe("when playing on the export clock", () => {
		it("should report every element as possibly changed on a restart", async () => {
			const { data } = buildRecording([
				(doc) => {
					setLayer(doc, "layer-1", []);
					setArtboard(doc, artboard);
				},
				(doc) => addElement(doc, "layer-1", squarePath("a", 0, 0)),
			]);

			const { player } = createPlayer(data, artboard);

			expect((await player.restart()).changedElements).toBeUndefined();
		});

		it("should report only the newly drawn path as changed", async () => {
			const { data } = buildRecording([
				(doc) => {
					setLayer(doc, "layer-1", []);
					setArtboard(doc, artboard);
				},
				(doc) => addElement(doc, "layer-1", squarePath("a", 0, 0)),
				(doc) => addElement(doc, "layer-1", squarePath("b", 100, 100)),
			]);

			const { player } = createPlayer(data, artboard);
			await player.restart();
			const frames = await playToEnd(player);

			const firstWithB = frames.find((frame) => frame.document.objects.b);
			expect([...(firstWithB?.changedElements?.upserted ?? [])]).toEqual(["b"]);
		});

		it("should report the drawn-on path on every frame of its animation and the one after", async () => {
			const { data } = buildRecording([
				(doc) => {
					setLayer(doc, "layer-1", []);
					setArtboard(doc, artboard);
				},
				(doc) => addElement(doc, "layer-1", squarePath("a", 0, 0)),
			]);

			const { player } = createPlayer(data, artboard);
			await player.restart();
			const frames = (await playToEnd(player)).filter(
				(frame) => frame.document.objects.a,
			);

			expect(frames.length).toBeGreaterThan(1);
			for (const frame of frames) {
				expect(frame.changedElements?.upserted.has("a")).toBe(true);
			}
		});

		it("should report a removed path as deleted", async () => {
			const { data } = buildRecording([
				(doc) => {
					setLayer(doc, "layer-1", []);
					setArtboard(doc, artboard);
				},
				(doc) => addElement(doc, "layer-1", squarePath("a", 0, 0)),
				(doc) => {
					doc.getMap("objects").delete("a");
					const yElementIds = doc
						.getArray<Y.Map<unknown>>("layers")
						.get(0)
						?.get("elementIds") as Y.Array<string>;
					yElementIds.delete(0, 1);
				},
			]);

			const { player } = createPlayer(data, artboard);
			await player.restart();
			const lastFrame = (await playToEnd(player)).at(-1);

			expect(lastFrame?.document.objects.a).toBeUndefined();
			expect(lastFrame?.changedElements?.deleted.has("a")).toBe(true);
			expect(lastFrame?.changedElements?.upserted.has("a")).toBe(false);
		});
	});

	describe("when skipping through the recording without frames", () => {
		function recordTwoPaths(): TimelapseData {
			return buildRecording([
				(doc) => {
					setLayer(doc, "layer-1", []);
					setArtboard(doc, artboard);
				},
				(doc) => addElement(doc, "layer-1", squarePath("a", 0, 0)),
				(doc) => addElement(doc, "layer-1", squarePath("b", 100, 100)),
			]).data;
		}

		it("should take as many steps to finish as playing every frame", async () => {
			const data = recordTwoPaths();

			const played = await stepsToEnd(data, artboard, (player) =>
				player.advanceBy(1000 / 30),
			);
			const skipped = await stepsToEnd(data, artboard, (player) =>
				player.skipBy(1000 / 30),
			);

			// More steps than entries: each path's draw-on takes steps of its own.
			expect(played).toBeGreaterThan(data.entries.length);
			expect(skipped).toBe(played);
		});

		it("should take as many steps on a recording made by an older build", async () => {
			const data = {
				...recordTwoPaths(),
				schemaVersions: [{ at: 0, version: migTransformOrigin.version - 1 }],
			};

			const played = await stepsToEnd(data, artboard, (player) =>
				player.advanceBy(1000 / 30),
			);
			const skipped = await stepsToEnd(data, artboard, (player) =>
				player.skipBy(1000 / 30),
			);

			expect(skipped).toBe(played);
		});

		it("should show everything skipped over on the next frame", async () => {
			const { player, onFrame } = createPlayer(recordTwoPaths(), artboard);
			await player.restart();
			while (!player.hasFinished) await player.skipBy(1000 / 30);

			await player.seekTo(player.totalEvents - 1);

			expect(Object.keys(lastFrame(onFrame).objects).sort()).toEqual([
				"a",
				"b",
			]);
		});
	});

	describe("when the recording was made by an older build", () => {
		const eraserCut = [{ t: 0.5, side1: 0, side2: 1 }];
		const recordedBeforeSplit = migSplitStrokeErasure.version - 1;

		function recordErasedPath(schemaVersion: number): TimelapseData {
			const { data } = buildRecording([
				(doc) => {
					setLayer(doc, "layer-1", []);
					setArtboard(doc, artboard);
				},
				(doc) =>
					addElement(doc, "layer-1", {
						...squarePath("a", 0, 0),
						strokeWidths: eraserCut,
					}),
			]);
			return { ...data, schemaVersions: [{ at: 0, version: schemaVersion }] };
		}

		it("should show the eraser cut as an erasure when seeking straight to it", async () => {
			const { player, onFrame } = createPlayer(
				recordErasedPath(recordedBeforeSplit),
				artboard,
			);
			await player.seekTo(player.totalEvents - 1);

			const path = lastFrame(onFrame).objects.a as Path;
			expect(path.strokeErasure).toEqual(eraserCut);
			expect(path.strokeWidths).toBeUndefined();
		});

		it("should show the eraser cut as an erasure when stepping onto it", async () => {
			const { player, onFrame } = createPlayer(
				recordErasedPath(recordedBeforeSplit),
				artboard,
			);
			for (let i = 0; i < player.totalEvents; i++) await player.seekTo(i);

			const path = lastFrame(onFrame).objects.a as Path;
			expect(path.strokeErasure).toEqual(eraserCut);
			expect(path.strokeWidths).toBeUndefined();
		});

		it("should keep a width profile recorded by the current build", async () => {
			const { player, onFrame } = createPlayer(
				recordErasedPath(LATEST_SCHEMA_VERSION),
				artboard,
			);
			for (let i = 0; i < player.totalEvents; i++) await player.seekTo(i);

			const path = lastFrame(onFrame).objects.a as Path;
			expect(path.strokeWidths).toEqual(eraserCut);
			expect(path.strokeErasure).toBeUndefined();
		});

		it("should draw a new path where the migrated frame puts it under a turned group", async () => {
			// The path arrives after its group, so its draw-on starts from the
			// frame that migrated it together with the group.
			const turned = { ...createIdentityTransform(), rotation: 0.5 };
			const { data } = buildRecording([
				(doc) => {
					setLayer(doc, "layer-1", []);
					setArtboard(doc, artboard);
				},
				(doc) =>
					addElement(doc, "layer-1", {
						type: "group",
						id: "g",
						childIds: ["a"],
						opacity: 1,
						blendMode: "normal",
						transform: turned,
					}),
				(doc) => setObject(doc, squarePath("a", 100, 0)),
			]);
			const { player, onFrame } = createPlayer(
				{
					...data,
					schemaVersions: [{ at: 0, version: migTransformOrigin.version - 1 }],
				},
				artboard,
			);
			for (let i = 0; i < player.totalEvents; i++) await player.seekTo(i);

			const { objects } = lastFrame(onFrame);
			const placed = composeTransforms(turned, getTransform(objects.a));
			const before = legacyPlace({ x: 100, y: 0 }, turned, { x: 105, y: 5 });
			const after = applyTransformToPoint(100, 0, placed);
			expect(after.x).toBeCloseTo(before.x);
			expect(after.y).toBeCloseTo(before.y);
		});

		it("should migrate a group with its children in view when stepping onto it", async () => {
			// The transform origin migration places a turned group's children
			// where the group drew them, which it can only do with both in hand.
			const turned = { ...createIdentityTransform(), rotation: 0.5 };
			const child = squarePath("a", 100, 0);
			const { data } = buildRecording([
				(doc) => {
					setLayer(doc, "layer-1", []);
					setArtboard(doc, artboard);
				},
				(doc) => setObject(doc, child),
				(doc) =>
					addElement(doc, "layer-1", {
						type: "group",
						id: "g",
						childIds: ["a"],
						opacity: 1,
						blendMode: "normal",
						transform: turned,
					}),
			]);
			const { player, onFrame } = createPlayer(
				{
					...data,
					schemaVersions: [{ at: 0, version: migTransformOrigin.version - 1 }],
				},
				artboard,
			);
			for (let i = 0; i < player.totalEvents; i++) await player.seekTo(i);

			const { objects } = lastFrame(onFrame);
			expect(getTransform(objects.g)).toEqual(turned);
			// Before this version the group turned the child around the child's
			// own centre.
			const placed = composeTransforms(turned, getTransform(objects.a));
			for (const corner of [
				{ x: 100, y: 0 },
				{ x: 110, y: 10 },
			]) {
				const before = legacyPlace(corner, turned, { x: 105, y: 5 });
				const after = applyTransformToPoint(corner.x, corner.y, placed);
				expect(after.x).toBeCloseTo(before.x);
				expect(after.y).toBeCloseTo(before.y);
			}
		});
	});

	describe("when most of the recording is still packed", () => {
		const pathIds = ["a", "b", "c", "d", "e", "f"];

		/** Seven entries: three packed blocks of two, then one expanded entry. */
		function recordPaths(): TimelapseData {
			return buildRecording([
				(doc) => {
					setLayer(doc, "layer-1", []);
					setArtboard(doc, artboard);
				},
				...pathIds.map(
					(id, i) => (doc: Y.Doc) =>
						addElement(doc, "layer-1", squarePath(id, i * 20, 0)),
				),
			]).data;
		}

		beforeEach(() => {
			vi.mocked(decodeTimelapseBlock).mockClear();
		});

		it("should show the whole drawing after seeking to the end", async () => {
			const { player, onFrame } = createPlayer(
				await packEntries(recordPaths(), 2),
				artboard,
			);

			await player.seekTo(player.totalEvents - 1);

			expect(Object.keys(lastFrame(onFrame).objects).sort()).toEqual(pathIds);
		});

		it("should show the drawing of that moment after seeking back into an earlier block", async () => {
			const { player, onFrame } = createPlayer(
				await packEntries(recordPaths(), 2),
				artboard,
			);

			await player.seekTo(player.totalEvents - 1);
			await player.seekTo(2);

			expect(Object.keys(lastFrame(onFrame).objects).sort()).toEqual([
				"a",
				"b",
			]);
		});

		it("should play the same frames as the expanded recording", async () => {
			const data = recordPaths();
			const expanded = createPlayer(data, artboard).player;
			const packed = createPlayer(await packEntries(data, 2), artboard).player;
			await expanded.restart();
			await packed.restart();

			const expandedFrames = await playToEnd(expanded);
			const packedFrames = await playToEnd(packed);

			expect(packedFrames.map(({ document }) => document)).toEqual(
				expandedFrames.map(({ document }) => document),
			);
		});

		it("should expand a block only once playback enters it, and again after leaving it", async () => {
			const data = await packEntries(recordPaths(), 2);
			const { player } = createPlayer(data, artboard);
			const expandedBlocks = () =>
				vi
					.mocked(decodeTimelapseBlock)
					.mock.calls.map(([block]) => data.packedBlocks?.indexOf(block));

			await player.seekTo(1);
			expect(expandedBlocks()).toEqual([0]);

			await player.seekTo(5);
			expect(expandedBlocks()).toEqual([0, 1, 2]);

			await player.seekTo(1);
			expect(expandedBlocks()).toEqual([0, 1, 2, 0]);
		});

		it("should rebuild a missing index across the packed blocks", async () => {
			const data = await packEntries(recordPaths(), 2);
			const onIndexBuilt = vi.fn();

			new TimelapsePlayer(
				{ ...data, index: undefined },
				{
					onFrame: vi.fn(),
					onStateChange: vi.fn(),
					getCompletedDocument: () => ({}) as Document,
					onIndexBuilt,
				},
				artboard,
			);

			await vi.waitFor(() => expect(onIndexBuilt).toHaveBeenCalled());
			expect(onIndexBuilt.mock.calls[0][0].rects).toEqual(data.index?.rects);
		});
	});
});

function createPlayer(data: TimelapseData, filterArtboard: Artboard) {
	const onFrame = vi.fn<(frame: TimelapseFrame) => void>();
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
	return (call[0] as TimelapseFrame).document;
}

/** Advance on the 30fps export clock until playback ends, collecting every frame. */
async function playToEnd(player: TimelapsePlayer): Promise<TimelapseFrame[]> {
	const frames: TimelapseFrame[] = [];
	while (!player.hasFinished) {
		const frame = await player.advanceBy(1000 / 30);
		if (frame) frames.push(frame);
	}
	return frames;
}

/** How many times `step` runs before a restarted player reaches the end. */
async function stepsToEnd(
	data: TimelapseData,
	filterArtboard: Artboard,
	step: (player: TimelapsePlayer) => Promise<unknown>,
): Promise<number> {
	const { player } = createPlayer(data, filterArtboard);
	await player.restart();
	let steps = 0;
	while (!player.hasFinished) {
		await step(player);
		steps++;
	}
	return steps;
}

/**
 * Pack the recording's entries into blocks of `blockSize` the way a saved file
 * stores them, leaving the last block expanded as a read file does.
 */
async function packEntries(
	data: TimelapseData,
	blockSize: number,
): Promise<TimelapseData> {
	const packedCount =
		Math.ceil(data.entries.length / blockSize - 1) * blockSize;
	const packedBlocks: TimelapsePackedBlock[] = [];
	for (let start = 0; start < packedCount; start += blockSize) {
		const block = data.entries.slice(start, start + blockSize);
		packedBlocks.push({
			count: block.length,
			payload: await compressDeflate(encode(block)),
			codec: Codec.Deflate,
			rawBytes: null,
		});
	}
	return {
		...data,
		packedBlocks,
		entries: data.entries.slice(packedCount),
	};
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

function addElement(doc: Y.Doc, layerId: string, element: AnyArtObject): void {
	setObject(doc, element);

	const yLayers = doc.getArray<Y.Map<unknown>>("layers");
	for (let i = 0; i < yLayers.length; i++) {
		const yLayer = yLayers.get(i);
		if (yLayer?.get("id") !== layerId) continue;
		(yLayer.get("elementIds") as Y.Array<string>).push([element.id]);
	}
}

/** Store an element without listing it in any layer. */
function setObject(doc: Y.Doc, element: AnyArtObject): void {
	const yMap = new Y.Map<unknown>();
	for (const [key, value] of Object.entries(objectToStoredFields(element))) {
		yMap.set(key, value);
	}
	doc.getMap<Y.Map<unknown>>("objects").set(element.id, yMap);
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
