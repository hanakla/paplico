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
 * The kernel reads every coefficient per texel (design §13-2), so beyond the
 * field invariants — bounded, non-creating, dt-independent — it has to show
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
			absorptionGranulation: fillTexture(W, H, [1, 1, 0, 1]),
			softnessEdgeDarkening: fillTexture(W, H, [1, 1, 0, 1]),
			moistureSeed: fillTexture(W, H, [1, 1, 1.5, 1]),
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
			absorptionGranulation: checker,
			softnessEdgeDarkening: checker,
			moistureSeed: fillTexture(W, H, [0, 0, 1.5, 0.5]),
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
		const coefficients = new Float32Array(W * H * 4);
		for (let y = 0; y < H; y++) {
			for (let x = 0; x < W; x++) {
				coefficients[(y * W + x) * 4] = x < W / 2 ? 1 : 0;
			}
		}

		const { moisture } = await runDiffusion({
			pigment: fillTexture(W, H, [0, 0, 0, 0]),
			moisture: fillTexture(W, H, [0, 0, 1, 0]),
			absorptionGranulation: coefficients,
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
				absorptionGranulation: fillTexture(W, H, [0, granulation, 0, 0]),
				softnessEdgeDarkening: fillTexture(W, H, [1, 0, 0, 0]),
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
				softnessEdgeDarkening: fillTexture(W, H, [softness, 0, 0, 0]),
				iterations: 8,
			});
			return pigment[(4 * W + 5) * 4 + 3];
		};

		expect(await neighbour(1)).toBeGreaterThan(await neighbour(0));
	});

	// Reach is the grid spacing times sqrt(2 * D * iterations), so the count is
	// half of how a wide bleed is bought. It used to be normalized away, which
	// is what left the top of the bleed slider with nothing to do.
	it("should spread further the longer it runs", async () => {
		const run = async (iterations: number) =>
			runDiffusion({
				pigment: centerDotTexture(W, H, [1, 1, 1, 1]),
				moisture: fillTexture(W, H, [0, 0, 1, 0]),
				uniformOverrides: { dt: 1 / iterations },
				iterations,
			});

		const brief = await run(8);
		const long = await run(32);
		const away = (4 * W + 7) * 4 + 3;
		expect(long.pigment[away]).toBeGreaterThan(brief.pigment[away] * 1.5);
	});

	// Drying is a rate over the stroke's own time, not over its steps: running
	// the pass longer must not dry the paper any further.
	it("should dry by the same amount at any iteration count", async () => {
		const run = async (iterations: number) =>
			runDiffusion({
				pigment: fillTexture(W, H, [0, 0, 0, 0]),
				// A flat water field has no gradient to diffuse, so only drying
				// moves it.
				moisture: fillTexture(W, H, [0, 0, 1, 0]),
				uniformOverrides: { dt: 1 / iterations },
				iterations,
			});

		const coarse = await run(8);
		const fine = await run(32);
		const at = (4 * W + 4) * 4 + 2;
		const ratio = fine.moisture[at] / coarse.moisture[at];
		expect(ratio).toBeGreaterThan(0.95);
		expect(ratio).toBeLessThan(1.05);
	});

	// Pigment is colour * density alongside that density, and the composite
	// recovers the colour by dividing one by the other. Every step here is a
	// weighted sum of whole pigment values, so a field laid down in one colour
	// has to stay that colour however long it runs — a ratio that drifts comes
	// out as paint brighter than anything the stroke was given.
	it("should keep the colour it was seeded with", async () => {
		const COLOUR = 0.8;
		// A stroke's seeds fall off to nothing at its edge, and the kernel
		// recovers wetness and directionality by dividing by that coverage.
		// A uniform fill never exercises those divisions.
		const falloff = (x: number, y: number): number => {
			const dx = (x - (W - 1) / 2) / (W / 2);
			const dy = (y - (H - 1) / 2) / (H / 2);
			return Math.max(0, 1 - Math.hypot(dx, dy));
		};
		const perTexel = (
			make: (cov: number, x: number, y: number) => number[],
		): Float32Array => {
			const out = new Float32Array(W * H * 4);
			for (let y = 0; y < H; y++) {
				for (let x = 0; x < W; x++) {
					out.set(make(falloff(x, y), x, y), (y * W + x) * 4);
				}
			}
			return out;
		};
		const seeded = perTexel((cov) => {
			const density = -Math.log(Math.max(1 - cov * 0.99, 0.001));
			return [COLOUR * density, 0, 0, density];
		});

		const { pigment } = await runDiffusion({
			pigment: seeded,
			moisture: perTexel((cov) => [0, 0, cov, cov * 0.5]),
			velocitySeed: perTexel((cov) => [cov * 0.7, cov * 0.3, cov, 0]),
			moistureSeed: perTexel((cov) => [
				cov * 0.5,
				cov * 0.2,
				cov * 1.2,
				cov * 0.3,
			]),
			absorptionGranulation: perTexel((cov, x) => [
				(x / W) * 0.9,
				cov * 0.8,
				0,
				cov,
			]),
			softnessEdgeDarkening: perTexel((cov, _x, y) => [
				(y / H) * 0.9,
				cov * 0.5,
				0,
				cov,
			]),
			uniformOverrides: { scale: 4 },
			iterations: 32,
		});

		let worst = 0;
		for (let i = 0; i < pigment.length; i += 4) {
			const a = pigment[i + 3];
			if (a < 1e-4) continue;
			worst = Math.max(worst, Math.abs(pigment[i] / a - COLOUR));
		}
		expect(worst).toBeLessThan(0.01);
	});

	it("should write zero where nothing was seeded", async () => {
		const { pigment, moisture } = await runDiffusion({
			pigment: fillTexture(W, H, [0, 0, 0, 0]),
			moisture: fillTexture(W, H, [0, 0, 0, 0]),
			velocitySeed: fillTexture(W, H, [0, 0, 0, 0]),
			moistureSeed: fillTexture(W, H, [0, 0, 0, 0]),
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
		// One field texel per seed texel: the coarse grid is the pass's job to
		// choose, and these cases pin the per-texel behaviour.
		seedResolution: [overrides.resolutionX ?? W, overrides.resolutionY ?? H],
		scale: overrides.scale ?? 1,
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
	absorptionGranulation?: Float32Array;
	softnessEdgeDarkening?: Float32Array;
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
	// b is coverage, which the kernel divides motion and the seeds by.
	const velocitySeed = field(
		opts.velocitySeed ?? fillTexture(W, H, [0, 0, 1, 0]),
	);
	const moistureSeed = field(
		opts.moistureSeed ?? fillTexture(W, H, [0, 0, 1, 0]),
	);
	const absorptionGranulation = field(
		opts.absorptionGranulation ?? fillTexture(W, H, [0, 0, 0, 0]),
	);
	const softnessEdgeDarkening = field(
		opts.softnessEdgeDarkening ?? fillTexture(W, H, [0.35, 0, 0, 0]),
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
				{ binding: 5, resource: absorptionGranulation.createView() },
				{ binding: 6, resource: softnessEdgeDarkening.createView() },
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
	absorptionGranulation.destroy();
	softnessEdgeDarkening.destroy();

	return { pigment: pigmentOut, moisture: moistureOut };
}

function sumChannel(pixels: Float32Array, channel: number): number {
	let sum = 0;
	for (let i = channel; i < pixels.length; i += 4) {
		sum += pixels[i];
	}
	return sum;
}
