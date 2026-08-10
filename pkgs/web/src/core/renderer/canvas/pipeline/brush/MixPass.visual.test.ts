import { getTestDevice } from "../../../../testUtils/shaderTestHarness";
import { PATH_META_FLOATS } from "../../../shaders/dabColor.wgsl";
import { DAB_INSTANCE_FLOATS, writeDabField } from "./DabInstanceLayout";
import { MIX_CHUNK_SIZE, MixPass } from "./MixPass";

/**
 * Direct GPU tests of the mix pass chunk compute (design §10-1):
 *   [A] footprint-weighted backdrop sample per dab
 *   [B] sequential bucket scan
 *       bucket   = mix(sample, bucket, smudgeLength)
 *       rgb      = styleMix(bucket.rgb, brushColor.rgb, colorRate²)
 *       alpha    = mix(bucket.a, brushColor.a, alphaRate)
 * The backdrop uses uniform color regions so the footprint average is exact
 * and the scan can be checked against a TS reference recurrence.
 */
describe("MixPass.resolveChunk", () => {
	const RED = { r: 1, g: 0, b: 0, a: 1 };
	const GREEN = [0, 200 / 255, 0, 1] as Vec4;
	const BLUE = [0, 0, 200 / 255, 1] as Vec4;

	it("should output the brush color when colorRate is 1", async () => {
		const [colors] = await runMixChunks([[dab(-20, 0), dab(0, 0)]], {
			brushColor: RED,
			params: { colorRate: 1, alphaRate: 1, smudge: 0 },
		});
		for (const c of colors) {
			expectVec4Close(c, [1, 0, 0, 1], 2 / 255);
		}
	});

	it("should output the sampled backdrop color when colorRate is 0", async () => {
		const [colors] = await runMixChunks([[dab(-20, 0), dab(-10, 10)]], {
			brushColor: RED,
			params: { colorRate: 0, alphaRate: 0, smudge: 0 },
		});
		for (const c of colors) {
			expectVec4Close(c, GREEN, 2 / 255);
		}
	});

	it("should keep the brush color over a transparent backdrop", async () => {
		// Dabs over the transparent strip: nothing to pick up, so the resolved
		// rgb stays the brush color and the sampled alpha is 0.
		const [colors] = await runMixChunks([[dab(0, -40), dab(10, -40)]], {
			brushColor: RED,
			params: { colorRate: 0, alphaRate: 0, smudge: 0 },
		});
		for (const c of colors) {
			expectVec4Close(c, [1, 0, 0, 0], 2 / 255);
		}
	});

	it("should apply alphaRate to alpha independently of the color", async () => {
		const [colors] = await runMixChunks([[dab(-20, 0)]], {
			brushColor: { ...RED, a: 0.4 },
			params: { colorRate: 0, alphaRate: 1, smudge: 0 },
		});
		expectVec4Close(colors[0], [GREEN[0], GREEN[1], GREEN[2], 0.4], 2 / 255);
	});

	it("should evolve the bucket across dabs and chunks like the reference recurrence", async () => {
		// First chunk samples the green region, second chunk the blue region;
		// the bucket must carry across the resolveChunk boundary.
		const params = { colorRate: 0.3, alphaRate: 0.5, smudge: 0.6 };
		const chunks = await runMixChunks(
			[
				[dab(-30, 0), dab(-20, 0), dab(-10, 0)],
				[dab(30, 0), dab(40, 0)],
			],
			{ brushColor: RED, params, blendStyle: 1 },
		);
		const expected = scanReference(
			[GREEN, GREEN, GREEN, BLUE, BLUE],
			params,
			[1, 0, 0, 1],
			1,
		);
		const actual = [...chunks[0], ...chunks[1]];
		for (let i = 0; i < expected.length; i++) {
			expectVec4Close(actual[i], expected[i], 3 / 255);
		}
	});

	it("should square colorRate (Krita paint-rate characteristic)", async () => {
		const [colors] = await runMixChunks([[dab(-20, 0)]], {
			brushColor: RED,
			params: { colorRate: 0.5, alphaRate: 0, smudge: 0 },
			blendStyle: 1,
		});
		const [expected] = scanReference(
			[GREEN],
			{ colorRate: 0.5, alphaRate: 0, smudge: 0 },
			[1, 0, 0, 1],
			1,
		);
		expectVec4Close(colors[0], expected, 2 / 255);
	});

	it("should mix differently between vivid and muted blend styles", async () => {
		const opts = {
			brushColor: RED,
			params: { colorRate: 0.5, alphaRate: 1, smudge: 0 },
		};
		const [[vivid]] = await runMixChunks([[dab(-20, 0)]], {
			...opts,
			blendStyle: 0,
		});
		const [[muted]] = await runMixChunks([[dab(-20, 0)]], {
			...opts,
			blendStyle: 1,
		});
		const diff =
			Math.abs(vivid[0] - muted[0]) +
			Math.abs(vivid[1] - muted[1]) +
			Math.abs(vivid[2] - muted[2]);
		expect(diff).toBeGreaterThan(4 / 255);
	});

	it("should fix the chunk size at 64 (design §10-1)", () => {
		expect(MIX_CHUNK_SIZE).toBe(64);
	});

	it("should sample ahead of the dab when sampleTrail is positive", async () => {
		// Dab sits exactly on the green/blue boundary (x=0) pointing +x; trail
		// 1.5 moves the footprint center to x=6 so it lies fully in blue
		// (radius 4 → footprint spans x 2..10).
		const [colors] = await runMixChunks([[dab(0, 0)]], {
			brushColor: RED,
			params: { colorRate: 0, alphaRate: 0, smudge: 0 },
			sampleTrail: 1.5,
		});
		expectVec4Close(colors[0], BLUE, 2 / 255);
	});
});

type Vec4 = [number, number, number, number];

/** World 128×128 backdrop centered at origin: green for x<0, blue for x≥0,
 *  with a transparent strip below y<-32. 1 texel per world unit. */
const TEX_SIZE = 128;

function dab(x: number, y: number, size = 16) {
	return { x, y, size };
}

async function runMixChunks(
	chunks: { x: number; y: number; size: number }[][],
	opts: {
		brushColor: { r: number; g: number; b: number; a: number };
		params: { colorRate: number; alphaRate: number; smudge: number };
		blendStyle?: number;
		sampleTrail?: number;
	},
): Promise<Vec4[][]> {
	const device = await getTestDevice();
	const mixPass = new MixPass(device);

	const below = device.createTexture({
		size: [TEX_SIZE, TEX_SIZE],
		format: "rgba8unorm",
		usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
	});
	const pixels = new Uint8Array(TEX_SIZE * TEX_SIZE * 4);
	for (let ty = 0; ty < TEX_SIZE; ty++) {
		for (let tx = 0; tx < TEX_SIZE; tx++) {
			const worldX = tx - TEX_SIZE / 2;
			const worldY = TEX_SIZE / 2 - ty;
			const i = (ty * TEX_SIZE + tx) * 4;
			if (worldY < -32) continue; // transparent strip
			if (worldX < 0) pixels[i + 1] = 200;
			else pixels[i + 2] = 200;
			pixels[i + 3] = 255;
		}
	}
	device.queue.writeTexture(
		{ texture: below },
		pixels,
		{ bytesPerRow: TEX_SIZE * 4 },
		[TEX_SIZE, TEX_SIZE],
	);

	// Flat falloff LUT: every footprint texel weighs 1.
	const lut = device.createTexture({
		size: [256, 1, 32],
		format: "r8unorm",
		usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
	});
	const lutData = new Uint8Array(256).fill(255);
	for (let layer = 0; layer < 32; layer++) {
		device.queue.writeTexture(
			{ texture: lut, origin: [0, 0, layer] },
			lutData,
			{ bytesPerRow: 256 },
			[256, 1, 1],
		);
	}

	// Solid-color PathMeta + identity transform: the mix pass resolves each
	// dab's brush color through the same path the dab shader uses.
	const pathMetaData = new Float32Array(PATH_META_FLOATS);
	pathMetaData[0] = opts.brushColor.r;
	pathMetaData[1] = opts.brushColor.g;
	pathMetaData[2] = opts.brushColor.b;
	pathMetaData[3] = opts.brushColor.a;
	new Uint32Array(pathMetaData.buffer).set([0, 0, 0, 0], 4);
	const pathMetas = makeStorageBuffer(device, pathMetaData);
	const transformData = new Float32Array(16);
	transformData[4] = 1; // m00
	transformData[7] = 1; // m11
	const transforms = makeStorageBuffer(device, transformData);
	const colorStops = makeStorageBuffer(device, new Float32Array(6));

	const bucket = mixPass.createBucket();
	const belowBounds = {
		minX: -TEX_SIZE / 2,
		minY: -TEX_SIZE / 2,
		maxX: TEX_SIZE / 2,
		maxY: TEX_SIZE / 2,
		width: TEX_SIZE,
		height: TEX_SIZE,
	};

	const results: Vec4[][] = [];
	for (const chunk of chunks) {
		const dabData = new Float32Array(chunk.length * DAB_INSTANCE_FLOATS);
		chunk.forEach((d, i) => {
			writeDabField(dabData, i, "positionX", d.x);
			writeDabField(dabData, i, "positionY", d.y);
			writeDabField(dabData, i, "sizeX", d.size);
			writeDabField(dabData, i, "sizeY", d.size);
			writeDabField(dabData, i, "strokeDirX", 1);
			writeDabField(dabData, i, "strokeDirY", 0);
			writeDabField(dabData, i, "hardnessLutIndex", 31);
		});
		const dabBuffer = device.createBuffer({
			size: dabData.byteLength,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
		});
		device.queue.writeBuffer(dabBuffer, 0, dabData);

		const paramData = new Float32Array(chunk.length * 4);
		for (let i = 0; i < chunk.length; i++) {
			paramData[i * 4] = opts.params.colorRate;
			paramData[i * 4 + 1] = opts.params.alphaRate;
			paramData[i * 4 + 2] = opts.params.smudge;
		}
		const paramBuffer = device.createBuffer({
			size: paramData.byteLength,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
		});
		device.queue.writeBuffer(paramBuffer, 0, paramData);

		const outColors = device.createBuffer({
			size: chunk.length * 16,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
		});

		const encoder = device.createCommandEncoder();
		mixPass.resolveChunk(encoder, {
			dabBuffer,
			firstDab: 0,
			dabCount: chunk.length,
			mixParams: paramBuffer,
			below,
			belowBounds,
			stroke: null,
			pathMetas,
			colorStops,
			transforms,
			sampleRadiusRatio: 0.5,
			sampleTrail: opts.sampleTrail ?? 0,
			blendStyle: opts.blendStyle ?? 0,
			falloffLut: lut,
			bucket,
			outColors,
		});
		const readback = device.createBuffer({
			size: chunk.length * 16,
			usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
		});
		encoder.copyBufferToBuffer(outColors, 0, readback, 0, chunk.length * 16);
		device.queue.submit([encoder.finish()]);
		await readback.mapAsync(GPUMapMode.READ);
		const floats = new Float32Array(readback.getMappedRange()).slice();
		readback.unmap();
		results.push(
			chunk.map(
				(_, i) =>
					[
						floats[i * 4],
						floats[i * 4 + 1],
						floats[i * 4 + 2],
						floats[i * 4 + 3],
					] as Vec4,
			),
		);
		dabBuffer.destroy();
		paramBuffer.destroy();
		outColors.destroy();
		readback.destroy();
	}
	mixPass.destroy();
	below.destroy();
	lut.destroy();
	pathMetas.destroy();
	transforms.destroy();
	colorStops.destroy();
	return results;
}

function makeStorageBuffer(device: GPUDevice, data: Float32Array): GPUBuffer {
	const buffer = device.createBuffer({
		size: data.byteLength,
		usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
	});
	device.queue.writeBuffer(buffer, 0, data);
	return buffer;
}

function expectVec4Close(actual: Vec4, expected: Vec4, tolerance: number) {
	for (let i = 0; i < 4; i++) {
		expect(
			Math.abs(actual[i] - expected[i]),
			`channel ${i}: ${actual} vs ${expected}`,
		).toBeLessThanOrEqual(tolerance);
	}
}

/** TS reference of the [B] scan recurrence over known uniform samples. */
function scanReference(
	samples: Vec4[],
	params: { colorRate: number; alphaRate: number; smudge: number },
	brushColor: Vec4,
	blendStyle: number,
): Vec4[] {
	let bucket: Vec4 | null = null;
	return samples.map((sample) => {
		bucket ??= sample;
		bucket = lerp4(sample, bucket, params.smudge);
		const rgbRate = params.colorRate * params.colorRate;
		const vivid = mixOklchRef(bucket, brushColor, rgbRate);
		const muted = mixOklabRef(bucket, brushColor, rgbRate);
		return [
			vivid[0] + (muted[0] - vivid[0]) * blendStyle,
			vivid[1] + (muted[1] - vivid[1]) * blendStyle,
			vivid[2] + (muted[2] - vivid[2]) * blendStyle,
			bucket[3] + (brushColor[3] - bucket[3]) * params.alphaRate,
		];
	});
}

function lerp4(a: Vec4, b: Vec4, t: number): Vec4 {
	return [
		a[0] + (b[0] - a[0]) * t,
		a[1] + (b[1] - a[1]) * t,
		a[2] + (b[2] - a[2]) * t,
		a[3] + (b[3] - a[3]) * t,
	];
}

function srgbToLinearScalar(c: number): number {
	return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function linearToSrgbScalar(c: number): number {
	return c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
}

function srgbToOklab(rgb: readonly number[]): [number, number, number] {
	const r = srgbToLinearScalar(Math.min(Math.max(rgb[0], 0), 1));
	const g = srgbToLinearScalar(Math.min(Math.max(rgb[1], 0), 1));
	const b = srgbToLinearScalar(Math.min(Math.max(rgb[2], 0), 1));
	const l = Math.cbrt(
		Math.max(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b, 0),
	);
	const m = Math.cbrt(
		Math.max(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b, 0),
	);
	const s = Math.cbrt(
		Math.max(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b, 0),
	);
	return [
		0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
		1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
		0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
	];
}

function oklabToSrgb(lab: readonly number[]): [number, number, number] {
	const l = (lab[0] + 0.3963377774 * lab[1] + 0.2158037573 * lab[2]) ** 3;
	const m = (lab[0] - 0.1055613458 * lab[1] - 0.0638541728 * lab[2]) ** 3;
	const s = (lab[0] - 0.0894841775 * lab[1] - 1.291485548 * lab[2]) ** 3;
	const clamp01 = (v: number) => Math.min(Math.max(v, 0), 1);
	return [
		linearToSrgbScalar(
			clamp01(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
		),
		linearToSrgbScalar(
			clamp01(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
		),
		linearToSrgbScalar(
			clamp01(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
		),
	];
}

function mixOklabRef(a: Vec4, b: Vec4, t: number): [number, number, number] {
	const labA = srgbToOklab(a);
	const labB = srgbToOklab(b);
	return oklabToSrgb([
		labA[0] + (labB[0] - labA[0]) * t,
		labA[1] + (labB[1] - labA[1]) * t,
		labA[2] + (labB[2] - labA[2]) * t,
	]);
}

function mixOklchRef(a: Vec4, b: Vec4, t: number): [number, number, number] {
	const labA = srgbToOklab(a);
	const labB = srgbToOklab(b);
	const mixed = [
		labA[0] + (labB[0] - labA[0]) * t,
		labA[1] + (labB[1] - labA[1]) * t,
		labA[2] + (labB[2] - labA[2]) * t,
	];
	const chromaA = Math.hypot(labA[1], labA[2]);
	const chromaB = Math.hypot(labB[1], labB[2]);
	const targetChroma = chromaA + (chromaB - chromaA) * t;
	const mixedChroma = Math.hypot(mixed[1], mixed[2]);
	const rawScale = targetChroma / Math.max(mixedChroma, 1e-5);
	const x = Math.min(Math.max(mixedChroma / 0.015, 0), 1);
	const chromaBlend = x * x * (3 - 2 * x);
	const scale = 1 + (Math.min(rawScale, 4) - 1) * chromaBlend;
	return oklabToSrgb([mixed[0], mixed[1] * scale, mixed[2] * scale]);
}
