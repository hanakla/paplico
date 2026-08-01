/**
 * PartyKitCollaboration - Cloud mode WebSocket connection via y-partykit
 *
 * Same public interface as Collaboration.ts (y-websocket based),
 * but uses y-partykit/provider + PartyKit server.
 *
 * Requires:
 * - NEXT_PUBLIC_COLLAB_MODE=cloud
 * - NEXT_PUBLIC_PARTYKIT_HOST set to the PartyKit host
 * - Supabase session JWT passed via CollaborationConfig.authToken
 */

import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import YPartyKitProvider from "y-partykit/provider";
import type * as Y from "yjs";
import { Emitter } from "../utils/emitter";
import {
	CollabMessage,
	type CollaborationConfig,
	type CollaborationEventMap,
	type ICollaboration,
	USER_COLORS,
} from "./ICollaboration";

export class PartyKitCollaboration
	extends Emitter<CollaborationEventMap>
	implements ICollaboration
{
	private provider: YPartyKitProvider;
	public readonly awareness: YPartyKitProvider["awareness"];
	public readonly isOwner: boolean;
	public readonly isReadonly: boolean;

	private userId: string;

	public constructor(ydoc: Y.Doc, config: CollaborationConfig) {
		super();

		const host = process.env.NEXT_PUBLIC_PARTYKIT_HOST ?? "localhost:1999";

		const color =
			config.user?.color ??
			USER_COLORS[Math.floor(Math.random() * USER_COLORS.length)];
		this.userId = `user-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
		const name = config.user?.name || `User ${this.userId.slice(-5)}`;

		this.isOwner = config.isOwner ?? false;
		// Owner is never readonly; non-owner inherits room-level readonly from server
		this.isReadonly = !this.isOwner && (config.roomReadonly ?? false);

		// Build params: auth token + readonly flag (owner is determined server-side by JWT userId)
		const params: Record<string, string> = {};
		if (config.authToken) params.token = config.authToken;
		if (config.roomReadonly) params.roomReadonly = "1";

		this.provider = new YPartyKitProvider(host, config.roomId, ydoc, {
			connect: true,
			protocol: globalThis.location?.protocol === "https:" ? "wss" : "ws",
			params: Object.keys(params).length > 0 ? params : undefined,
		});

		this.awareness = this.provider.awareness;

		this.awareness.setLocalStateField("user", {
			name,
			color,
			id: this.userId,
		});
		this.awareness.setLocalStateField("readonly", this.isReadonly);

		// Status listeners
		this.provider.on("status", (event: { status: string }) => {
			console.log(`PartyKit WebSocket status: ${event.status}`);
			this.emit(
				"status",
				event.status === "connected" ? "connected" : "disconnected",
			);
		});

		this.provider.on("sync", (isSynced: boolean) => {
			console.log(`PartyKit sync status: ${isSynced ? "synced" : "syncing"}`);
			this.emit("synced", isSynced);
		});

		this.provider.on("connection-error", (error: Event) => {
			console.error("PartyKit connection error:", error);
		});

		// Listen for custom binary messages from server
		this.provider.ws?.addEventListener("message", (event) => {
			this.handleCustomMessage(event.data);
		});

		this.provider.on("status", (event: { status: string }) => {
			if (event.status === "connected") {
				this.provider.ws?.addEventListener("message", (ev) => {
					this.handleCustomMessage(ev.data);
				});
			}
		});

		console.log(
			`PartyKit provider initialized for room: ${config.roomId} on ${host}`,
		);
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
		this.provider.ws?.send(encoding.toUint8Array(encoder));
	}

	public closeRoom(): void {
		const encoder = encoding.createEncoder();
		encoding.writeVarUint(encoder, CollabMessage.Custom);
		encoding.writeVarUint(encoder, CollabMessage.CloseRoom);
		this.provider.ws?.send(encoding.toUint8Array(encoder));
	}

	// --- Lifecycle ---

	public disconnect(): void {
		this.provider.disconnect();
	}

	public reconnect(): void {
		this.provider.connect();
	}

	public simulateDisconnect(): void {
		this.provider.ws?.close();
		this.emit("status", "disconnected");
	}

	public destroy(): void {
		this.offAll();
		this.provider.disconnect();
		this.provider.destroy();
	}
}
