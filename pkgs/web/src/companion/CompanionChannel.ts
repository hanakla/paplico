/**
 * CompanionChannel - encrypted command link between a host and its companions
 *
 * Both ends run this same class; which one is the host is decided by who
 * answers `hello` with a state. The relay underneath forwards opaque bytes and
 * keeps nothing, so a channel exists only as long as both ends are connected.
 *
 * A host may hold more than one of these at once — one per way a companion was
 * invited in — and treats them alike.
 */

import {
	createPartyRelaySocket,
	type RelaySocket,
} from "@/core/collaboration/relaySocket";
import {
	decryptMessage,
	encryptMessage,
} from "@/core/collaboration/roomCrypto";
import { Emitter } from "@/core/utils/emitter";
import {
	type CompanionMessage,
	companionRelayRoom,
	decodeCompanionMessage,
	encodeCompanionMessage,
} from "./companionProtocol";

type CompanionChannelEventMap = {
	message: CompanionMessage;
	status: "connected" | "disconnected";
	/** Some connection in the room went away. Which one, the relay does not say. */
	peerLeft: void;
};

export class CompanionChannel extends Emitter<CompanionChannelEventMap> {
	private readonly roomKey: CryptoKey;
	private readonly socket: RelaySocket;
	private destroyed = false;
	/** Serializes decryption so messages are acted on in arrival order. */
	private receiveChain: Promise<void> = Promise.resolve();
	/**
	 * Serializes encryption for the same reason. Commands are not commutative —
	 * a size change followed by an undo is not the same the other way round —
	 * so a long payload must not be overtaken by the short one sent after it.
	 */
	private sendChain: Promise<void> = Promise.resolve();

	public constructor({
		roomId,
		roomKey,
		createSocket = createPartyRelaySocket,
	}: {
		roomId: string;
		roomKey: CryptoKey;
		/** Seam so tests can drive the protocol without a real relay. */
		createSocket?: (relayRoom: string) => RelaySocket;
	}) {
		super();

		this.roomKey = roomKey;
		this.socket = createSocket(companionRelayRoom(roomId));
		this.socket.onMessage(this.handleRelayMessage);
		this.socket.onPeerLeft(this.handlePeerLeft);
		this.socket.onStatusChange(this.handleStatusChange);
	}

	public send(message: CompanionMessage): void {
		this.sendChain = this.sendChain.then(() => this.sendEncrypted(message));
		this.sendChain = isolate(this.sendChain);
	}

	public destroy(): void {
		if (this.destroyed) return;

		this.destroyed = true;
		this.offAll();
		this.socket.close();
	}

	/**
	 * Closes only once what has already been handed to `send` is on the wire.
	 * Sending is asynchronous, so a farewell followed by `destroy` would be
	 * dropped by the very call meant to follow it.
	 */
	public async destroyAfterFlush(): Promise<void> {
		await this.sendChain;
		this.destroy();
	}

	private handleStatusChange = (status: "connected" | "disconnected"): void => {
		if (this.destroyed) return;
		this.emit("status", status);
	};

	/**
	 * Decryption is asynchronous, so handling arrivals as they come would let a
	 * short message overtake a long one — a state sent right after a command
	 * could then be read as if it came first.
	 */
	private handleRelayMessage = (data: Uint8Array): void => {
		this.receiveChain = this.receiveChain.then(() => this.receive(data));
		// One failure must not end the link. A chain left rejected stays that way,
		// and every later message would be dropped without a word — the companion
		// would sit there reporting a connection that no longer does anything.
		this.receiveChain = isolate(this.receiveChain);
	};

	private handlePeerLeft = (): void => {
		if (this.destroyed) return;
		this.emit("peerLeft", undefined);
	};

	private async receive(data: Uint8Array): Promise<void> {
		const plaintext = await decryptMessage(this.roomKey, data);
		// A payload we cannot decrypt is not ours to act on. The relay is open to
		// whoever knows the room, so dropping it silently is expected.
		if (!plaintext) return;
		if (this.destroyed) return;

		const message = decodeCompanionMessage(plaintext);
		if (!message) return;

		this.emit("message", message);
	}

	private async sendEncrypted(message: CompanionMessage): Promise<void> {
		if (this.destroyed) return;

		const payload = await encryptMessage(
			this.roomKey,
			encodeCompanionMessage(message),
		);
		// Awaiting encryption gives destroy() a chance to land in between.
		if (this.destroyed) return;

		this.socket.send(payload);
	}
}

/**
 * The tail of a chain, carrying on past whatever went wrong in the step before
 * it. Without this a single failure leaves the chain rejected for good, and
 * every message after it is dropped in silence.
 */
function isolate(chain: Promise<void>): Promise<void> {
	return chain.catch(() => {});
}
