import * as Y from "yjs";
import { InMemoryRelay } from "../testUtils/inMemoryRelay";
import { E2EECollaboration } from "./E2EECollaboration";
import type { CollaborationConfig } from "./ICollaboration";
import { generateRoomKey } from "./roomCrypto";

describe("E2EECollaboration", () => {
	let relay: InMemoryRelay;
	let roomKey: CryptoKey;

	beforeEach(async () => {
		relay = new InMemoryRelay();
		roomKey = await generateRoomKey();
	});

	// A peer left running keeps its sync timer alive, which then fires inside
	// whichever test comes next.
	afterEach(() => {
		for (const peer of livePeers.splice(0)) peer.collab.destroy();
	});

	describe("document sync", () => {
		it("should deliver the host's edits to a guest", async () => {
			const host = createPeer(relay, roomKey, { isOwner: true });
			const guest = createPeer(relay, roomKey, { isOwner: false });

			host.ydoc.getMap("doc").set("title", "shared canvas");

			await vi.waitFor(() => {
				expect(guest.ydoc.getMap("doc").get("title")).toBe("shared canvas");
			});
		});

		it("should hand the existing document to a guest that joins later", async () => {
			const host = createPeer(relay, roomKey, { isOwner: true });
			host.ydoc.getMap("doc").set("title", "drawn before joining");

			const guest = createPeer(relay, roomKey, { isOwner: false });

			await vi.waitFor(() => {
				expect(guest.ydoc.getMap("doc").get("title")).toBe(
					"drawn before joining",
				);
			});
		});

		it("should propagate a guest's edits back to the host", async () => {
			const host = createPeer(relay, roomKey, { isOwner: true });
			const guest = createPeer(relay, roomKey, { isOwner: false });

			guest.ydoc.getMap("doc").set("note", "from the iPad");

			await vi.waitFor(() => {
				expect(host.ydoc.getMap("doc").get("note")).toBe("from the iPad");
			});
		});

		it("should leave a guest without the document once the host is gone", async () => {
			const host = createPeer(relay, roomKey, { isOwner: true });
			host.ydoc.getMap("doc").set("title", "only the host has this");

			const guest = createPeer(relay, roomKey, { isOwner: false });
			await vi.waitFor(() => {
				expect(guest.ydoc.getMap("doc").get("title")).toBe(
					"only the host has this",
				);
			});

			host.collab.destroy();

			// The guest holds the document but must not answer for it, so a
			// latecomer arriving after the host left gets nothing.
			const latecomer = createPeer(relay, roomKey, { isOwner: false });
			await relay.settle();

			expect(latecomer.ydoc.getMap("doc").get("title")).toBeUndefined();
		});

		it("should report synced once the document has arrived", async () => {
			createPeer(relay, roomKey, { isOwner: true });
			const guest = createPeer(relay, roomKey, { isOwner: false });

			const onSynced = vi.fn();
			guest.collab.on("synced", onSynced);

			await vi.waitFor(() => {
				expect(onSynced).toHaveBeenCalledWith(true);
			});
		});
	});

	describe("waiting for the document", () => {
		afterEach(() => {
			vi.useRealTimers();
		});

		it("should give up when nobody offers the document", async () => {
			vi.useFakeTimers();

			const guest = createPeer(relay, roomKey, { isOwner: false });
			const onSyncTimeout = vi.fn();
			guest.collab.on("syncTimeout", onSyncTimeout);

			await vi.advanceTimersByTimeAsync(30_000);

			expect(onSyncTimeout).toHaveBeenCalled();
		});

		it("should stop waiting once the document has arrived", async () => {
			const host = createPeer(relay, roomKey, { isOwner: true });
			host.ydoc.getMap("doc").set("title", "arrived in time");
			const guest = createPeer(relay, roomKey, { isOwner: false });

			// Real timers until the document lands: decryption is genuinely
			// asynchronous, and fake ones would race past it rather than let it
			// finish, which is a race the 15s budget never sees in practice.
			await vi.waitFor(() => {
				expect(guest.ydoc.getMap("doc").get("title")).toBe("arrived in time");
			});

			const onSyncTimeout = vi.fn();
			guest.collab.on("syncTimeout", onSyncTimeout);

			vi.useFakeTimers();
			await vi.advanceTimersByTimeAsync(30_000);

			expect(onSyncTimeout).not.toHaveBeenCalled();
		});

		it("should not give up on a host, which has the document already", async () => {
			vi.useFakeTimers();

			const host = createPeer(relay, roomKey, { isOwner: true });
			const onSyncTimeout = vi.fn();
			host.collab.on("syncTimeout", onSyncTimeout);

			await vi.advanceTimersByTimeAsync(30_000);

			expect(onSyncTimeout).not.toHaveBeenCalled();
		});
	});

	describe("confidentiality", () => {
		it("should never expose document text to the relay", async () => {
			const host = createPeer(relay, roomKey, { isOwner: true });
			const guest = createPeer(relay, roomKey, { isOwner: false });

			host.ydoc.getMap("doc").set("title", "confidential artwork");

			await vi.waitFor(() => {
				expect(guest.ydoc.getMap("doc").get("title")).toBe(
					"confidential artwork",
				);
			});

			expect(relay.transmitted.length).toBeGreaterThan(0);
			expect(relay.transmittedAsText()).not.toContain("confidential artwork");
			expect(relay.transmittedAsText()).not.toContain("title");
		});

		it("should never expose cursor positions or user names to the relay", async () => {
			const host = createPeer(relay, roomKey, {
				isOwner: true,
				user: { name: "Hanakla" },
			});
			const guest = createPeer(relay, roomKey, { isOwner: false });

			host.collab.updateCursor(1234, 5678);

			await vi.waitFor(() => {
				expect(guest.collab.getAwarenessStates().size).toBeGreaterThan(1);
			});

			expect(relay.transmittedAsText()).not.toContain("Hanakla");
			expect(relay.transmittedAsText()).not.toContain("cursor");
		});

		it("should ignore peers holding a different key", async () => {
			const host = createPeer(relay, roomKey, { isOwner: true });
			const outsider = createPeer(relay, await generateRoomKey(), {
				isOwner: false,
			});

			host.ydoc.getMap("doc").set("title", "not for outsiders");
			await relay.settle();

			expect(outsider.ydoc.getMap("doc").get("title")).toBeUndefined();
		});
	});

	describe("awareness", () => {
		it("should share the cursor position with other peers", async () => {
			const host = createPeer(relay, roomKey, { isOwner: true });
			const guest = createPeer(relay, roomKey, { isOwner: false });

			host.collab.updateCursor(42, 99);

			await vi.waitFor(() => {
				const state = guest.collab
					.getAwarenessStates()
					.get(host.collab.localClientId) as { cursor?: unknown } | undefined;
				expect(state?.cursor).toEqual({ x: 42, y: 99 });
			});
		});
	});

	describe("owner actions", () => {
		it("should notify other peers when the room is closed", async () => {
			const host = createPeer(relay, roomKey, { isOwner: true });
			const guest = createPeer(relay, roomKey, { isOwner: false });

			const onRoomClosed = vi.fn();
			guest.collab.on("roomClosed", onRoomClosed);

			host.collab.closeRoom();

			await vi.waitFor(() => {
				expect(onRoomClosed).toHaveBeenCalled();
			});
		});

		it("should tell a guest when the host drops without closing the room", async () => {
			const host = createPeer(relay, roomKey, { isOwner: true });
			host.ydoc.getMap("doc").set("title", "sent by the host");

			const guest = createPeer(relay, roomKey, { isOwner: false });
			// The host names its connection before answering with the document, so
			// receiving the document means the guest knows whose connection to
			// watch. Waiting on a fixed number of ticks would not say that.
			await vi.waitFor(() => {
				expect(guest.ydoc.getMap("doc").get("title")).toBe("sent by the host");
			});

			const onRoomClosed = vi.fn();
			guest.collab.on("roomClosed", onRoomClosed);

			// destroy() closes the socket without sending anything, which is what
			// a crashed or backgrounded device looks like from here.
			host.collab.destroy();

			await vi.waitFor(() => {
				expect(onRoomClosed).toHaveBeenCalled();
			});
		});

		it("should not report the room closed when a guest leaves", async () => {
			const host = createPeer(relay, roomKey, { isOwner: true });
			const staying = createPeer(relay, roomKey, { isOwner: false });
			const leaving = createPeer(relay, roomKey, { isOwner: false });
			await relay.settle();

			const onRoomClosed = vi.fn();
			const onHostRoomClosed = vi.fn();
			staying.collab.on("roomClosed", onRoomClosed);
			host.collab.on("roomClosed", onHostRoomClosed);

			leaving.collab.destroy();
			await relay.settle();

			expect(onRoomClosed).not.toHaveBeenCalled();
			expect(onHostRoomClosed).not.toHaveBeenCalled();
		});

		it("should only notify the peer that was kicked", async () => {
			const host = createPeer(relay, roomKey, { isOwner: true });
			const kicked = createPeer(relay, roomKey, { isOwner: false });
			const bystander = createPeer(relay, roomKey, { isOwner: false });

			const onKicked = vi.fn();
			const onBystanderKicked = vi.fn();
			kicked.collab.on("kicked", onKicked);
			bystander.collab.on("kicked", onBystanderKicked);

			host.collab.kickUser(kicked.collab.localClientId);

			await vi.waitFor(() => {
				expect(onKicked).toHaveBeenCalled();
			});
			expect(onBystanderKicked).not.toHaveBeenCalled();
		});
	});
});

type Peer = {
	ydoc: Y.Doc;
	collab: E2EECollaboration;
};

/** Everything createPeer handed out, so afterEach can shut it all down. */
const livePeers: Peer[] = [];

function createPeer(
	relay: InMemoryRelay,
	roomKey: CryptoKey,
	overrides: Partial<CollaborationConfig>,
): Peer {
	const ydoc = new Y.Doc();
	const collab = new E2EECollaboration(
		ydoc,
		{ roomId: "test-room", wsUrl: "unused", roomKey, ...overrides },
		() => relay.createSocket(),
	);

	const peer = { ydoc, collab };
	livePeers.push(peer);
	return peer;
}
