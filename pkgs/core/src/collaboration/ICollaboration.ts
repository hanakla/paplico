import type { Awareness } from "y-protocols/awareness";
import { Emitter } from "../utils/emitter";

/**
 * Custom binary message types for collaboration protocol.
 * Yjs uses messageSync=0, messageAwareness=1.
 * Custom messages use type=3 with sub-types.
 */
export const CollabMessage = {
	Custom: 3,
	Kick: 1,
	Kicked: 2,
	CloseRoom: 3,
	RoomClosed: 4,
} as const;

export type CollaborationEventMap = {
	synced: boolean;
	status: "connected" | "disconnected";
	kicked: undefined;
	roomClosed: undefined;
	/**
	 * Nobody answered the request for the document. Only a transport whose
	 * server holds no state can end up here — the others are answered by the
	 * server itself.
	 */
	syncTimeout: undefined;
	/** A message from a peer could not be applied and was skipped. */
	messageRejected: { cause: unknown };
};

export interface ICollaboration extends Emitter<CollaborationEventMap> {
	readonly awareness: Awareness;
	readonly localClientId: number;
	updateCursor(x: number, y: number): void;
	clearCursor(): void;
	getAwarenessStates(): Map<number, unknown>;
	disconnect(): void;
	reconnect(): void;
	/** Simulate server-side disconnection for development/testing */
	simulateDisconnect(): void;
	destroy(): void;
	readonly isOwner: boolean;
	readonly isReadonly: boolean;
	kickUser(clientId: number): void;
	closeRoom(): void;
}

/**
 * Base class for collaboration transports, including ones a host app
 * implements itself. Supplies the typed event emitter so a subclass only
 * implements the transport.
 */
export abstract class CollaborationBase
	extends Emitter<CollaborationEventMap>
	implements ICollaboration
{
	public abstract readonly awareness: Awareness;
	public abstract readonly localClientId: number;
	public abstract readonly isOwner: boolean;
	public abstract readonly isReadonly: boolean;
	public abstract updateCursor(x: number, y: number): void;
	public abstract clearCursor(): void;
	public abstract getAwarenessStates(): Map<number, unknown>;
	public abstract disconnect(): void;
	public abstract reconnect(): void;
	public abstract simulateDisconnect(): void;
	public abstract destroy(): void;
	public abstract kickUser(clientId: number): void;
	public abstract closeRoom(): void;
}

export interface CollaborationConfig {
	roomId: string;
	/** WebSocket endpoint for local mode. */
	wsUrl?: string;
	/** PartyKit host (`host:port`) for cloud and E2EE modes. */
	relayHost?: string;
	user?: {
		name?: string;
		color?: string;
	};
	/** Supabase session JWT for cloud mode authentication */
	authToken?: string;
	/**
	 * HMAC-signed room token issued with a new cloud-mode room. The relay
	 * requires it from the connection that creates the room.
	 */
	roomToken?: string;
	/**
	 * AES-GCM room key for end-to-end encrypted mode. Its presence selects the
	 * E2EE provider. Never sent to the relay — it travels in the invite URL
	 * fragment and stays on the participating devices.
	 */
	roomKey?: CryptoKey;
	/** Room-level readonly: non-owner clients cannot write. Owner is never readonly. */
	roomReadonly?: boolean;
	isOwner?: boolean;
}

export const USER_COLORS = [
	"#FF6B6B",
	"#4ECDC4",
	"#45B7D1",
	"#FFA07A",
	"#98D8C8",
	"#F7DC6F",
	"#BB8FCE",
	"#85C1E2",
	"#F8B195",
	"#C06C84",
];
