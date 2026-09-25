import { uint8ToBase64 } from "../../../utils/binary";

/** Encode bytes as a base64 data URL. */
export function bytesToDataUrl(bytes: Uint8Array, mimeType: string): string {
	return `data:${mimeType};base64,${uint8ToBase64(bytes)}`;
}
