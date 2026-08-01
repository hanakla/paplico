/**
 * HMAC-SHA256 based room token signing.
 *
 * Token format: `{roomId}:{timestamp}:{hmac_hex}`
 * - roomId: the room identifier (UUID)
 * - timestamp: creation time in ms (for auditability; no TTL enforced)
 * - hmac_hex: HMAC-SHA256(roomId|timestamp, secret) in hex
 *
 * Used by the API Route to issue tokens.
 * Verification is done on the PartyKit side (Cloudflare Workers)
 * via pkgs/partykit-collab-server/src/roomToken.ts.
 */

import { createHmac } from "node:crypto";

export function signRoomId(roomId: string, secret: string): string {
	const timestamp = Date.now().toString();
	const hmac = createHmac("sha256", secret)
		.update(`${roomId}|${timestamp}`)
		.digest("hex");
	return `${roomId}:${timestamp}:${hmac}`;
}
