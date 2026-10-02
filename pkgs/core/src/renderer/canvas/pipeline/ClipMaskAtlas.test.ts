import type { AnyArtObject, BoundingBox } from "../../../schema";
import {
	ClipMaskAtlas,
	clipMaskKey,
	computeMaskCoverage,
} from "./ClipMaskAtlas";
import { IDLE_EVICT_FRAMES, IDLE_EVICT_MS } from "./IdleClock";

describe("computeMaskCoverage", () => {
	it("allocates only the part of the mask inside the render target", () => {
		const coverage = computeMaskCoverage(
			box(-4_000, -4_000, 4_000, 4_000),
			box(-100, -50, 100, 50),
			2,
			16_384,
		);

		expect(coverage).toMatchObject({
			logicalWidth: 400,
			logicalHeight: 200,
			effectiveZoom: 2,
			coverageBounds: box(-100, -50, 100, 50),
		});
	});

	it("returns null when the mask does not intersect the render target", () => {
		expect(
			computeMaskCoverage(
				box(100, 100, 200, 200),
				box(-50, -50, 50, 50),
				1,
				16_384,
			),
		).toBeNull();
	});

	it("reduces one uniform scale when export coverage exceeds the GPU limit", () => {
		const coverage = computeMaskCoverage(
			box(0, 0, 40_000, 10_000),
			null,
			1,
			10_000,
		);

		expect(coverage).toMatchObject({
			logicalWidth: 10_000,
			logicalHeight: 2_500,
			effectiveZoom: 0.25,
			coverageBounds: box(0, 0, 40_000, 10_000),
		});
		expect(coverage?.texWidth).toBeLessThanOrEqual(10_000);
		expect(coverage?.texHeight).toBeLessThanOrEqual(10_000);
	});
});

describe("ClipMaskAtlas shared atlas release", () => {
	let now = 0;

	beforeEach(() => {
		now = 0;
		vi.spyOn(performance, "now").mockImplementation(() => now);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("should release the atlas once no mask has needed it for the idle frames and time", () => {
		const { atlas, deps, renderClipMask, sharedAtlas } = createAtlas();
		atlas.beginFrame();
		renderClipMask();

		atlas.invalidateAll();
		runIdleFrames(atlas, IDLE_EVICT_FRAMES, IDLE_EVICT_MS);

		expect(deps.deferDestroy).toHaveBeenCalledWith(sharedAtlas());
	});

	it("should keep the atlas while a cached mask still holds a slot in it", () => {
		const { atlas, deps, renderClipMask, sharedAtlas } = createAtlas();
		atlas.beginFrame();
		renderClipMask();

		runIdleFrames(atlas, IDLE_EVICT_FRAMES, IDLE_EVICT_MS);

		expect(sharedAtlas()).toBeDefined();
		expect(deps.deferDestroy).not.toHaveBeenCalledWith(sharedAtlas());
	});

	it("should destroy the atlas on trimIdle once the last mask is gone", () => {
		const { atlas, renderClipMask, sharedAtlas } = createAtlas();
		atlas.beginFrame();
		renderClipMask();

		atlas.invalidateAll();
		atlas.trimIdle(1);

		expect(sharedAtlas().destroy).toHaveBeenCalledOnce();
	});

	function runIdleFrames(
		atlas: ClipMaskAtlas,
		frames: number,
		durationMs: number,
	): void {
		const start = now;
		for (let i = 1; i <= frames; i++) {
			now = start + (durationMs * i) / frames;
			atlas.beginFrame();
		}
	}
});

function box(
	minX: number,
	minY: number,
	maxX: number,
	maxY: number,
): BoundingBox {
	return {
		minX,
		minY,
		maxX,
		maxY,
		width: maxX - minX,
		height: maxY - minY,
	};
}

/** An atlas over mock GPU objects, and a way to bake one silhouette clip
 *  mask into its shared atlas. */
function createAtlas() {
	const device = {
		limits: { maxTextureDimension2D: 8192 },
		createBuffer: vi.fn(() => ({ destroy: vi.fn() })),
		createSampler: vi.fn(() => ({})),
		createTexture: vi.fn((descriptor: GPUTextureDescriptor) => ({
			label: descriptor.label,
			createView: vi.fn(() => ({})),
			destroy: vi.fn(),
		})),
		createBindGroup: vi.fn(() => ({})),
		queue: { writeBuffer: vi.fn() },
	} as unknown as GPUDevice;
	const deps = {
		device,
		canvasFormat: "rgba8unorm",
		maskBindGroupLayout: {},
		getTransformsBindGroup: () => null,
		viewportState: { current: { zoom: 1 }, bounds: null },
		deferDestroy: vi.fn(),
	} as unknown as ConstructorParameters<typeof ClipMaskAtlas>[0];
	const atlas = new ClipMaskAtlas(deps);
	const source = { id: "clip", type: "path" } as AnyArtObject;
	const renderClipMask = () =>
		atlas.preRender(
			{ copyTextureToTexture: vi.fn() } as unknown as GPUCommandEncoder,
			[
				{
					key: clipMaskKey(source.id),
					sources: [source],
					coverBounds: box(0, 0, 64, 64),
					mode: "silhouette",
				},
			],
			new Map([[source.id, source]]),
			null,
		);
	const sharedAtlas = () =>
		vi
			.mocked(device.createTexture)
			.mock.results.map((r) => r.value as GPUTexture)
			.find((t) => t.label === "Clip Mask Shared Atlas")!;
	return { atlas, deps, renderClipMask, sharedAtlas };
}
