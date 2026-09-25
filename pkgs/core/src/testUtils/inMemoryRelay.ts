import type { RelaySocket } from "../collaboration/relaySocket";

/**
 * Stands in for the relay party: forwards every payload to the other sockets in
 * the same room without inspecting it, and keeps what passed through so tests
 * can assert on what the relay would have been able to see.
 */
export class InMemoryRelay {
	public readonly transmitted: Uint8Array[] = [];
	/** Rooms sockets were opened on, in the order they were opened. */
	public readonly joinedRooms: string[] = [];

	private nextId = 0;
	private sockets = new Set<InMemoryPeer>();

	public createSocket(room = "test-room"): RelaySocket {
		const self: InMemoryPeer = { id: `conn-${this.nextId++}`, room };
		this.sockets.add(self);
		this.joinedRooms.push(room);

		const leave = () => {
			if (!this.sockets.delete(self)) return;
			// The relay announces the departure to whoever is still in the room.
			for (const peer of this.sockets) {
				if (peer.room !== self.room) continue;
				queueMicrotask(() => peer.onPeerLeft?.(self.id));
			}
		};

		return {
			id: self.id,
			send: (data) => {
				this.transmitted.push(data);
				for (const peer of this.sockets) {
					if (peer === self || peer.room !== self.room) continue;
					queueMicrotask(() => peer.onMessage?.(data));
				}
			},
			close: leave,
			reconnect: () => {
				this.sockets.add(self);
			},
			onMessage: (handler) => {
				self.onMessage = handler;
			},
			onPeerLeft: (handler) => {
				self.onPeerLeft = handler;
			},
			onStatusChange: (handler) => {
				queueMicrotask(() => handler("connected"));
			},
		};
	}

	/** Lets every queued encryption, delivery and decryption finish. */
	public async settle(): Promise<void> {
		for (let round = 0; round < 5; round++) {
			for (let i = 0; i < 20; i++) await Promise.resolve();
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
	}

	/** Everything the relay carried, as text, to assert nothing legible leaked. */
	public transmittedAsText(): string {
		const total = this.transmitted.reduce((sum, part) => sum + part.length, 0);
		const joined = new Uint8Array(total);
		let offset = 0;
		for (const part of this.transmitted) {
			joined.set(part, offset);
			offset += part.length;
		}
		return new TextDecoder("utf-8", { fatal: false }).decode(joined);
	}
}

type InMemoryPeer = {
	id: string;
	room: string;
	onMessage?: (data: Uint8Array) => void;
	onPeerLeft?: (connectionId: string) => void;
};
