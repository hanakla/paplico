import { describe, expect, it } from "vitest";
import { getTestDevice } from "../../../../testUtils/shaderTestHarness";
import { WetLayerPass, type WetLayerSeedTextures } from "./WetLayerPass";

// copyTextureToBuffer needs bytesPerRow to be a multiple of 256.
const DOMAIN = 64;
const TARGET = 64;

/**
 * End-to-end run of the wet layer: seed the fields from a stroke's dab pass,
 * diffuse them and composite. The seed targets are written directly here
 * rather than by rendering dabs, so a case can state exactly what the dab
 * pass would have produced.
 */
describe("WetLayerPass", () => {
	it("should composite a seeded blob onto the target", async () => {
		const pixels = await runWetLayer({});

		// The blob covers the middle; its centre must end up painted.
		expect(alphaAt(pixels, TARGET / 2, TARGET / 2)).toBeGreaterThan(0.3);
		// ...and the far corner untouched.
		expect(alphaAt(pixels, 1, 1)).toBeCloseTo(0, 2);
	});

	it("should paint nothing when no dab seeded the field", async () => {
		const pixels = await runWetLayer({ coverage: 0 });

		for (let i = 3; i < pixels.length; i += 4) {
			expect(pixels[i]).toBeCloseTo(0, 3);
		}
	});

	it("should spread the blob further as bleed softness rises", async () => {
		// Painted area rather than one probe texel: the bleed front is a few
		// texels wide, so where exactly it lands is not the point.
		const paintedArea = async (softness: number): Promise<number> => {
			const pixels = await runWetLayer({ bleedSoftness: softness, water: 1 });
			let painted = 0;
			for (let i = 3; i < pixels.length; i += 4) {
				if (pixels[i] > 12) painted++;
			}
			return painted;
		};

		expect(await paintedArea(1)).toBeGreaterThan(await paintedArea(0));
	});

	it("should reuse its fields across strokes without leaking", async () => {
		// Two runs on one pass instance: the second must still paint, which it
		// cannot if the first run's fields were destroyed or left dirty.
		const device = await getTestDevice();
		const pass = new WetLayerPass(device, "rgba8unorm");
		const first = await runWetLayer({ pass, device });
		const second = await runWetLayer({ pass, device });

		expect(alphaAt(second, TARGET / 2, TARGET / 2)).toBeCloseTo(
			alphaAt(first, TARGET / 2, TARGET / 2),
			2,
		);
		pass.destroy();
	});
});

function alphaAt(pixels: Uint8Array, x: number, y: number): number {
	return pixels[(y * TARGET + x) * 4 + 3] / 255;
}

async function runWetLayer(opts: {
	pass?: WetLayerPass;
	device?: GPUDevice;
	coverage?: number;
	water?: number;
	bleedSoftness?: number;
}): Promise<Uint8Array> {
	const device = opts.device ?? (await getTestDevice());
	const pass = opts.pass ?? new WetLayerPass(device, "rgba8unorm");
	const coverage = opts.coverage ?? 1;
	const water = opts.water ?? 0.7;

	// A round blob of dabs in the middle of the domain.
	const blob = (
		fill: (inside: boolean) => [number, number, number, number],
	): Float32Array => {
		const data = new Float32Array(DOMAIN * DOMAIN * 4);
		for (let y = 0; y < DOMAIN; y++) {
			for (let x = 0; x < DOMAIN; x++) {
				const inside =
					Math.hypot(x - DOMAIN / 2, y - DOMAIN / 2) < 5 && coverage > 0;
				data.set(fill(inside), (y * DOMAIN + x) * 4);
			}
		}
		return data;
	};

	const density = -Math.log(1 - Math.min(coverage, 0.999));
	const seeds: WetLayerSeedTextures = {
		pigment: makeTexture(
			device,
			"rgba16float",
			blob((inside) => (inside ? [density, 0, 0, density] : [0, 0, 0, 0])),
		),
		fluidVelocity: makeTexture(
			device,
			"rgba16float",
			blob((inside) => (inside ? [0, 0, coverage, 0] : [0, 0, 0, 0])),
		),
		moisture: makeTexture(
			device,
			"rgba16float",
			blob((inside) =>
				inside ? [0, 0, coverage * water, coverage * 0.2] : [0, 0, 0, 0],
			),
		),
		absorptionGranulation: makeTexture(
			device,
			"rg8unorm",
			blob(() => [0.1, 0, 0, 0]),
		),
		softnessEdgeDarkening: makeTexture(
			device,
			"rg8unorm",
			blob(() => [opts.bleedSoftness ?? 0.35, 0.4, 0, 0]),
		),
		edgeRoughness: makeTexture(
			device,
			"r8unorm",
			blob(() => [0.3, 0, 0, 0]),
		),
	};

	const target = device.createTexture({
		size: [TARGET, TARGET],
		format: "rgba8unorm",
		usage:
			GPUTextureUsage.RENDER_ATTACHMENT |
			GPUTextureUsage.COPY_SRC |
			GPUTextureUsage.TEXTURE_BINDING,
	});

	const encoder = device.createCommandEncoder();
	// Clear the target first: the composite blends over what is there.
	const clear = encoder.beginRenderPass({
		colorAttachments: [
			{
				view: target.createView(),
				clearValue: { r: 0, g: 0, b: 0, a: 0 },
				loadOp: "clear",
				storeOp: "store",
			},
		],
	});
	clear.end();

	pass.apply(encoder, {
		seeds,
		domain: { width: DOMAIN, height: DOMAIN },
		domainWorldOrigin: { x: 0, y: 0 },
		domainWorldPerPixel: 1,
		target: target.createView(),
		targetResolution: { width: TARGET, height: TARGET },
		targetWorldOrigin: { x: 0, y: 0 },
		targetWorldPerPixel: 1,
		brushRadiusPx: 5,
		bleedRadius: 0.5,
		pigmentLoad: 0.85,
		grainScale: 1,
		randomSeed: 7,
		paperGrain: 0.2,
	});

	const readback = device.createBuffer({
		size: TARGET * TARGET * 4,
		usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
	});
	encoder.copyTextureToBuffer(
		{ texture: target },
		{ buffer: readback, bytesPerRow: TARGET * 4 },
		[TARGET, TARGET],
	);
	device.queue.submit([encoder.finish()]);
	await readback.mapAsync(GPUMapMode.READ);
	const pixels = new Uint8Array(readback.getMappedRange()).slice();
	readback.unmap();

	pass.releaseFrame();
	if (!opts.pass) pass.destroy();
	readback.destroy();
	target.destroy();
	for (const texture of Object.values(seeds)) texture.destroy();
	return pixels;
}

function makeTexture(
	device: GPUDevice,
	format: GPUTextureFormat,
	rgba: Float32Array,
): GPUTexture {
	const texture = device.createTexture({
		size: [DOMAIN, DOMAIN],
		format,
		usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
	});
	const components = format === "r8unorm" ? 1 : format === "rg8unorm" ? 2 : 4;
	if (components === 4) {
		const half = new Uint16Array(rgba.length);
		for (let i = 0; i < rgba.length; i++) half[i] = toHalf(rgba[i]);
		device.queue.writeTexture({ texture }, half, { bytesPerRow: DOMAIN * 8 }, [
			DOMAIN,
			DOMAIN,
		]);
		return texture;
	}
	const bytes = new Uint8Array(DOMAIN * DOMAIN * components);
	for (let i = 0; i < DOMAIN * DOMAIN; i++) {
		for (let c = 0; c < components; c++) {
			bytes[i * components + c] = Math.round(
				Math.min(Math.max(rgba[i * 4 + c], 0), 1) * 255,
			);
		}
	}
	device.queue.writeTexture(
		{ texture },
		bytes,
		{ bytesPerRow: DOMAIN * components },
		[DOMAIN, DOMAIN],
	);
	return texture;
}

/** float32 -> float16 bits, enough for test fixtures. */
function toHalf(value: number): number {
	const floatView = new Float32Array(1);
	const intView = new Uint32Array(floatView.buffer);
	floatView[0] = value;
	const x = intView[0];
	const sign = (x >>> 16) & 0x8000;
	const exponent = ((x >>> 23) & 0xff) - 112;
	let mantissa = x & 0x7fffff;
	if (exponent <= 0) return sign;
	if (exponent >= 0x1f) return sign | 0x7c00;
	mantissa = mantissa >> 13;
	return sign | (exponent << 10) | mantissa;
}
