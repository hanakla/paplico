import { RenderOrchestrator } from "./RenderOrchestrator";

type LifecycleAccess = {
	device: GPUDevice | null;
	profiler: { destroy(): void } | null;
	onDeviceLost: (() => void) | null;
	recoveryTimer: ReturnType<typeof setTimeout> | null;
	handleDeviceLost(device: GPUDevice, info: GPUDeviceLostInfo): void;
	releaseGPUResources(): void;
};

describe("RenderOrchestrator GPU lifecycle", () => {
	it("should destroy the profiler and owned device exactly once", () => {
		const renderer = new RenderOrchestrator();
		const device = createDevice();
		const profiler = { destroy: vi.fn() };
		const lifecycle = accessLifecycle(renderer);
		lifecycle.device = device;
		lifecycle.profiler = profiler;

		renderer.destroy();
		renderer.destroy();

		expect(profiler.destroy).toHaveBeenCalledTimes(1);
		expect(device.destroy).toHaveBeenCalledTimes(1);
		expect(lifecycle.device).toBeNull();
		expect(lifecycle.profiler).toBeNull();
	});

	it("should not destroy a device after it reports device loss", () => {
		const renderer = new RenderOrchestrator();
		const device = createDevice();
		const profiler = { destroy: vi.fn() };
		const lifecycle = accessLifecycle(renderer);
		lifecycle.device = device;
		lifecycle.profiler = profiler;

		lifecycle.handleDeviceLost(device, {
			reason: "destroyed",
			message: "device was already destroyed",
		} as GPUDeviceLostInfo);
		lifecycle.releaseGPUResources();

		expect(profiler.destroy).toHaveBeenCalledTimes(1);
		expect(device.destroy).not.toHaveBeenCalled();
	});

	it("should ignore a stale loss notification from a replaced device", () => {
		const renderer = new RenderOrchestrator();
		const staleDevice = createDevice();
		const activeDevice = createDevice();
		const onDeviceLost = vi.fn();
		const lifecycle = accessLifecycle(renderer);
		lifecycle.device = activeDevice;
		lifecycle.onDeviceLost = onDeviceLost;

		lifecycle.handleDeviceLost(staleDevice, {
			reason: "unknown",
			message: "stale loss",
		} as GPUDeviceLostInfo);

		expect(onDeviceLost).not.toHaveBeenCalled();
		expect(lifecycle.device).toBe(activeDevice);
		expect(lifecycle.recoveryTimer).toBeNull();
		renderer.destroy();
	});
});

function createDevice(): GPUDevice & { destroy: ReturnType<typeof vi.fn> } {
	return { destroy: vi.fn() } as unknown as GPUDevice & {
		destroy: ReturnType<typeof vi.fn>;
	};
}

function accessLifecycle(renderer: RenderOrchestrator): LifecycleAccess {
	return renderer as unknown as LifecycleAccess;
}
