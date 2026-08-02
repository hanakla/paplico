/**
 * Collaboration - WebSocket connection management and awareness
 * Manages real-time collaboration transport layer (WebSocket, awareness, cursor sync)
 *
 * Receives Y.Doc from YjsProvider (document state management stays in YjsProvider).
 * This class is opt-in: only created when CollaborationConfig is provided to Paplico.
 */

import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { WebsocketProvider } from "y-websocket";
import type * as Y from "yjs";
import { Emitter } from "../utils/emitter";
import {
	CollabMessage,
	type CollaborationConfig,
	type CollaborationEventMap,
	type ICollaboration,
	USER_COLORS,
} from "./ICollaboration";

export class Collaboration
	extends Emitter<CollaborationEventMap>
	implements ICollaboration
{
	private wsProvider: WebsocketProvider;
	public readonly awareness: WebsocketProvider["awareness"];
	public readonly isOwner: boolean;
	public readonly isReadonly: boolean;

	private userId: string;

	public constructor(ydoc: Y.Doc, config: CollaborationConfig) {
		super();

		if (!config.wsUrl) {
			throw new Error("Collaboration requires a WebSocket URL");
		}

		const color =
			config.user?.color ??
			USER_COLORS[Math.floor(Math.random() * USER_COLORS.length)];
		this.userId = `user-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
		const name = config.user?.name || `User ${this.userId.slice(-5)}`;

		this.isOwner = config.isOwner ?? false;
		// Owner is never readonly; non-owner inherits room-level readonly from server
		this.isReadonly = !this.isOwner && (config.roomReadonly ?? false);

		// Build URL params for server-side features
		const params: Record<string, string> = {};
		if (this.isOwner) {
			params.owner = "1";
			params.ownerId = this.userId;
			if (config.roomReadonly) params.roomReadonly = "1";
		}

		this.wsProvider = new WebsocketProvider(config.wsUrl, config.roomId, ydoc, {
			connect: true,
			disableBc: true,
			maxBackoffTime: 10_000,
			resyncInterval: 30_000,
			params,
		});

		this.awareness = this.wsProvider.awareness;

		this.awareness.setLocalStateField("user", {
			name,
			color,
			id: this.userId,
		});
		this.awareness.setLocalStateField("readonly", this.isReadonly);

		// Listen for custom messages from server (kicked / roomClosed)
		this.wsProvider.on("status", (event: { status: string }) => {
			console.log(`WebSocket status: ${event.status}`);
			this.emit(
				"status",
				event.status === "connected" ? "connected" : "disconnected",
			);
		});

		this.wsProvider.on("sync", (isSynced: boolean) => {
			console.log(`Sync status: ${isSynced ? "synced" : "syncing"}`);
			this.emit("synced", isSynced);
		});

		this.wsProvider.on("connection-error", (error: Event) => {
			console.error("WebSocket connection error:", error);
		});

		// Listen for custom binary messages from server
		this.wsProvider.ws?.addEventListener("message", (event) => {
			this.handleCustomMessage(event.data);
		});

		// Also listen on future reconnections
		this.wsProvider.on("status", (event: { status: string }) => {
			if (event.status === "connected") {
				this.wsProvider.ws?.addEventListener("message", (ev) => {
					this.handleCustomMessage(ev.data);
				});
			}
		});

		console.log(`WebSocket provider initialized for room: ${config.roomId}`);
	}

	private handleCustomMessage(data: unknown): void {
		if (!(data instanceof ArrayBuffer)) return;
		const arr = new Uint8Array(data);
		if (arr.length < 2) return;

		const decoder = decoding.createDecoder(arr);
		const msgType = decoding.readVarUint(decoder);
		if (msgType !== CollabMessage.Custom) return;

		const subType = decoding.readVarUint(decoder);

		if (subType === CollabMessage.Kicked) {
			this.emit("kicked");
		} else if (subType === CollabMessage.RoomClosed) {
			this.emit("roomClosed");
		}
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

	public kickUser(clientId: number): void {
		const encoder = encoding.createEncoder();
		encoding.writeVarUint(encoder, CollabMessage.Custom);
		encoding.writeVarUint(encoder, CollabMessage.Kick);
		encoding.writeVarUint(encoder, clientId);
		this.wsProvider.ws?.send(encoding.toUint8Array(encoder));
	}

	public closeRoom(): void {
		const encoder = encoding.createEncoder();
		encoding.writeVarUint(encoder, CollabMessage.Custom);
		encoding.writeVarUint(encoder, CollabMessage.CloseRoom);
		this.wsProvider.ws?.send(encoding.toUint8Array(encoder));
	}

	// --- Lifecycle ---

	public disconnect(): void {
		this.wsProvider.disconnect();
	}

	public reconnect(): void {
		this.wsProvider.connect();
	}

	public simulateDisconnect(): void {
		this.wsProvider.ws?.close();
		this.emit("status", "disconnected");
	}

	public destroy(): void {
		this.offAll();
		this.wsProvider.disconnect();
		this.wsProvider.destroy();
	}
}
