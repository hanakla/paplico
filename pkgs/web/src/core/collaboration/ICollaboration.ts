import type { Awareness } from "y-protocols/awareness";
import type { Emitter } from "../utils/emitter";

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

export interface CollaborationConfig {
	roomId: string;
	/**
	 * WebSocket endpoint for local mode. Cloud and E2EE modes derive their host
	 * from NEXT_PUBLIC_PARTYKIT_HOST instead.
	 */
	wsUrl?: string;
	user?: {
		name?: string;
		color?: string;
	};
	/** Supabase session JWT for cloud mode authentication */
	authToken?: string;
	/** HMAC-signed room token for local mode authentication */
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
