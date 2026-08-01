import { describe, expect, it } from "vitest";
import type { CubicBezierSegment } from "../../schema";
import { resolveSegment } from "../../utils/geometry/segmentOps";
import {
	applyRotate3DToSegments,
	createRotate3DProjectionContext,
	type Rotate3DFilter,
	Rotate3DFilterProcessor,
} from "./Rotate3DFilterProcessor";

describe("Rotate3DFilterProcessor", () => {
	describe("preProcess", () => {
		it("should keep projected points finite when perspective would cross the near plane", () => {
			const handler = new Rotate3DFilterProcessor();
			const input = makeRect(0, 0, 100, 100);

			const result = handler.preProcess(
				input,
				makeFilter({
					rotateX: 0,
					rotateY: 89,
					rotateZ: 0,
					perspective: 179,
				}),
			);

			expect(result).not.toBe(input);
			for (let i = 0; i < result.length; i++) {
				const resolved = resolveSegment(
					result[i],
					i > 0 ? result[i - 1].end : undefined,
				);
				for (const point of [
					resolved.start,
					resolved.cp1,
					resolved.cp2,
					resolved.end,
				]) {
					expect(Number.isFinite(point.x)).toBe(true);
					expect(Number.isFinite(point.y)).toBe(true);
				}
			}
		});
	});

	describe("applyRotate3DToSegments", () => {
		it("should use the provided bounds as the shared rotation frame", () => {
			const glyph = makeRect(-40, 0, 20, 20);
			const params = {
				rotateX: 0,
				rotateY: 45,
				rotateZ: 0,
				perspective: 60,
			};

			const ownFrame = applyRotate3DToSegments(glyph, params);
			const sharedFrame = applyRotate3DToSegments(glyph, params, {
				minX: -50,
				minY: -10,
				maxX: 50,
				maxY: 10,
			});

			expect(sharedFrame).not.toEqual(ownFrame);
			expect(computeBounds(sharedFrame).maxX).toBeGreaterThan(
				computeBounds(ownFrame).maxX,
			);
		});

		it("should interpolate segment metadata on subdivision boundaries", () => {
			const curve = makeCurveWithPressure();

			const result = applyRotate3DToSegments(curve, {
				rotateX: 0,
				rotateY: 70,
				rotateZ: 0,
				perspective: 150,
			});

			expect(result.length).toBeGreaterThan(1);
			expect(result[0].startPressure).toBeCloseTo(0.2);
			expect(result[0].endPressure).toBeGreaterThan(0.2);
			expect(result[0].endPressure).toBeLessThan(0.8);
			expect(result[0].end.pressure).toBeGreaterThan(0.2);
			expect(result[0].end.pressure).toBeLessThan(0.8);
			expect(result.at(-1)?.endPressure).toBeCloseTo(0.8);
		});
	});

	describe("createRotate3DProjectionContext", () => {
		it("should derive perspective distance from the full half diagonal", () => {
			const input = makeRect(0, 0, 100, 100);
			const context = createRotate3DProjectionContext(
				{
					rotateX: 0,
					rotateY: 0,
					rotateZ: 1,
					perspective: 90,
				},
				input,
			);

			expect(context?.d).toBeCloseTo(Math.sqrt(100 * 100 + 100 * 100) / 2);
		});
	});
});

function makeFilter(
	params: Rotate3DFilter["paramData"]["params"],
): Rotate3DFilter {
	return {
		uid: "rotate-3d",
		processor: "3d-rotate",
		opacity: 1,
		blendMode: "normal",
		paramData: { version: "1", params },
	};
}

function makeRect(
	cx: number,
	cy: number,
	width: number,
	height: number,
): CubicBezierSegment[] {
	const halfW = width / 2;
	const halfH = height / 2;
	const p0 = { x: cx - halfW, y: cy - halfH };
	const p1 = { x: cx + halfW, y: cy - halfH };
	const p2 = { x: cx + halfW, y: cy + halfH };
	const p3 = { x: cx - halfW, y: cy + halfH };

	return [
		makeLineSegment(p0, p1, true),
		makeLineSegment(p1, p2, false),
		makeLineSegment(p2, p3, false),
		makeLineSegment(p3, p0, false, true),
	];
}

function makeLineSegment(
	start: { x: number; y: number },
	end: { x: number; y: number },
	isMoved: boolean,
	isClosed?: boolean,
): CubicBezierSegment {
	const dx = end.x - start.x;
	const dy = end.y - start.y;

	return {
		start: isMoved ? { ...start } : undefined,
		cp1: { x: dx / 3, y: dy / 3 },
		cp2: { x: -dx / 3, y: -dy / 3 },
		end: { ...end },
		startPressure: 1,
		endPressure: 1,
		startTiltX: 0,
		startTiltY: 0,
		endTiltX: 0,
		endTiltY: 0,
		startDeltaTime: 0,
		endDeltaTime: 0,
		isMoved,
		isClosed,
	};
}

function makeCurveWithPressure(): CubicBezierSegment[] {
	return [
		{
			start: { x: -50, y: 0, pressure: 0.2 },
			cp1: { x: 0, y: 100 },
			cp2: { x: 0, y: -100 },
			end: { x: 50, y: 0, pressure: 0.8 },
			startPressure: 0.2,
			endPressure: 0.8,
			startTiltX: 10,
			startTiltY: 20,
			endTiltX: 30,
			endTiltY: 40,
			startDeltaTime: 100,
			endDeltaTime: 200,
			isMoved: true,
		},
	];
}

function computeBounds(segments: CubicBezierSegment[]): {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
} {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;

	for (let i = 0; i < segments.length; i++) {
		const resolved = resolveSegment(
			segments[i],
			i > 0 ? segments[i - 1].end : undefined,
		);
		for (const point of [
			resolved.start,
			resolved.cp1,
			resolved.cp2,
			resolved.end,
		]) {
			minX = Math.min(minX, point.x);
			minY = Math.min(minY, point.y);
			maxX = Math.max(maxX, point.x);
			maxY = Math.max(maxY, point.y);
		}
	}

	return { minX, minY, maxX, maxY };
}
