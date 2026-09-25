import { describe, expect, it } from "vitest";
import {
	expandStripBatch,
	type ReferenceCoverageMode,
	type ReferencePolygon,
	referenceCoverage,
} from "../../../testUtils/referenceCoverage";
import { tessellateStroke } from "../strokeTessellator";
import {
	appendClippedDeviceLine,
	appendTriangleSoupLines,
} from "./deviceGeometry";
import { StripRasterizer } from "./stripRenderer";
import { type ClipRect, type DeviceTransform, TILE_SIZE } from "./stripTypes";

const SIZE = 32;
const CLIP: ClipRect = { x0: 0, y0: 0, x1: SIZE, y1: SIZE };
const IDENTITY: DeviceTransform = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

describe("StripRasterizer", () => {
	it("should cover a pixel-aligned rectangle exactly", () => {
		const coverage = rasterize([rect(4, 4, 12, 8)]);
		expectPixel(coverage, 5, 5, 1);
		expectPixel(coverage, 15, 11, 1);
		expectPixel(coverage, 3, 5, 0);
		expectPixel(coverage, 16, 5, 0);
		expectPixel(coverage, 5, 12, 0);
		expect(sum(coverage)).toBeCloseTo(12 * 8, 5);
	});

	it("should give half coverage on half-pixel edges", () => {
		const coverage = rasterize([rect(4.5, 4.5, 10, 10)]);
		expectPixel(coverage, 4, 6, 0.5);
		expectPixel(coverage, 6, 4, 0.5);
		expectPixel(coverage, 4, 4, 0.25);
		expectPixel(coverage, 14, 14, 0.25);
		expectPixel(coverage, 8, 8, 1);
		// 8-bit alphas quantize each partial pixel by up to 1/510.
		expect(sum(coverage)).toBeCloseTo(100, 0);
	});

	it("should match the reference rasterizer for a rotated square", () => {
		const polygon = rotatedSquare(16, 16, 9, 0.6);
		expectMatchesReference(rasterize([polygon]), [polygon]);
	});

	it("should fill the centre of a self-intersecting star under nonzero winding", () => {
		const star = pentagram(16, 16, 13);
		const coverage = rasterize([star]);
		expectPixel(coverage, 16, 16, 1);
		// Area accumulation integrates the winding, so pixels where the
		// star's edges cross carry the integral rather than the sample count.
		expectMatchesReference(coverage, [star], "winding-integral");
	});

	it("should cut a hole when the inner contour runs the other way", () => {
		const outer = rect(4, 4, 24, 24);
		const inner = reversed(rect(12, 12, 8, 8));
		const coverage = rasterize([outer, inner]);
		expectPixel(coverage, 6, 6, 1);
		expectPixel(coverage, 15, 15, 0);
		expect(sum(coverage)).toBeCloseTo(24 * 24 - 8 * 8, 4);
	});

	it("should keep the inner area when both contours share orientation", () => {
		const coverage = rasterize([rect(4, 4, 24, 24), rect(12, 12, 8, 8)]);
		expectPixel(coverage, 15, 15, 1);
		expect(sum(coverage)).toBeCloseTo(24 * 24, 4);
	});

	it("should union overlapping same-orientation contours and cancel opposite ones", () => {
		const union = rasterize([rect(4, 4, 16, 16), rect(12, 12, 16, 16)]);
		expectPixel(union, 14, 14, 1);
		expect(sum(union)).toBeCloseTo(16 * 16 * 2 - 8 * 8, 4);

		const cancel = rasterize([
			rect(4, 4, 16, 16),
			reversed(rect(12, 12, 16, 16)),
		]);
		expectPixel(cancel, 14, 14, 0);
		expectPixel(cancel, 6, 6, 1);
		expectPixel(cancel, 24, 24, 1);
	});

	it("should keep partial coverage for a sliver thinner than a pixel", () => {
		const coverage = rasterize([rect(4, 8.25, 20, 0.25)]);
		expectPixel(coverage, 10, 8, 0.25);
		expectPixel(coverage, 10, 9, 0);
	});

	it("should clip geometry crossing all four edges of the clip rect", () => {
		const polygon = rotatedSquare(16, 16, 30, 0.3);
		expectMatchesReference(rasterize([polygon]), [polygon]);
		const shifted = rect(-10, -10, 30, 30);
		const coverage = rasterize([shifted]);
		expectPixel(coverage, 0, 0, 1);
		expectPixel(coverage, 19, 19, 1);
		expectPixel(coverage, 20, 20, 0);
		expect(sum(coverage)).toBeCloseTo(20 * 20, 4);
	});

	it("should span empty interior tiles with a fill gap instead of alpha slots", () => {
		const rasterizer = new StripRasterizer();
		addPolygon(rasterizer, rect(0, 4, 28, 4));
		const batch = rasterizer.rasterize(CLIP, { denseOnly: false });
		expect(Array.from(batch.strips)).toEqual([0, 4, 28, 4, 28, 4, 4, 4]);
		expect(batch.slotCount).toBe(8);
		expect(sum(expandStripBatch(batch, SIZE, SIZE))).toBeCloseTo(112, 5);
	});

	it("should cover up to the clip edge when geometry leaves through it", () => {
		const rasterizer = new StripRasterizer();
		addPolygon(rasterizer, rect(0, 4, 40, 4));
		const batch = rasterizer.rasterize(CLIP, { denseOnly: false });
		expect(Array.from(batch.strips)).toEqual([0, 4, 32, 4]);
		expect(batch.slotCount).toBe(4);
		expect(sum(expandStripBatch(batch, SIZE, SIZE))).toBeCloseTo(128, 5);
	});

	it("should give every covered pixel a slot in denseOnly mode", () => {
		const rasterizer = new StripRasterizer();
		addPolygon(rasterizer, rect(0, 4, 32, 4));
		const batch = rasterizer.rasterize(CLIP, { denseOnly: true });
		expect(batch.stripCount).toBe(1);
		expect(batch.strips[2]).toBe(32);
		expect(batch.strips[3]).toBe(32);
		expect(batch.slotCount).toBe(32);
		expect(batch.alphas[10 * 4 + 2]).toBe(255);
		expect(sum(expandStripBatch(batch, SIZE, SIZE))).toBeCloseTo(128, 5);
	});

	it("should emit strips row-major on tile rows", () => {
		const rasterizer = new StripRasterizer();
		addPolygon(rasterizer, pentagram(16, 16, 13));
		const batch = rasterizer.rasterize(CLIP, { denseOnly: false });
		for (let s = 1; s < batch.stripCount; s++) {
			const y0 = batch.strips[(s - 1) * 4 + 1];
			const x0 = batch.strips[(s - 1) * 4];
			const y1 = batch.strips[s * 4 + 1];
			const x1 = batch.strips[s * 4];
			expect(y1 % TILE_SIZE).toBe(0);
			expect(y1 > y0 || (y1 === y0 && x1 > x0)).toBe(true);
		}
	});

	it("should rasterize a triangle soup as the exact union regardless of orientation", () => {
		const triangles = new Float32Array([
			4, 4, 20, 4, 4, 20, 20, 4, 20, 20, 4, 20, 10, 10, 26, 12, 12, 26,
		]);
		const rasterizer = new StripRasterizer();
		appendTriangleSoupLines(rasterizer.lines, triangles, IDENTITY, CLIP);
		const coverage = expandStripBatch(
			rasterizer.rasterize(CLIP, { denseOnly: false }),
			SIZE,
			SIZE,
		);
		expectMatchesReference(coverage, [
			[4, 4, 20, 4, 4, 20],
			[20, 4, 20, 20, 4, 20],
			[10, 10, 26, 12, 12, 26],
		]);
		expectPixel(coverage, 12, 12, 1);
	});

	it("should not double count the inner edge of a stroke corner", () => {
		const { vertices } = tessellateStroke({
			points: [4.5, 24.5, 16.5, 24.5, 16.5, 6.5],
			pressures: [1, 1, 1],
			baseWidth: 8,
			sizeByPressure: 0,
			lineCap: "butt",
			lineJoin: "bevel",
			miterLimit: 4,
			isClosed: false,
		});
		const triangles = Float32Array.from(vertices);
		const rasterizer = new StripRasterizer();
		appendTriangleSoupLines(rasterizer.lines, triangles, IDENTITY, CLIP);
		const coverage = expandStripBatch(
			rasterizer.rasterize(CLIP, { denseOnly: false }),
			SIZE,
			SIZE,
		);
		expectMatchesReference(coverage, [
			[
				4.5, 20.5, 12.5, 20.5, 12.5, 6.5, 20.5, 6.5, 20.5, 24.5, 16.5, 28.5,
				4.5, 28.5,
			],
		]);
	});

	it("should reuse scratch across rasterize calls without leaking lines", () => {
		const rasterizer = new StripRasterizer();
		addPolygon(rasterizer, rect(4, 4, 8, 8));
		rasterizer.rasterize(CLIP, { denseOnly: false });
		addPolygon(rasterizer, rect(20, 20, 4, 4));
		const coverage = expandStripBatch(
			rasterizer.rasterize(CLIP, { denseOnly: false }),
			SIZE,
			SIZE,
		);
		expectPixel(coverage, 6, 6, 0);
		expectPixel(coverage, 21, 21, 1);
	});
});

function rasterize(polygons: ReferencePolygon[]): Float32Array {
	const rasterizer = new StripRasterizer();
	for (const polygon of polygons) addPolygon(rasterizer, polygon);
	return expandStripBatch(
		rasterizer.rasterize(CLIP, { denseOnly: false }),
		SIZE,
		SIZE,
	);
}

function addPolygon(
	rasterizer: StripRasterizer,
	polygon: ReferencePolygon,
): void {
	const n = polygon.length / 2;
	for (let i = 0; i < n; i++) {
		const j = (i + 1) % n;
		appendClippedDeviceLine(
			rasterizer.lines,
			polygon[i * 2],
			polygon[i * 2 + 1],
			polygon[j * 2],
			polygon[j * 2 + 1],
			CLIP,
		);
	}
}

function expectMatchesReference(
	coverage: Float32Array,
	polygons: ReferencePolygon[],
	mode: ReferenceCoverageMode = "nonzero",
): void {
	const reference = referenceCoverage(polygons, SIZE, SIZE, mode);
	let maxDiff = 0;
	for (let i = 0; i < coverage.length; i++) {
		maxDiff = Math.max(maxDiff, Math.abs(coverage[i] - reference[i]));
	}
	expect(maxDiff).toBeLessThan(0.07);
	expect(sum(coverage)).toBeCloseTo(sum(reference), 0);
}

function expectPixel(
	coverage: Float32Array,
	x: number,
	y: number,
	value: number,
): void {
	expect(coverage[y * SIZE + x]).toBeCloseTo(value, 2);
}

function sum(values: Float32Array): number {
	let total = 0;
	for (const v of values) total += v;
	return total;
}

function rect(x: number, y: number, w: number, h: number): ReferencePolygon {
	return [x, y, x + w, y, x + w, y + h, x, y + h];
}

function reversed(polygon: ReferencePolygon): ReferencePolygon {
	const out: number[] = [];
	for (let i = polygon.length - 2; i >= 0; i -= 2) {
		out.push(polygon[i], polygon[i + 1]);
	}
	return out;
}

function rotatedSquare(
	cx: number,
	cy: number,
	half: number,
	angle: number,
): ReferencePolygon {
	const c = Math.cos(angle);
	const s = Math.sin(angle);
	const corners = [
		[-half, -half],
		[half, -half],
		[half, half],
		[-half, half],
	];
	return corners.flatMap(([x, y]) => [cx + x * c - y * s, cy + x * s + y * c]);
}

function pentagram(cx: number, cy: number, radius: number): ReferencePolygon {
	const out: number[] = [];
	for (let i = 0; i < 5; i++) {
		const angle = -Math.PI / 2 + (i * 4 * Math.PI) / 5;
		out.push(cx + radius * Math.cos(angle), cy + radius * Math.sin(angle));
	}
	return out;
}
