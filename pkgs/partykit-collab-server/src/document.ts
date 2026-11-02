/**
 * PartyServer document server for Paplico collaboration (cloud mode)
 *
 * Responsibilities:
 * - Yjs document synchronization via y-partyserver
 * - Supabase JWT verification via HS256 symmetric key at edge (onBeforeConnect)
 * - Room metadata and document snapshot storage in Durable Object storage
 * - Readonly enforcement, kick, and room closure
 */

import { type JWTPayload, jwtVerify } from "jose";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import type { Connection, ConnectionContext, WSMessage } from "partyserver";
import { YServer } from "y-partyserver";
import * as Y from "yjs";
import { verifyRoomToken } from "./roomToken";

const CollabMessage = {
	Custom: 3,
	Kick: 1,
	Kicked: 2,
	CloseRoom: 3,
	RoomClosed: 4,
} as const;

const ROOM_TOKEN_VERIFIED_HEADER = "X-Room-Token-Verified";

const SNAPSHOT_CHUNK_COUNT_KEY = "snapshot:count";
const SNAPSHOT_CHUNK_KEY_PREFIX = "snapshot:";
/** Durable Object storage holds at most 2 MiB per value. */
const SNAPSHOT_CHUNK_BYTES = 1024 * 1024;

interface RoomMetadata {
	createdBy: string;
	createdAt: string;
}

interface ConnectionState {
	readonly?: boolean;
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

export class DocumentServer extends YServer {
	private ownerConnId: string | null = null;
	private ownerId: string | null = null;
	/** Room-level readonly flag set by owner. Non-owner clients inherit this. */
	private roomReadonly = false;
	/** Maps connection ID → awareness clientID for kick targeting */
	private connClientIds = new Map<string, number>();

	/**
	 * Runs in the Worker before the request reaches the Durable Object, so an
	 * unauthenticated connection never wakes the room. The verified user is
	 * handed to onConnect through request headers.
	 */
	public static async onBeforeConnect(
		request: Request,
		roomId: string,
		env: Env,
	): Promise<Request | Response> {
		const url = new URL(request.url);
		const token = url.searchParams.get("token");

		if (!token) {
			return new Response("Authentication required", { status: 401 });
		}

		const jwtSecret = env.SUPABASE_JWT_SECRET;
		if (!jwtSecret) {
			console.error("SUPABASE_JWT_SECRET is not set");
			return new Response("Server misconfigured", { status: 500 });
		}

		const user = await verifyWithSecret(token, jwtSecret);
		if (!user) {
			return new Response("Invalid authentication token", { status: 403 });
		}

		const roomSigningSecret = env.ROOM_SIGNING_SECRET;
		if (!roomSigningSecret) {
			console.error("ROOM_SIGNING_SECRET is not set");
			return new Response("Server misconfigured", { status: 500 });
		}

		// Only the creator holds a room token, which proves our API issued the
		// room id. Guests joining an existing room come without one, so whether
		// it is required is decided in onConnect, where room storage is readable.
		const roomToken = url.searchParams.get("roomToken");
		if (
			roomToken &&
			!(await verifyRoomToken(roomId, roomToken, roomSigningSecret))
		) {
			return new Response("Invalid room token", { status: 403 });
		}

		// The incoming request's headers are immutable in Workers.
		const forwarded = new Request(request);
		// Only the id is read back in onConnect. A header value carries only
		// ASCII on the wire — a display name like "はなくら😈" made workerd
		// reject the whole request.
		forwarded.headers.set("X-User-ID", user.userId);
		// Always overwritten, so a client cannot claim the check by sending it.
		forwarded.headers.set(ROOM_TOKEN_VERIFIED_HEADER, roomToken ? "1" : "0");

		return forwarded;
	}

	public async onStart() {
		await super.onStart();
		// A kick names an awareness client id, so remember which connection
		// announced each one.
		this.document.awareness.on(
			"update",
			({ added }: { added: number[] }, origin: Connection | null) => {
				if (!origin) return;
				for (const clientId of added)
					this.connClientIds.set(origin.id, clientId);
			},
		);
	}

	public async onLoad() {
		const count = await this.ctx.storage.get<number>(SNAPSHOT_CHUNK_COUNT_KEY);
		if (!count) return;

		const chunks = await this.ctx.storage.get<Uint8Array>(
			snapshotChunkKeys(count),
		);
		Y.applyUpdate(
			this.document,
			concatBytes(snapshotChunkKeys(count).map((key) => chunks.get(key))),
		);
	}

	public async onSave() {
		const update = Y.encodeStateAsUpdate(this.document);
		const count = Math.ceil(update.byteLength / SNAPSHOT_CHUNK_BYTES);
		const previousCount =
			(await this.ctx.storage.get<number>(SNAPSHOT_CHUNK_COUNT_KEY)) ?? 0;

		// The chunks and their count are written together, so a load never
		// mixes chunks from two saves.
		await this.ctx.storage.put({
			[SNAPSHOT_CHUNK_COUNT_KEY]: count,
			...Object.fromEntries(
				// slice, not subarray: storage clones a view's whole buffer.
				snapshotChunkKeys(count).map((key, i) => [
					key,
					update.slice(
						i * SNAPSHOT_CHUNK_BYTES,
						(i + 1) * SNAPSHOT_CHUNK_BYTES,
					),
				]),
			),
		});
		if (previousCount > count) {
			await this.ctx.storage.delete(
				snapshotChunkKeys(previousCount).slice(count),
			);
		}
	}

	public isReadOnly(connection: Connection) {
		return (connection.state as ConnectionState | null)?.readonly === true;
	}

	public async onConnect(conn: Connection, ctx: ConnectionContext) {
		const userId = ctx.request.headers.get("X-User-ID") ?? "";
		const url = new URL(ctx.request.url);

		// Determine owner by matching JWT userId against room creator,
		// not by trusting client-supplied query params.
		const existing = await this.ctx.storage.get<RoomMetadata>("metadata");
		// Creating a room makes the connector its owner, so only an id our API
		// issued may be created.
		if (
			!existing &&
			ctx.request.headers.get(ROOM_TOKEN_VERIFIED_HEADER) !== "1"
		) {
			conn.close(4003, "Room token required");
			return;
		}

		const isOwner = !existing || existing.createdBy === userId;

		if (!existing) {
			await this.ctx.storage.put<RoomMetadata>("metadata", {
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
		conn.setState({
			readonly: !isOwner && this.roomReadonly,
		} satisfies ConnectionState);

		super.onConnect(conn, ctx);
	}

	public onMessage(sender: Connection, message: WSMessage) {
		if (!isCustomMessage(message)) {
			super.onMessage(sender, message);
			return;
		}

		// Only owner can send custom control messages
		if (sender.id !== this.ownerConnId) return;

		const decoder = decoding.createDecoder(new Uint8Array(message));
		decoding.readVarUint(decoder);
		const subType = decoding.readVarUint(decoder);

		if (subType === CollabMessage.Kick) {
			const targetClientId = decoding.readVarUint(decoder);
			// Find connection by clientId and kick
			for (const conn of this.getConnections()) {
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
			for (const conn of this.getConnections()) {
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

	public onClose(
		conn: Connection,
		code: number,
		reason: string,
		wasClean: boolean,
	) {
		super.onClose(conn, code, reason, wasClean);
		this.connClientIds.delete(conn.id);
		if (conn.id === this.ownerConnId) {
			// Null out connection but keep ownerId for reconnection
			this.ownerConnId = null;
		}
	}

	/** HTTP endpoint: GET /parties/main/{roomId} returns Y.Doc meta as JSON. */
	public async onRequest(request: Request): Promise<Response> {
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
		const existing = await this.ctx.storage.get<RoomMetadata>("metadata");
		if (!existing) {
			return new Response(JSON.stringify({ error: "room not found" }), {
				status: 404,
				headers: { ...corsHeaders, "Content-Type": "application/json" },
			});
		}

		const yMeta = this.document.getMap("meta");
		const meta: Record<string, unknown> = {};
		yMeta.forEach((value, key) => {
			meta[key] = value;
		});

		return new Response(JSON.stringify(meta), {
			headers: { ...corsHeaders, "Content-Type": "application/json" },
		});
	}
}

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

// --- Message and snapshot helpers ---

/** A binary frame whose first varuint is our control type, not a Yjs one. */
function isCustomMessage(message: WSMessage): message is ArrayBuffer {
	if (!(message instanceof ArrayBuffer) || message.byteLength < 2) return false;
	return (
		decoding.readVarUint(decoding.createDecoder(new Uint8Array(message))) ===
		CollabMessage.Custom
	);
}

function snapshotChunkKeys(count: number) {
	return Array.from(
		{ length: count },
		(_, i) => `${SNAPSHOT_CHUNK_KEY_PREFIX}${i}`,
	);
}

function concatBytes(chunks: (Uint8Array | undefined)[]) {
	const bytes = new Uint8Array(
		chunks.reduce((sum, chunk) => sum + (chunk?.byteLength ?? 0), 0),
	);
	let offset = 0;
	for (const chunk of chunks) {
		if (!chunk) continue;
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}
