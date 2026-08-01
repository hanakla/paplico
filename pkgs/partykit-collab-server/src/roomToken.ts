/**
 * HMAC-SHA256 based room token verification for Cloudflare Workers.
 *
 * Uses Web Crypto API (crypto.subtle) since Node.js `crypto` is unavailable
 * in the Cloudflare Workers runtime that PartyKit runs on.
 *
 * Token format: `{roomId}:{timestamp}:{hmac_hex}`
 */

async function hmacSign(data: string, secret: string): Promise<string> {
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
	return Array.from(new Uint8Array(signature))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

function timingSafeEqualHex(left: string, right: string): boolean {
	if (left.length !== right.length) return false;

	let mismatch = 0;
	for (let i = 0; i < left.length; i++) {
		mismatch |= left.charCodeAt(i) ^ right.charCodeAt(i);
	}
	return mismatch === 0;
}

export async function verifyRoomToken(
	roomId: string,
	token: string,
	secret: string,
): Promise<boolean> {
	const parts = token.split(":");
	if (parts.length < 3) return false;

	const hmac = parts.at(-1);
	const timestamp = parts.at(-2);
	if (!hmac || !timestamp) return false;
	const tokenRoomId = parts.slice(0, -2).join(":");

	if (tokenRoomId !== roomId) return false;

	const expected = await hmacSign(`${roomId}|${timestamp}`, secret);

	if (hmac.length !== expected.length) return false;

	return timingSafeEqualHex(hmac, expected);
}
