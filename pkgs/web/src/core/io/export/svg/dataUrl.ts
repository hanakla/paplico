/**
 * Encode bytes as a base64 data URL. Chunked so large images do not blow the
 * argument-spread call-stack limit of String.fromCharCode.
 */
export function bytesToDataUrl(bytes: Uint8Array, mimeType: string): string {
	const chunkSize = 0x8000;
	let binary = "";
	for (let i = 0; i < bytes.length; i += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
	}
	return `data:${mimeType};base64,${btoa(binary)}`;
}
