/**
 * E2EECollaboration - end-to-end encrypted collaboration over a dumb relay
 *
 * Every byte that leaves this class is encrypted with the room key, so the
 * relay can only forward opaque payloads between participants. That also means
 * the relay cannot merge document state: it holds nothing, and a joining peer
 * has to ask the peers already in the room for the current document.
 *
 * A consequence worth stating plainly: a peer that holds the document must stay
 * online. When the last such peer leaves, the session is gone.
 */

import {
	Awareness,
	applyAwarenessUpdate,
	encodeAwarenessUpdate,
	removeAwarenessStates,
} from "y-protocols/awareness";
import * as Y from "yjs";
import { Emitter } from "../utils/emitter";
import {
	type CollaborationConfig,
	type CollaborationEventMap,
	type ICollaboration,
	USER_COLORS,
} from "./ICollaboration";
import { createPartyRelaySocket, type RelaySocket } from "./relaySocket";
import { decryptMessage, encryptMessage } from "./roomCrypto";

/**
 * Message kinds carried *inside* the encrypted payload. The relay never sees
 * these — it cannot tell a cursor move from a document edit.
 */
const RelayMessage = {
	Update: 0,
	Awareness: 1,
	StateRequest: 2,
	RoomClosed: 3,
	Kick: 4,
	/** The host naming its relay connection, so peers can notice it leaving. */
	HostConnection: 5,
} as const;

/**
 * How long a joining peer waits for the host to hand over the document. The
 * relay reports neither who is present nor that nobody is, so waiting is the
 * only way to find out, and without a limit the wait never ends.
 */
const SYNC_TIMEOUT_MS = 15_000;

export class E2EECollaboration
	extends Emitter<CollaborationEventMap>
	implements ICollaboration
{
	public readonly awareness: Awareness;
	public readonly isOwner: boolean;
	public readonly isReadonly: boolean;

	private ydoc: Y.Doc;
	private roomKey: CryptoKey;
	private socket: RelaySocket;
	private userId: string;
	/** Marks locally applied remote changes so they are not echoed back. */
	private readonly remoteOrigin = Symbol("e2ee-remote");
	private destroyed = false;
	private synced = false;
	private syncTimer: ReturnType<typeof setTimeout> | null = null;
	/** Relay connection the host is on, learned from the host itself. */
	private hostConnectionId: string | null = null;
	/** Serializes decryption so messages are acted on in arrival order. */
	private receiveChain: Promise<void> = Promise.resolve();

	public constructor(
		ydoc: Y.Doc,
		config: CollaborationConfig,
		createSocket: (config: CollaborationConfig) => RelaySocket = (config) =>
			createPartyRelaySocket(config.roomId),
	) {
		super();

		if (!config.roomKey) {
			throw new Error("E2EECollaboration requires a room key");
		}

		this.ydoc = ydoc;
		this.roomKey = config.roomKey;

		const color =
			config.user?.color ??
			USER_COLORS[Math.floor(Math.random() * USER_COLORS.length)];
		this.userId = `user-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
		const name = config.user?.name || `User ${this.userId.slice(-5)}`;

		this.isOwner = config.isOwner ?? false;
		// Owner is never readonly; non-owner inherits the room-level flag. The
		// relay cannot enforce this, so it is an agreement between clients.
		this.isReadonly = !this.isOwner && (config.roomReadonly ?? false);

		this.awareness = new Awareness(ydoc);
		this.awareness.setLocalStateField("user", {
			name,
			color,
			id: this.userId,
		});
		this.awareness.setLocalStateField("readonly", this.isReadonly);

		this.ydoc.on("update", this.handleLocalUpdate);
		this.awareness.on("update", this.handleLocalAwarenessUpdate);

		this.socket = createSocket(config);
		this.socket.onMessage(this.handleRelayMessage);
		this.socket.onPeerLeft(this.handlePeerLeft);
		this.socket.onStatusChange(this.handleStatusChange);
	}

	// --- Awareness / Cursor ---

	public get localClientId(): number {
		return this.awareness.clientID;
	}

	public updateCursor(x: number, y: number): void {
		this.awareness.setLocalStateField("cursor", { x, y });
	}

	public clearCursor(): void {
		this.awareness.setLocalStateField("cursor", null);
	}

	public getAwarenessStates(): Map<number, unknown> {
		return this.awareness.getStates();
	}

	// --- Owner actions ---

	/**
	 * Asks the target peer to leave. The relay holds no authority here, so this
	 * is a request the peer's client honours rather than an enforced eviction.
	 */
	public kickUser(clientId: number): void {
		const body = new Uint8Array(4);
		new DataView(body.buffer).setUint32(0, clientId);
		void this.sendEncrypted(RelayMessage.Kick, body);
	}

	/** Tells the other peers the session is over. Nothing is stored to delete. */
	public closeRoom(): void {
		void this.sendEncrypted(RelayMessage.RoomClosed, new Uint8Array(0));
	}

	// --- Lifecycle ---

	public disconnect(): void {
		this.clearSyncTimeout();
		removeAwarenessStates(this.awareness, [this.awareness.clientID], "local");
		this.socket.close();
		this.emit("status", "disconnected");
	}

	public reconnect(): void {
		// The relay kept no state, so reconnecting re-runs the join handshake and
		// pulls the document from whichever peer is still holding it.
		this.synced = false;
		this.socket.reconnect();
	}

	public simulateDisconnect(): void {
		this.clearSyncTimeout();
		this.socket.close();
		this.emit("status", "disconnected");
	}

	public destroy(): void {
		if (this.destroyed) return;

		this.destroyed = true;
		this.clearSyncTimeout();
		this.offAll();
		this.ydoc.off("update", this.handleLocalUpdate);
		this.awareness.off("update", this.handleLocalAwarenessUpdate);
		this.awareness.destroy();
		this.socket.close();
	}

	// --- Protocol ---

	private handleStatusChange = (status: "connected" | "disconnected"): void => {
		this.emit("status", status);
		if (status !== "connected") return;

		if (this.isOwner) {
			// The host already holds the document, so there is nothing to wait for.
			this.markSynced();
			void this.announceHostConnection();
		} else {
			void this.sendEncrypted(RelayMessage.StateRequest, new Uint8Array(0));
			this.startSyncTimeout();
		}

		this.broadcastAwareness([this.awareness.clientID]);
	};

	private handleLocalUpdate = (update: Uint8Array, origin: unknown): void => {
		if (origin === this.remoteOrigin) return;
		void this.sendEncrypted(RelayMessage.Update, update);
	};

	private handleLocalAwarenessUpdate = (
		changes: { added: number[]; updated: number[]; removed: number[] },
		origin: unknown,
	): void => {
		if (origin === this.remoteOrigin) return;
		this.broadcastAwareness([
			...changes.added,
			...changes.updated,
			...changes.removed,
		]);
	};

	private broadcastAwareness(clients: number[]): void {
		if (clients.length === 0) return;
		void this.sendEncrypted(
			RelayMessage.Awareness,
			encodeAwarenessUpdate(this.awareness, clients),
		);
	}

	/**
	 * Decryption is asynchronous, so handling arrivals as they come would let a
	 * short message overtake a long one. Yjs updates survive that, but the
	 * control messages around them do not: a host naming its connection after
	 * the document it came with would be read the wrong way round.
	 */
	private handleRelayMessage = (data: Uint8Array): void => {
		this.receiveChain = this.receiveChain.then(() => this.receive(data));
	};

	/**
	 * A departure the relay reports is only worth acting on when it is the
	 * host's: peers hold the document but do not serve it, so losing the host
	 * is what ends the session. A host that closed the room deliberately has
	 * already said so, and this arrives afterwards with nothing left to end.
	 */
	private handlePeerLeft = (connectionId: string): void => {
		if (this.destroyed) return;
		if (connectionId !== this.hostConnectionId) return;

		this.hostConnectionId = null;
		this.emit("roomClosed");
	};

	/**
	 * The newcomer joined after the host first announced itself, so it is told
	 * again — without that it could not tell the host leaving from any other
	 * peer leaving. Naming the connection goes first and is awaited, so the
	 * newcomer knows who answered before the answer itself arrives.
	 */
	private async answerStateRequest(): Promise<void> {
		await this.announceHostConnection();
		await this.sendEncrypted(
			RelayMessage.Update,
			Y.encodeStateAsUpdate(this.ydoc),
		);
	}

	private announceHostConnection(): Promise<void> {
		return this.sendEncrypted(
			RelayMessage.HostConnection,
			new TextEncoder().encode(this.socket.id),
		);
	}

	private async receive(data: Uint8Array): Promise<void> {
		const plaintext = await decryptMessage(this.roomKey, data);
		// A payload we cannot decrypt is not ours to act on. The relay is open, so
		// dropping it silently is the expected outcome, not an error.
		if (!plaintext || plaintext.length < 1) return;
		if (this.destroyed) return;

		const kind = plaintext[0];
		const body = plaintext.subarray(1);

		switch (kind) {
			case RelayMessage.Update:
				Y.applyUpdate(this.ydoc, body, this.remoteOrigin);
				this.markSynced();
				break;

			case RelayMessage.Awareness:
				applyAwarenessUpdate(this.awareness, body, this.remoteOrigin);
				break;

			case RelayMessage.StateRequest:
				// Only the host answers. Every peer answering meant one full
				// snapshot per participant on the wire, and the document can run to
				// megabytes once images are embedded in it.
				//
				// The cost is that a session outlives its host only as far as the
				// peers already in it: once the host is gone nobody hands the
				// document to a newcomer, and the request times out.
				if (this.isOwner) void this.answerStateRequest();
				this.broadcastAwareness([this.awareness.clientID]);
				break;

			case RelayMessage.HostConnection:
				this.hostConnectionId = new TextDecoder().decode(body);
				break;

			case RelayMessage.RoomClosed:
				this.emit("roomClosed");
				break;

			case RelayMessage.Kick:
				if (body.length < 4) return;
				if (
					new DataView(body.buffer, body.byteOffset).getUint32(0) ===
					this.awareness.clientID
				) {
					this.emit("kicked");
				}
				break;
		}
	}

	private markSynced(): void {
		this.clearSyncTimeout();
		if (this.synced) return;
		this.synced = true;
		this.emit("synced", true);
	}

	private startSyncTimeout(): void {
		this.clearSyncTimeout();
		this.syncTimer = setTimeout(() => {
			this.syncTimer = null;
			if (this.synced || this.destroyed) return;
			this.emit("syncTimeout");
		}, SYNC_TIMEOUT_MS);
	}

	private clearSyncTimeout(): void {
		if (this.syncTimer == null) return;
		clearTimeout(this.syncTimer);
		this.syncTimer = null;
	}

	private async sendEncrypted(
		kind: (typeof RelayMessage)[keyof typeof RelayMessage],
		body: Uint8Array,
	): Promise<void> {
		if (this.destroyed) return;

		const plaintext = new Uint8Array(1 + body.length);
		plaintext[0] = kind;
		plaintext.set(body, 1);

		this.socket.send(await encryptMessage(this.roomKey, plaintext));
	}
}
