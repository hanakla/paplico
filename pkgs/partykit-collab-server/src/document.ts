/**
 * PartyKit Server for Paplico collaboration (cloud mode)
 *
 * Responsibilities:
 * - Yjs document synchronization via y-partykit
 * - Supabase JWT verification via HS256 symmetric key at edge (onBeforeConnect)
 * - Room metadata storage in Durable Object KV
 * - Readonly enforcement, kick, and room closure
 */

import { type JWTPayload, jwtVerify } from "jose";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import type * as Party from "partykit/server";
import { onConnect, unstable_getYDoc } from "y-partykit";
import { verifyRoomToken } from "./roomToken";

const CollabMessage = {
	Custom: 3,
	Kick: 1,
	Kicked: 2,
	CloseRoom: 3,
	RoomClosed: 4,
} as const;

interface RoomMetadata {
	createdBy: string;
	createdAt: string;
}

interface SupabaseJWTPayload extends JWTPayload {
	sub: string;
	email?: string;
	user_metadata?: {
		full_name?: string;
		avatar_url?: string;
		user_name?: string;
	};
	role?: string;
}

export default class DocumentServer implements Party.Server {
	private ownerConnId: string | null = null;
	private ownerId: string | null = null;
	/** Room-level readonly flag set by owner. Non-owner clients inherit this. */
	private roomReadonly = false;
	/** Maps connection ID → awareness clientID for kick targeting */
	private connClientIds = new Map<string, number>();

	public constructor(public room: Party.Room) {}

	/**
	 * Edge workerで実行。未認証接続をDurable Objectに到達させずに弾く。
	 * 検証済みユーザー情報はリクエストヘッダ経由でonConnectに渡す。
	 */
	public static async onBeforeConnect(
		request: Party.Request,
		lobby: Party.Lobby,
		_ctx: Party.ExecutionContext,
	): Promise<Party.Request | Response> {
		const url = new URL(request.url);
		const token = url.searchParams.get("token");

		if (!token) {
			return new Response("Authentication required", { status: 401 });
		}

		const jwtSecret = lobby.env.SUPABASE_JWT_SECRET as string | undefined;
		const user = jwtSecret
			? await verifyWithSecret(token, jwtSecret)
			: verifyFallback(token);

		if (!user) {
			return new Response("Invalid authentication token", { status: 403 });
		}

		// Verify room token (proves roomId was issued by our API)
		const roomSigningSecret = lobby.env.ROOM_SIGNING_SECRET as
			| string
			| undefined;
		const roomToken = url.searchParams.get("roomToken");
		if (roomSigningSecret && roomToken) {
			const roomId = lobby.id;
			const valid = await verifyRoomToken(roomId, roomToken, roomSigningSecret);
			if (!valid) {
				return new Response("Invalid room token", { status: 403 });
			}
		}

		// Only the id is read back in onConnect. The name and image were set here
		// but never consumed, and a header value carries only ASCII on the wire —
		// a display name like "はなくら😈" made workerd reject the whole request.
		request.headers.set("X-User-ID", user.userId);

		return request;
	}

	public async onConnect(conn: Party.Connection, ctx: Party.ConnectionContext) {
		const userId = ctx.request.headers.get("X-User-ID") ?? "";
		const url = new URL(ctx.request.url);

		// Determine owner by matching JWT userId against room creator,
		// not by trusting client-supplied query params.
		const existing = await this.room.storage.get<RoomMetadata>("metadata");
		const isOwner = !existing || existing.createdBy === userId;

		if (!existing) {
			await this.room.storage.put<RoomMetadata>("metadata", {
				createdBy: userId,
				createdAt: new Date().toISOString(),
			});
		}

		if (isOwner) {
			this.ownerConnId = conn.id;
			this.ownerId = userId;
			if (url.searchParams.get("roomReadonly") === "1") {
				this.roomReadonly = true;
			}
		}

		// Owner is never readonly; non-owner clients inherit room-level readonly
		const isReadonly = !isOwner && this.roomReadonly;

		return onConnect(conn, this.room, {
			persist: { mode: "snapshot" },
			readOnly: isReadonly,
		});
	}

	public onMessage(message: string | ArrayBuffer, sender: Party.Connection) {
		if (typeof message === "string") return;

		const data = new Uint8Array(message);
		if (data.length < 2) return;

		const decoder = decoding.createDecoder(data);
		const msgType = decoding.readVarUint(decoder);
		if (msgType !== CollabMessage.Custom) return;

		// Only owner can send custom control messages
		if (sender.id !== this.ownerConnId) return;

		const subType = decoding.readVarUint(decoder);

		if (subType === CollabMessage.Kick) {
			const targetClientId = decoding.readVarUint(decoder);
			// Find connection by clientId and kick
			for (const conn of this.room.getConnections()) {
				const clientId = this.connClientIds.get(conn.id);
				if (clientId === targetClientId) {
					const enc = encoding.createEncoder();
					encoding.writeVarUint(enc, CollabMessage.Custom);
					encoding.writeVarUint(enc, CollabMessage.Kicked);
					conn.send(encoding.toUint8Array(enc));
					setTimeout(() => conn.close(), 100);
					break;
				}
			}
		} else if (subType === CollabMessage.CloseRoom) {
			for (const conn of this.room.getConnections()) {
				if (conn.id === sender.id) continue;
				const enc = encoding.createEncoder();
				encoding.writeVarUint(enc, CollabMessage.Custom);
				encoding.writeVarUint(enc, CollabMessage.RoomClosed);
				conn.send(encoding.toUint8Array(enc));
				setTimeout(() => conn.close(), 100);
			}
			this.ownerConnId = null;
			this.ownerId = null;
		}
	}

	public onClose(conn: Party.Connection) {
		this.connClientIds.delete(conn.id);
		if (conn.id === this.ownerConnId) {
			// Null out connection but keep ownerId for reconnection
			this.ownerConnId = null;
		}
	}

	/** HTTP endpoint: GET /parties/document/{roomId} returns Y.Doc meta as JSON. */
	public async onRequest(request: Party.Request): Promise<Response> {
		const corsHeaders = {
			"Access-Control-Allow-Origin": request.headers.get("Origin") ?? "*",
			"Access-Control-Allow-Methods": "GET, OPTIONS",
		};

		if (request.method === "OPTIONS") {
			return new Response(null, { status: 204, headers: corsHeaders });
		}

		if (request.method !== "GET") {
			return new Response("Method not allowed", {
				status: 405,
				headers: corsHeaders,
			});
		}

		// Room only exists if metadata was stored during onConnect
		const existing = await this.room.storage.get<RoomMetadata>("metadata");
		if (!existing) {
			return new Response(JSON.stringify({ error: "room not found" }), {
				status: 404,
				headers: { ...corsHeaders, "Content-Type": "application/json" },
			});
		}

		const doc = await unstable_getYDoc(this.room, {
			persist: { mode: "snapshot" },
		});
		const yMeta = doc.getMap("meta");
		const meta: Record<string, unknown> = {};
		yMeta.forEach((value, key) => {
			meta[key] = value;
		});

		return new Response(JSON.stringify(meta), {
			headers: { ...corsHeaders, "Content-Type": "application/json" },
		});
	}
}

DocumentServer satisfies Party.Worker;

// --- JWT verification helpers ---

interface VerifiedUser {
	userId: string;
	name?: string;
	imageUrl?: string;
}

async function verifyWithSecret(
	token: string,
	jwtSecret: string,
): Promise<VerifiedUser | null> {
	try {
		const secret = new TextEncoder().encode(jwtSecret);
		const { payload } = await jwtVerify<SupabaseJWTPayload>(token, secret, {
			algorithms: ["HS256"],
		});

		if (!payload.sub) return null;

		return {
			userId: payload.sub,
			name:
				payload.user_metadata?.full_name ?? payload.user_metadata?.user_name,
			imageUrl: payload.user_metadata?.avatar_url,
		};
	} catch (e) {
		console.error("JWT verification failed:", e);
		return null;
	}
}

/**
 * SUPABASE_JWT_SECRET未設定時のフォールバック。
 * ペイロードのデコードと有効期限チェックのみ。署名検証はスキップされる。
 */
function verifyFallback(token: string): VerifiedUser | null {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) return null;

		const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
		const padding = (4 - (base64.length % 4)) % 4;
		const padded = base64 + "=".repeat(padding);
		const payload: SupabaseJWTPayload = JSON.parse(atob(padded));

		if (payload.exp && payload.exp * 1000 < Date.now()) return null;
		if (!payload.sub) return null;

		return {
			userId: payload.sub,
			name:
				payload.user_metadata?.full_name ?? payload.user_metadata?.user_name,
			imageUrl: payload.user_metadata?.avatar_url,
		};
	} catch {
		return null;
	}
}
