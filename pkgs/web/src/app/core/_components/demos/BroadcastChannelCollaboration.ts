import { CollaborationBase } from "@paplico/core/collaboration";
import {
	Awareness,
	applyAwarenessUpdate,
	encodeAwarenessUpdate,
	removeAwarenessStates,
} from "y-protocols/awareness";
import * as Y from "yjs";

type Message =
	| { type: "hello"; state: Uint8Array }
	| { type: "update"; update: Uint8Array }
	| { type: "awareness"; update: Uint8Array };

/**
 * A collaboration transport with no server: every Paplico instance on the
 * same channel name, in this tab or another tab of the same browser, edits
 * one document. A joining peer sends its whole document, and each peer
 * answers with its own, so both sides end up with the merged state.
 */
export class BroadcastChannelCollaboration extends CollaborationBase {
	public readonly awareness: Awareness;
	public readonly isOwner = true;
	public readonly isReadonly = false;

	private channel: BroadcastChannel | null = null;

	public constructor(
		private readonly ydoc: Y.Doc,
		private readonly channelName: string,
	) {
		super();
		this.awareness = new Awareness(ydoc);
		ydoc.on("update", this.handleDocUpdate);
		this.awareness.on("update", this.handleAwarenessUpdate);
		this.open();
	}

	public get localClientId(): number {
		return this.ydoc.clientID;
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

	public disconnect(): void {
		if (!this.channel) return;
		removeAwarenessStates(this.awareness, [this.localClientId], "local");
		this.channel.close();
		this.channel = null;
		this.emit("status", "disconnected");
	}

	public reconnect(): void {
		if (!this.channel) this.open();
	}

	public simulateDisconnect(): void {
		this.disconnect();
	}

	public destroy(): void {
		this.disconnect();
		this.ydoc.off("update", this.handleDocUpdate);
		this.awareness.off("update", this.handleAwarenessUpdate);
		this.awareness.destroy();
		this.offAll();
	}

	// Every peer is equal on a broadcast channel, so there is nobody to kick
	// and no room to close.
	public kickUser(): void {}

	public closeRoom(): void {}

	private open(): void {
		this.channel = new BroadcastChannel(this.channelName);
		this.channel.onmessage = (event: MessageEvent<Message>) =>
			this.receive(event.data);
		this.post({ type: "hello", state: Y.encodeStateAsUpdate(this.ydoc) });

		// Paplico subscribes to "synced" right after the constructor returns.
		queueMicrotask(() => {
			this.emit("status", "connected");
			this.emit("synced", true);
		});
	}

	private receive(message: Message): void {
		switch (message.type) {
			case "hello": {
				Y.applyUpdate(this.ydoc, message.state, this);
				this.post({ type: "update", update: Y.encodeStateAsUpdate(this.ydoc) });
				return;
			}
			case "update": {
				Y.applyUpdate(this.ydoc, message.update, this);
				return;
			}
			case "awareness": {
				applyAwarenessUpdate(this.awareness, message.update, this);
				return;
			}
		}
	}

	private post(message: Message): void {
		this.channel?.postMessage(message);
	}

	private readonly handleDocUpdate = (update: Uint8Array, origin: unknown) => {
		if (origin === this) return;
		this.post({ type: "update", update });
	};

	private readonly handleAwarenessUpdate = (
		changes: { added: number[]; updated: number[]; removed: number[] },
		origin: unknown,
	) => {
		if (origin === this) return;
		const clients = [...changes.added, ...changes.updated, ...changes.removed];
		this.post({
			type: "awareness",
			update: encodeAwarenessUpdate(this.awareness, clients),
		});
	};
}
