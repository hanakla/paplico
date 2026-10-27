import type { BezierPoint, PathSegment, StrokeWidthPoint } from "../schema";

/**
 * Binary storage for a path's `segments` and `strokeWidths` in its Y.Map.
 *
 * A long stroke holds thousands of segments, and every anchor edit rewrites
 * the whole field. A Float64Array keeps that write, its read-back and the copy
 * the undo history keeps of the overwritten value small.
 *
 * Layout: slot 0 holds FORMAT_VERSION, then one fixed-size record per array
 * entry. Every field of the schema type has its own slot, in the order the
 * write functions below put them; that order is the format. An absent field is
 * NaN, so absent and 0 stay distinct and decoding adds no key that was absent.
 * Booleans are 0 and 1. The bytes are the platform's Float64 layout, which is
 * little-endian on every platform Paplico runs on.
 *
 * Fields are read and written by name rather than looked up from a table: a
 * long stroke runs this on every edit, and per-key lookups cost as much as JSON.
 * `pathFieldCodec.test.ts` round-trips a fixture typed with every schema field,
 * so a field added to the schema fails there until it has a slot here.
 *
 * Readers also accept the JSON string earlier builds wrote, which timelapse
 * recordings and collaboration rooms still hold.
 */

/** Bump when a layout below changes; decoding refuses any other version. */
const FORMAT_VERSION = 1;
const HEADER_SLOTS = 1;
const POINT_SLOTS = 7;
const SEGMENT_SLOTS = 4 * POINT_SLOTS + 14;
const STROKE_WIDTH_SLOTS = 3;

export function encodeSegments(segments: readonly PathSegment[]): Uint8Array {
	const data = allocate(segments.length, SEGMENT_SLOTS);
	let o = HEADER_SLOTS;
	for (const segment of segments) {
		writePoint(data, o, segment.start);
		writePoint(data, o + POINT_SLOTS, segment.cp1);
		writePoint(data, o + 2 * POINT_SLOTS, segment.cp2);
		writePoint(data, o + 3 * POINT_SLOTS, segment.end);
		o += 4 * POINT_SLOTS;
		data[o++] = numberSlot(segment.startPressure);
		data[o++] = numberSlot(segment.endPressure);
		data[o++] = numberSlot(segment.startTiltX);
		data[o++] = numberSlot(segment.startTiltY);
		data[o++] = numberSlot(segment.endTiltX);
		data[o++] = numberSlot(segment.endTiltY);
		data[o++] = numberSlot(segment.startTwist);
		data[o++] = numberSlot(segment.endTwist);
		data[o++] = numberSlot(segment.startDeltaTime);
		data[o++] = numberSlot(segment.endDeltaTime);
		data[o++] = booleanSlot(segment.isMoved);
		data[o++] = booleanSlot(segment.isClosed);
		data[o++] = numberSlot(segment.cornerRadius);
		data[o++] = numberSlot(segment.cornerSuperellipseN);
	}
	return new Uint8Array(data.buffer);
}

/** Decode a stored `segments` value, binary or the JSON string of earlier builds. */
export function decodeSegments(stored: unknown): PathSegment[] {
	if (typeof stored === "string") return JSON.parse(stored);
	const data = readSlots(stored, SEGMENT_SLOTS, "segments");
	const segments: PathSegment[] = [];
	for (let o = HEADER_SLOTS; o < data.length; o += SEGMENT_SLOTS) {
		const segment = {} as PathSegment;
		const start = readPoint(data, o);
		if (start) segment.start = start;
		const cp1 = readPoint(data, o + POINT_SLOTS);
		if (cp1) segment.cp1 = cp1;
		const cp2 = readPoint(data, o + 2 * POINT_SLOTS);
		if (cp2) segment.cp2 = cp2;
		const end = readPoint(data, o + 3 * POINT_SLOTS);
		if (end) segment.end = end;
		let s = o + 4 * POINT_SLOTS;
		let v = data[s++];
		if (!Number.isNaN(v)) segment.startPressure = v;
		v = data[s++];
		if (!Number.isNaN(v)) segment.endPressure = v;
		v = data[s++];
		if (!Number.isNaN(v)) segment.startTiltX = v;
		v = data[s++];
		if (!Number.isNaN(v)) segment.startTiltY = v;
		v = data[s++];
		if (!Number.isNaN(v)) segment.endTiltX = v;
		v = data[s++];
		if (!Number.isNaN(v)) segment.endTiltY = v;
		v = data[s++];
		if (!Number.isNaN(v)) segment.startTwist = v;
		v = data[s++];
		if (!Number.isNaN(v)) segment.endTwist = v;
		v = data[s++];
		if (!Number.isNaN(v)) segment.startDeltaTime = v;
		v = data[s++];
		if (!Number.isNaN(v)) segment.endDeltaTime = v;
		v = data[s++];
		if (!Number.isNaN(v)) segment.isMoved = v === 1;
		v = data[s++];
		if (!Number.isNaN(v)) segment.isClosed = v === 1;
		v = data[s++];
		if (!Number.isNaN(v)) segment.cornerRadius = v;
		v = data[s++];
		if (!Number.isNaN(v)) segment.cornerSuperellipseN = v;
		segments.push(segment);
	}
	return segments;
}

export function encodeStrokeWidths(
	points: readonly StrokeWidthPoint[],
): Uint8Array {
	const data = allocate(points.length, STROKE_WIDTH_SLOTS);
	let o = HEADER_SLOTS;
	for (const point of points) {
		data[o++] = numberSlot(point.t);
		data[o++] = numberSlot(point.side1);
		data[o++] = numberSlot(point.side2);
	}
	return new Uint8Array(data.buffer);
}

/** Decode a stored `strokeWidths` value, binary or the JSON string of earlier builds. */
export function decodeStrokeWidths(stored: unknown): StrokeWidthPoint[] {
	if (typeof stored === "string") return JSON.parse(stored);
	const data = readSlots(stored, STROKE_WIDTH_SLOTS, "strokeWidths");
	const points: StrokeWidthPoint[] = [];
	for (let o = HEADER_SLOTS; o < data.length; o += STROKE_WIDTH_SLOTS) {
		const point = {} as StrokeWidthPoint;
		if (!Number.isNaN(data[o])) point.t = data[o];
		if (!Number.isNaN(data[o + 1])) point.side1 = data[o + 1];
		if (!Number.isNaN(data[o + 2])) point.side2 = data[o + 2];
		points.push(point);
	}
	return points;
}

function allocate(count: number, stride: number): Float64Array {
	const data = new Float64Array(HEADER_SLOTS + count * stride);
	data[0] = FORMAT_VERSION;
	return data;
}

function numberSlot(value: number | undefined): number {
	return typeof value === "number" ? value : Number.NaN;
}

function booleanSlot(value: boolean | undefined): number {
	if (typeof value !== "boolean") return Number.NaN;
	return value ? 1 : 0;
}

function writePoint(
	data: Float64Array,
	o: number,
	point: BezierPoint | undefined,
): void {
	data[o] = numberSlot(point?.x);
	data[o + 1] = numberSlot(point?.y);
	data[o + 2] = numberSlot(point?.pressure);
	data[o + 3] = numberSlot(point?.tiltX);
	data[o + 4] = numberSlot(point?.tiltY);
	data[o + 5] = numberSlot(point?.twist);
	data[o + 6] = numberSlot(point?.deltaTime);
}

/** A point whose every slot is absent was itself absent (an optional `start`). */
function readPoint(data: Float64Array, o: number): BezierPoint | null {
	let present = false;
	for (let i = o; i < o + POINT_SLOTS; i++) {
		if (!Number.isNaN(data[i])) present = true;
	}
	if (!present) return null;
	const point = {} as BezierPoint;
	if (!Number.isNaN(data[o])) point.x = data[o];
	if (!Number.isNaN(data[o + 1])) point.y = data[o + 1];
	if (!Number.isNaN(data[o + 2])) point.pressure = data[o + 2];
	if (!Number.isNaN(data[o + 3])) point.tiltX = data[o + 3];
	if (!Number.isNaN(data[o + 4])) point.tiltY = data[o + 4];
	if (!Number.isNaN(data[o + 5])) point.twist = data[o + 5];
	if (!Number.isNaN(data[o + 6])) point.deltaTime = data[o + 6];
	return point;
}

function readSlots(
	stored: unknown,
	stride: number,
	field: string,
): Float64Array {
	if (!(stored instanceof Uint8Array)) {
		throw new Error(`${field}: stored value is neither binary nor JSON`);
	}
	if (stored.byteLength % Float64Array.BYTES_PER_ELEMENT !== 0) {
		throw new Error(`${field}: binary length is not a whole number of slots`);
	}
	// Yjs hands out views into its update buffer at any byte offset, and a
	// Float64Array view needs one aligned to 8.
	const bytes =
		stored.byteOffset % Float64Array.BYTES_PER_ELEMENT === 0
			? stored
			: stored.slice();
	const data = new Float64Array(
		bytes.buffer,
		bytes.byteOffset,
		bytes.byteLength / Float64Array.BYTES_PER_ELEMENT,
	);
	if (data[0] !== FORMAT_VERSION) {
		throw new Error(`${field}: unknown binary format version ${data[0]}`);
	}
	if ((data.length - HEADER_SLOTS) % stride !== 0) {
		throw new Error(`${field}: binary length does not match its layout`);
	}
	return data;
}
