import { beforeAll, describe, expect, it } from "vitest";
import {
	captureTexturePixels,
	ensureWebGPUGlobals,
} from "../../../testUtils/visualRegression";
import { computeQuadProjectiveWeights } from "../../../utils/geometry/quadProjection";
import { BackdropCaptureManager } from "../../canvas/pipeline/BackdropCaptureManager";
import {
	BackdropEffectCoordinator,
	type BackdropEffectRequest,
} from "../../canvas/pipeline/BackdropEffectCoordinator";
import type { FilterRenderer } from "../../canvas/pipeline/FilterRenderer";
import { TexturePool } from "../../canvas/pipeline/TexturePool";
import {
	RefractionCompositor,
	type RefractionParams,
} from "./RefractionCompositor";

const WIDTH = 8;
const HEIGHT = 8;
/** World bounds mapping exactly onto the 8×8 canvas at zoom 1 (origin center). */
const FULL_BOUNDS = {
	minX: -WIDTH / 2,
	minY: -HEIGHT / 2,
	maxX: WIDTH / 2,
	maxY: HEIGHT / 2,
	width: WIDTH,
	height: HEIGHT,
};
const VIEWPORT = { x: 0, y: 0, zoom: 1 };
/** An axis-aligned solid filling the whole compose viewport: the quad corners
 *  in NDC (TL,TR / BR,BL) with no projective correction. */
const FULL_VIEWPORT_QUAD = {
	quadNdc: [
		[-1, 1, 1, 1],
		[1, -1, -1, -1],
	],
	quadQ: [1, 1, 1, 1],
} satisfies Pick<RefractionParams, "quadNdc" | "quadQ">;

// Backdrop: left half red, right half blue — a horizontal offset moves the
// sampled color across the seam so we can read the refraction direction.
const RED: [number, number, number, number] = [255, 0, 0, 255];
const BLUE: [number, number, number, number] = [0, 0, 255, 255];
// Screen-space normal tilted +X, coverage 1: encoded (2·n−1 → n) as (1, .5).
const NORMAL_RIGHT: [number, number, number, number] = [255, 128, 0, 255];

let device: GPUDevice;

beforeAll(async () => {
	const gpu = await ensureWebGPUGlobals();
	const adapter = await gpu.requestAdapter();
	if (!adapter) throw new Error("Failed to get GPU adapter for test");
	device = await adapter.requestDevice();
});

describe("RefractionCompositor (extrudeRefraction.wgsl + backdrop pyramid)", () => {
	it("should reproduce the backdrop when the offset is zero", async () => {
		const pixels = await compose({
			mesh: () => [0, 0, 0, 0],
			normal: () => NORMAL_RIGHT,
			backdrop: (x) => (x < 4 ? RED : BLUE),
			params: { refractScale: 0, aberration: 0, blurSigma: 0 },
		});

		expectPixelAt(pixels, 0, 0, RED, 4);
		expectPixelAt(pixels, 7, 0, BLUE, 4);
	});

	it("should sample the backdrop shifted toward the normal tilt", async () => {
		// +X normal with a half-width offset pushes a left (red) pixel's sample
		// past the seam into the blue half.
		const pixels = await compose({
			mesh: () => [0, 0, 0, 0],
			normal: () => NORMAL_RIGHT,
			backdrop: (x) => (x < 4 ? RED : BLUE),
			params: { refractScale: 0.5, aberration: 0, blurSigma: 0 },
		});

		expectPixelAt(pixels, 0, 0, BLUE, 8);
	});

	it("should not refract outside the solid (zero coverage)", async () => {
		// Coverage 0 (normal alpha 0) → offset is gated to zero, backdrop as-is.
		const pixels = await compose({
			mesh: () => [0, 0, 0, 0],
			normal: () => [255, 128, 0, 0],
			backdrop: (x) => (x < 4 ? RED : BLUE),
			params: { refractScale: 0.5, aberration: 0, blurSigma: 0 },
		});

		expectPixelAt(pixels, 0, 0, RED, 4);
	});

	it("should hide the backdrop under an opaque solid", async () => {
		// Opaque green mesh (premultiplied) → over-composite leaves only green.
		const pixels = await compose({
			mesh: () => [0, 255, 0, 255],
			normal: () => NORMAL_RIGHT,
			backdrop: () => RED,
			params: { refractScale: 0.5, aberration: 0, blurSigma: 0 },
		});

		expectPixelAt(pixels, 4, 4, [0, 255, 0, 255], 4);
	});

	it("should keep the blur inside the solid (no leak past the edges)", async () => {
		// Coverage 0: the solid mixes in `sharp` (the unblurred backdrop), so a
		// pixel next to the red/blue seam stays sharp even though pyramid levels
		// were built — nothing bleeds the other color in outside the solid.
		const pixels = await compose({
			mesh: () => [0, 0, 0, 0],
			normal: () => [128, 128, 0, 0],
			backdrop: (x) => (x < 4 ? RED : BLUE),
			params: { refractScale: 0, aberration: 0, blurSigma: 2 },
		});

		expectPixelAt(pixels, 3, 0, RED, 4);
		expectPixelAt(pixels, 4, 0, BLUE, 4);
	});

	it("should soften the backdrop with the pyramid blur under the solid", async () => {
		// Coverage 1: the solid shows the blurred backdrop (pyramid levels
		// bracketing sigma, lerped), so a red-side pixel near the seam picks up
		// blue from the downsampled levels.
		const pixels = await compose({
			mesh: () => [0, 0, 0, 0],
			normal: () => [128, 128, 0, 255],
			backdrop: (x) => (x < 4 ? RED : BLUE),
			params: { refractScale: 0, aberration: 0, blurSigma: 3 },
		});

		const i = 3 * 4;
		expect(pixels[i + 2]).toBeGreaterThan(20);
	});

	it("should leave pixels outside the solid untouched even when the capture is stale", async () => {
		// A backdrop sample can predate content drawn after it. Outside the solid
		// (coverage 0) the compose must not write at all — rewriting the rect
		// with the stale capture used to roll the glass BBox back to the old
		// backdrop.
		const compositor = new RefractionCompositor(device);
		compositor.initialize("rgba8unorm");
		compositor.beginFrame();
		const texturePool = new TexturePool(device);
		const coordinator = new BackdropEffectCoordinator(
			device,
			texturePool,
			new BackdropCaptureManager(device, null as unknown as FilterRenderer),
		);

		const meshColor = makeTexture(() => [0, 0, 0, 0]);
		const meshNormal = makeTexture(() => [128, 128, 0, 0]); // coverage 0
		const target = makeTexture(
			() => RED,
			GPUTextureUsage.RENDER_ATTACHMENT |
				GPUTextureUsage.COPY_SRC |
				GPUTextureUsage.COPY_DST |
				GPUTextureUsage.TEXTURE_BINDING,
		);
		const request: BackdropEffectRequest = {
			bounds: FULL_BOUNDS,
			blurSigma: 0,
		};
		coordinator.beginFrame();
		coordinator.planFrame([request]);

		// Capture while the target is RED…
		const captureEncoder = device.createCommandEncoder();
		const sample = coordinator.acquireSample(
			captureEncoder,
			target,
			VIEWPORT,
			WIDTH,
			HEIGHT,
			request,
		);
		if (!sample) throw new Error("acquireSample returned null");
		device.queue.submit([captureEncoder.finish()]);

		// …then repaint it BLUE, making the capture stale.
		const blueData = new Uint8Array(WIDTH * HEIGHT * 4);
		for (let i = 0; i < WIDTH * HEIGHT; i++) {
			blueData[i * 4 + 2] = 255;
			blueData[i * 4 + 3] = 255;
		}
		device.queue.writeTexture(
			{ texture: target },
			blueData,
			{ bytesPerRow: WIDTH * 4 },
			{ width: WIDTH, height: HEIGHT },
		);

		const composeEncoder = device.createCommandEncoder();
		compositor.compose(
			composeEncoder,
			target.createView(),
			true,
			meshColor,
			meshNormal,
			sample,
			{
				refractScale: 0,
				aberration: 0,
				meshUvRect: [0, 0, 1, 1],
				...FULL_VIEWPORT_QUAD,
			},
		);
		device.queue.submit([composeEncoder.finish()]);

		const pixels = await captureTexturePixels(device, target, WIDTH, HEIGHT);
		coordinator.releaseFrame((tex) => {
			if (!texturePool.release(tex)) tex.destroy();
		});
		coordinator.destroy();
		texturePool.destroy();
		meshColor.destroy();
		meshNormal.destroy();
		target.destroy();
		compositor.destroy();

		expectPixelAt(pixels, 4, 4, BLUE, 2);
	});

	it("should keep each glass reading its own region of a shared batch capture", async () => {
		// Two glasses over one 16×8 backdrop (left red, right blue) — near enough
		// to share one capture. Each must sample ITS region through the non-identity
		// backdropRemap, so the left glass stays red and the right stays blue; a
		// remap bug would bleed the neighbor's color across.
		const W = 16;
		const H = 8;
		const compositor = new RefractionCompositor(device);
		compositor.initialize("rgba8unorm");
		compositor.beginFrame();
		const texturePool = new TexturePool(device);
		const coordinator = new BackdropEffectCoordinator(
			device,
			texturePool,
			new BackdropCaptureManager(device, null as unknown as FilterRenderer),
		);

		const meshColor = makeTexture(() => [0, 0, 0, 0], undefined, W, H);
		const meshNormal = makeTexture(() => [128, 128, 0, 255], undefined, W, H);
		const target = makeTexture(
			(x) => (x < W / 2 ? RED : BLUE),
			GPUTextureUsage.RENDER_ATTACHMENT |
				GPUTextureUsage.COPY_SRC |
				GPUTextureUsage.COPY_DST |
				GPUTextureUsage.TEXTURE_BINDING,
			W,
			H,
		);

		// World: canvas spans x ∈ [-8, 8], y ∈ [-4, 4] at zoom 1.
		const left: BackdropEffectRequest = {
			bounds: { minX: -8, minY: -4, maxX: 0, maxY: 4, width: 8, height: 8 },
			blurSigma: 0,
		};
		const right: BackdropEffectRequest = {
			bounds: { minX: 0, minY: -4, maxX: 8, maxY: 4, width: 8, height: 8 },
			blurSigma: 0,
		};
		coordinator.beginFrame();
		coordinator.planFrame([left, right]);

		const encoder = device.createCommandEncoder();
		for (const request of [left, right]) {
			const sample = coordinator.acquireSample(
				encoder,
				target,
				VIEWPORT,
				W,
				H,
				request,
			);
			if (!sample) throw new Error("acquireSample returned null");
			compositor.compose(
				encoder,
				target.createView(),
				true,
				meshColor,
				meshNormal,
				sample,
				{
					refractScale: 0,
					aberration: 0,
					meshUvRect: [0, 0, 1, 1],
					...FULL_VIEWPORT_QUAD,
				},
			);
		}
		device.queue.submit([encoder.finish()]);

		const pixels = await captureTexturePixels(device, target, W, H);
		coordinator.releaseFrame((tex) => {
			if (!texturePool.release(tex)) tex.destroy();
		});
		coordinator.destroy();
		texturePool.destroy();
		meshColor.destroy();
		meshNormal.destroy();
		target.destroy();
		compositor.destroy();

		expectPixelAt(pixels, 0, 4, RED, 4, W);
		expectPixelAt(pixels, 7, 4, RED, 4, W);
		expectPixelAt(pixels, 8, 4, BLUE, 4, W);
		expectPixelAt(pixels, 15, 4, BLUE, 4, W);
	});

	it("should match the opaque composite when a transparent composite is flattened over white", async () => {
		// Same scene, two grounds: red block on transparent vs red block on
		// white. The compose must replace the destination within coverage, so
		// flattening the transparent result over white reproduces the opaque
		// one. Keying the blend on the blurred alpha instead leaves the sharp
		// red edge showing through at (1 - alpha) — only on the transparent
		// ground.
		const transparent = await compose({
			mesh: () => [0, 0, 0, 0],
			normal: () => [128, 128, 0, 255],
			backdrop: (x) => (x < 4 ? RED : [0, 0, 0, 0]),
			params: { refractScale: 0, aberration: 0, blurSigma: 2 },
		});
		const opaque = await compose({
			mesh: () => [0, 0, 0, 0],
			normal: () => [128, 128, 0, 255],
			backdrop: (x) => (x < 4 ? RED : [255, 255, 255, 255]),
			params: { refractScale: 0, aberration: 0, blurSigma: 2 },
		});

		// Blur softens the alpha edge, so just inside the red block the result
		// must be translucent, not the opaque sharp red.
		const seam = (4 * WIDTH + 3) * 4;
		expect(transparent[seam + 3]).toBeLessThan(250);

		for (let i = 0; i < transparent.length; i += 4) {
			const a = transparent[i + 3] / 255;
			for (let c = 0; c < 3; c++) {
				const flattened = transparent[i + c] + 255 * (1 - a);
				expect(Math.abs(flattened - opaque[i + c])).toBeLessThanOrEqual(6);
			}
		}
	});

	it("should keep a transparent backdrop transparent under the glass", async () => {
		// A transparent glass solid (coverage 1) over a transparent backdrop must
		// stay transparent, not composite to opaque black — otherwise a
		// transparent-background PNG export renders black behind the glass.
		const pixels = await compose({
			mesh: () => [0, 0, 0, 0],
			normal: () => [128, 128, 0, 255],
			backdrop: () => [0, 0, 0, 0],
			params: { refractScale: 0, aberration: 0, blurSigma: 0 },
		});

		expectPixelAt(pixels, 4, 4, [0, 0, 0, 0], 2);
	});

	describe("projective quad mapping", () => {
		// The mesh texture encodes its own UV in rg (r = u, g = v) and is fully
		// opaque, so a composed pixel reads back exactly which mesh UV the
		// compositor sampled there.
		const UV_MESH = (
			x: number,
			y: number,
		): [number, number, number, number] => [
			Math.round((x / (QUAD_SIZE - 1)) * 255),
			Math.round((y / (QUAD_SIZE - 1)) * 255),
			0,
			255,
		];
		const FLAT_COVERED: [number, number, number, number] = [128, 128, 0, 255];

		it("should map an axis-aligned quad's corners to the mesh corners", async () => {
			const pixels = await composeQuad({
				quad: [
					[-1, 1, 1, 1],
					[1, -1, -1, -1],
				],
				q: [1, 1, 1, 1],
			});

			expectMeshUvAt(pixels, 0, 0, [0, 0]);
			expectMeshUvAt(pixels, QUAD_SIZE - 1, 0, [1, 0]);
			expectMeshUvAt(pixels, QUAD_SIZE - 1, QUAD_SIZE - 1, [1, 1]);
			expectMeshUvAt(pixels, 0, QUAD_SIZE - 1, [0, 1]);
		});

		it("should map a 45°-rotated square's corners to the mesh corners", async () => {
			// A diamond inscribed in the viewport: each mesh corner lands on the
			// midpoint of one viewport edge.
			const pixels = await composeQuad({
				quad: [
					[0, 1, 1, 0],
					[0, -1, -1, 0],
				],
				q: [1, 1, 1, 1],
			});

			const mid = QUAD_SIZE / 2;
			expectMeshUvAt(pixels, mid, 1, [0, 0], 0.08);
			expectMeshUvAt(pixels, QUAD_SIZE - 2, mid, [1, 0], 0.08);
			expectMeshUvAt(pixels, mid, QUAD_SIZE - 2, [1, 1], 0.08);
			expectMeshUvAt(pixels, 1, mid, [0, 1], 0.08);
			// A rotation is a parallelogram, so the centre is still the mid UV.
			expectMeshUvAt(pixels, mid, mid, [0.5, 0.5], 0.05);
		});

		it("should follow the projective mapping inside a trapezoid", async () => {
			// Quad TL(-0.5,1) TR(0.5,1) BR(1,-1) BL(-1,-1). Its diagonals cross at
			// NDC (0, 1/3) — the point that must read UV (0.5, 0.5) under a
			// projective mapping. Plain per-triangle interpolation would put
			// (0.667, 0.333) there, since that point sits on the TR–BL split edge
			// one third of the way from TR.
			const pixels = await composeQuad({
				quad: [
					[-0.5, 1, 0.5, 1],
					[1, -1, -1, -1],
				],
				q: computeQuadProjectiveWeights([
					{ x: -0.5, y: 1 },
					{ x: 0.5, y: 1 },
					{ x: 1, y: -1 },
					{ x: -1, y: -1 },
				]),
			});

			const x = QUAD_SIZE / 2;
			const y = Math.round((QUAD_SIZE * (1 - 1 / 3)) / 2);
			expectMeshUvAt(pixels, x, y, [0.5, 0.5], 0.06);
		});

		it("should read the mesh, its normal and the backdrop at the same place", async () => {
			// Coverage lives in the normal texture's alpha and is sampled through
			// the same projective UV as the color. Give the normal coverage only
			// on the mesh's left half: the composed result must then keep the
			// untouched backdrop exactly where the mesh's u > 0.5, whatever the
			// quad's shape.
			const quad: [number, number, number, number][] = [
				[-0.5, 1, 0.5, 1],
				[1, -1, -1, -1],
			];
			const q = computeQuadProjectiveWeights([
				{ x: -0.5, y: 1 },
				{ x: 0.5, y: 1 },
				{ x: 1, y: -1 },
				{ x: -1, y: -1 },
			]);
			const covered = await composeQuad({ quad, q });
			const halfCovered = await composeQuad({
				quad,
				q,
				normal: (x) => [128, 128, 0, x < QUAD_SIZE / 2 ? 255 : 0],
			});

			// Walk the row through the diagonal crossing; wherever the fully
			// covered pass reports u ≤ 0.5 the masked pass must have drawn too,
			// and wherever it reports u > 0.5 the backdrop must survive.
			const row = Math.round((QUAD_SIZE * (1 - 1 / 3)) / 2);
			let checked = 0;
			for (let x = 1; x < QUAD_SIZE - 1; x++) {
				const i = (row * QUAD_SIZE + x) * 4;
				// The mesh never writes blue, so a blue pixel is bare backdrop —
				// i.e. outside the quad, where neither pass draws anything.
				if (covered[i + 2] > 200) continue;
				const u = covered[i] / 255;
				if (Math.abs(u - 0.5) < 0.1) continue;
				checked++;
				if (u > 0.5) {
					expect(halfCovered[i + 2]).toBeGreaterThan(200);
				} else {
					expect(halfCovered[i + 2]).toBeLessThan(60);
				}
			}
			expect(checked).toBeGreaterThan(8);
		});

		it("should leave every pixel outside the quad untouched", async () => {
			// A quad covering only the middle: the backdrop must survive
			// everywhere else, including the corners of its own bounding box.
			const pixels = await composeQuad({
				quad: [
					[-0.5, 0.5, 0.5, 0.5],
					[0.5, -0.5, -0.5, -0.5],
				],
				q: [1, 1, 1, 1],
			});

			for (const [x, y] of [
				[0, 0],
				[QUAD_SIZE - 1, 0],
				[0, QUAD_SIZE - 1],
				[QUAD_SIZE - 1, QUAD_SIZE - 1],
			]) {
				const i = (y * QUAD_SIZE + x) * 4;
				expect(pixels[i + 2]).toBeGreaterThan(200);
				expect(pixels[i]).toBeLessThan(60);
			}
		});

		/** Compose one UV-encoding mesh over a plain blue backdrop. */
		async function composeQuad({
			quad,
			q,
			normal = () => FLAT_COVERED,
		}: {
			quad: [number, number, number, number][];
			q: [number, number, number, number];
			normal?: (x: number, y: number) => [number, number, number, number];
		}): Promise<Uint8Array> {
			return composeWithQuad({
				mesh: UV_MESH,
				normal,
				backdrop: () => BLUE,
				size: QUAD_SIZE,
				quadNdc: [quad[0], quad[1]],
				quadQ: q,
			});
		}
	});
});

// Helpers

/** Side of the square canvas the projective-quad cases compose over. */
const QUAD_SIZE = 48;

/** Assert the mesh UV the compositor sampled at a pixel (mesh rg = uv). */
function expectMeshUvAt(
	pixels: Uint8Array,
	x: number,
	y: number,
	[u, v]: [number, number],
	tolerance = 0.03,
): void {
	const i = (y * QUAD_SIZE + x) * 4;
	expect(Math.abs(pixels[i] / 255 - u)).toBeLessThanOrEqual(tolerance);
	expect(Math.abs(pixels[i + 1] / 255 - v)).toBeLessThanOrEqual(tolerance);
}

/** Run the real capture → pyramid → refraction-compose chain over an 8×8
 *  target pre-filled with the backdrop pattern (the prebuf stand-in). */
async function compose({
	mesh,
	normal,
	backdrop,
	params,
}: {
	mesh: (x: number, y: number) => [number, number, number, number];
	normal: (x: number, y: number) => [number, number, number, number];
	backdrop: (x: number, y: number) => [number, number, number, number];
	params: { refractScale: number; aberration: number; blurSigma: number };
}): Promise<Uint8Array> {
	return composeWithQuad({
		mesh,
		normal,
		backdrop,
		size: WIDTH,
		refractScale: params.refractScale,
		aberration: params.aberration,
		blurSigma: params.blurSigma,
		...FULL_VIEWPORT_QUAD,
	});
}

/** The same chain over a square canvas of `size`, with the solid drawn as an
 *  explicit quad in compose-viewport NDC. */
async function composeWithQuad({
	mesh,
	normal,
	backdrop,
	size,
	quadNdc,
	quadQ,
	refractScale = 0,
	aberration = 0,
	blurSigma = 0,
}: {
	mesh: (x: number, y: number) => [number, number, number, number];
	normal: (x: number, y: number) => [number, number, number, number];
	backdrop: (x: number, y: number) => [number, number, number, number];
	size: number;
	quadNdc: RefractionParams["quadNdc"];
	quadQ: RefractionParams["quadQ"];
	refractScale?: number;
	aberration?: number;
	blurSigma?: number;
}): Promise<Uint8Array> {
	const compositor = new RefractionCompositor(device);
	compositor.initialize("rgba8unorm");
	compositor.beginFrame();
	const texturePool = new TexturePool(device);
	// captureRegion only touches its FilterRenderer when filters are passed —
	// the coordinator never passes any.
	const coordinator = new BackdropEffectCoordinator(
		device,
		texturePool,
		new BackdropCaptureManager(device, null as unknown as FilterRenderer),
	);

	const meshColor = makeTexture(mesh, undefined, size, size);
	const meshNormal = makeTexture(normal, undefined, size, size);
	const target = makeTexture(
		backdrop,
		GPUTextureUsage.RENDER_ATTACHMENT |
			GPUTextureUsage.COPY_SRC |
			GPUTextureUsage.COPY_DST |
			GPUTextureUsage.TEXTURE_BINDING,
		size,
		size,
	);

	const request: BackdropEffectRequest = {
		bounds: {
			minX: -size / 2,
			minY: -size / 2,
			maxX: size / 2,
			maxY: size / 2,
			width: size,
			height: size,
		},
		blurSigma,
	};
	coordinator.beginFrame();
	coordinator.planFrame([request]);

	const encoder = device.createCommandEncoder();
	const sample = coordinator.acquireSample(
		encoder,
		target,
		VIEWPORT,
		size,
		size,
		request,
	);
	if (!sample) throw new Error("acquireSample returned null");
	// load=true: the compose is coverage-masked (over-blend), so pixels
	// outside the solid must come from the existing target content — exactly
	// how the real prebuf path drives it.
	compositor.compose(
		encoder,
		target.createView(),
		true,
		meshColor,
		meshNormal,
		sample,
		{
			refractScale,
			aberration,
			meshUvRect: [0, 0, 1, 1],
			quadNdc,
			quadQ,
		},
	);
	device.queue.submit([encoder.finish()]);

	const pixels = await captureTexturePixels(device, target, size, size);
	coordinator.releaseFrame((tex) => {
		if (!texturePool.release(tex)) tex.destroy();
	});
	coordinator.destroy();
	texturePool.destroy();
	meshColor.destroy();
	meshNormal.destroy();
	target.destroy();
	compositor.destroy();
	return pixels;
}

function makeTexture(
	fn: (x: number, y: number) => [number, number, number, number],
	usage: GPUTextureUsageFlags = GPUTextureUsage.TEXTURE_BINDING |
		GPUTextureUsage.COPY_DST,
	width = WIDTH,
	height = HEIGHT,
): GPUTexture {
	const data = new Uint8Array(width * height * 4);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const [r, g, b, a] = fn(x, y);
			const i = (y * width + x) * 4;
			data[i] = r;
			data[i + 1] = g;
			data[i + 2] = b;
			data[i + 3] = a;
		}
	}
	const texture = device.createTexture({
		size: { width, height },
		format: "rgba8unorm",
		usage,
	});
	device.queue.writeTexture(
		{ texture },
		data,
		{ bytesPerRow: width * 4 },
		{ width, height },
	);
	return texture;
}

function expectPixelAt(
	pixels: Uint8Array,
	col: number,
	row: number,
	expected: [number, number, number, number],
	tolerance = 1,
	width = WIDTH,
): void {
	const i = (row * width + col) * 4;
	for (let c = 0; c < 4; c++) {
		expect(Math.abs(pixels[i + c] - expected[c])).toBeLessThanOrEqual(
			tolerance,
		);
	}
}
