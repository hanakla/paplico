/** Validates an ICC header: 'acsp' signature at offset 36. Returns parsed colorSpace or null if invalid. */
export function inspectIccProfile(
	bytes: Uint8Array,
): { colorSpace: "rgb" | "cmyk" | "gray" | "other" } | null {
	const ICC_HEADER_SIZE = 128;
	if (bytes.length < ICC_HEADER_SIZE) return null;
	if (readSignature(bytes, 36) !== "acsp") return null;

	switch (readSignature(bytes, 16)) {
		case "RGB ":
			return { colorSpace: "rgb" };
		case "CMYK":
			return { colorSpace: "cmyk" };
		case "GRAY":
			return { colorSpace: "gray" };
		default:
			return { colorSpace: "other" };
	}
}

function readSignature(bytes: Uint8Array, offset: number): string {
	return String.fromCharCode(
		bytes[offset],
		bytes[offset + 1],
		bytes[offset + 2],
		bytes[offset + 3],
	);
}
