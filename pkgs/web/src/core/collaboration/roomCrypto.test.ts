import {
	decryptMessage,
	encryptMessage,
	exportRoomKey,
	generateRoomId,
	generateRoomKey,
	importRoomKey,
} from "./roomCrypto";

describe("roomCrypto", () => {
	describe("generateRoomId", () => {
		it("should return a URL-safe string", () => {
			expect(generateRoomId()).toMatch(/^[A-Za-z0-9_-]+$/);
		});

		it("should return a different id on every call", () => {
			const ids = new Set(Array.from({ length: 100 }, generateRoomId));
			expect(ids.size).toBe(100);
		});
	});

	describe("key export and import", () => {
		it("should round-trip a key through its encoded form", async () => {
			const key = await generateRoomKey();
			const restored = await importRoomKey(await exportRoomKey(key));

			const message = textBytes("survives the round trip");
			const decrypted = await decryptMessage(
				restored,
				await encryptMessage(key, message),
			);

			expect(decrypted).toEqual(message);
		});

		it("should encode the key URL-safely so it can live in a URL fragment", async () => {
			const encoded = await exportRoomKey(await generateRoomKey());
			expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
			expect(encoded).toBe(encodeURIComponent(encoded));
		});

		it("should reject a malformed encoded key", async () => {
			await expect(importRoomKey("not-a-real-key")).rejects.toThrow();
		});
	});

	describe("encryptMessage", () => {
		it("should not leave the plaintext visible in the payload", async () => {
			const key = await generateRoomKey();
			const plaintext = textBytes("secret document contents");

			const payload = await encryptMessage(key, plaintext);

			expect(containsSequence(payload, plaintext)).toBe(false);
			expect(decodeText(payload)).not.toContain("secret document contents");
		});

		it("should produce a different payload each time for the same plaintext", async () => {
			const key = await generateRoomKey();
			const plaintext = textBytes("same input");

			const first = await encryptMessage(key, plaintext);
			const second = await encryptMessage(key, plaintext);

			expect(first).not.toEqual(second);
		});
	});

	describe("decryptMessage", () => {
		it("should recover the original bytes", async () => {
			const key = await generateRoomKey();
			const plaintext = crypto.getRandomValues(new Uint8Array(1024));

			const decrypted = await decryptMessage(
				key,
				await encryptMessage(key, plaintext),
			);

			expect(decrypted).toEqual(plaintext);
		});

		it("should return null when decrypted with a different key", async () => {
			const payload = await encryptMessage(
				await generateRoomKey(),
				textBytes("for another room"),
			);

			expect(await decryptMessage(await generateRoomKey(), payload)).toBeNull();
		});

		it("should return null when the payload was tampered with", async () => {
			const key = await generateRoomKey();
			const payload = await encryptMessage(key, textBytes("do not modify"));
			payload[payload.length - 1] ^= 0xff;

			expect(await decryptMessage(key, payload)).toBeNull();
		});

		it("should return null when the payload is too short to hold an IV", async () => {
			const key = await generateRoomKey();

			expect(await decryptMessage(key, new Uint8Array(8))).toBeNull();
		});
	});
});

function textBytes(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

function decodeText(bytes: Uint8Array): string {
	return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function containsSequence(haystack: Uint8Array, needle: Uint8Array): boolean {
	for (let start = 0; start + needle.length <= haystack.length; start++) {
		let matched = true;
		for (let offset = 0; offset < needle.length && matched; offset++) {
			if (haystack[start + offset] !== needle[offset]) matched = false;
		}
		if (matched) return true;
	}
	return false;
}
