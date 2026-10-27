import { describe, expect, it } from "vitest";
import {
	expandStripBatch,
	layoutStrips,
	pentagram,
	type ReferenceCoverageMode,
	type ReferencePolygon,
	rect,
	referenceCoverage,
} from "../../testUtils/referenceCoverage";
import { getTestDevice } from "../../testUtils/shaderTestHarness";
import { tessellateStroke } from "../../utils/geometry/generate/strokeTessellator";
import { StripFrame } from "../canvas/pipeline/strips/StripFrame";
import type { ResidentStrips } from "../canvas/pipeline/strips/StripPagePool";
import {
	STRIP_PAGE_WIDTH,
	STRIP_PARAMS_ROWS_PER_ALPHA_ROW,
} from "../canvas/pipeline/strips/stripInstanceLayout";
import { appendTriangleSoupLines } from "../geometry/strips/deviceGeometry";
import { StripRasterizer } from "../geometry/strips/stripRenderer";
import type {
	ClipRect,
	DeviceTransform,
	StripBatch,
} from "../geometry/strips/stripTypes";
import { binStrokeParams } from "../geometry/strips/strokeParamsBinning";

const SIZE = 32;
const CLIP: ClipRect = { x0: 0, y0: 0, x1: SIZE, y1: SIZE };
const IDENTITY: DeviceTransform = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

describe("strip coverage kernels", () => {
	it("should cover a pixel-aligned rectangle exactly", async () => {
		const coverage = await rasterize([rect(4, 4, 12, 8)]);
		expectPixel(coverage, 5, 5, 1);
		expectPixel(coverage, 15, 11, 1);
		expectPixel(coverage, 3, 5, 0);
		expectPixel(coverage, 16, 5, 0);
		expectPixel(coverage, 5, 12, 0);
		expect(sum(coverage)).toBeCloseTo(12 * 8, 5);
	});

	it("should give half coverage on half-pixel edges", async () => {
		const coverage = await rasterize([rect(4.5, 4.5, 10, 10)]);
		expectPixel(coverage, 4, 6, 0.5);
		expectPixel(coverage, 6, 4, 0.5);
		expectPixel(coverage, 4, 4, 0.25);
		expectPixel(coverage, 14, 14, 0.25);
		expectPixel(coverage, 8, 8, 1);
		// 8-bit alphas quantize each partial pixel by up to 1/510.
		expect(sum(coverage)).toBeCloseTo(100, 0);
	});

	it("should match the reference rasterizer for a rotated square", async () => {
		const polygon = rotatedSquare(16, 16, 9, 0.6);
		expectMatchesReference(await rasterize([polygon]), [polygon]);
	});

	it("should fill the centre of a self-intersecting star under nonzero winding", async () => {
		const star = pentagram(16, 16, 13);
		const coverage = await rasterize([star]);
		expectPixel(coverage, 16, 16, 1);
		// Area accumulation integrates the winding, so pixels where the
		// star's edges cross carry the integral rather than the sample count.
		expectMatchesReference(coverage, [star], "winding-integral");
	});

	it("should cut a hole when the inner contour runs the other way", async () => {
		const outer = rect(4, 4, 24, 24);
		const inner = reversed(rect(12, 12, 8, 8));
		const coverage = await rasterize([outer, inner]);
		expectPixel(coverage, 6, 6, 1);
		expectPixel(coverage, 15, 15, 0);
		expect(sum(coverage)).toBeCloseTo(24 * 24 - 8 * 8, 4);
	});

	it("should keep the inner area when both contours share orientation", async () => {
		const coverage = await rasterize([rect(4, 4, 24, 24), rect(12, 12, 8, 8)]);
		expectPixel(coverage, 15, 15, 1);
		expect(sum(coverage)).toBeCloseTo(24 * 24, 4);
	});

	it("should union overlapping same-orientation contours and cancel opposite ones", async () => {
		const union = await rasterize([rect(4, 4, 16, 16), rect(12, 12, 16, 16)]);
		expectPixel(union, 14, 14, 1);
		expect(sum(union)).toBeCloseTo(16 * 16 * 2 - 8 * 8, 4);

		const cancel = await rasterize([
			rect(4, 4, 16, 16),
			reversed(rect(12, 12, 16, 16)),
		]);
		expectPixel(cancel, 14, 14, 0);
		expectPixel(cancel, 6, 6, 1);
		expectPixel(cancel, 24, 24, 1);
	});

	it("should keep partial coverage for a sliver thinner than a pixel", async () => {
		const coverage = await rasterize([rect(4, 8.25, 20, 0.25)]);
		expectPixel(coverage, 10, 8, 0.25);
		expectPixel(coverage, 10, 9, 0);
	});

	it("should clip geometry crossing all four edges of the clip rect", async () => {
		const polygon = rotatedSquare(16, 16, 30, 0.3);
		expectMatchesReference(await rasterize([polygon]), [polygon]);
		const coverage = await rasterize([rect(-10, -10, 30, 30)]);
		expectPixel(coverage, 0, 0, 1);
		expectPixel(coverage, 19, 19, 1);
		expectPixel(coverage, 20, 20, 0);
		expect(sum(coverage)).toBeCloseTo(20 * 20, 4);
	});

	it("should fill gaps and the clip edge from the winding carried into them", async () => {
		expect(sum(await rasterize([rect(0, 4, 28, 4)]))).toBeCloseTo(112, 5);
		expect(sum(await rasterize([rect(0, 4, 40, 4)]))).toBeCloseTo(128, 5);
		expect(sum(await rasterize([rect(0, 4, 32, 4)], true))).toBeCloseTo(128, 5);
	});

	it("should rasterize a triangle soup as the exact union regardless of orientation", async () => {
		const triangles = new Float32Array([
			4, 4, 20, 4, 4, 20, 20, 4, 20, 20, 4, 20, 10, 10, 26, 12, 12, 26,
		]);
		const coverage = await rasterizeTriangles(triangles);
		expectMatchesReference(coverage, [
			[4, 4, 20, 4, 4, 20],
			[20, 4, 20, 20, 4, 20],
			[10, 10, 26, 12, 12, 26],
		]);
		expectPixel(coverage, 12, 12, 1);
	});

	it("should not double count the inner edge of a stroke corner", async () => {
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
		const coverage = await rasterizeTriangles(Float32Array.from(vertices));
		expectMatchesReference(coverage, [
			[
				4.5, 20.5, 12.5, 20.5, 12.5, 6.5, 20.5, 6.5, 20.5, 24.5, 16.5, 28.5,
				4.5, 28.5,
			],
		]);
	});

	it("should keep batches of one frame apart", async () => {
		const device = await getTestDevice();
		const frame = new StripFrame(
			device,
			{} as GPURenderPipeline,
			{} as GPUBindGroupLayout,
		);
		frame.beginFrame();
		const first = layout([rect(4, 4, 8, 8)], false);
		const second = layout([rect(20, 20, 4, 4)], false);
		const firstStrips = frame.upload(first);
		const secondStrips = frame.upload(second);
		frame.finishFrame();
		const a = expand(first, await readAlphas(device, firstStrips, first));
		const b = expand(second, await readAlphas(device, secondStrips, second));
		expect(sum(a)).toBeCloseTo(64, 4);
		expect(sum(b)).toBeCloseTo(16, 4);
		expectPixel(b, 6, 6, 0);
		frame.destroy();
	});

	it("should interpolate t along and u across a stroke quad", async () => {
		// A horizontal stroke body from x=4 to x=28, y=8..16, as two triangles.
		const vertices = new Float32Array([
			4, 8, 28, 8, 4, 16, 28, 8, 28, 16, 4, 16,
		]);
		const read = await rasterizeParams(vertices);
		const left = read(4, 8);
		expect(left.t).toBeCloseTo(0.5 / 24, 1);
		expect(left.u).toBeCloseTo(0.5 / 8, 1);
		const middle = read(16, 12);
		expect(middle.t).toBeCloseTo(12.5 / 24, 1);
		expect(middle.u).toBeCloseTo(4.5 / 8, 1);
		const right = read(27, 15);
		expect(right.t).toBeCloseTo(23.5 / 24, 1);
		expect(right.u).toBeCloseTo(7.5 / 8, 1);
	});

	it("should give params to pixels a sub-pixel stroke covers without containing their centre", async () => {
		// A 0.3px tall line from x=4 to x=28 at y=8.1..8.4: every covered pixel
		// centre (y=8.5) lies outside both triangles.
		const vertices = new Float32Array([
			4, 8.1, 28, 8.1, 4, 8.4, 28, 8.1, 28, 8.4, 4, 8.4,
		]);
		const read = await rasterizeParams(vertices);
		expect(read(16, 8).t).toBeCloseTo(12.5 / 24, 1);
		expect(read(27, 8).t).toBeCloseTo(23.5 / 24, 1);
	});
});

const QUAD_PARAMS = new Float32Array([0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1]);

async function rasterize(
	polygons: ReferencePolygon[],
	denseOnly = false,
): Promise<Float32Array> {
	return runBatch(layout(polygons, denseOnly));
}

async function rasterizeTriangles(
	triangles: Float32Array,
): Promise<Float32Array> {
	const rasterizer = new StripRasterizer();
	appendTriangleSoupLines(rasterizer.lines, triangles, IDENTITY, CLIP);
	return runBatch(rasterizer.rasterize(CLIP, { denseOnly: false }));
}

/** Rasterize stroke triangles with params and return a reader of (t, u) per pixel. */
async function rasterizeParams(vertices: Float32Array) {
	const rasterizer = new StripRasterizer();
	appendTriangleSoupLines(rasterizer.lines, vertices, IDENTITY, CLIP);
	const batch = rasterizer.rasterize(CLIP, { denseOnly: true });
	binStrokeParams(batch, vertices, QUAD_PARAMS, IDENTITY, CLIP);
	const device = await getTestDevice();
	const frame = new StripFrame(
		device,
		{} as GPURenderPipeline,
		{} as GPUBindGroupLayout,
	);
	frame.beginFrame();
	const strips = frame.upload(batch);
	frame.finishFrame();
	const params = await readParams(device, strips, batch);
	frame.destroy();
	return (px: number, py: number) => {
		const band = Math.floor(py / 4) * 4;
		for (let s = 0; s < batch.stripCount; s++) {
			const x = batch.strips[s * 4];
			if (batch.strips[s * 4 + 1] !== band) continue;
			if (px < x || px >= x + batch.strips[s * 4 + 3]) continue;
			const at = ((batch.slots[s] + px - x) * 4 + (py - band)) * 2;
			return { t: params[at] / 255, u: params[at + 1] / 255 };
		}
		throw new Error(`no strip at (${px}, ${py})`);
	};
}

async function runBatch(batch: StripBatch): Promise<Float32Array> {
	const device = await getTestDevice();
	const frame = new StripFrame(
		device,
		{} as GPURenderPipeline,
		{} as GPUBindGroupLayout,
	);
	frame.beginFrame();
	const strips = frame.upload(batch);
	frame.finishFrame();
	const coverage = expand(batch, await readAlphas(device, strips, batch));
	frame.destroy();
	return coverage;
}

function layout(polygons: ReferencePolygon[], denseOnly: boolean): StripBatch {
	return layoutStrips(polygons, CLIP, denseOnly);
}

function expand(batch: StripBatch, alphas: Uint8Array): Float32Array {
	return expandStripBatch(batch, alphas, SIZE, SIZE);
}

/** The batch's alpha slots, 4 bytes each, read back from its page. */
async function readAlphas(
	device: GPUDevice,
	strips: ResidentStrips | null,
	batch: StripBatch,
): Promise<Uint8Array> {
	if (!strips?.page) return new Uint8Array(0);
	return readSlots(
		device,
		strips.page.alpha,
		strips.firstSlot,
		batch.slotCount,
		1,
	);
}

/** The batch's params, 8 bytes per slot (t, u per row), read back from its page. */
async function readParams(
	device: GPUDevice,
	strips: ResidentStrips | null,
	batch: StripBatch,
): Promise<Uint8Array> {
	const texture = strips?.page?.params;
	if (!strips || !texture) throw new Error("no params page");
	return readSlots(
		device,
		texture,
		strips.firstSlot,
		batch.slotCount,
		STRIP_PARAMS_ROWS_PER_ALPHA_ROW,
	);
}

/**
 * Read `count` slots from `firstSlot` of a page whose slot texel row spans
 * `rowsPerSlotRow` texture rows, as `rowsPerSlotRow * 4` bytes per slot.
 */
async function readSlots(
	device: GPUDevice,
	texture: GPUTexture,
	firstSlot: number,
	count: number,
	rowsPerSlotRow: number,
): Promise<Uint8Array> {
	const bytesPerRow = STRIP_PAGE_WIDTH * 4;
	const firstRow = Math.floor(firstSlot / STRIP_PAGE_WIDTH);
	const lastRow = Math.floor((firstSlot + count - 1) / STRIP_PAGE_WIDTH);
	const rows = (lastRow - firstRow + 1) * rowsPerSlotRow;
	const buffer = device.createBuffer({
		size: bytesPerRow * rows,
		usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
	});
	const encoder = device.createCommandEncoder();
	encoder.copyTextureToBuffer(
		{ texture, origin: { x: 0, y: firstRow * rowsPerSlotRow } },
		{ buffer, bytesPerRow },
		{ width: STRIP_PAGE_WIDTH, height: rows },
	);
	device.queue.submit([encoder.finish()]);
	await buffer.mapAsync(GPUMapMode.READ);
	const texels = new Uint8Array(buffer.getMappedRange().slice(0));
	buffer.unmap();
	buffer.destroy();
	const out = new Uint8Array(count * 4 * rowsPerSlotRow);
	for (let i = 0; i < count; i++) {
		const slot = firstSlot + i;
		const column = slot % STRIP_PAGE_WIDTH;
		const slotRow = Math.floor(slot / STRIP_PAGE_WIDTH) - firstRow;
		for (let r = 0; r < rowsPerSlotRow; r++) {
			const at =
				((slotRow * rowsPerSlotRow + r) * STRIP_PAGE_WIDTH + column) * 4;
			out.set(texels.subarray(at, at + 4), (i * rowsPerSlotRow + r) * 4);
		}
	}
	return out;
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
