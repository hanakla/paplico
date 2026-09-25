import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdentityTransform } from "../document/factory";
import {
	InMemoryCollaboration,
	InMemoryRoom,
} from "../testUtils/InMemoryCollaboration";
import { extractDocumentFromYDoc } from "./extractDocumentFromYDoc";
import { YjsProvider, type YjsProviderCallbacks } from "./YjsProvider";

function createMockCallbacks(): YjsProviderCallbacks {
	return {
		onDocumentUpdate: vi.fn(),
		onLayersUpdate: vi.fn(),
		getCurrentLayerId: vi.fn(() => null),
		setCurrentLayerId: vi.fn(),
	};
}

const testLayer = {
	id: "layer-1",
	name: "Layer 1",
	visible: true,
	locked: false,
	opacity: 1,
	elementIds: [],
};

const testPath = {
	id: "path-1",
	type: "path" as const,
	segments: [],
	opacity: 1,
	blendMode: "normal" as const,
	transform: createIdentityTransform(),
};

describe("InMemoryCollaboration", () => {
	let room: InMemoryRoom;
	let provider1: YjsProvider;
	let provider2: YjsProvider;
	let collab1: InMemoryCollaboration;
	let collab2: InMemoryCollaboration;

	beforeEach(() => {
		room = new InMemoryRoom();
	});

	afterEach(() => {
		room.destroy();
	});

	function createPeer(opts?: {
		isOwner?: boolean;
		roomReadonly?: boolean;
		userName?: string;
	}) {
		const callbacks = createMockCallbacks();
		const provider = new YjsProvider({ callbacks });
		const collab = new InMemoryCollaboration(provider.ydoc, {
			room,
			isOwner: opts?.isOwner,
			roomReadonly: opts?.roomReadonly,
			user: opts?.userName ? { name: opts.userName } : undefined,
		});
		return { callbacks, provider, collab };
	}

	describe("Y.Doc synchronization", () => {
		it("should sync initial document state when a peer joins after data exists", () => {
			const peer1 = createPeer({ isOwner: true });
			provider1 = peer1.provider;
			collab1 = peer1.collab;

			provider1.addLayer(testLayer);
			provider1.addElement("layer-1", testPath);

			// Peer 2 joins after data already exists
			const peer2 = createPeer();
			provider2 = peer2.provider;
			collab2 = peer2.collab;

			const doc2 = extractDocumentFromYDoc(provider2.ydoc);
			expect(doc2.layers).toHaveLength(1);
			expect(doc2.layers[0].id).toBe("layer-1");
			expect(doc2.objects["path-1"]).toBeDefined();
			expect(doc2.objects["path-1"].type).toBe("path");
		});

		it("should propagate addElement from one peer to another", () => {
			const peer1 = createPeer({ isOwner: true });
			const peer2 = createPeer();
			provider1 = peer1.provider;
			provider2 = peer2.provider;
			collab1 = peer1.collab;
			collab2 = peer2.collab;

			provider1.addLayer(testLayer);
			provider1.addElement("layer-1", testPath);

			const doc2 = extractDocumentFromYDoc(provider2.ydoc);
			expect(doc2.objects["path-1"]).toBeDefined();
		});

		it("should propagate updateElement changes bidirectionally", () => {
			const peer1 = createPeer({ isOwner: true });
			const peer2 = createPeer();
			provider1 = peer1.provider;
			provider2 = peer2.provider;
			collab1 = peer1.collab;
			collab2 = peer2.collab;

			provider1.addLayer(testLayer);
			provider1.addElement("layer-1", testPath);

			// Peer 1 updates opacity
			provider1.updateElement("layer-1", "path-1", { opacity: 0.5 });
			const doc2 = extractDocumentFromYDoc(provider2.ydoc);
			expect(doc2.objects["path-1"].opacity).toBe(0.5);

			// Peer 2 updates blendMode
			provider2.updateElement("layer-1", "path-1", { blendMode: "multiply" });
			const doc1 = extractDocumentFromYDoc(provider1.ydoc);
			expect(doc1.objects["path-1"].blendMode).toBe("multiply");
		});

		it("should propagate deleteElement from one peer to another", () => {
			const peer1 = createPeer({ isOwner: true });
			const peer2 = createPeer();
			provider1 = peer1.provider;
			provider2 = peer2.provider;
			collab1 = peer1.collab;
			collab2 = peer2.collab;

			provider1.addLayer(testLayer);
			provider1.addElement("layer-1", testPath);

			provider1.deleteElements({ "layer-1": ["path-1"] });

			const doc2 = extractDocumentFromYDoc(provider2.ydoc);
			expect(doc2.objects["path-1"]).toBeUndefined();
			expect(doc2.layers[0].elementIds).toHaveLength(0);
		});

		it("should propagate addLayer from one peer to another", () => {
			const peer1 = createPeer({ isOwner: true });
			const peer2 = createPeer();
			provider1 = peer1.provider;
			provider2 = peer2.provider;
			collab1 = peer1.collab;
			collab2 = peer2.collab;

			provider1.addLayer(testLayer);
			provider1.addLayer({
				id: "layer-2",
				name: "Layer 2",
				visible: true,
				locked: false,
				opacity: 0.5,
				elementIds: [],
			});

			const doc2 = extractDocumentFromYDoc(provider2.ydoc);
			expect(doc2.layers).toHaveLength(2);
			expect(doc2.layers[1].id).toBe("layer-2");
			expect(doc2.layers[1].opacity).toBe(0.5);
		});

		it("should handle concurrent edits to different elements", () => {
			const peer1 = createPeer({ isOwner: true });
			const peer2 = createPeer();
			provider1 = peer1.provider;
			provider2 = peer2.provider;
			collab1 = peer1.collab;
			collab2 = peer2.collab;

			provider1.addLayer(testLayer);
			provider1.addElement("layer-1", testPath);
			provider1.addElement("layer-1", {
				...testPath,
				id: "path-2",
			});

			// Both peers edit different elements concurrently
			provider1.updateElement("layer-1", "path-1", { opacity: 0.3 });
			provider2.updateElement("layer-1", "path-2", { opacity: 0.7 });

			const doc1 = extractDocumentFromYDoc(provider1.ydoc);
			const doc2 = extractDocumentFromYDoc(provider2.ydoc);

			// Both changes should be visible on both peers
			expect(doc1.objects["path-1"].opacity).toBe(0.3);
			expect(doc1.objects["path-2"].opacity).toBe(0.7);
			expect(doc2.objects["path-1"].opacity).toBe(0.3);
			expect(doc2.objects["path-2"].opacity).toBe(0.7);
		});
	});

	describe("Awareness and cursor sharing", () => {
		it("should propagate cursor position to other peers", () => {
			const peer1 = createPeer({ isOwner: true });
			const peer2 = createPeer();
			collab1 = peer1.collab;
			collab2 = peer2.collab;
			provider1 = peer1.provider;
			provider2 = peer2.provider;

			collab1.updateCursor(100, 200);

			const states = collab2.getAwarenessStates();
			const peer1State = states.get(collab1.localClientId) as Record<
				string,
				unknown
			>;
			expect(peer1State?.cursor).toEqual({ x: 100, y: 200 });
		});

		it("should propagate cursor clear to other peers", () => {
			const peer1 = createPeer({ isOwner: true });
			const peer2 = createPeer();
			collab1 = peer1.collab;
			collab2 = peer2.collab;
			provider1 = peer1.provider;
			provider2 = peer2.provider;

			collab1.updateCursor(100, 200);
			collab1.clearCursor();

			const states = collab2.getAwarenessStates();
			const peer1State = states.get(collab1.localClientId) as Record<
				string,
				unknown
			>;
			expect(peer1State?.cursor).toBeNull();
		});

		it("should include user info in awareness state", () => {
			const peer1 = createPeer({ isOwner: true, userName: "Alice" });
			const peer2 = createPeer({ userName: "Bob" });
			collab1 = peer1.collab;
			collab2 = peer2.collab;
			provider1 = peer1.provider;
			provider2 = peer2.provider;

			const states = collab2.getAwarenessStates();
			const peer1State = states.get(collab1.localClientId) as Record<
				string,
				unknown
			>;
			expect((peer1State?.user as { name: string })?.name).toBe("Alice");
		});

		it("should remove awareness state on disconnect", () => {
			const peer1 = createPeer({ isOwner: true });
			const peer2 = createPeer();
			collab1 = peer1.collab;
			collab2 = peer2.collab;
			provider1 = peer1.provider;
			provider2 = peer2.provider;

			collab1.updateCursor(100, 200);
			collab1.disconnect();

			const states = collab2.getAwarenessStates();
			expect(states.has(collab1.localClientId)).toBe(false);
		});
	});

	describe("Owner actions", () => {
		it("should trigger kicked callback on target peer when owner kicks", () => {
			const peer1 = createPeer({ isOwner: true });
			const peer2 = createPeer();
			collab1 = peer1.collab;
			collab2 = peer2.collab;
			provider1 = peer1.provider;
			provider2 = peer2.provider;

			const kickedFn = vi.fn();
			collab2.on("kicked", kickedFn);

			collab1.kickUser(collab2.localClientId);

			expect(kickedFn).toHaveBeenCalledTimes(1);
		});

		it("should trigger roomClosed callback on all non-owner peers", () => {
			const peer1 = createPeer({ isOwner: true });
			const peer2 = createPeer();
			const peer3 = createPeer();
			collab1 = peer1.collab;
			collab2 = peer2.collab;
			provider1 = peer1.provider;
			provider2 = peer2.provider;

			const closedFn2 = vi.fn();
			const closedFn3 = vi.fn();
			collab2.on("roomClosed", closedFn2);
			peer3.collab.on("roomClosed", closedFn3);

			collab1.closeRoom();

			expect(closedFn2).toHaveBeenCalledTimes(1);
			expect(closedFn3).toHaveBeenCalledTimes(1);

			peer3.collab.destroy();
			peer3.provider.destroy();
		});
	});

	describe("Disconnect", () => {
		it("should stop receiving updates after disconnect", () => {
			const peer1 = createPeer({ isOwner: true });
			const peer2 = createPeer();
			provider1 = peer1.provider;
			provider2 = peer2.provider;
			collab1 = peer1.collab;
			collab2 = peer2.collab;

			provider1.addLayer(testLayer);

			collab2.disconnect();

			// Changes after disconnect should not propagate to peer2
			provider1.addElement("layer-1", testPath);

			const doc2 = extractDocumentFromYDoc(provider2.ydoc);
			expect(doc2.objects["path-1"]).toBeUndefined();
		});

		it("should stop broadcasting updates after disconnect", () => {
			const peer1 = createPeer({ isOwner: true });
			const peer2 = createPeer();
			provider1 = peer1.provider;
			provider2 = peer2.provider;
			collab1 = peer1.collab;
			collab2 = peer2.collab;

			provider1.addLayer(testLayer);

			collab1.disconnect();

			// Changes from peer1 after disconnect should not reach peer2
			provider1.addElement("layer-1", testPath);

			const doc2 = extractDocumentFromYDoc(provider2.ydoc);
			expect(doc2.objects["path-1"]).toBeUndefined();
		});
	});

	describe("Integration with YjsProvider", () => {
		it("should sync document changes through YjsProvider across two peers", () => {
			const peer1 = createPeer({ isOwner: true });
			const peer2 = createPeer();
			provider1 = peer1.provider;
			provider2 = peer2.provider;
			collab1 = peer1.collab;
			collab2 = peer2.collab;

			// Full workflow: add layer, add element, update, verify on both sides
			provider1.addLayer(testLayer);
			provider1.addElement("layer-1", testPath);
			provider1.updateElement("layer-1", "path-1", { opacity: 0.8 });

			const doc2 = extractDocumentFromYDoc(provider2.ydoc);
			expect(doc2.layers).toHaveLength(1);
			expect(doc2.objects["path-1"]).toBeDefined();
			expect(doc2.objects["path-1"].opacity).toBe(0.8);
		});

		it("should handle peer joining mid-session with existing document state", () => {
			const peer1 = createPeer({ isOwner: true });
			provider1 = peer1.provider;
			collab1 = peer1.collab;

			// Peer 1 builds up document state
			provider1.addLayer(testLayer);
			provider1.addLayer({
				id: "layer-2",
				name: "Layer 2",
				visible: true,
				locked: false,
				opacity: 1,
				elementIds: [],
			});
			provider1.addElement("layer-1", testPath);
			provider1.addElement("layer-2", {
				...testPath,
				id: "path-2",
			});

			// Peer 2 joins mid-session
			const peer2 = createPeer();
			provider2 = peer2.provider;
			collab2 = peer2.collab;

			const doc2 = extractDocumentFromYDoc(provider2.ydoc);
			expect(doc2.layers).toHaveLength(2);
			expect(doc2.objects["path-1"]).toBeDefined();
			expect(doc2.objects["path-2"]).toBeDefined();

			// Further changes from peer 1 should also sync
			provider1.updateElement("layer-1", "path-1", { opacity: 0.1 });
			const doc2Updated = extractDocumentFromYDoc(provider2.ydoc);
			expect(doc2Updated.objects["path-1"].opacity).toBe(0.1);
		});
	});

	describe("Multi-peer scenarios", () => {
		it("should sync state across 3 peers", () => {
			const peer1 = createPeer({ isOwner: true });
			const peer2 = createPeer();
			const peer3 = createPeer();
			provider1 = peer1.provider;
			provider2 = peer2.provider;
			collab1 = peer1.collab;
			collab2 = peer2.collab;

			provider1.addLayer(testLayer);
			provider2.addElement("layer-1", testPath);

			const doc3 = extractDocumentFromYDoc(peer3.provider.ydoc);
			expect(doc3.layers).toHaveLength(1);
			expect(doc3.objects["path-1"]).toBeDefined();

			peer3.collab.destroy();
			peer3.provider.destroy();
		});

		it("should keep all ArtObjects in sync after multi-step drawing across 3 peers", () => {
			const peer1 = createPeer({ isOwner: true });
			const peer2 = createPeer();
			const peer3 = createPeer();

			const p1 = peer1.provider;
			const p2 = peer2.provider;
			const p3 = peer3.provider;

			// Step 1: Peer1 creates two layers
			p1.addLayer(testLayer);
			p1.addLayer({
				id: "layer-2",
				name: "Layer 2",
				visible: true,
				locked: false,
				opacity: 1,
				elementIds: [],
			});

			// Step 2: Peer1 draws a path stroke on layer-1
			p1.addElement("layer-1", {
				id: "stroke-1",
				type: "path" as const,
				segments: [],
				opacity: 1,
				blendMode: "normal" as const,
				transform: createIdentityTransform(),
			});

			// Step 3: Peer2 adds an image object on layer-2
			p2.addElement("layer-2", {
				id: "img-1",
				type: "image" as const,
				fileUid: "file-abc",
				x: 10,
				y: 20,
				width: 300,
				height: 200,
				opacity: 1,
				blendMode: "normal" as const,
				transform: createIdentityTransform(),
			});

			// Step 4: Peer3 adds a text element on layer-1
			p3.addElement("layer-1", {
				id: "text-1",
				type: "text" as const,
				x: 50,
				y: 60,
				content: {
					paragraphs: [
						{
							runs: [
								{
									text: "Hello collaboration",
									style: {
										fontFamily: "Arial",
										fontSource: {
											type: "local" as const,
											postScriptName: "ArialMT",
										},
										fontSize: 16,
										fontWeight: 400,
										fontStyle: "normal" as const,
										fill: {
											type: "solid" as const,
											color: {
												type: "rgb" as const,
												r: 0,
												g: 0,
												b: 0,
												a: 1,
											},
										},
										letterSpacing: 0,
										lineHeight: 1.2,
										underline: false,
										strikethrough: false,
										baselineShift: 0,
									},
								},
							],
							alignment: "left" as const,
							lineHeight: 1.2,
							indent: 0,
							spacing: { before: 0, after: 0 },
						},
					],
				},
				defaultStyle: {
					fontFamily: "Arial",
					fontSource: { type: "local" as const, postScriptName: "ArialMT" },
					fontSize: 16,
					fontWeight: 400,
					fontStyle: "normal" as const,
					fill: {
						type: "solid" as const,
						color: { type: "rgb" as const, r: 0, g: 0, b: 0, a: 1 },
					},
					letterSpacing: 0,
					lineHeight: 1.2,
					underline: false,
					strikethrough: false,
					baselineShift: 0,
				},
				layout: {
					writingMode: "horizontal-tb" as const,
					boxWidth: 200,
					boxHeight: "auto" as const,
					overflow: "visible" as const,
					wordWrap: true,
				},
				opacity: 1,
				blendMode: "normal" as const,
				transform: createIdentityTransform(),
			});

			// Step 5: Peer1 adds another path on layer-2
			p1.addElement("layer-2", {
				id: "stroke-2",
				type: "path" as const,
				segments: [],
				opacity: 0.8,
				blendMode: "multiply" as const,
				transform: createIdentityTransform(),
			});

			// Step 6: Peer2 updates stroke-1 opacity and blendMode
			p2.updateElement("layer-1", "stroke-1", {
				opacity: 0.6,
				blendMode: "screen",
			});

			// Step 7: Peer3 adds a group containing two children on layer-1
			p3.addElement("layer-1", {
				id: "child-a",
				type: "path" as const,
				segments: [],
				opacity: 1,
				blendMode: "normal" as const,
				transform: createIdentityTransform(),
			});
			p3.addElement("layer-1", {
				id: "child-b",
				type: "path" as const,
				segments: [],
				opacity: 1,
				blendMode: "normal" as const,
				transform: createIdentityTransform(),
			});
			p3.groupElements("layer-1", ["child-a", "child-b"]);

			// Step 8: Peer1 deletes the image
			p1.deleteElements({ "layer-2": ["img-1"] });

			// Step 9: Peer2 adds a replacement image
			p2.addElement("layer-2", {
				id: "img-2",
				type: "image" as const,
				fileUid: "file-xyz",
				x: 0,
				y: 0,
				width: 500,
				height: 400,
				opacity: 0.9,
				blendMode: "normal" as const,
				transform: createIdentityTransform(),
			});

			// Verify final state on all 3 peers
			const docs = [p1, p2, p3].map((p) => extractDocumentFromYDoc(p.ydoc));

			for (const doc of docs) {
				// 2 layers
				expect(doc.layers).toHaveLength(2);

				// stroke-1: updated by peer2
				expect(doc.objects["stroke-1"]).toBeDefined();
				expect(doc.objects["stroke-1"].type).toBe("path");
				expect(doc.objects["stroke-1"].opacity).toBe(0.6);
				expect(doc.objects["stroke-1"].blendMode).toBe("screen");

				// text-1: added by peer3
				expect(doc.objects["text-1"]).toBeDefined();
				expect(doc.objects["text-1"].type).toBe("text");

				// stroke-2: added by peer1
				expect(doc.objects["stroke-2"]).toBeDefined();
				expect(doc.objects["stroke-2"].opacity).toBe(0.8);
				expect(doc.objects["stroke-2"].blendMode).toBe("multiply");

				// img-1 deleted, img-2 added
				expect(doc.objects["img-1"]).toBeUndefined();
				expect(doc.objects["img-2"]).toBeDefined();
				expect(doc.objects["img-2"].type).toBe("image");

				// Group created by peer3
				const groupEntry = Object.values(doc.objects).find(
					(o) => o.type === "group",
				);
				expect(groupEntry).toBeDefined();
				expect((groupEntry as { childIds: string[] }).childIds).toEqual(
					expect.arrayContaining(["child-a", "child-b"]),
				);
			}

			peer1.collab.destroy();
			peer2.collab.destroy();
			peer3.collab.destroy();
			p1.destroy();
			p2.destroy();
			p3.destroy();
		});
	});
});
