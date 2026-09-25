/**
 * Room key crypto for end-to-end encrypted collaboration sessions.
 *
 * The key never reaches the relay: the host generates it, hands it over through
 * the invite URL fragment, and every Yjs update and awareness payload is
 * encrypted with it before being sent. The relay only ever sees opaque bytes.
 */

const KEY_ALGORITHM = "AES-GCM";
const KEY_LENGTH = 256;
const IV_BYTE_LENGTH = 12;
const ROOM_ID_BYTE_LENGTH = 16;

export async function generateRoomKey(): Promise<CryptoKey> {
	return crypto.subtle.generateKey(
		{ name: KEY_ALGORITHM, length: KEY_LENGTH },
		true,
		["encrypt", "decrypt"],
	);
}

/** Encodes the key for the invite URL fragment. */
export async function exportRoomKey(key: CryptoKey): Promise<string> {
	const raw = await crypto.subtle.exportKey("raw", key);
	return toBase64Url(new Uint8Array(raw));
}

/** Rejects when the encoded key is malformed or has the wrong length. */
export async function importRoomKey(encoded: string): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		"raw",
		fromBase64Url(encoded),
		{ name: KEY_ALGORITHM, length: KEY_LENGTH },
		true,
		["encrypt", "decrypt"],
	);
}

/**
 * Room ids are generated on the client so that joining needs no server round
 * trip, and are long enough that guessing one is not a practical attack.
 */
export function generateRoomId(): string {
	return toBase64Url(
		crypto.getRandomValues(new Uint8Array(ROOM_ID_BYTE_LENGTH)),
	);
}

/** Returns `[IV | ciphertext]`. A fresh IV is drawn for every message. */
export async function encryptMessage(
	key: CryptoKey,
	plaintext: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
	const iv = crypto.getRandomValues(new Uint8Array(IV_BYTE_LENGTH));
	const ciphertext = await crypto.subtle.encrypt(
		{ name: KEY_ALGORITHM, iv },
		key,
		// Copied into a plain ArrayBuffer: callers hand us views produced by Yjs
		// and TextEncoder, which are not guaranteed to be backed by one.
		new Uint8Array(plaintext),
	);

	const payload = new Uint8Array(IV_BYTE_LENGTH + ciphertext.byteLength);
	payload.set(iv, 0);
	payload.set(new Uint8Array(ciphertext), IV_BYTE_LENGTH);
	return payload;
}

/**
 * Returns null when the payload is truncated, tampered with, or was encrypted
 * under a different key. Callers drop such messages instead of throwing, since
 * a relay can deliver anything.
 */
export async function decryptMessage(
	key: CryptoKey,
	payload: Uint8Array,
): Promise<Uint8Array<ArrayBuffer> | null> {
	if (payload.length <= IV_BYTE_LENGTH) return null;

	try {
		const plaintext = await crypto.subtle.decrypt(
			{
				name: KEY_ALGORITHM,
				iv: new Uint8Array(payload.subarray(0, IV_BYTE_LENGTH)),
			},
			key,
			new Uint8Array(payload.subarray(IV_BYTE_LENGTH)),
		);
		return new Uint8Array(plaintext);
	} catch {
		return null;
	}
}

function toBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

function fromBase64Url(encoded: string): Uint8Array<ArrayBuffer> {
	const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
	const padded = base64.padEnd(
		base64.length + ((4 - (base64.length % 4)) % 4),
		"=",
	);
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}
