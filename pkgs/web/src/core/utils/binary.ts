/**
 * Encode bytes as base64. Chunked so large payloads do not blow the
 * argument-spread call-stack limit of String.fromCharCode.
 */
export function uint8ToBase64(bytes: Uint8Array): string {
	const chunkSize = 0x8000;
	const parts: string[] = [];
	for (let i = 0; i < bytes.length; i += chunkSize) {
		parts.push(String.fromCharCode(...bytes.subarray(i, i + chunkSize)));
	}
	return btoa(parts.join(""));
}
