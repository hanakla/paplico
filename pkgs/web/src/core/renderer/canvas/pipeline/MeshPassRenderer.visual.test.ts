import { beforeAll, describe, expect, it } from "vitest";
import type { CubicBezierSegment } from "../../../schema";
import {
	captureTexturePixels,
	ensureWebGPUGlobals,
} from "../../../testUtils/visualRegression";
import { mat4Identity, mat4Orthographic } from "../../../utils/geometry/mat4";
import type { ExtrudeMeshData } from "../../geometry/extrudeMesh";
import { buildRevolveMesh } from "../../geometry/revolveMesh";
import {
	type MeshPassGeometry,
	type MeshPassParams,
	MeshPassRenderer,
} from "./MeshPassRenderer";
import { quantizeSize } from "./TexturePool";

// encodePass's internal MSAA scratch is quantized via TexturePool, matching
// the production caller (which always sources colorTexture/normalTexture
// from a TexturePool, so they're already quantum-sized). Quantize here too
// so the resolve target's size matches the MSAA attachment's exactly.
const WIDTH = quantizeSize(8);
const HEIGHT = quantizeSize(8);

let device: GPUDevice;

beforeAll(async () => {
	const gpu = await ensureWebGPUGlobals();
	const adapter = await gpu.requestAdapter();
	if (!adapter) throw new Error("Failed to get GPU adapter for test");
	device = await adapter.requestDevice();
});

describe("MeshPassRenderer (meshLit.wgsl)", () => {
	it("should output the plain premultiplied base color in flat mode", async () => {
		const pixels = await renderQuad({
			baseColor: [1, 0, 0, 1],
			lightDir: [0, 0, 1],
			shadingMode: 0,
			specularPower: 32,
		});

		expectPixel(pixels, [255, 0, 0, 255]);
	});

	it("should premultiply alpha in the output", async () => {
		const pixels = await renderQuad({
			baseColor: [1, 0, 0, 0.5],
			lightDir: [0, 0, 1],
			shadingMode: 0,
			specularPower: 32,
		});

		expectPixel(pixels, [128, 0, 0, 128], 2);
	});

	it("should fully light a lambert surface facing the light", async () => {
		const pixels = await renderQuad({
			baseColor: [1, 0, 0, 1],
			lightDir: [0, 0, 1],
			shadingMode: 1,
			specularPower: 32,
		});

		expectPixel(pixels, [255, 0, 0, 255]);
	});

	it("should fall back to the ambient floor when facing away from the light", async () => {
		const pixels = await renderQuad({
			baseColor: [1, 0, 0, 1],
			lightDir: [0, 0, -1],
			shadingMode: 1,
			specularPower: 32,
		});

		// Ambient floor 0.25 → 64.
		expectPixel(pixels, [64, 0, 0, 255], 2);
	});

	it("should add a specular highlight in blinn-phong mode", async () => {
		const pixels = await renderQuad({
			baseColor: [0, 1, 0, 1],
			lightDir: [0, 0, 1],
			shadingMode: 2,
			specularPower: 32,
		});

		// Full diffuse green + white specular 0.5 → (128, 255, 128).
		expectPixel(pixels, [128, 255, 128, 255], 3);
	});

	it("should sample the albedo texture and keep premultiplied output", async () => {
		// Premultiplied translucent red texel; the shader un-premultiplies for
		// lighting (flat here) then re-premultiplies on output → round-trips to
		// the same premultiplied bytes. baseColor is ignored when useTexture is on.
		const pixels = await renderTexturedQuad([128, 0, 0, 128], {
			baseColor: [0, 1, 0, 1],
			lightDir: [0, 0, 1],
			shadingMode: 0,
			specularPower: 32,
		});

		expectPixel(pixels, [128, 0, 0, 128], 2);
	});

	it("should reproduce the classic look when PBR params are neutral", async () => {
		// Neutral pbr (reflect 0, glass 0, no fresnel) must leave the lambert
		// output byte-identical to the pre-PBR shader.
		const pixels = await renderQuad({
			baseColor: [1, 0, 0, 1],
			lightDir: [0, 0, -1],
			shadingMode: 1,
			specularPower: 32,
			pbr: { roughness: 0.5, metalness: 0, reflectivity: 0, glass: 0 },
		});

		expectPixel(pixels, [64, 0, 0, 255], 2);
	});

	it("should drop coverage for glass so the backdrop shows through", async () => {
		// glass 0.5 halves the premultiplied output → the alpha blit composites
		// it 50% over the real backdrop.
		const pixels = await renderQuad({
			baseColor: [1, 0, 0, 1],
			lightDir: [0, 0, 1],
			shadingMode: 1,
			specularPower: 32,
			pbr: { roughness: 0.5, metalness: 0, reflectivity: 0, glass: 0.5 },
		});

		expectPixel(pixels, [128, 0, 0, 128], 2);
	});

	it("should darken the diffuse toward black as metalness rises", async () => {
		// Full metal kills the diffuse albedo (reflectivity 0 → no env fill).
		const pixels = await renderQuad({
			baseColor: [1, 0, 0, 1],
			lightDir: [0, 0, 1],
			shadingMode: 1,
			specularPower: 32,
			pbr: { roughness: 0.5, metalness: 1, reflectivity: 0, glass: 0 },
		});

		expectPixel(pixels, [0, 0, 0, 255], 2);
	});

	it("should add a rim term when fresnel is enabled and facing the viewer", async () => {
		// Quad faces +Z (N·V = 1) so 1−N·V = 0: with factor 1 the rim reduces to
		// the bias term. bias 0.5, intensity 1, blue color → +0.5 blue.
		const pixels = await renderQuad({
			baseColor: [0, 0, 0, 1],
			lightDir: [0, 0, -1],
			shadingMode: 1,
			specularPower: 32,
			pbr: { roughness: 0.5, metalness: 0, reflectivity: 0, glass: 0 },
			fresnel: {
				color: [0, 0, 1],
				bias: 0.5,
				scale: 1,
				intensity: 1,
				factor: 1,
			},
		});

		// base 0 lit → 0; rim = saturate(0.5 + 1·0) = 0.5 → blue 128.
		expectPixel(pixels, [0, 0, 128, 255], 3);
	});

	it("should emit the screen-space normal and coverage in the MRT variant", async () => {
		// Quad faces +Z → normal (0,0,1) encodes to (0.5, 0.5, 0.0) and
		// coverage 1. The color target still carries the lit result.
		const { color, normal } = await renderQuadMRT({
			baseColor: [1, 0, 0, 1],
			lightDir: [0, 0, 1],
			shadingMode: 1,
			specularPower: 32,
		});

		expectPixel(color, [255, 0, 0, 255]);
		expectPixel(normal, [128, 128, 0, 255], 2);
	});

	it("should sample the tiled surface pattern via the wrap uv", async () => {
		// 2×2 pattern; the wrap uv (0.25, 0.25) with a unit tile lands exactly on
		// texel (0,0) = blue. The pattern replaces baseColor as the albedo, and
		// flat shading round-trips the premultiplied bytes.
		const pixels = await renderPatternedQuad(
			// row 0: (0,0)=blue (1,0)=green ; row 1: (0,1)=red (1,1)=white
			// biome-ignore format: texel table
			[
				0, 0, 255, 255, 0, 255, 0, 255,
				255, 0, 0, 255, 255, 255, 255, 255,
			],
			[0.25, 0.25],
			{
				baseColor: [0, 1, 0, 1],
				lightDir: [0, 0, 1],
				shadingMode: 0,
				specularPower: 32,
			},
		);

		expectPixel(pixels, [0, 0, 255, 255], 2);
	});

	it("should keep the base fill visible through transparent pattern regions", async () => {
		// A fully transparent pattern is a decal over the fill/baseColor, not a
		// replacement — the base color must show through unchanged.
		const pixels = await renderPatternedQuad(
			// biome-ignore format: texel table
			[
				0, 0, 0, 0, 0, 0, 0, 0,
				0, 0, 0, 0, 0, 0, 0, 0,
			],
			[0.25, 0.25],
			{
				baseColor: [1, 0, 0, 1],
				lightDir: [0, 0, 1],
				shadingMode: 0,
				specularPower: 32,
			},
		);

		expectPixel(pixels, [255, 0, 0, 255], 2);
	});

	it("should keep the surface pattern opaque over a semi-transparent object", async () => {
		// baseColor is 50% transparent, but the opaque pattern (default opacity 1)
		// composites at its own coverage — the surface stays fully opaque where
		// the pattern is drawn, independent of the object's alpha.
		const pixels = await renderPatternedQuad(
			// biome-ignore format: texel table
			[
				0, 0, 255, 255, 0, 0, 255, 255,
				0, 0, 255, 255, 0, 0, 255, 255,
			],
			[0.25, 0.25],
			{
				baseColor: [1, 0, 0, 0.5],
				lightDir: [0, 0, 1],
				shadingMode: 0,
				specularPower: 32,
			},
		);

		expectPixel(pixels, [0, 0, 255, 255], 2);
	});

	it("should stay pixel-identical when no pattern is set", async () => {
		// shadingParams.w = 0 (no patternTexture) must fall through to the
		// existing lambert path byte-for-byte (guards the new branch).
		const pixels = await renderQuad({
			baseColor: [1, 0, 0, 1],
			lightDir: [0, 0, -1],
			shadingMode: 1,
			specularPower: 32,
		});

		expectPixel(pixels, [64, 0, 0, 255], 2);
	});

	it("should keep nearer geometry in front regardless of draw order", async () => {
		// One mesh: lit front quad at z=0 first, dark back quad at z=-0.5 last.
		// With depth testing the back quad must lose even though it draws later.
		// Vertex layout [px,py,pz, nx,ny,nz, u,v, u2,v2]; uvs unused (baseColor).
		// biome-ignore format: vertex table
		const vertices = new Float32Array([
			// front quad (normal +Z → fully lit)
			-1, -1, 0, 0, 0, 1, 0, 0, 0, 0,
			1, -1, 0, 0, 0, 1, 0, 0, 0, 0,
			1, 1, 0, 0, 0, 1, 0, 0, 0, 0,
			-1, 1, 0, 0, 0, 1, 0, 0, 0, 0,
			// back quad (normal -Z → ambient only)
			-1, -1, -0.5, 0, 0, -1, 0, 0, 0, 0,
			1, -1, -0.5, 0, 0, -1, 0, 0, 0, 0,
			1, 1, -0.5, 0, 0, -1, 0, 0, 0, 0,
			-1, 1, -0.5, 0, 0, -1, 0, 0, 0, 0,
		]);
		const indices = new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);

		const pixels = await renderGeometry(vertices, indices, {
			// Ortho keeps both planes inside clip z ∈ [0, 1].
			mvp: mat4Orthographic(-1, 1, -1, 1, 0.5, -1),
			model: mat4Identity(),
			baseColor: [1, 0, 0, 1],
			lightDir: [0, 0, 1],
			shadingMode: 1,
			specularPower: 32,
		});

		expectPixel(pixels, [255, 0, 0, 255]);
	});

	describe("revolve meshes (buildRevolveMesh output)", () => {
		it("should render a lambert sphere: lit center, empty corners, dimmer rim", async () => {
			const mesh = buildRevolveMesh({
				segments: halfDiscProfile(1, 32),
				angleDeg: 360,
				offset: 0,
				axis: "left",
				cap: true,
				tolerance: 0.005,
			})!;
			expect(mesh).not.toBe(null);
			const pixels = await renderRevolveMesh(mesh, {
				baseColor: [1, 0, 0, 1],
				lightDir: [0, 0, 1],
				shadingMode: 1,
				specularPower: 32,
			});

			// Center of the sphere faces the +Z light head-on → near-full red.
			const center = pixelAt(pixels, WIDTH / 2, HEIGHT / 2);
			expect(center[3]).toBe(255);
			expect(center[0]).toBeGreaterThan(200);
			// Corners lie outside the silhouette → fully transparent.
			expect(pixelAt(pixels, 1, 1)[3]).toBe(0);
			expect(pixelAt(pixels, WIDTH - 2, HEIGHT - 2)[3]).toBe(0);
			// The rim tilts away from the light → dimmer than the center.
			const rim = pixelAt(pixels, Math.floor(WIDTH * 0.92), HEIGHT / 2);
			expect(rim[3]).toBe(255);
			expect(rim[0]).toBeLessThan(center[0]);
		});

		it("should close a partial sweep with end caps (cap on/off renders differently)", async () => {
			const build = (cap: boolean) =>
				buildRevolveMesh({
					segments: rectProfile(0.3, -0.8, 0.6, 1.6),
					angleDeg: 270,
					offset: 0,
					axis: "left",
					cap,
					tolerance: 0.01,
				})!;
			const params = {
				baseColor: [1, 0, 0, 1] as [number, number, number, number],
				lightDir: [0, 0, 1] as [number, number, number],
				shadingMode: 1,
				specularPower: 32,
			};
			const capped = await renderRevolveMesh(build(true), params);
			const open = await renderRevolveMesh(build(false), params);

			// Both silhouettes stay opaque at the center of the solid...
			expect(pixelAt(capped, WIDTH / 2, HEIGHT / 2)[3]).toBe(255);
			expect(pixelAt(open, WIDTH / 2, HEIGHT / 2)[3]).toBe(255);
			// ...but the flat end caps must actually draw: at least one pixel
			// differs between the capped and open variants.
			let differs = false;
			for (let i = 0; i < capped.length; i++) {
				if (Math.abs(capped[i] - open[i]) > 2) {
					differs = true;
					break;
				}
			}
			expect(differs).toBe(true);
		});

		it("should emit a viewer-facing normal at the sphere center in the MRT variant (glass input)", async () => {
			const mesh = buildRevolveMesh({
				segments: halfDiscProfile(1, 32),
				angleDeg: 360,
				offset: 0,
				axis: "left",
				cap: true,
				tolerance: 0.005,
			})!;
			const { normal } = await renderRevolveMeshMRT(mesh, {
				baseColor: [1, 0, 0, 1],
				lightDir: [0, 0, 1],
				shadingMode: 1,
				specularPower: 32,
			});

			// The sphere center faces +Z → screen-space normal encodes to
			// (0.5, 0.5) with full coverage — the input the glass refraction
			// compositor warps by.
			const center = pixelAt(normal, WIDTH / 2, HEIGHT / 2);
			expect(Math.abs(center[0] - 128)).toBeLessThanOrEqual(3);
			expect(Math.abs(center[1] - 128)).toBeLessThanOrEqual(3);
			expect(center[3]).toBe(255);
			// Outside the silhouette the coverage stays 0.
			expect(pixelAt(normal, 1, 1)[3]).toBe(0);
		});
	});
});

// Helpers

async function renderQuad(
	params: Omit<MeshPassParams, "mvp" | "model">,
): Promise<Uint8Array> {
	// Full-clip quad on the z=0 plane facing +Z. Layout [px,py,pz, nx,ny,nz, u,v].
	// biome-ignore format: vertex table
	const vertices = new Float32Array([
		-1, -1, 0, 0, 0, 1, 0, 0, 0, 0,
		1, -1, 0, 0, 0, 1, 0, 0, 0, 0,
		1, 1, 0, 0, 0, 1, 0, 0, 0, 0,
		-1, 1, 0, 0, 0, 1, 0, 0, 0, 0,
	]);
	const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
	return renderGeometry(vertices, indices, {
		...params,
		mvp: mat4Orthographic(-1, 1, -1, 1, 0.5, -1),
		model: mat4Identity(),
	});
}

async function renderTexturedQuad(
	premultTexel: [number, number, number, number],
	params: Omit<MeshPassParams, "mvp" | "model" | "fillTexture" | "texUvRect">,
): Promise<Uint8Array> {
	const texture = device.createTexture({
		size: { width: 1, height: 1 },
		format: "rgba8unorm",
		usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
	});
	device.queue.writeTexture(
		{ texture },
		new Uint8Array(premultTexel),
		{ bytesPerRow: 4 },
		{ width: 1, height: 1 },
	);
	// All vertices share uv=(0,0), sampling the single texel. Layout adds u,v.
	// biome-ignore format: vertex table
	const vertices = new Float32Array([
		-1, -1, 0, 0, 0, 1, 0, 0, 0, 0,
		1, -1, 0, 0, 0, 1, 0, 0, 0, 0,
		1, 1, 0, 0, 0, 1, 0, 0, 0, 0,
		-1, 1, 0, 0, 0, 1, 0, 0, 0, 0,
	]);
	const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
	const pixels = await renderGeometry(vertices, indices, {
		...params,
		mvp: mat4Orthographic(-1, 1, -1, 1, 0.5, -1),
		model: mat4Identity(),
		fillTexture: texture,
		texUvRect: [0, 0, 1, 1],
	});
	texture.destroy();
	return pixels;
}

async function renderPatternedQuad(
	texels2x2: number[],
	uv2: [number, number],
	params: Omit<
		MeshPassParams,
		"mvp" | "model" | "patternTexture" | "patternInvTile"
	>,
): Promise<Uint8Array> {
	const texture = device.createTexture({
		size: { width: 2, height: 2 },
		format: "rgba8unorm",
		usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
	});
	device.queue.writeTexture(
		{ texture },
		new Uint8Array(texels2x2),
		{ bytesPerRow: 8, rowsPerImage: 2 },
		{ width: 2, height: 2 },
	);
	const [u, v] = uv2;
	// Every vertex carries the same wrap uv so all fragments sample one texel.
	// Layout [px,py,pz, nx,ny,nz, u,v, u2,v2].
	// biome-ignore format: vertex table
	const vertices = new Float32Array([
		-1, -1, 0, 0, 0, 1, 0, 0, u, v,
		1, -1, 0, 0, 0, 1, 0, 0, u, v,
		1, 1, 0, 0, 0, 1, 0, 0, u, v,
		-1, 1, 0, 0, 0, 1, 0, 0, u, v,
	]);
	const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
	const pixels = await renderGeometry(vertices, indices, {
		...params,
		mvp: mat4Orthographic(-1, 1, -1, 1, 0.5, -1),
		model: mat4Identity(),
		patternTexture: texture,
		patternInvTile: [1, 1],
	});
	texture.destroy();
	return pixels;
}

async function renderQuadMRT(
	params: Omit<MeshPassParams, "mvp" | "model">,
): Promise<{ color: Uint8Array; normal: Uint8Array }> {
	// biome-ignore format: vertex table
	const vertices = new Float32Array([
		-1, -1, 0, 0, 0, 1, 0, 0, 0, 0,
		1, -1, 0, 0, 0, 1, 0, 0, 0, 0,
		1, 1, 0, 0, 0, 1, 0, 0, 0, 0,
		-1, 1, 0, 0, 0, 1, 0, 0, 0, 0,
	]);
	const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);

	const renderer = new MeshPassRenderer(device);
	renderer.initialize();
	renderer.beginFrame();

	const geometry = createGeometry(vertices, indices);
	const makeColorTarget = () =>
		device.createTexture({
			size: { width: WIDTH, height: HEIGHT },
			format: "rgba8unorm",
			usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
		});
	const colorTexture = makeColorTarget();
	const normalTexture = makeColorTarget();

	const encoder = device.createCommandEncoder();
	renderer.encodePass(
		encoder,
		colorTexture,
		{ width: WIDTH, height: HEIGHT },
		geometry,
		{
			...params,
			mvp: mat4Orthographic(-1, 1, -1, 1, 0.5, -1),
			model: mat4Identity(),
		},
		normalTexture,
	);
	device.queue.submit([encoder.finish()]);

	const color = await captureTexturePixels(device, colorTexture, WIDTH, HEIGHT);
	const normal = await captureTexturePixels(
		device,
		normalTexture,
		WIDTH,
		HEIGHT,
	);
	colorTexture.destroy();
	normalTexture.destroy();
	geometry.vertexBuffer.destroy();
	geometry.indexBuffer.destroy();
	renderer.destroy();
	return { color, normal };
}

async function renderGeometry(
	vertices: Float32Array,
	indices: Uint32Array,
	params: MeshPassParams,
): Promise<Uint8Array> {
	const renderer = new MeshPassRenderer(device);
	renderer.initialize();
	renderer.beginFrame();

	const geometry = createGeometry(vertices, indices);
	const colorTexture = device.createTexture({
		size: { width: WIDTH, height: HEIGHT },
		format: "rgba8unorm",
		usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
	});

	const encoder = device.createCommandEncoder();
	renderer.encodePass(
		encoder,
		colorTexture,
		{ width: WIDTH, height: HEIGHT },
		geometry,
		params,
	);
	device.queue.submit([encoder.finish()]);

	const pixels = await captureTexturePixels(
		device,
		colorTexture,
		WIDTH,
		HEIGHT,
	);
	colorTexture.destroy();
	geometry.vertexBuffer.destroy();
	geometry.indexBuffer.destroy();
	renderer.destroy();
	return pixels;
}

function createGeometry(
	vertices: Float32Array,
	indices: Uint32Array,
): MeshPassGeometry {
	const vertexBuffer = device.createBuffer({
		size: vertices.byteLength,
		usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
	});
	device.queue.writeBuffer(vertexBuffer, 0, vertices);
	const indexBuffer = device.createBuffer({
		size: indices.byteLength,
		usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
	});
	device.queue.writeBuffer(indexBuffer, 0, indices);
	return { vertexBuffer, indexBuffer, indexCount: indices.length };
}

/** Assert every pixel matches the expected RGBA within the tolerance. */
function expectPixel(
	pixels: Uint8Array,
	expected: [number, number, number, number],
	tolerance = 1,
): void {
	for (let i = 0; i < pixels.length; i += 4) {
		for (let c = 0; c < 4; c++) {
			expect(Math.abs(pixels[i + c] - expected[c])).toBeLessThanOrEqual(
				tolerance,
			);
		}
	}
}

/** One pixel's RGBA at (x, y). */
function pixelAt(
	pixels: Uint8Array,
	x: number,
	y: number,
): [number, number, number, number] {
	const i = (y * WIDTH + x) * 4;
	return [pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3]];
}

/** Straight-line closed profile from a point list (CCW expected). */
function profileFromPoints(points: [number, number][]): CubicBezierSegment[] {
	return points.map((p, i) => {
		const [ex, ey] = points[(i + 1) % points.length];
		return {
			start: { x: p[0], y: p[1] },
			cp1: { x: 0, y: 0 },
			cp2: { x: 0, y: 0 },
			end: { x: ex, y: ey },
			startTiltX: 0,
			startTiltY: 0,
			endTiltX: 0,
			endTiltY: 0,
			startDeltaTime: 0,
			endDeltaTime: 0,
			isMoved: i === 0,
			isClosed: i === points.length - 1,
		};
	});
}

/** Right half-disc of radius r touching the axis at x=0 (revolves to a sphere). */
function halfDiscProfile(r: number, arcSteps: number): CubicBezierSegment[] {
	const points: [number, number][] = [];
	// Arc from the bottom pole (0, -r) around the right side to the top (0, r);
	// the closing edge runs down the axis. CCW winding.
	for (let i = 0; i <= arcSteps; i++) {
		const t = -Math.PI / 2 + (Math.PI * i) / arcSteps;
		points.push([r * Math.cos(t), r * Math.sin(t)]);
	}
	return profileFromPoints(points);
}

/** Axis-clear CCW rectangle profile. */
function rectProfile(
	x: number,
	y: number,
	w: number,
	h: number,
): CubicBezierSegment[] {
	return profileFromPoints([
		[x, y],
		[x + w, y],
		[x + w, y + h],
		[x, y + h],
	]);
}

/** Render a revolve mesh through the shared pass with an ortho projection
 *  spanning its bounds3d (the baker's framing, squared for pixel math). */
async function renderRevolveMesh(
	mesh: ExtrudeMeshData,
	params: Omit<MeshPassParams, "mvp" | "model">,
): Promise<Uint8Array> {
	return renderGeometry(
		new Float32Array(mesh.vertices),
		new Uint32Array(mesh.indices),
		{ ...params, mvp: revolveOrtho(mesh), model: mat4Identity() },
	);
}

async function renderRevolveMeshMRT(
	mesh: ExtrudeMeshData,
	params: Omit<MeshPassParams, "mvp" | "model">,
): Promise<{ color: Uint8Array; normal: Uint8Array }> {
	const renderer = new MeshPassRenderer(device);
	renderer.initialize();
	renderer.beginFrame();

	const geometry = createGeometry(
		new Float32Array(mesh.vertices),
		new Uint32Array(mesh.indices),
	);
	const makeColorTarget = () =>
		device.createTexture({
			size: { width: WIDTH, height: HEIGHT },
			format: "rgba8unorm",
			usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
		});
	const colorTexture = makeColorTarget();
	const normalTexture = makeColorTarget();

	const encoder = device.createCommandEncoder();
	renderer.encodePass(
		encoder,
		colorTexture,
		{ width: WIDTH, height: HEIGHT },
		geometry,
		{ ...params, mvp: revolveOrtho(mesh), model: mat4Identity() },
		normalTexture,
	);
	device.queue.submit([encoder.finish()]);

	const color = await captureTexturePixels(device, colorTexture, WIDTH, HEIGHT);
	const normal = await captureTexturePixels(
		device,
		normalTexture,
		WIDTH,
		HEIGHT,
	);
	colorTexture.destroy();
	normalTexture.destroy();
	geometry.vertexBuffer.destroy();
	geometry.indexBuffer.destroy();
	renderer.destroy();
	return { color, normal };
}

function revolveOrtho(mesh: ExtrudeMeshData) {
	const b = mesh.bounds3d;
	return mat4Orthographic(
		b.minX,
		b.maxX,
		b.minY,
		b.maxY,
		b.maxZ + 1,
		b.minZ - 1,
	);
}
