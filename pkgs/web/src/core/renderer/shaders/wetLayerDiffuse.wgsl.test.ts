import { describe, expect, it } from "vitest";
import { WET_LAYER_DIFFUSE_SHADER } from "@/core/renderer/shaders/wetLayerDiffuse.wgsl";
import {
	centerDotTexture,
	fillTexture,
	setupComputeShaderTest,
} from "@/core/testUtils/shaderTestHarness";
import type { StructuredView } from "@/core/utils/wgpu-utils";

const W = 8;
const H = 8;

/**
 * The v2 kernel reads every coefficient per texel (design §13-2), so beyond
 * the v1 invariants — bounded, non-creating, dt-independent — it has to show
 * that two halves of one field can behave differently, which a stroke-wide
 * uniform structurally could not do.
 */
describe("wetLayerDiffuse compute shader", () => {
	it("should not create pigment from nothing", async () => {
		const { pigment } = await runDiffusion({
			pigment: fillTexture(W, H, [0, 0, 0, 0]),
			moisture: fillTexture(W, H, [0, 0, 0.5, 0]),
		});

		expect(sumChannel(pigment, 3)).toBeCloseTo(0, 5);
	});

	it("should spread a centre dot into its neighbours", async () => {
		const { pigment } = await runDiffusion({
			pigment: centerDotTexture(W, H, [1, 1, 1, 1]),
			moisture: fillTexture(W, H, [0, 0, 1, 0]),
			iterations: 8,
		});

		const center = pigment[(4 * W + 4) * 4 + 3];
		const neighbour = pigment[(4 * W + 5) * 4 + 3];
		expect(center).toBeLessThan(1);
		expect(neighbour).toBeGreaterThan(0);
	});

	it("should leave a uniform field unchanged", async () => {
		const { pigment } = await runDiffusion({
			pigment: fillTexture(W, H, [0.5, 0.5, 0.5, 0.5]),
			moisture: fillTexture(W, H, [0, 0, 1, 0]),
			iterations: 4,
		});

		for (let i = 3; i < pigment.length; i += 4) {
			expect(pigment[i]).toBeCloseTo(0.5, 2);
		}
	});

	it("should not diffuse without water", async () => {
		const { pigment } = await runDiffusion({
			pigment: centerDotTexture(W, H, [1, 1, 1, 1]),
			moisture: fillTexture(W, H, [0, 0, 0, 0]),
			iterations: 8,
		});

		expect(pigment[(4 * W + 5) * 4 + 3]).toBeCloseTo(0, 4);
	});

	it("should keep pigment non-negative and bounded under extreme settings", async () => {
		const { pigment, moisture } = await runDiffusion({
			pigment: centerDotTexture(W, H, [1, 1, 1, 1]),
			moisture: fillTexture(W, H, [0, 0, 1.5, 1]),
			// Every coefficient at its maximum, with the highest water seed the
			// wetness clamp allows.
			coefficients: fillTexture(W, H, [1, 1, 1, 1]),
			moistureSeed: fillTexture(W, H, [1, 0, 1.5, 1]),
			velocitySeed: fillTexture(W, H, [1, 0, 1, 0]),
			iterations: 20,
		});

		for (let i = 0; i < pigment.length; i++) {
			expect(Number.isFinite(pigment[i])).toBe(true);
			expect(pigment[i]).toBeGreaterThanOrEqual(0);
		}
		for (let i = 0; i < moisture.length; i++) {
			expect(Number.isFinite(moisture[i])).toBe(true);
		}
		expect(sumChannel(pigment, 3)).toBeLessThanOrEqual(
			sumChannel(centerDotTexture(W, H, [1, 1, 1, 1]), 3) * 1.02,
		);
	});

	it("should stay stable with checkerboard coefficients and maximum wetness", async () => {
		// Appendix H's stability case: neighbouring texels pulling in opposite
		// directions every step.
		const checker = new Float32Array(W * H * 4);
		for (let y = 0; y < H; y++) {
			for (let x = 0; x < W; x++) {
				const on = (x + y) % 2 === 0 ? 1 : 0;
				const i = (y * W + x) * 4;
				checker[i] = on;
				checker[i + 1] = 1 - on;
				checker[i + 2] = on;
				checker[i + 3] = 1 - on;
			}
		}

		const { pigment, moisture } = await runDiffusion({
			pigment: centerDotTexture(W, H, [1, 1, 1, 1]),
			moisture: fillTexture(W, H, [0, 0, 1.5, 0.5]),
			coefficients: checker,
			moistureSeed: fillTexture(W, H, [1, 0, 1.5, 0.5]),
			iterations: 32,
		});

		for (const value of [...pigment, ...moisture]) {
			expect(Number.isFinite(value)).toBe(true);
		}
		expect(Math.max(...pigment)).toBeLessThan(4);
	});

	it("should dry faster where the absorption coefficient is higher", async () => {
		// Left half absorbs fully, right half not at all — one field, two
		// behaviours, which is the whole point of per-texel coefficients.
		const seed = new Float32Array(W * H * 4);
		for (let y = 0; y < H; y++) {
			for (let x = 0; x < W; x++) {
				const i = (y * W + x) * 4;
				seed[i] = x < W / 2 ? 1 : 0; // absorption
				seed[i + 2] = 1; // water
			}
		}

		const { moisture } = await runDiffusion({
			pigment: fillTexture(W, H, [0, 0, 0, 0]),
			moisture: fillTexture(W, H, [0, 0, 1, 0]),
			moistureSeed: seed,
			iterations: 16,
		});

		const wetSide = moisture[(4 * W + 6) * 4 + 2];
		const drySide = moisture[(4 * W + 1) * 4 + 2];
		expect(drySide).toBeLessThan(wetSide * 0.7);
	});

	it("should hold pigment where granulation is high", async () => {
		const atCenter = async (granulation: number): Promise<number> => {
			const { pigment } = await runDiffusion({
				pigment: centerDotTexture(W, H, [1, 1, 1, 1]),
				moisture: fillTexture(W, H, [0, 0, 1, 0]),
				coefficients: fillTexture(W, H, [granulation, 1, 0, 0]),
				iterations: 8,
			});
			return pigment[(4 * W + 4) * 4 + 3];
		};

		expect(await atCenter(1)).toBeGreaterThan(await atCenter(0));
	});

	it("should bleed further as bleed softness rises", async () => {
		const neighbour = async (softness: number): Promise<number> => {
			const { pigment } = await runDiffusion({
				pigment: centerDotTexture(W, H, [1, 1, 1, 1]),
				moisture: fillTexture(W, H, [0, 0, 1, 0]),
				coefficients: fillTexture(W, H, [0, softness, 0, 0]),
				iterations: 8,
			});
			return pigment[(4 * W + 5) * 4 + 3];
		};

		expect(await neighbour(1)).toBeGreaterThan(await neighbour(0));
	});

	it("should reach the same state at any iteration count", async () => {
		const run = async (iterations: number) =>
			runDiffusion({
				pigment: centerDotTexture(W, H, [1, 1, 1, 1]),
				moisture: fillTexture(W, H, [0, 0, 1, 0]),
				uniformOverrides: { dt: 1 / iterations },
				iterations,
			});

		const coarse = await run(8);
		const fine = await run(16);
		const ratio =
			fine.pigment[(4 * W + 4) * 4 + 3] / coarse.pigment[(4 * W + 4) * 4 + 3];
		expect(ratio).toBeGreaterThan(0.95);
		expect(ratio).toBeLessThan(1.05);
	});

	it("should write zero where nothing was seeded", async () => {
		const { pigment, moisture } = await runDiffusion({
			pigment: fillTexture(W, H, [0, 0, 0, 0]),
			moisture: fillTexture(W, H, [0, 0, 0, 0]),
			mask: fillTexture(W, H, [0, 0, 0, 0]),
		});

		expect(sumChannel(pigment, 3)).toBe(0);
		expect(sumChannel(moisture, 2)).toBe(0);
	});
});

function setUniforms(
	view: StructuredView,
	overrides: Partial<Record<string, number>> = {},
): void {
	view.set({
		resolution: [overrides.resolutionX ?? W, overrides.resolutionY ?? H],
		paperScale: overrides.paperScale ?? 24,
		randomSeed: overrides.randomSeed ?? 42,
		dt: overrides.dt ?? 1 / 32,
		brushRadiusPx: overrides.brushRadiusPx ?? 16,
		bleedRadius: overrides.bleedRadius ?? 0.3,
	});
}

async function runDiffusion(opts: {
	pigment: Float32Array;
	moisture: Float32Array;
	velocitySeed?: Float32Array;
	moistureSeed?: Float32Array;
	mask?: Float32Array;
	coefficients?: Float32Array;
	uniformOverrides?: Partial<Record<string, number>>;
	iterations?: number;
}) {
	const harness = await setupComputeShaderTest(WET_LAYER_DIFFUSE_SHADER);
	const {
		dispatch,
		readTexture,
		createUniformBuffer,
		createTexture,
		uniformViews,
	} = harness;

	const uv = uniformViews.uniforms;
	setUniforms(uv, opts.uniformOverrides);
	const uniformBuf = createUniformBuffer(uv);

	const field = (data: Float32Array) =>
		createTexture({ width: W, height: H, format: "rgba16float", data });

	let srcPigment = field(opts.pigment);
	let srcMoisture = field(opts.moisture);
	// Seeded with full coverage and unit water unless a case says otherwise,
	// so wetness recovers as 1 and the field is active everywhere.
	const velocitySeed = field(
		opts.velocitySeed ?? fillTexture(W, H, [0, 0, 0, 0]),
	);
	const moistureSeed = field(
		opts.moistureSeed ?? fillTexture(W, H, [0, 0, 1, 0]),
	);
	const maskSeed = field(opts.mask ?? fillTexture(W, H, [1, 0, 0, 0]));
	const coefficients = field(
		opts.coefficients ?? fillTexture(W, H, [0, 0.35, 0, 0]),
	);

	const iterations = opts.iterations ?? 1;
	for (let i = 0; i < iterations; i++) {
		const dstPigment = createTexture({
			width: W,
			height: H,
			format: "rgba16float",
		});
		const dstMoisture = createTexture({
			width: W,
			height: H,
			format: "rgba16float",
		});

		await dispatch(
			[
				{ binding: 0, resource: { buffer: uniformBuf } },
				{ binding: 1, resource: srcPigment.createView() },
				{ binding: 2, resource: srcMoisture.createView() },
				{ binding: 3, resource: velocitySeed.createView() },
				{ binding: 4, resource: moistureSeed.createView() },
				{ binding: 5, resource: maskSeed.createView() },
				{ binding: 6, resource: coefficients.createView() },
				{ binding: 7, resource: dstPigment.createView() },
				{ binding: 8, resource: dstMoisture.createView() },
			],
			[Math.ceil(W / 16), Math.ceil(H / 16), 1],
		);

		srcPigment.destroy();
		srcMoisture.destroy();
		srcPigment = dstPigment;
		srcMoisture = dstMoisture;
	}

	const pigmentOut = await readTexture(srcPigment, W, H);
	const moistureOut = await readTexture(srcMoisture, W, H);

	uniformBuf.destroy();
	srcPigment.destroy();
	srcMoisture.destroy();
	velocitySeed.destroy();
	moistureSeed.destroy();
	maskSeed.destroy();
	coefficients.destroy();

	return { pigment: pigmentOut, moisture: moistureOut };
}

function sumChannel(pixels: Float32Array, channel: number): number {
	let sum = 0;
	for (let i = channel; i < pixels.length; i += 4) {
		sum += pixels[i];
	}
	return sum;
}
