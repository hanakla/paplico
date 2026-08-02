import { describe, expect, it } from "vitest";
import { WET_INK_DIFFUSE_SHADER } from "@/core/renderer/shaders/wetInkDiffuse.wgsl";
import {
	centerDotTexture,
	fillTexture,
	readFloat32PixelAt,
	setupComputeShaderTest,
} from "@/core/testUtils/shaderTestHarness";
import type { StructuredView } from "@/core/utils/wgpu-utils";

const W = 8;
const H = 8;

describe("wetInkDiffuse compute shader", () => {
	it("does not create pigment from nothing", async () => {
		const { pigment } = await runDiffusion({
			pigment: fillTexture(W, H, [0, 0, 0, 0]),
			water: fillTexture(W, H, [0, 0, 0.5, 0]),
		});

		const totalAlpha = sumChannel(pigment, 3);
		expect(totalAlpha).toBeCloseTo(0, 3);
	});

	it("spreads a center dot of pigment to neighbors after multiple iterations", async () => {
		const { pigment } = await runDiffusion({
			pigment: centerDotTexture(W, H, [1, 0, 0, 1]),
			water: fillTexture(W, H, [0, 0, 0.8, 0]),
			iterations: 8,
		});

		const cx = W / 2;
		const cy = H / 2;
		const center = readFloat32PixelAt(pigment, W, cx, cy);
		const right = readFloat32PixelAt(pigment, W, cx + 1, cy);
		const left = readFloat32PixelAt(pigment, W, cx - 1, cy);

		expect(right[3]).toBeGreaterThan(0.001);
		expect(left[3]).toBeGreaterThan(0.001);
		expect(center[3]).toBeLessThan(1.0);
	});

	it("produces no change on a uniform pigment field", async () => {
		const { pigment } = await runDiffusion({
			pigment: fillTexture(W, H, [0.5, 0.3, 0.1, 0.5]),
			water: fillTexture(W, H, [0, 0, 0.5, 0]),
			iterations: 4,
		});

		for (let y = 1; y < H - 1; y++) {
			for (let x = 1; x < W - 1; x++) {
				const p = readFloat32PixelAt(pigment, W, x, y);
				expect(p[0]).toBeCloseTo(0.5, 1);
				expect(p[1]).toBeCloseTo(0.3, 1);
				expect(p[2]).toBeCloseTo(0.1, 1);
			}
		}
	});

	it("does not diffuse when water is zero everywhere", async () => {
		const { pigment } = await runDiffusion({
			pigment: centerDotTexture(W, H, [1, 0, 0, 1]),
			water: fillTexture(W, H, [0, 0, 0, 0]),
			mask: fillTexture(W, H, [0, 0, 0, 0]),
			iterations: 4,
		});

		const cx = W / 2;
		const cy = H / 2;
		const right = readFloat32PixelAt(pigment, W, cx + 1, cy);
		expect(right[3]).toBeCloseTo(0, 2);
	});

	it("water amount decreases over time when absorption > 0", async () => {
		const { water: water1 } = await runDiffusion({
			pigment: fillTexture(W, H, [0.5, 0, 0, 0.5]),
			water: fillTexture(W, H, [0, 0, 0.8, 0]),
			uniformOverrides: { absorption: 0.5 },
			iterations: 1,
		});

		const { water: water4 } = await runDiffusion({
			pigment: fillTexture(W, H, [0.5, 0, 0, 0.5]),
			water: fillTexture(W, H, [0, 0, 0.8, 0]),
			uniformOverrides: { absorption: 0.5 },
			iterations: 4,
		});

		const waterSum1 = sumChannel(water1, 2);
		const waterSum4 = sumChannel(water4, 2);
		expect(waterSum4).toBeLessThan(waterSum1);
	});

	it("outputs zero when all inputs are zero (early return path)", async () => {
		const { pigment, water } = await runDiffusion({
			pigment: fillTexture(W, H, [0, 0, 0, 0]),
			water: fillTexture(W, H, [0, 0, 0, 0]),
			mask: fillTexture(W, H, [0, 0, 0, 0]),
			flow: fillTexture(W, H, [0, 0, 0, 0]),
			fluid: fillTexture(W, H, [0, 0, 0, 0]),
		});

		expect(sumChannel(pigment, 0)).toBeCloseTo(0, 5);
		expect(sumChannel(pigment, 3)).toBeCloseTo(0, 5);
		expect(sumChannel(water, 2)).toBeCloseTo(0, 5);
	});

	it("higher bleedWidth produces faster spread", async () => {
		const { pigment: lowBleed } = await runDiffusion({
			pigment: centerDotTexture(W, H, [1, 0, 0, 1]),
			water: fillTexture(W, H, [0, 0, 0.8, 0]),
			uniformOverrides: { bleedWidth: 0.1 },
			iterations: 4,
		});

		const { pigment: highBleed } = await runDiffusion({
			pigment: centerDotTexture(W, H, [1, 0, 0, 1]),
			water: fillTexture(W, H, [0, 0, 0.8, 0]),
			uniformOverrides: { bleedWidth: 1.0 },
			iterations: 4,
		});

		const cx = W / 2;
		const cy = H / 2;
		const lowNeighbor = readFloat32PixelAt(lowBleed, W, cx + 2, cy)[3];
		const highNeighbor = readFloat32PixelAt(highBleed, W, cx + 2, cy)[3];
		expect(highNeighbor).toBeGreaterThan(lowNeighbor);
	});

	it("directionality causes asymmetric spread along flow field", async () => {
		const flow = fillTexture(W, H, [1, 0, 1, 0]);

		const { pigment } = await runDiffusion({
			pigment: centerDotTexture(W, H, [1, 0, 0, 1]),
			water: fillTexture(W, H, [0, 0, 0.8, 0]),
			flow,
			uniformOverrides: { directionality: 1.0, brushRadiusPx: 32 },
			iterations: 6,
		});

		const cx = W / 2;
		const cy = H / 2;
		const downstream = readFloat32PixelAt(pigment, W, cx + 2, cy)[3];
		const upstream = readFloat32PixelAt(pigment, W, cx - 2, cy)[3];
		expect(downstream).toBeGreaterThan(upstream);
	});

	it("high granulation suppresses pigment diffusion", async () => {
		const { pigment: noGrain } = await runDiffusion({
			pigment: centerDotTexture(W, H, [1, 0, 0, 1]),
			water: fillTexture(W, H, [0, 0, 0.8, 0]),
			uniformOverrides: { granulation: 0 },
			iterations: 4,
		});

		const { pigment: hiGrain } = await runDiffusion({
			pigment: centerDotTexture(W, H, [1, 0, 0, 1]),
			water: fillTexture(W, H, [0, 0, 0.8, 0]),
			uniformOverrides: { granulation: 1.0 },
			iterations: 4,
		});

		const cx = W / 2;
		const cy = H / 2;
		const noGrainCenter = readFloat32PixelAt(noGrain, W, cx, cy)[3];
		const hiGrainCenter = readFloat32PixelAt(hiGrain, W, cx, cy)[3];
		expect(hiGrainCenter).toBeGreaterThan(noGrainCenter);
	});

	it("pigment never goes negative", async () => {
		const sparse = fillTexture(W, H, [0, 0, 0, 0]);
		const cx = W / 2;
		const cy = H / 2;
		const i = (cy * W + cx) * 4;
		sparse[i] = 0.001;
		sparse[i + 3] = 0.001;

		const { pigment } = await runDiffusion({
			pigment: sparse,
			water: fillTexture(W, H, [0, 0, 1.0, 0]),
			uniformOverrides: { bleedWidth: 1.0, wetness: 1.0 },
			iterations: 20,
		});

		for (let j = 0; j < pigment.length; j++) {
			expect(pigment[j]).toBeGreaterThanOrEqual(0);
		}
	});

	it("conserves total pigment within ±1% under diffusion only", async () => {
		// dt-normalized to 8 iterations (same total diffusion as 32 @ 1/32).
		// Fewer iterations isolate scheme conservation from rgba16float store
		// truncation, which accumulates ~0.033% loss per iteration (measured
		// -1.05% at 32 iterations on both the old and new shader).
		const size = 16;
		const iterations = 8;
		const { pigment } = await runDiffusion({
			width: size,
			height: size,
			pigment: centerDotTexture(size, size, [1, 0, 0, 1]),
			water: fillTexture(size, size, [0, 0, 0.8, 0]),
			uniformOverrides: { bleedWidth: 0.5, wetness: 0.8, dt: 1 / iterations },
			iterations,
		});

		const total = sumChannel(pigment, 3);
		expect(total).toBeGreaterThan(0.99);
		expect(total).toBeLessThan(1.01);
	});

	it("keeps total pigment within 0.85..1.02x of initial with advection", async () => {
		const size = 16;
		const { pigment } = await runDiffusion({
			width: size,
			height: size,
			pigment: centerDotTexture(size, size, [1, 0, 0, 1]),
			water: fillTexture(size, size, [0, 0, 0.8, 0]),
			flow: fillTexture(size, size, [1, 0, 1, 0]),
			uniformOverrides: { directionality: 1.0, brushRadiusPx: 8 },
			iterations: 32,
		});

		const total = sumChannel(pigment, 3);
		expect(total).toBeGreaterThan(0.85);
		expect(total).toBeLessThanOrEqual(1.02);
	});

	it("produces dt-invariant totals (8 @ dt=1/8 vs 16 @ dt=1/16)", async () => {
		const size = 16;
		const scenario = (iterations: number) => ({
			width: size,
			height: size,
			pigment: centerDotTexture(size, size, [1, 0, 0, 1]),
			water: fillTexture(size, size, [0, 0, 0.8, 0]),
			flow: fillTexture(size, size, [1, 0, 1, 0]),
			uniformOverrides: {
				directionality: 0.5,
				absorption: 0.5,
				brushRadiusPx: 16,
				dt: 1 / iterations,
			},
			iterations,
		});
		const runA = await runDiffusion(scenario(8));
		const runB = await runDiffusion(scenario(16));

		const pigmentRatio =
			sumChannel(runA.pigment, 3) / sumChannel(runB.pigment, 3);
		const waterRatio = sumChannel(runA.water, 2) / sumChannel(runB.water, 2);
		expect(pigmentRatio).toBeGreaterThan(0.95);
		expect(pigmentRatio).toBeLessThan(1.05);
		expect(waterRatio).toBeGreaterThan(0.95);
		expect(waterRatio).toBeLessThan(1.05);
	});

	it("keeps directionality 0.05 subtle (weak asymmetry, near-conserved pigment)", async () => {
		const size = 16;
		const { pigment } = await runDiffusion({
			width: size,
			height: size,
			pigment: centerDotTexture(size, size, [1, 0, 0, 1]),
			water: fillTexture(size, size, [0, 0, 0.8, 0]),
			flow: fillTexture(size, size, [1, 0, 1, 0]),
			uniformOverrides: { directionality: 0.05, brushRadiusPx: 32 },
			iterations: 32,
		});

		const cx = size / 2;
		const cy = size / 2;
		const downstream = readFloat32PixelAt(pigment, size, cx + 2, cy)[3];
		const upstream = readFloat32PixelAt(pigment, size, cx - 2, cy)[3];
		expect(Math.abs(downstream - upstream)).toBeLessThan(0.2);

		const total = sumChannel(pigment, 3);
		expect(total).toBeGreaterThan(0.85);
		expect(total).toBeLessThan(1.15);
	});

	it("stays finite and non-amplifying with all parameters at 1.0", async () => {
		const size = 16;
		const { pigment, water } = await runDiffusion({
			width: size,
			height: size,
			pigment: centerDotTexture(size, size, [1, 0, 0, 1]),
			water: fillTexture(size, size, [0, 0, 1, 0]),
			flow: fillTexture(size, size, [1, 0, 1, 0]),
			mask: fillTexture(size, size, [1, 0.5, 1, 1]),
			uniformOverrides: {
				bleedWidth: 1,
				directionality: 1,
				wetness: 1,
				accelInfluence: 1,
				speedInfluence: 1,
				absorption: 1,
				granulation: 1,
				softness: 1,
				brushRadiusPx: 32,
			},
			iterations: 32,
		});

		expect(pigment.every(Number.isFinite)).toBe(true);
		expect(water.every(Number.isFinite)).toBe(true);
		const total = sumChannel(pigment, 3);
		expect(total).toBeLessThanOrEqual(1.02);
	});

	it("does not crash at texture corners", async () => {
		const corner = fillTexture(W, H, [0, 0, 0, 0]);
		corner[0] = 1;
		corner[3] = 1;
		const lastIdx = (W * H - 1) * 4;
		corner[lastIdx] = 1;
		corner[lastIdx + 3] = 1;

		const { pigment } = await runDiffusion({
			pigment: corner,
			water: fillTexture(W, H, [0, 0, 0.5, 0]),
			iterations: 4,
		});

		const tl = readFloat32PixelAt(pigment, W, 0, 0);
		const br = readFloat32PixelAt(pigment, W, W - 1, H - 1);
		expect(Number.isFinite(tl[3])).toBe(true);
		expect(Number.isFinite(br[3])).toBe(true);
	});
});

function setUniforms(
	view: StructuredView,
	overrides: Partial<Record<string, number>> = {},
): void {
	const dt = overrides.dt ?? 1 / 32;
	const absorption = overrides.absorption ?? 0;
	view.set({
		resolution: [overrides.resolutionX ?? W, overrides.resolutionY ?? H],
		bleedWidth: overrides.bleedWidth ?? 0.3,
		directionality: overrides.directionality ?? 0,
		wetness: overrides.wetness ?? 0.5,
		accelInfluence: overrides.accelInfluence ?? 0,
		speedInfluence: overrides.speedInfluence ?? 0,
		absorption,
		granulation: overrides.granulation ?? 0,
		paperScale: overrides.paperScale ?? 24,
		randomSeed: overrides.randomSeed ?? 42,
		dt,
		brushRadiusPx: overrides.brushRadiusPx ?? 16,
		softness: overrides.softness ?? 0.35,
		// Derived the same way WetInkPass pre-computes them on the CPU.
		absorbLambda: overrides.absorbLambda ?? -Math.log(1 - 0.85 * absorption),
		poolStepRetention:
			overrides.poolStepRetention ?? (0.75 - 0.35 * absorption) ** dt,
	});
}

async function runDiffusion(opts: {
	pigment: Float32Array;
	water: Float32Array;
	flow?: Float32Array;
	fluid?: Float32Array;
	mask?: Float32Array;
	uniformOverrides?: Partial<Record<string, number>>;
	iterations?: number;
	width?: number;
	height?: number;
}) {
	const w = opts.width ?? W;
	const h = opts.height ?? H;
	const harness = await setupComputeShaderTest(WET_INK_DIFFUSE_SHADER);
	const {
		dispatch,
		readTexture,
		createUniformBuffer,
		createTexture,
		uniformViews,
	} = harness;

	const uv = uniformViews.uniforms;
	setUniforms(uv, {
		resolutionX: w,
		resolutionY: h,
		...opts.uniformOverrides,
	});
	const uniformBuf = createUniformBuffer(uv);

	let srcPigment = createTexture({
		width: w,
		height: h,
		format: "rgba16float",
		data: opts.pigment,
	});
	let srcWater = createTexture({
		width: w,
		height: h,
		format: "rgba16float",
		data: opts.water,
	});
	const flowMRT = createTexture({
		width: w,
		height: h,
		format: "rgba16float",
		data: opts.flow ?? fillTexture(w, h, [0, 0, 0, 0]),
	});
	const fluidMRT = createTexture({
		width: w,
		height: h,
		format: "rgba16float",
		data: opts.fluid ?? fillTexture(w, h, [0, 0, 0, 0]),
	});
	const maskMRT = createTexture({
		width: w,
		height: h,
		format: "rgba16float",
		data: opts.mask ?? fillTexture(w, h, [1, 0, 0, 0]),
	});
	const iterations = opts.iterations ?? 1;
	for (let i = 0; i < iterations; i++) {
		const dstPigment = createTexture({
			width: w,
			height: h,
			format: "rgba16float",
		});
		const dstWater = createTexture({
			width: w,
			height: h,
			format: "rgba16float",
		});

		await dispatch(
			[
				{ binding: 0, resource: { buffer: uniformBuf } },
				{ binding: 1, resource: srcPigment.createView() },
				{ binding: 2, resource: srcWater.createView() },
				{ binding: 3, resource: flowMRT.createView() },
				{ binding: 4, resource: fluidMRT.createView() },
				{ binding: 5, resource: maskMRT.createView() },
				{ binding: 7, resource: dstPigment.createView() },
				{ binding: 8, resource: dstWater.createView() },
			],
			[Math.ceil(w / 16), Math.ceil(h / 16), 1],
		);

		srcPigment.destroy();
		srcWater.destroy();
		srcPigment = dstPigment;
		srcWater = dstWater;
	}

	const pigmentOut = await readTexture(srcPigment, w, h);
	const waterOut = await readTexture(srcWater, w, h);

	uniformBuf.destroy();
	srcPigment.destroy();
	srcWater.destroy();
	flowMRT.destroy();
	fluidMRT.destroy();
	maskMRT.destroy();

	return { pigment: pigmentOut, water: waterOut };
}

function sumChannel(pixels: Float32Array, channel: number): number {
	let sum = 0;
	for (let i = channel; i < pixels.length; i += 4) {
		sum += pixels[i];
	}
	return sum;
}
