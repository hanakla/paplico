/**
 * In-memory ICollaboration implementation for testing.
 * No WebSocket or network — Y.Doc updates and awareness sync entirely in memory.
 */

import {
	Awareness,
	applyAwarenessUpdate,
	encodeAwarenessUpdate,
	removeAwarenessStates,
} from "y-protocols/awareness";
import * as Y from "yjs";
import {
	type CollaborationEventMap,
	type ICollaboration,
	USER_COLORS,
} from "../collaboration/ICollaboration";
import { Emitter } from "../utils/emitter";

const REMOTE_ORIGIN = "in-memory-remote";

// ---- InMemoryRoom (hub / server role) ----

export class InMemoryRoom {
	private peers = new Set<InMemoryCollaboration>();

	public join(peer: InMemoryCollaboration): void {
		// Initial Y.Doc sync from an existing peer
		const existing = this.peers.values().next().value as
			| InMemoryCollaboration
			| undefined;
		if (existing) {
			const update = Y.encodeStateAsUpdate(existing.ydoc);
			Y.applyUpdate(peer.ydoc, update, REMOTE_ORIGIN);

			// Propagate existing awareness states
			const awarenessUpdate = encodeAwarenessUpdate(
				existing.awareness,
				Array.from(existing.awareness.getStates().keys()),
			);
			applyAwarenessUpdate(peer.awareness, awarenessUpdate, "remote");
		}

		this.peers.add(peer);
	}

	public leave(peer: InMemoryCollaboration): void {
		this.peers.delete(peer);

		// Broadcast awareness removal to remaining peers
		for (const p of this.peers) {
			if (p === peer) continue;
			removeAwarenessStates(p.awareness, [peer.localClientId], "remote");
		}
	}

	public broadcastUpdate(
		sender: InMemoryCollaboration,
		update: Uint8Array,
	): void {
		for (const peer of this.peers) {
			if (peer === sender) continue;
			peer._receiveUpdate(update);
		}
	}

	public broadcastAwareness(
		sender: InMemoryCollaboration,
		update: Uint8Array,
	): void {
		for (const peer of this.peers) {
			if (peer === sender) continue;
			peer._receiveAwarenessUpdate(update);
		}
	}

	public kickClient(clientId: number): void {
		for (const peer of this.peers) {
			if (peer.localClientId === clientId) {
				peer._notifyKicked();
				return;
			}
		}
	}

	public closeRoom(sender: InMemoryCollaboration): void {
		for (const peer of this.peers) {
			if (peer === sender) continue;
			peer._notifyRoomClosed();
		}
	}

	public destroy(): void {
		for (const peer of this.peers) {
			peer.destroy();
		}
		this.peers.clear();
	}
}

// ---- InMemoryCollaboration ----

export interface InMemoryCollaborationConfig {
	room: InMemoryRoom;
	user?: { name?: string; color?: string };
	isOwner?: boolean;
	roomReadonly?: boolean;
}

export class InMemoryCollaboration
	extends Emitter<CollaborationEventMap>
	implements ICollaboration
{
	public readonly awareness: Awareness;
	public readonly isOwner: boolean;
	public readonly isReadonly: boolean;
	public readonly ydoc: Y.Doc;

	private room: InMemoryRoom;
	private connected = true;

	private updateHandler: (update: Uint8Array, origin: unknown) => void;
	private awarenessHandler: (
		changes: { added: number[]; updated: number[]; removed: number[] },
		origin: string | null,
	) => void;

	public constructor(ydoc: Y.Doc, config: InMemoryCollaborationConfig) {
		super();

		this.ydoc = ydoc;
		this.room = config.room;
		this.isOwner = config.isOwner ?? false;
		this.isReadonly = config.roomReadonly ?? false;

		this.awareness = new Awareness(ydoc);

		// Set local user info
		const color =
			config.user?.color ??
			USER_COLORS[Math.floor(Math.random() * USER_COLORS.length)];
		const userId = `user-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
		const name = config.user?.name ?? `User ${userId.slice(-5)}`;

		this.awareness.setLocalStateField("user", {
			name,
			color,
			id: userId,
		});
		this.awareness.setLocalStateField("readonly", this.isReadonly);

		// Y.Doc update listener — broadcast to room (skip remote-originated updates)
		this.updateHandler = (update: Uint8Array, origin: unknown) => {
			if (origin === REMOTE_ORIGIN || !this.connected) return;
			this.room.broadcastUpdate(this, update);
		};
		ydoc.on("update", this.updateHandler);

		// Awareness update listener — broadcast to room
		this.awarenessHandler = (changes, origin) => {
			if (origin === "remote" || !this.connected) return;
			const changedClients = [
				...changes.added,
				...changes.updated,
				...changes.removed,
			];
			if (changedClients.length === 0) return;
			const update = encodeAwarenessUpdate(this.awareness, changedClients);
			this.room.broadcastAwareness(this, update);
		};
		this.awareness.on("update", this.awarenessHandler);

		// Join the room (triggers initial sync)
		this.room.join(this);
	}

	// -- ICollaboration: Awareness / Cursor --

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

	// -- ICollaboration: Owner actions --

	public kickUser(clientId: number): void {
		this.room.kickClient(clientId);
	}

	public closeRoom(): void {
		this.room.closeRoom(this);
	}

	// -- ICollaboration: Lifecycle --

	public disconnect(): void {
		if (!this.connected) return;
		this.connected = false;
		this.room.leave(this);
		removeAwarenessStates(this.awareness, [this.localClientId], "local");
	}

	public reconnect(): void {
		if (this.connected) return;
		this.connected = true;
		this.room.join(this);
		this.emit("status", "connected");
	}

	public simulateDisconnect(): void {
		this.disconnect();
		this.emit("status", "disconnected");
	}

	private destroyed = false;

	public destroy(): void {
		if (this.destroyed) return;
		this.destroyed = true;
		this.offAll();
		this.disconnect();
		this.ydoc.off("update", this.updateHandler);
		this.awareness.off("update", this.awarenessHandler);
		this.awareness.destroy();
	}

	// -- Internal methods (used by InMemoryRoom) --

	public _receiveUpdate(update: Uint8Array): void {
		if (!this.connected) return;
		Y.applyUpdate(this.ydoc, update, REMOTE_ORIGIN);
	}

	public _receiveAwarenessUpdate(update: Uint8Array): void {
		if (!this.connected) return;
		applyAwarenessUpdate(this.awareness, update, "remote");
	}

	public _notifyKicked(): void {
		this.emit("kicked");
	}

	public _notifyRoomClosed(): void {
		this.emit("roomClosed");
	}
}
