import type { CubicBezierSegment } from "../../../schema";

// -- Hashing ----------------------------------------------------------------

const _hashF32 = new Float32Array(1);
const _hashU32 = new Uint32Array(_hashF32.buffer);
export function floatBits(v: number): number {
	_hashF32[0] = v;
	return _hashU32[0];
}

export function hashSegments(segments: CubicBezierSegment[]): number {
	let h = segments.length | 0;
	for (let i = 0; i < segments.length; i++) {
		const s = segments[i];
		h = (h * 31 + floatBits(s.start?.x ?? 0)) | 0;
		h = (h * 31 + floatBits(s.start?.y ?? 0)) | 0;
		h = (h * 31 + floatBits(s.cp1.x)) | 0;
		h = (h * 31 + floatBits(s.cp1.y)) | 0;
		h = (h * 31 + floatBits(s.cp2.x)) | 0;
		h = (h * 31 + floatBits(s.cp2.y)) | 0;
		h = (h * 31 + floatBits(s.end.x)) | 0;
		h = (h * 31 + floatBits(s.end.y)) | 0;
	}
	return h;
}

export function hashSegmentsWithMetadata(
	segments: CubicBezierSegment[],
): number {
	let h = hashSegments(segments);
	for (let i = 0; i < segments.length; i++) {
		const s = segments[i];
		h = (h * 31 + floatBits(s.startPressure ?? 0)) | 0;
		h = (h * 31 + floatBits(s.endPressure ?? 0)) | 0;
		h = (h * 31 + floatBits(s.startTiltX ?? 0)) | 0;
		h = (h * 31 + floatBits(s.startTiltY ?? 0)) | 0;
		h = (h * 31 + floatBits(s.endTiltX ?? 0)) | 0;
		h = (h * 31 + floatBits(s.endTiltY ?? 0)) | 0;
		h = (h * 31 + floatBits(s.startTwist ?? 0)) | 0;
		h = (h * 31 + floatBits(s.endTwist ?? 0)) | 0;
		h = (h * 31 + floatBits(s.startDeltaTime ?? 0)) | 0;
		h = (h * 31 + floatBits(s.endDeltaTime ?? 0)) | 0;
		h = (h * 31 + (s.isMoved ? 1 : 0)) | 0;
		h = (h * 31 + (s.isClosed ? 1 : 0)) | 0;
	}
	return h;
}
