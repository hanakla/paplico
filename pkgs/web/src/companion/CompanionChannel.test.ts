import { generateRoomKey } from "@/core/collaboration/roomCrypto";
import { InMemoryRelay } from "@/core/testUtils/inMemoryRelay";
import { CompanionChannel } from "./CompanionChannel";
import type { CompanionMessage } from "./companionProtocol";

describe("CompanionChannel", () => {
	let relay: InMemoryRelay;
	let roomKey: CryptoKey;
	let liveChannels: CompanionChannel[];

	beforeEach(async () => {
		relay = new InMemoryRelay();
		roomKey = await generateRoomKey();
		liveChannels = [];
	});

	afterEach(() => {
		for (const channel of liveChannels) channel.destroy();
	});

	it("should keep the room the document travels in free of companion traffic", () => {
		createChannel(roomKey, "room-a");

		expect(relay.joinedRooms).not.toContain("room-a");
		expect(relay.joinedRooms).toHaveLength(1);
	});

	it("should deliver a message to the other end", async () => {
		const host = createChannel(roomKey);
		const companion = createChannel(roomKey);
		const received = collect(host);

		companion.send({ type: "hello" });
		await relay.settle();

		expect(received).toEqual([{ type: "hello" }]);
	});

	it("should not let the relay read what was said", async () => {
		const companion = createChannel(roomKey);

		companion.send({
			type: "command",
			command: { type: "setBrushSize", size: 42 },
		});
		await relay.settle();

		expect(relay.transmittedAsText()).not.toContain("setBrushSize");
		expect(relay.transmittedAsText()).not.toContain("42");
	});

	it("should drop a payload encrypted under a different key", async () => {
		const host = createChannel(roomKey);
		const stranger = createChannel(await generateRoomKey());
		const received = collect(host);

		stranger.send({ type: "hello" });
		await relay.settle();

		expect(received).toEqual([]);
	});

	it("should hand over messages in the order they were sent", async () => {
		const host = createChannel(roomKey);
		const companion = createChannel(roomKey);
		const received = collect(host);

		// The long one first: decryption is asynchronous, so handling arrivals as
		// they resolve would let the short one overtake it.
		companion.send({
			type: "command",
			command: { type: "applyBrushPreset", presetUid: "x".repeat(50_000) },
		});
		companion.send({ type: "command", command: { type: "undo" } });
		await relay.settle();

		expect(received).toHaveLength(2);
		expect(received[1]).toEqual({
			type: "command",
			command: { type: "undo" },
		});
	});

	it("should report that a peer went away", async () => {
		const host = createChannel(roomKey);
		const companion = createChannel(roomKey);
		let left = 0;
		host.on("peerLeft", () => {
			left++;
		});

		companion.destroy();
		await relay.settle();

		expect(left).toBe(1);
	});

	it("should keep delivering after a handler throws", async () => {
		const host = createChannel(roomKey);
		const companion = createChannel(roomKey);
		const received: CompanionMessage[] = [];

		// A listener of ours failing must not take the link with it: the chain
		// would stay rejected and every later message would vanish in silence.
		host.on("message", (message) => {
			received.push(message);
			if (received.length === 1) throw new Error("handler blew up");
		});

		companion.send({ type: "hello" });
		await relay.settle();
		companion.send({ type: "command", command: { type: "undo" } });
		await relay.settle();

		expect(received).toHaveLength(2);
	});

	it("should still say goodbye after a send has failed", async () => {
		const host = createChannel(roomKey);
		const companion = createChannel(roomKey);
		const received = collect(host);

		// A key that cannot encrypt stands in for anything that makes a send
		// reject; the farewell after it still has to reach the other end.
		const brokenKey = await crypto.subtle.generateKey(
			{ name: "AES-GCM", length: 256 },
			true,
			["decrypt"],
		);
		Object.assign(companion as unknown as { roomKey: CryptoKey }, {
			roomKey: brokenKey,
		});
		companion.send({ type: "hello" });
		await relay.settle();

		Object.assign(companion as unknown as { roomKey: CryptoKey }, { roomKey });
		companion.send({ type: "ended" });
		await companion.destroyAfterFlush();
		await relay.settle();

		expect(received).toEqual([{ type: "ended" }]);
	});

	it("should stay silent once destroyed", async () => {
		const host = createChannel(roomKey);
		const companion = createChannel(roomKey);
		const received = collect(host);

		host.destroy();
		companion.send({ type: "hello" });
		await relay.settle();

		expect(received).toEqual([]);
	});

	function createChannel(key: CryptoKey, roomId = "room-a"): CompanionChannel {
		const channel = new CompanionChannel({
			roomId,
			roomKey: key,
			createSocket: (relayRoom) => relay.createSocket(relayRoom),
		});
		liveChannels.push(channel);
		return channel;
	}
});

function collect(channel: CompanionChannel): CompanionMessage[] {
	const received: CompanionMessage[] = [];
	channel.on("message", (message) => {
		received.push(message);
	});
	return received;
}
