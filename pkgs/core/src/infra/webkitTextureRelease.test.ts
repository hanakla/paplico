import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { releaseDestroyedTexturesPromptly } from "./webkitTextureRelease";

const SAFARI_UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const CHROME_UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

const MiB = 1024 * 1024;

/** Reports as collected every sentinel but the newest, which is still held. */
let collectSentinels: () => void;
/** Reports as collected every bind group made so far. */
let collectBindGroups: () => void;

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("releaseDestroyedTexturesPromptly", () => {
	it("should hold nothing until the destroyed textures pass 256 MiB on WebKit", () => {
		const allocate = stubBrowser(SAFARI_UA);
		const { device } = createMockDevice();
		releaseDestroyedTexturesPromptly(device);

		// 4096 x 4096 RGBA is 64 MiB.
		destroyTextures(device, 3);
		vi.advanceTimersByTime(100);

		expect(allocate).not.toHaveBeenCalled();
	});

	it("should hold one more 64 MiB buffer per task until the collector takes the sentinel", () => {
		const allocate = stubBrowser(SAFARI_UA);
		const { device } = createMockDevice();
		releaseDestroyedTexturesPromptly(device);

		destroyTextures(device, 4);
		expect(allocate).not.toHaveBeenCalled();
		vi.advanceTimersToNextTimer();
		vi.advanceTimersToNextTimer();
		vi.advanceTimersToNextTimer();
		expect(allocate).toHaveBeenCalledTimes(3);
		expect(allocate.mock.calls[0][0]).toBe(64 * MiB);

		collectSentinels();
		vi.advanceTimersByTime(100);

		expect(allocate).toHaveBeenCalledTimes(3);
	});

	it("should stop at 64 buffers when the collector never takes the sentinel", () => {
		const allocate = stubBrowser(SAFARI_UA);
		const { device } = createMockDevice();
		releaseDestroyedTexturesPromptly(device);

		destroyTextures(device, 4);
		vi.advanceTimersByTime(10_000);

		expect(allocate).toHaveBeenCalledTimes(64);
	});

	it("should start again for the textures destroyed while it waited", () => {
		const allocate = stubBrowser(SAFARI_UA);
		const { device } = createMockDevice();
		releaseDestroyedTexturesPromptly(device);

		destroyTextures(device, 4);
		vi.advanceTimersToNextTimer();
		destroyTextures(device, 4);
		collectSentinels();
		vi.advanceTimersToNextTimer();
		expect(allocate).toHaveBeenCalledTimes(1);

		vi.advanceTimersToNextTimer();

		expect(allocate).toHaveBeenCalledTimes(2);
	});

	it("should report being behind once uncollected bind groups keep 768 MiB of destroyed textures", () => {
		stubBrowser(SAFARI_UA);
		const { device } = createMockDevice();
		const release = releaseDestroyedTexturesPromptly(device);

		destroyBoundTextures(device, 11);
		expect(release.isBehind).toBe(false);
		destroyBoundTextures(device, 1);

		expect(release.isBehind).toBe(true);
	});

	it("should not count a destroyed texture no bind group was made with", () => {
		stubBrowser(SAFARI_UA);
		const { device } = createMockDevice();
		const release = releaseDestroyedTexturesPromptly(device);

		destroyTextures(device, 20);

		expect(release.isBehind).toBe(false);
	});

	it("should report having caught up once the collector takes the bind groups", () => {
		stubBrowser(SAFARI_UA);
		const { device } = createMockDevice();
		const release = releaseDestroyedTexturesPromptly(device);
		const onCaughtUp = vi.fn();
		release.onCaughtUp = onCaughtUp;
		destroyBoundTextures(device, 12);
		expect(onCaughtUp).not.toHaveBeenCalled();

		collectBindGroups();

		expect(release.isBehind).toBe(false);
		expect(onCaughtUp).toHaveBeenCalledOnce();
	});

	it("should stop reporting being behind after 5 s when the bind groups are not collected", () => {
		stubBrowser(SAFARI_UA);
		const { device } = createMockDevice();
		const release = releaseDestroyedTexturesPromptly(device);
		const onCaughtUp = vi.fn();
		release.onCaughtUp = onCaughtUp;
		destroyBoundTextures(device, 12);
		vi.advanceTimersByTime(4900);
		expect(release.isBehind).toBe(true);

		vi.advanceTimersByTime(200);

		expect(release.isBehind).toBe(false);
		expect(onCaughtUp).toHaveBeenCalledOnce();
	});

	it("should give a collection up after 5 s so that the next one starts", () => {
		const allocate = stubBrowser(SAFARI_UA);
		const { device } = createMockDevice();
		releaseDestroyedTexturesPromptly(device);
		destroyTextures(device, 4);
		vi.advanceTimersByTime(1000);
		expect(allocate).toHaveBeenCalledTimes(64);
		destroyTextures(device, 4);

		vi.advanceTimersByTime(5000);

		expect(allocate.mock.calls.length).toBeGreaterThan(64);
	});

	it("should never report being behind on another engine", () => {
		stubBrowser(CHROME_UA);
		const { device } = createMockDevice();
		const release = releaseDestroyedTexturesPromptly(device);

		destroyTextures(device, 20);

		expect(release.isBehind).toBe(false);
	});

	it("should still destroy the texture on WebKit", () => {
		stubBrowser(SAFARI_UA);
		const { device, destroys } = createMockDevice();
		releaseDestroyedTexturesPromptly(device);

		destroyTextures(device, 1);

		expect(destroys).toHaveBeenCalledOnce();
	});

	it("should hold nothing on another engine", () => {
		const allocate = stubBrowser(CHROME_UA);
		const { device } = createMockDevice();
		releaseDestroyedTexturesPromptly(device);

		destroyTextures(device, 8);
		vi.advanceTimersByTime(100);

		expect(allocate).not.toHaveBeenCalled();
	});
});

function stubBrowser(userAgent: string) {
	const allocate = vi.fn(function ArrayBufferStub(_byteLength: number) {});
	vi.stubGlobal("navigator", { userAgent });
	vi.stubGlobal("ArrayBuffer", allocate);
	// Sentinels are registered with a number, bind groups with their textures.
	let registered: Array<{ held: unknown; report: () => void }> = [];
	const report = (isCollected: (held: unknown) => boolean): void => {
		const collected = registered.filter((entry) => isCollected(entry.held));
		registered = registered.filter((entry) => !collected.includes(entry));
		for (const entry of collected) entry.report();
	};
	collectSentinels = () => {
		const newest = registered.findLast(
			(entry) => typeof entry.held === "number",
		);
		report((held) => typeof held === "number" && held !== newest?.held);
	};
	collectBindGroups = () => report((held) => typeof held !== "number");
	vi.stubGlobal(
		"FinalizationRegistry",
		class {
			public constructor(
				private readonly onCollected: (held: unknown) => void,
			) {}

			public register(_target: object, held: unknown): void {
				registered.push({ held, report: () => this.onCollected(held) });
			}
		},
	);
	return allocate;
}

/** Create and destroy `count` textures of 64 MiB each. */
function destroyTextures(device: GPUDevice, count: number): void {
	for (let i = 0; i < count; i++) createTexture(device).destroy();
}

/** Create `count` textures of 64 MiB each, make a bind group with each and
 *  destroy them. */
function destroyBoundTextures(device: GPUDevice, count: number): void {
	for (let i = 0; i < count; i++) {
		const texture = createTexture(device);
		device.createBindGroup({
			layout: {} as GPUBindGroupLayout,
			entries: [{ binding: 0, resource: texture.createView() }],
		});
		texture.destroy();
	}
}

function createTexture(device: GPUDevice): GPUTexture {
	return device.createTexture({
		size: { width: 4096, height: 4096 },
		format: "rgba8unorm",
		usage: GPUTextureUsage.RENDER_ATTACHMENT,
	});
}

function createMockDevice() {
	const destroys = vi.fn();
	const device = {
		createTexture(descriptor: GPUTextureDescriptor) {
			return {
				...(descriptor.size as GPUExtent3DDict),
				depthOrArrayLayers: 1,
				sampleCount: 1,
				destroy: destroys,
				createView: () => ({}),
			} as unknown as GPUTexture;
		},
		createBindGroup: () => ({}) as GPUBindGroup,
	} as unknown as GPUDevice;
	return { device, destroys };
}
