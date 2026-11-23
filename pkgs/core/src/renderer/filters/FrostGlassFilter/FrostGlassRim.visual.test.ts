import { describe, expect, it } from "vitest";
import { getTestDevice } from "../../../testUtils/shaderTestHarness";
import { captureTexturePixels } from "../../../testUtils/visualRegression";
import {
	type FilterCoordinateSpace,
	FilterRenderer,
} from "../../canvas/pipeline/FilterRenderer";
import {
	type FrostGlassFilter,
	FrostGlassFilterHandler,
	type FrostGlassParams,
} from "./FrostGlassFilter";

const SIZE = 96;
/** The element is a 64 px square centred in the 96 px region. */
const SHAPE_MIN = 16;
const SHAPE_MAX = 80;
/** The curved-edge element is a circle centred in the region. */
const CIRCLE_CENTER = 48;
const CIRCLE_RADIUS = 44;
/** Width of each stripe the curved-edge test's backdrop alternates. */
const STRIPE_WIDTH = 6;
/** Mean difference per texel near the curved edge, as a share of the stripe contrast. */
const STREAK_TOLERANCE = 0.07;

describe("FrostGlass rim", () => {
	it("should leave the flat face of the pane unshifted", async () => {
		const out = await runRim(
			{ radius: 0, bevel: 16, refraction: 12 },
			"backdrop",
		);

		expect(at(out, 48, 48)).toBeCloseTo(rampValue(48), 2);
	});

	it("should show the backdrop from further inward near the edge on the backdrop route", async () => {
		const out = await runRim(
			{ radius: 0, bevel: 16, refraction: 12 },
			"backdrop",
		);

		// Three texels inside the left edge the rim shifts the read about
		// 8 texels inward, i.e. toward brighter ramp values.
		expect(at(out, 18, 48) - rampValue(18)).toBeGreaterThan(0.04);
	});

	it("should refract the element's own picture on the element route", async () => {
		const out = await runRim(
			{ radius: 0, bevel: 16, refraction: 12 },
			"element",
		);

		expect(at(out, 18, 48) - rampValue(18)).toBeGreaterThan(0.04);
		expect(at(out, 48, 48)).toBeCloseTo(rampValue(48), 2);
	});

	it("should brighten the rim with the highlight", async () => {
		const out = await runRim(
			{ radius: 0, bevel: 16, highlight: 1 },
			"backdrop",
		);

		expect(at(out, 48, 17) - rampValue(48)).toBeGreaterThan(0.2);
		expect(at(out, 48, 48)).toBeCloseTo(rampValue(48), 2);
	});

	it("should keep pixels outside the shape around a backdrop pane with a rim", () => {
		const frost = new FrostGlassFilterHandler();
		const filter = {
			uid: "frost-rim-margin-test",
			processor: "frost-glass",
			enabled: true,
			applyToBackdrop: true,
			paramData: {
				version: "1",
				params: { radius: 0, bevel: 16, refraction: 12 },
			},
		} as unknown as FrostGlassFilter;

		// The rim finds the edge from the pixels outside the shape, so the
		// backdrop region must reach past the element on every side.
		expect(frost.getExpansionMargin(filter)).toBeGreaterThan(0);
	});

	it("should show a wider patch of the backdrop as the pane moves away from it", async () => {
		const out = await runRim({ radius: 0, distance: 8 }, "backdrop", {
			worldSize: { width: SIZE, height: SIZE },
			sourceOffset: { x: 0, y: 0 },
			elementRect: {
				x: SHAPE_MIN,
				y: SHAPE_MIN,
				width: SHAPE_MAX - SHAPE_MIN,
				height: SHAPE_MAX - SHAPE_MIN,
			},
		});

		// The pane scales its read by 1.25 about its centre, so x = 18 reads
		// about 7 texels further left, where the ramp is darker. Its centre
		// still reads in place.
		expect(rampValue(18) - at(out, 18, 48)).toBeGreaterThan(0.05);
		expect(at(out, 48, 48)).toBeCloseTo(rampValue(48), 1);
	});

	it("should capture the backdrop as far out as a distant pane reads", () => {
		const frost = new FrostGlassFilterHandler();
		const filter = {
			uid: "frost-distance-margin-test",
			processor: "frost-glass",
			enabled: true,
			applyToBackdrop: true,
			paramData: { version: "1", params: { radius: 4, distance: 30 } },
		} as unknown as FrostGlassFilter;

		expect(frost.getExpansionMargin(filter)).toBeGreaterThanOrEqual(30);
	});

	it("should bend a curved edge smoothly without radial streaks", async () => {
		const bevel = 40;
		const refraction = 30;
		const out = await runRimOverCircle({ radius: 0, bevel, refraction });

		// Near the edge, compare each texel with the backdrop read along the
		// circle's true normal. A streak reads from the wrong place, which the
		// sharp stripes turn into a large difference.
		let total = 0;
		let count = 0;
		for (let y = 0; y < SIZE; y++) {
			for (let x = 0; x < SIZE; x++) {
				const dx = x + 0.5 - CIRCLE_CENTER;
				const dy = y + 0.5 - CIRCLE_CENTER;
				const r = Math.hypot(dx, dy);
				const depth = CIRCLE_RADIUS - r;
				if (depth < 1 || depth > 12) continue;
				const t = 1 - depth / bevel;
				const expected = stripeAt(x + 0.5 - (dx / r) * refraction * t * t);
				total += Math.abs(out[(y * SIZE + x) * 4] / 255 - expected);
				count++;
			}
		}
		expect(total / count).toBeLessThan(STREAK_TOLERANCE);
	});
});

// Helpers

/** Red channel of the horizontal ramp the source carries at column x. */
function rampValue(x: number): number {
	return (x * 2 + 20) / 255;
}

/** Red channel of the stripes at a texel-space x, bilinear between texels. */
function stripeAt(u: number): number {
	const left = Math.floor(u - 0.5);
	const f = u - 0.5 - left;
	return stripeValue(left) * (1 - f) + stripeValue(left + 1) * f;
}

function stripeValue(x: number): number {
	return Math.floor(x / STRIPE_WIDTH) % 2 ? 1 : 0;
}

/** Red channel at texel (x, y), normalized to 0~1. */
function at(pixels: Uint8Array, x: number, y: number): number {
	return pixels[(y * SIZE + x) * 4] / 255;
}

/**
 * Run one frost glass filter over a horizontal ramp. On the backdrop route
 * the ramp fills the region and the square arrives as the mask; on the
 * element route the ramp only covers the square, whose alpha is the shape.
 */
async function runRim(
	params: FrostGlassParams,
	route: "backdrop" | "element",
	coordinateSpace?: FilterCoordinateSpace,
): Promise<Uint8Array> {
	const device = await getTestDevice();
	const filterRenderer = new FilterRenderer(device);
	const frost = new FrostGlassFilterHandler();
	await frost.initialize(device, "rgba8unorm");
	filterRenderer.registerHandler("frost-glass", frost);
	frost.startFrame();

	const filter = {
		uid: "frost-rim-test",
		processor: "frost-glass",
		enabled: true,
		applyToBackdrop: route === "backdrop",
		paramData: { version: "1", params },
	} as unknown as FrostGlassFilter;
	const source = createTexture(device, (x, y) =>
		route === "backdrop" || insideShape(x, y) ? rampValue(x) : -1,
	);
	const mask =
		route === "backdrop"
			? createTexture(device, (x, y) => (insideShape(x, y) ? 1 : -1))
			: undefined;

	const encoder = device.createCommandEncoder();
	const { texture } = filterRenderer.applyFilters(
		source,
		[filter],
		encoder,
		mask,
		1,
		undefined,
		undefined,
		undefined,
		undefined,
		coordinateSpace,
	);
	device.queue.submit([encoder.finish()]);
	await device.queue.onSubmittedWorkDone();
	return captureTexturePixels(device, texture, SIZE, SIZE);
}

/**
 * Run the rim on the backdrop route over vertical stripes, with a circle as
 * the element's shape.
 */
async function runRimOverCircle(params: FrostGlassParams): Promise<Uint8Array> {
	const device = await getTestDevice();
	const filterRenderer = new FilterRenderer(device);
	const frost = new FrostGlassFilterHandler();
	await frost.initialize(device, "rgba8unorm");
	filterRenderer.registerHandler("frost-glass", frost);
	frost.startFrame();

	const filter = {
		uid: "frost-rim-circle-test",
		processor: "frost-glass",
		enabled: true,
		applyToBackdrop: true,
		paramData: { version: "1", params },
	} as unknown as FrostGlassFilter;
	const source = createTexture(device, (x) => stripeValue(x));
	const mask = createTexture(device, (x, y) =>
		Math.hypot(x + 0.5 - CIRCLE_CENTER, y + 0.5 - CIRCLE_CENTER) < CIRCLE_RADIUS
			? 1
			: -1,
	);

	const encoder = device.createCommandEncoder();
	const { texture } = filterRenderer.applyFilters(
		source,
		[filter],
		encoder,
		mask,
		1,
	);
	device.queue.submit([encoder.finish()]);
	await device.queue.onSubmittedWorkDone();
	return captureTexturePixels(device, texture, SIZE, SIZE);
}

function insideShape(x: number, y: number): boolean {
	return x >= SHAPE_MIN && x < SHAPE_MAX && y >= SHAPE_MIN && y < SHAPE_MAX;
}

/** Opaque grey `value(x, y)` per texel; a negative value is transparent. */
function createTexture(
	device: GPUDevice,
	value: (x: number, y: number) => number,
): GPUTexture {
	const data = new Uint8Array(SIZE * SIZE * 4);
	for (let y = 0; y < SIZE; y++) {
		for (let x = 0; x < SIZE; x++) {
			const v = value(x, y);
			if (v < 0) continue;
			const index = (y * SIZE + x) * 4;
			data[index] = Math.round(v * 255);
			data[index + 1] = Math.round(v * 255);
			data[index + 2] = Math.round(v * 255);
			data[index + 3] = 255;
		}
	}
	const texture = device.createTexture({
		label: "FrostGlass Rim Test Texture",
		size: { width: SIZE, height: SIZE },
		format: "rgba8unorm",
		usage:
			GPUTextureUsage.TEXTURE_BINDING |
			GPUTextureUsage.COPY_SRC |
			GPUTextureUsage.COPY_DST |
			GPUTextureUsage.RENDER_ATTACHMENT,
	});
	device.queue.writeTexture(
		{ texture },
		data,
		{ bytesPerRow: SIZE * 4 },
		{ width: SIZE, height: SIZE },
	);
	return texture;
}
