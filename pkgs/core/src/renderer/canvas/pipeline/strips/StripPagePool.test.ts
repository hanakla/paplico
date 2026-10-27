import { IDLE_EVICT_FRAMES, IDLE_EVICT_MS } from "../IdleClock";
import { StripPagePool } from "./StripPagePool";
import { STRIP_INSTANCE_BYTES, STRIP_PAGE_WIDTH } from "./stripInstanceLayout";

/** Alpha slots and strips that fill one standard page. */
const PAGE_SLOTS = 256 * STRIP_PAGE_WIDTH;
const PAGE_STRIPS = 1 << 17;
const PAGE_BYTES = PAGE_SLOTS * 4 + PAGE_STRIPS * STRIP_INSTANCE_BYTES;
const MAX_TEXTURE_ROWS = 8192;
/** Alpha slots whose page is taller than half of `MAX_TEXTURE_ROWS`. */
const TALL_SLOTS = 6000 * STRIP_PAGE_WIDTH;

let now = 0;

describe("StripPagePool", () => {
	beforeEach(() => {
		now = 0;
		vi.spyOn(performance, "now").mockImplementation(() => now);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("should free idle pages at frame start until the pool fits its budget", () => {
		const { device, destroyedTextures } = createDevice();
		const pool = new StripPagePool(device);
		pool.setBudgetBytes(PAGE_BYTES);
		pool.beginFrame();
		pool.allocate(PAGE_SLOTS, 1, false);
		pool.allocate(PAGE_SLOTS, 1, false);

		runIdleFrames(pool);

		expect(destroyedTextures()).toBe(1);
	});

	it("should keep idle pages that fit the budget", () => {
		const { device, destroyedTextures } = createDevice();
		const pool = new StripPagePool(device);
		pool.setBudgetBytes(PAGE_BYTES * 2);
		pool.beginFrame();
		pool.allocate(PAGE_SLOTS, 1, false);
		pool.allocate(PAGE_SLOTS, 1, false);

		runIdleFrames(pool);

		expect(destroyedTextures()).toBe(0);
	});

	it("should place an alpha-only batch taller than half the device's texture rows", () => {
		const { device } = createDevice();
		const pool = new StripPagePool(device);
		pool.beginFrame();

		expect(pool.allocate(TALL_SLOTS, 1, false)).not.toBeNull();
		expect(pool.allocate(TALL_SLOTS, 1, true)).toBeNull();
	});

	it("should not reuse a page too tall for params for a params batch", () => {
		const { device } = createDevice();
		const pool = new StripPagePool(device);
		pool.setBudgetBytes(0);
		pool.beginFrame();
		const tall = pool.allocate(TALL_SLOTS, 1, false);

		pool.beginFrame();
		const params = pool.allocate(PAGE_SLOTS, 1, true);

		expect(params?.page).not.toBe(tall?.page);
		expect(params?.page.params).not.toBeNull();
	});

	it("should count params textures toward the budget", () => {
		const { device } = createDevice();
		const pool = new StripPagePool(device);
		pool.setBudgetBytes(PAGE_BYTES * 2);
		pool.beginFrame();
		const first = pool.allocate(PAGE_SLOTS, 1, true);

		pool.beginFrame();
		const second = pool.allocate(PAGE_SLOTS, 1, false);

		expect(second?.page).toBe(first?.page);
	});
});

function runIdleFrames(pool: StripPagePool): void {
	for (let i = 0; i < IDLE_EVICT_FRAMES; i++) pool.beginFrame();
	now += IDLE_EVICT_MS;
	pool.beginFrame();
}

function createDevice() {
	const textures: { destroy: ReturnType<typeof vi.fn> }[] = [];
	const device = {
		limits: {
			maxTextureDimension2D: MAX_TEXTURE_ROWS,
			maxBufferSize: 1 << 30,
		},
		createBuffer: vi.fn(() => ({ destroy: vi.fn() })),
		createTexture: vi.fn(() => {
			const texture = { createView: vi.fn(() => ({})), destroy: vi.fn() };
			textures.push(texture);
			return texture;
		}),
	} as unknown as GPUDevice;
	return {
		device,
		destroyedTextures: () =>
			textures.filter((t) => t.destroy.mock.calls.length > 0).length,
	};
}
