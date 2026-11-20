/**
 * Framing for payloads sent through the relay.
 *
 * The relay refuses a single WebSocket message above 32 MiB, and a document
 * with embedded images can exceed that. A payload is therefore carried as one
 * whole frame, or as chunk frames the receiver puts back together.
 *
 * Payloads are encrypted, so a frame cannot be told apart by looking at its
 * body. Every frame starts with a byte that says which kind it is.
 *
 * Whole frame: [WHOLE_FRAME, ...payload]
 * Chunk frame: [CHUNK_FRAME, messageId u32, index u32, count u32, ...bytes]
 */

/** Well below the relay's limit, so a chunk and its header always fit. */
export const MAX_CHUNK_BYTES = 8 * 1024 * 1024;

const WHOLE_FRAME = 0;
const CHUNK_FRAME = 1;
const CHUNK_HEADER_BYTES = 13;

export function encodeFrames(
	payload: Uint8Array,
	maxChunkBytes = MAX_CHUNK_BYTES,
): Uint8Array[] {
	if (payload.length <= maxChunkBytes) {
		const frame = new Uint8Array(1 + payload.length);
		frame[0] = WHOLE_FRAME;
		frame.set(payload, 1);
		return [frame];
	}

	const messageId = crypto.getRandomValues(new Uint32Array(1))[0];
	const count = Math.ceil(payload.length / maxChunkBytes);

	return Array.from({ length: count }, (_, index) => {
		const bytes = payload.subarray(
			index * maxChunkBytes,
			(index + 1) * maxChunkBytes,
		);
		const frame = new Uint8Array(CHUNK_HEADER_BYTES + bytes.length);
		const view = new DataView(frame.buffer);
		view.setUint8(0, CHUNK_FRAME);
		view.setUint32(1, messageId);
		view.setUint32(5, index);
		view.setUint32(9, count);
		frame.set(bytes, CHUNK_HEADER_BYTES);
		return frame;
	});
}

/** Puts payloads back together from the frames that arrive, in any interleaving. */
export class FrameAssembler {
	private pending = new Map<
		number,
		{ parts: Uint8Array[]; received: number }
	>();

	/** Returns the payload once its last frame has arrived, otherwise null. */
	public push(frame: Uint8Array): Uint8Array | null {
		if (frame[0] === WHOLE_FRAME) return frame.subarray(1);
		if (frame[0] !== CHUNK_FRAME || frame.length < CHUNK_HEADER_BYTES) {
			return null;
		}

		const view = new DataView(frame.buffer, frame.byteOffset);
		const messageId = view.getUint32(1);
		const index = view.getUint32(5);
		const count = view.getUint32(9);
		if (index >= count) return null;

		let entry = this.pending.get(messageId);
		if (!entry) {
			entry = { parts: new Array(count), received: 0 };
			this.pending.set(messageId, entry);
		}
		if (entry.parts.length !== count || entry.parts[index]) return null;

		entry.parts[index] = frame.subarray(CHUNK_HEADER_BYTES);
		entry.received++;
		if (entry.received < count) return null;

		this.pending.delete(messageId);
		return concat(entry.parts);
	}

	/** Drops half-received payloads, whose remaining frames will never come. */
	public clear(): void {
		this.pending.clear();
	}
}

function concat(parts: Uint8Array[]): Uint8Array {
	const result = new Uint8Array(
		parts.reduce((sum, part) => sum + part.length, 0),
	);
	let offset = 0;
	for (const part of parts) {
		result.set(part, offset);
		offset += part.length;
	}
	return result;
}
