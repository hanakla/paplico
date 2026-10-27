import { beforeAll, describe, expect, it } from "vitest";
import type {
	BezierPoint,
	Document,
	PathSegment,
	StrokeWidthPoint,
} from "../schema";
import { loadTestDocument } from "../testUtils/loadTestDocument";
import {
	decodeSegments,
	decodeStrokeWidths,
	encodeSegments,
	encodeStrokeWidths,
} from "./pathFieldCodec";

let testDoc: Document;
beforeAll(async () => {
	testDoc = await loadTestDocument();
});

describe("pathFieldCodec", () => {
	it("should restore every path of the test document exactly", () => {
		const paths = Object.values(testDoc.objects).filter(
			(object) => object.type === "path",
		);
		expect(paths.length).toBeGreaterThan(0);

		for (const path of paths) {
			expect(decodeSegments(encodeSegments(path.segments))).toStrictEqual(
				path.segments,
			);
			if (!path.strokeWidths) continue;
			expect(
				decodeStrokeWidths(encodeStrokeWidths(path.strokeWidths)),
			).toStrictEqual(path.strokeWidths);
		}
	});

	it("should restore every field the schema gives a segment and a stroke width point", () => {
		// Typed Required<>, so a field added to the schema fails to compile here
		// until the fixture, and then the codec, carry it.
		const point = (base: number): Required<BezierPoint> => ({
			x: base + 1,
			y: base + 2,
			pressure: base + 3,
			tiltX: base + 4,
			tiltY: base + 5,
			twist: base + 6,
			deltaTime: base + 7,
		});
		const full: Required<PathSegment> = {
			start: point(0),
			cp1: point(10),
			cp2: point(20),
			end: point(30),
			startPressure: 41,
			endPressure: 42,
			startTiltX: 43,
			startTiltY: 44,
			endTiltX: 45,
			endTiltY: 46,
			startTwist: 47,
			endTwist: 48,
			startDeltaTime: 49,
			endDeltaTime: 50,
			isMoved: true,
			isClosed: true,
			cornerRadius: 51,
			cornerSuperellipseN: 52,
		};
		const width: Required<StrokeWidthPoint> = { t: 0.25, side1: 2, side2: 3 };

		expect(decodeSegments(encodeSegments([full]))).toStrictEqual([full]);
		expect(decodeStrokeWidths(encodeStrokeWidths([width]))).toStrictEqual([
			width,
		]);
	});

	it("should keep an absent optional field absent and a zero zero", () => {
		const segments = [
			segment({ startPressure: 0, cornerRadius: 0 }),
			segment({ endPressure: 0.5 }),
		];

		const decoded = decodeSegments(encodeSegments(segments));

		expect(decoded).toStrictEqual(segments);
		expect(decoded[1]).not.toHaveProperty("startPressure");
		expect(decoded[1]).not.toHaveProperty("cornerRadius");
	});

	it("should restore booleans as booleans and leave an absent one absent", () => {
		const segments = [
			segment({ isMoved: true, isClosed: false }),
			segment({ isMoved: false, isClosed: true }),
			segment({ isMoved: false }),
		];

		const decoded = decodeSegments(encodeSegments(segments));

		expect(decoded).toStrictEqual(segments);
		expect(decoded[2]).not.toHaveProperty("isClosed");
	});

	it("should restore every optional field of each point", () => {
		const point = {
			x: 1,
			y: -2,
			pressure: 0.3,
			tiltX: 10,
			tiltY: -20,
			twist: 270,
			deltaTime: 16,
		};
		const segments = [
			segment({ start: point, cp1: point, cp2: { x: 0, y: 0 }, end: point }),
		];

		expect(decodeSegments(encodeSegments(segments))).toStrictEqual(segments);
	});

	it("should leave out a start the segment did not have", () => {
		const segments = [segment({ start: { x: 0, y: 0 } }), segment({})];

		const decoded = decodeSegments(encodeSegments(segments));

		expect(decoded[0].start).toStrictEqual({ x: 0, y: 0 });
		expect(decoded[1]).not.toHaveProperty("start");
	});

	it("should restore stroke widths exactly", () => {
		const points: StrokeWidthPoint[] = [
			{ t: 0, side1: 1, side2: 1 },
			{ t: 0.5, side1: -0.25, side2: 0 },
			{ t: 1, side1: 0.75, side2: 1.5 },
		];

		expect(decodeStrokeWidths(encodeStrokeWidths(points))).toStrictEqual(
			points,
		);
	});

	it("should restore empty arrays", () => {
		expect(decodeSegments(encodeSegments([]))).toStrictEqual([]);
		expect(decodeStrokeWidths(encodeStrokeWidths([]))).toStrictEqual([]);
	});

	it("should read the JSON strings that paths used to be stored as", () => {
		const segments = [segment({ start: { x: 1, y: 2 }, startPressure: 0.5 })];
		const points: StrokeWidthPoint[] = [{ t: 0.5, side1: 1, side2: 0.5 }];

		expect(decodeSegments(JSON.stringify(segments))).toStrictEqual(segments);
		expect(decodeStrokeWidths(JSON.stringify(points))).toStrictEqual(points);
	});

	it("should read bytes that start at an offset Float64Array cannot view", () => {
		const segments = [segment({ cornerRadius: 4 })];
		const encoded = encodeSegments(segments);
		const buffer = new Uint8Array(encoded.byteLength + 3);
		buffer.set(encoded, 3);

		expect(decodeSegments(buffer.subarray(3))).toStrictEqual(segments);
	});

	it("should refuse a format version it does not know", () => {
		const encoded = encodeSegments([segment({})]);
		new Float64Array(encoded.buffer)[0] = 2;

		expect(() => decodeSegments(encoded)).toThrow(/format version/);
	});

	it("should refuse a stored value that is neither binary nor JSON", () => {
		expect(() => decodeSegments(undefined)).toThrow();
	});
});

function segment(fields: Partial<PathSegment>): PathSegment {
	return {
		cp1: { x: 0, y: 0 },
		cp2: { x: 0, y: 0 },
		end: { x: 10, y: 10 },
		startTiltX: 0,
		startTiltY: 0,
		endTiltX: 0,
		endTiltY: 0,
		startDeltaTime: 0,
		endDeltaTime: 0,
		isMoved: false,
		...fields,
	};
}
