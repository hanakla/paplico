import { describe, expect, it, vi } from "vitest";
import { RunBatcher, type WorldFillBounds } from "./RunBatcher";

describe("RunBatcher pass lifecycle", () => {
	it("should never flush a cached stencil fill after its mask pass has ended", () => {
		const batcher = createBatcher();
		const maskPass = createGuardedPass();
		const mainPass = createGuardedPass();
		batcher.beginFrame();
		batcher.setBatching(true);

		const previousBatching = batcher.pauseBatching();
		batcher.appendFill(
			maskPass.encoder,
			createFillState(),
			{ firstVertex: 0, vertexCount: 3 },
			{ byteOffset: 0, vertexCount: 6 },
			null,
			{ minX: 0, minY: 0, maxX: 10, maxY: 10 } as WorldFillBounds,
		);
		maskPass.end();
		batcher.resumeBatching(previousBatching);

		expect(() => {
			batcher.append(mainPass.encoder, createRunState(), 0, 2);
			batcher.flush();
		}).not.toThrow();
		expect(maskPass.setPipeline).toHaveBeenCalledTimes(2);
		expect(mainPass.setPipeline).toHaveBeenCalledTimes(1);
	});
});

function createGuardedPass() {
	let ended = false;
	const assertOpen = () => {
		if (ended) throw new Error("command recorded after render pass end");
	};
	const setPipeline = vi.fn(assertOpen);
	const encoder = {
		setPipeline,
		setBindGroup: vi.fn(assertOpen),
		setVertexBuffer: vi.fn(assertOpen),
		draw: vi.fn(assertOpen),
	} as unknown as GPURenderPassEncoder;
	return {
		encoder,
		setPipeline,
		end: () => {
			ended = true;
		},
	};
}

function createRunState() {
	return {
		pipeline: {} as GPURenderPipeline,
		bg0: {} as GPUBindGroup,
		bg1: {} as GPUBindGroup,
		bg3: {} as GPUBindGroup,
		storeBuffer: {} as GPUBuffer,
	};
}

function createFillState() {
	return {
		fanPipeline: {} as GPURenderPipeline,
		fringePipeline: {} as GPURenderPipeline,
		coverPipeline: {} as GPURenderPipeline,
		coverBg2: {} as GPUBindGroup,
		bg0: {} as GPUBindGroup,
		bg1: {} as GPUBindGroup,
		bg3: {} as GPUBindGroup,
		storeBuffer: {} as GPUBuffer,
		coverBuffer: {} as GPUBuffer,
	};
}

function createBatcher(): RunBatcher {
	const device = {
		createBuffer: vi.fn(() => ({ destroy: vi.fn() })),
		createBindGroup: vi.fn(() => ({})),
		queue: { writeBuffer: vi.fn() },
	} as unknown as GPUDevice;
	return new RunBatcher(device, {} as GPUBindGroupLayout);
}
