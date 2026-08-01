import { encodeLeb128 } from "../utils/leb128";

const OBU_SEQUENCE_HEADER = 1;
const OBU_FRAME = 6;

function obuHeader(type: number): number {
	return (type << 3) | 0x02;
}

export function packObus(
	sequenceHeader: Uint8Array,
	frameHeader: Uint8Array,
	tileData: Uint8Array,
): Uint8Array {
	const parts: Uint8Array[] = [];

	// Sequence header OBU
	const seqSizeBytes = encodeLeb128(sequenceHeader.length);
	parts.push(new Uint8Array([obuHeader(OBU_SEQUENCE_HEADER)]));
	parts.push(seqSizeBytes);
	parts.push(sequenceHeader);

	// Frame OBU (combined frame header + tile data)
	const frameSize = frameHeader.length + tileData.length;
	const frameSizeBytes = encodeLeb128(frameSize);
	parts.push(new Uint8Array([obuHeader(OBU_FRAME)]));
	parts.push(frameSizeBytes);
	parts.push(frameHeader);
	parts.push(tileData);

	const totalLength = parts.reduce((sum, p) => sum + p.length, 0);
	const result = new Uint8Array(totalLength);
	let offset = 0;
	for (const part of parts) {
		result.set(part, offset);
		offset += part.length;
	}
	return result;
}
