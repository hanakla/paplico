import { describe, expect, it } from "vitest";
import { createIdentityTransform } from "../../document/factory";
import type {
	BezierPoint,
	CubicBezierSegment,
	FillAppearance,
	Path,
	StrokeAppearance,
} from "../../schema";
import {
	getWorldSegments,
	hashSegmentsWithMetadata,
	resolveSegment,
	toWorldPath,
	translateSegments,
} from "./segmentOps";

describe("translateSegments", () => {
	it("translates only anchors and keeps cp offsets unchanged", () => {
		const segments: CubicBezierSegment[] = [
			{
				start: { x: 10, y: 20 },
				cp1: { x: 5, y: -3 },
				cp2: { x: -7, y: 4 },
				end: { x: 100, y: 200 },
				startPressure: 0.3,
				endPressure: 0.8,
				startTiltX: 0,
				startTiltY: 0,
				endTiltX: 0,
				endTiltY: 0,
				startDeltaTime: 0,
				endDeltaTime: 0,
				isMoved: true,
			},
			{
				cp1: { x: 12, y: 6 },
				cp2: { x: -9, y: 2 },
				end: { x: 150, y: 240 },
				startTiltX: 0,
				startTiltY: 0,
				endTiltX: 0,
				endTiltY: 0,
				startDeltaTime: 0,
				endDeltaTime: 0,
				isMoved: false,
			},
		];

		const translated = translateSegments(segments, 30, -10);

		expect(translated[0].start).toEqual({ x: 40, y: 10 });
		expect(translated[0].end).toEqual({ x: 130, y: 190 });
		expect(translated[1].start).toBeUndefined();
		expect(translated[1].end).toEqual({ x: 180, y: 230 });

		expect(translated[0].cp1).toEqual(segments[0].cp1);
		expect(translated[0].cp2).toEqual(segments[0].cp2);
		expect(translated[1].cp1).toEqual(segments[1].cp1);
		expect(translated[1].cp2).toEqual(segments[1].cp2);
		expect(translated[0].startPressure).toBe(segments[0].startPressure);
		expect(translated[0].endPressure).toBe(segments[0].endPressure);
	});

	it("keeps absolute control points shifted by the same delta with resolveSegment", () => {
		const segments: CubicBezierSegment[] = [
			{
				start: { x: 0, y: 0 },
				cp1: { x: 10, y: 0 },
				cp2: { x: -10, y: 0 },
				end: { x: 100, y: 0 },
				startTiltX: 0,
				startTiltY: 0,
				endTiltX: 0,
				endTiltY: 0,
				startDeltaTime: 0,
				endDeltaTime: 0,
				isMoved: true,
			},
			{
				cp1: { x: 20, y: 10 },
				cp2: { x: -15, y: 5 },
				end: { x: 150, y: 40 },
				startTiltX: 0,
				startTiltY: 0,
				endTiltX: 0,
				endTiltY: 0,
				startDeltaTime: 0,
				endDeltaTime: 0,
				isMoved: false,
			},
		];
		const deltaX = 37;
		const deltaY = -19;

		const translated = translateSegments(segments, deltaX, deltaY);

		const originalSeg0 = resolveSegment(segments[0]);
		const translatedSeg0 = resolveSegment(translated[0]);
		expect(translatedSeg0.start.x - originalSeg0.start.x).toBe(deltaX);
		expect(translatedSeg0.start.y - originalSeg0.start.y).toBe(deltaY);
		expect(translatedSeg0.end.x - originalSeg0.end.x).toBe(deltaX);
		expect(translatedSeg0.end.y - originalSeg0.end.y).toBe(deltaY);
		expect(translatedSeg0.cp1.x - originalSeg0.cp1.x).toBe(deltaX);
		expect(translatedSeg0.cp1.y - originalSeg0.cp1.y).toBe(deltaY);
		expect(translatedSeg0.cp2.x - originalSeg0.cp2.x).toBe(deltaX);
		expect(translatedSeg0.cp2.y - originalSeg0.cp2.y).toBe(deltaY);

		const originalSeg1 = resolveSegment(segments[1], segments[0].end);
		const translatedSeg1 = resolveSegment(translated[1], translated[0].end);
		expect(translated[1].start).toBeUndefined();
		expect(translatedSeg1.start.x - originalSeg1.start.x).toBe(deltaX);
		expect(translatedSeg1.start.y - originalSeg1.start.y).toBe(deltaY);
		expect(translatedSeg1.end.x - originalSeg1.end.x).toBe(deltaX);
		expect(translatedSeg1.end.y - originalSeg1.end.y).toBe(deltaY);
		expect(translatedSeg1.cp1.x - originalSeg1.cp1.x).toBe(deltaX);
		expect(translatedSeg1.cp1.y - originalSeg1.cp1.y).toBe(deltaY);
		expect(translatedSeg1.cp2.x - originalSeg1.cp2.x).toBe(deltaX);
		expect(translatedSeg1.cp2.y - originalSeg1.cp2.y).toBe(deltaY);
	});
});

describe("toWorldPath", () => {
	it("keeps geometry unchanged when transform is identity", () => {
		const path = createPath(createIdentityTransform());

		const worldPath = toWorldPath(path);

		expect(worldPath.transform).toEqual(createIdentityTransform());
		const originalResolved = resolvePathSegments(path);
		const worldResolved = resolvePathSegments(worldPath);
		expect(worldResolved).toEqual(originalResolved);
	});

	it("applies transform to anchors and control points", () => {
		const path = createPath({
			x: 120,
			y: -40,
			rotation: Math.PI / 5,
			scaleX: 1.3,
			scaleY: 0.7,
		});

		const worldPath = toWorldPath(path);
		const expectedWorld = getWorldSegments(path);
		const actualWorld = resolvePathSegments(worldPath);

		expect(worldPath.transform).toEqual(createIdentityTransform());
		expect(actualWorld).toHaveLength(expectedWorld.length);
		for (let i = 0; i < expectedWorld.length; i++) {
			const expected = expectedWorld[i];
			const actual = actualWorld[i];
			assertPointClose(actual.start, expected.start);
			assertPointClose(actual.cp1, expected.cp1);
			assertPointClose(actual.cp2, expected.cp2);
			assertPointClose(actual.end, expected.end);
		}
	});

	it("preserves segment metadata fields", () => {
		const path = createPath({
			x: 20,
			y: 10,
			rotation: Math.PI / 8,
			scaleX: 0.9,
			scaleY: 1.2,
		});

		const worldPath = toWorldPath(path);

		expect(worldPath.segments).toHaveLength(path.segments.length);
		for (let i = 0; i < path.segments.length; i++) {
			expect(worldPath.segments[i].isMoved).toBe(path.segments[i].isMoved);
			expect(worldPath.segments[i].isClosed).toBe(path.segments[i].isClosed);
			expect(worldPath.segments[i].startPressure).toBe(
				path.segments[i].startPressure,
			);
			expect(worldPath.segments[i].endPressure).toBe(
				path.segments[i].endPressure,
			);
		}
	});
});

function createPath(transform: Path["transform"]): Path {
	const segments: CubicBezierSegment[] = [
		{
			start: { x: 10, y: 20 },
			cp1: { x: 35, y: -8 },
			cp2: { x: -24, y: 14 },
			end: { x: 80, y: 50 },
			startPressure: 0.3,
			endPressure: 0.7,
			startTiltX: 0,
			startTiltY: 0,
			endTiltX: 0,
			endTiltY: 0,
			startDeltaTime: 0,
			endDeltaTime: 0,
			isMoved: true,
		},
		{
			cp1: { x: 12, y: -5 },
			cp2: { x: -16, y: 9 },
			end: { x: 120, y: 85 },
			startPressure: 0.7,
			endPressure: 1,
			startTiltX: 0,
			startTiltY: 0,
			endTiltX: 0,
			endTiltY: 0,
			startDeltaTime: 0,
			endDeltaTime: 0,
			isMoved: false,
			isClosed: true,
		},
	];

	return {
		type: "path",
		id: "path-1",
		segments,
		filters: [
			{
				processor: "stroke",
				paramData: {
					version: "1",
					params: {
						strokeColor: {
							type: "solid",
							color: { type: "rgb", r: 0, g: 0, b: 0, a: 1 },
						},
						brushSettings: { type: "line", size: 2, opacity: 1 },
					},
				},
			} as unknown as StrokeAppearance,
			{
				processor: "fill",
				paramData: {
					version: "1",
					params: {
						fill: {
							type: "solid",
							color: { type: "rgb", r: 1, g: 0.4, b: 0.2, a: 0.8 },
						},
					},
				},
			} as FillAppearance,
		],
		opacity: 1,
		blendMode: "normal",
		transform,
	};
}

function resolvePathSegments(path: Path): Array<{
	start: BezierPoint;
	cp1: BezierPoint;
	cp2: BezierPoint;
	end: BezierPoint;
}> {
	const resolved: Array<{
		start: BezierPoint;
		cp1: BezierPoint;
		cp2: BezierPoint;
		end: BezierPoint;
	}> = [];
	let prevEnd: BezierPoint | undefined;
	for (const segment of path.segments) {
		const point = resolveSegment(segment, prevEnd);
		resolved.push(point);
		prevEnd = segment.end;
	}
	return resolved;
}

function assertPointClose(
	actual: { x: number; y: number } | undefined,
	expected: { x: number; y: number } | undefined,
): void {
	expect(actual).toBeDefined();
	expect(expected).toBeDefined();
	expect(actual?.x).toBeCloseTo(expected?.x ?? 0, 6);
	expect(actual?.y).toBeCloseTo(expected?.y ?? 0, 6);
}

describe("hashSegmentsWithMetadata", () => {
	function metaSegment(
		overrides: Partial<CubicBezierSegment> = {},
	): CubicBezierSegment {
		return {
			start: { x: 0, y: 0 },
			cp1: { x: 1, y: 0 },
			cp2: { x: -1, y: 0 },
			end: { x: 10, y: 0 },
			startPressure: 0.5,
			endPressure: 0.5,
			startTiltX: 0,
			startTiltY: 0,
			endTiltX: 0,
			endTiltY: 0,
			startDeltaTime: 0,
			endDeltaTime: 10,
			isMoved: true,
			...overrides,
		};
	}

	it("should change when only the twist endpoints change", () => {
		const base = hashSegmentsWithMetadata([metaSegment()]);
		const twisted = hashSegmentsWithMetadata([
			metaSegment({ startTwist: 90, endTwist: 180 }),
		]);
		expect(twisted).not.toBe(base);
	});

	it("should stay stable for identical twist endpoints", () => {
		const a = hashSegmentsWithMetadata([
			metaSegment({ startTwist: 90, endTwist: 180 }),
		]);
		const b = hashSegmentsWithMetadata([
			metaSegment({ startTwist: 90, endTwist: 180 }),
		]);
		expect(a).toBe(b);
	});
});
