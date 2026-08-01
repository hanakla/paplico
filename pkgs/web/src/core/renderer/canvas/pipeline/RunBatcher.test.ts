import { describe, expect, it, vi } from "vitest";
import {
	createLocalFillBounds,
	RunBatcher,
	transformFillBoundsToWorld,
	type WorldFillBounds,
} from "./RunBatcher";

describe("RunBatcher", () => {
	it("should merge consecutive same-state appends into one pulled draw", () => {
		const { batcher, device } = createBatcher();
		const pass = createPass();
		const state = createState();
		batcher.beginFrame();
		batcher.setBatching(true);

		batcher.append(pass.encoder, state, 100, 3);
		batcher.append(pass.encoder, state, 500, 2);
		expect(pass.draw).not.toHaveBeenCalled();
		batcher.flush();

		expect(pass.draw).toHaveBeenCalledTimes(1);
		expect(pass.draw.mock.calls[0]).toEqual([5, 1, 0, 0]);
		batcher.finishFrame();
		// Run table: header {memberCount, 0} then {cumulativeStart, firstVertex}.
		expect([...device.writes[0].data]).toEqual([2, 0, 0, 100, 3, 500]);
	});

	it("should split the run when the bind-group state changes", () => {
		const { batcher } = createBatcher();
		const pass = createPass();
		const stateA = createState();
		const stateB = {
			...stateA,
			bg3: { id: "other-bg3" } as unknown as GPUBindGroup,
		};
		batcher.beginFrame();
		batcher.setBatching(true);

		batcher.append(pass.encoder, stateA, 0, 2);
		batcher.append(pass.encoder, stateB, 10, 2);
		batcher.flush();

		expect(pass.draw).toHaveBeenCalledTimes(2);
		expect(pass.draw.mock.calls[0]).toEqual([2, 1, 0, 0]);
		expect(pass.draw.mock.calls[1]).toEqual([2, 1, 0, 2]); // after run A's 2 entries
	});

	it("should split the run when the pass changes", () => {
		const { batcher } = createBatcher();
		const passA = createPass();
		const passB = createPass();
		const state = createState();
		batcher.beginFrame();
		batcher.setBatching(true);

		batcher.append(passA.encoder, state, 0, 2);
		batcher.append(passB.encoder, state, 4, 2);
		batcher.flush();

		expect(passA.draw).toHaveBeenCalledTimes(1);
		expect(passB.draw).toHaveBeenCalledTimes(1);
	});

	it("should split the run when the store buffer changes (regrowth)", () => {
		const { batcher, device } = createBatcher();
		const pass = createPass();
		const stateOld = createState();
		const stateNew = {
			...stateOld,
			storeBuffer: { id: "grown-buffer" } as unknown as GPUBuffer,
		};
		batcher.beginFrame();
		batcher.setBatching(true);

		batcher.append(pass.encoder, stateOld, 0, 2);
		batcher.append(pass.encoder, stateNew, 0, 2);
		batcher.flush();

		expect(pass.draw).toHaveBeenCalledTimes(2);
		// Each merged draw's BG2 pairs the store buffer its members reference.
		expect(device.bindGroupEntries[0][0]).toBe(stateOld.storeBuffer);
		expect(device.bindGroupEntries[1][0]).toBe(stateNew.storeBuffer);
	});

	it("should emit immediately while batching is disabled", () => {
		const { batcher } = createBatcher();
		const pass = createPass();
		const state = createState();
		batcher.beginFrame();

		batcher.append(pass.encoder, state, 0, 2);
		batcher.append(pass.encoder, state, 4, 2);

		expect(pass.draw).toHaveBeenCalledTimes(2);
	});

	it("should flush the pending run when batching is disabled", () => {
		const { batcher } = createBatcher();
		const pass = createPass();
		const state = createState();
		batcher.beginFrame();
		batcher.setBatching(true);

		batcher.append(pass.encoder, state, 0, 2);
		batcher.setBatching(false);

		expect(pass.draw).toHaveBeenCalledTimes(1);
	});

	it("should emit a cached stencil fill before an interrupted mask pass ends", () => {
		const { batcher } = createBatcher();
		const mainPass = createPass();
		const maskPass = createPass();
		const state = createFillState();
		batcher.beginFrame();
		batcher.setBatching(true);

		const wasBatching = batcher.pauseBatching();
		batcher.appendFill(
			maskPass.encoder,
			state,
			{ firstVertex: 0, vertexCount: 3 },
			{ byteOffset: 0, vertexCount: 6 },
			null,
			worldBounds({ minX: 0, minY: 0, maxX: 10, maxY: 10 }),
		);

		expect(maskPass.draw).toHaveBeenCalledTimes(2);
		batcher.resumeBatching(wasBatching);
		batcher.append(mainPass.encoder, createState(), 0, 2);
		expect(mainPass.draw).not.toHaveBeenCalled();
		batcher.flush();
		expect(mainPass.draw).toHaveBeenCalledTimes(1);
	});

	it("should overflow into a new chunk and upload both in finishFrame", () => {
		const { batcher, device } = createBatcher();
		const pass = createPass();
		const state = createState();
		batcher.beginFrame();
		batcher.setBatching(true);

		// Default chunk capacity is 16,384 entries; each run writes a header
		// plus one entry per member, so two 10,000-member runs need two chunks.
		for (let i = 0; i < 10_000; i++) batcher.append(pass.encoder, state, i, 1);
		batcher.flush();
		for (let i = 0; i < 10_000; i++) batcher.append(pass.encoder, state, i, 1);
		batcher.flush();

		expect(pass.draw).toHaveBeenCalledTimes(2);
		batcher.finishFrame();
		expect(device.writes).toHaveLength(2);
		expect(device.writes[0].size).toBe(10_001 * 8);
		expect(device.writes[1].size).toBe(10_001 * 8);
	});

	describe("fill groups", () => {
		it("should re-sequence two non-overlapping fills into three draws", () => {
			const { batcher, device } = createBatcher();
			const pass = createPass();
			const state = createFillState();
			batcher.beginFrame();
			batcher.setBatching(true);

			batcher.appendFill(
				pass.encoder,
				state,
				{ firstVertex: 10, vertexCount: 3 },
				{ byteOffset: 0, vertexCount: 6 },
				{ firstVertex: 50, vertexCount: 6 },
				worldBounds({ minX: 0, minY: 0, maxX: 10, maxY: 10 }),
			);
			batcher.appendFill(
				pass.encoder,
				state,
				{ firstVertex: 20, vertexCount: 3 },
				{ byteOffset: 6 * 36, vertexCount: 6 },
				{ firstVertex: 60, vertexCount: 6 },
				worldBounds({ minX: 20, minY: 0, maxX: 30, maxY: 10 }),
			);
			batcher.flush();

			// fans (pulled) + covers (classic) + fringes (pulled) = 3 draws.
			expect(pass.draw).toHaveBeenCalledTimes(3);
			expect(pass.draw.mock.calls[0]).toEqual([6, 1, 0, 0]); // both fans
			expect(pass.draw.mock.calls[1]).toEqual([12, 1, 0, 0]); // both covers
			expect(pass.draw.mock.calls[2]).toEqual([12, 1, 0, 3]); // both fringes
			// The cover draw binds the contiguous batch range's start.
			expect(pass.setVertexBuffer.mock.calls[0][2]).toBe(0);
			batcher.finishFrame();
			expect([...device.writes[0].data]).toEqual([
				2,
				0,
				0,
				10,
				3,
				20, // fan table
				2,
				0,
				0,
				50,
				6,
				60, // fringe table
			]);
		});

		it("should split the group when bounds intersect", () => {
			const { batcher } = createBatcher();
			const pass = createPass();
			const state = createFillState();
			batcher.beginFrame();
			batcher.setBatching(true);

			batcher.appendFill(
				pass.encoder,
				state,
				{ firstVertex: 0, vertexCount: 3 },
				{ byteOffset: 0, vertexCount: 6 },
				null,
				worldBounds({ minX: 0, minY: 0, maxX: 10, maxY: 10 }),
			);
			batcher.appendFill(
				pass.encoder,
				state,
				{ firstVertex: 10, vertexCount: 3 },
				{ byteOffset: 6 * 36, vertexCount: 6 },
				null,
				worldBounds({ minX: 5, minY: 5, maxX: 15, maxY: 15 }), // overlaps the first
			);
			batcher.flush();

			// Two separate groups of (fan + cover) each.
			expect(pass.draw).toHaveBeenCalledTimes(4);
		});

		it("should split raw-disjoint fills that overlap after their transforms", () => {
			const { batcher } = createBatcher();
			const pass = createPass();
			const state = createFillState();
			const origin = {
				minX: 0,
				minY: 0,
				maxX: 30,
				maxY: 10,
				width: 30,
				height: 10,
			};
			const identity = {
				x: 0,
				y: 0,
				rotation: 0,
				scaleX: 1,
				scaleY: 1,
			};
			batcher.beginFrame();
			batcher.setBatching(true);

			batcher.appendFill(
				pass.encoder,
				state,
				{ firstVertex: 0, vertexCount: 3 },
				{ byteOffset: 0, vertexCount: 6 },
				null,
				transformFillBoundsToWorld(
					createLocalFillBounds({
						minX: 0,
						minY: 0,
						maxX: 10,
						maxY: 10,
					}),
					identity,
					origin,
				),
			);
			batcher.appendFill(
				pass.encoder,
				state,
				{ firstVertex: 10, vertexCount: 3 },
				{ byteOffset: 6 * 36, vertexCount: 6 },
				null,
				transformFillBoundsToWorld(
					createLocalFillBounds({
						minX: 20,
						minY: 0,
						maxX: 30,
						maxY: 10,
					}),
					{ ...identity, x: -20 },
					origin,
				),
			);
			batcher.flush();

			expect(pass.draw).toHaveBeenCalledTimes(4);
		});

		it("should split the group when cover quads are not contiguous", () => {
			const { batcher } = createBatcher();
			const pass = createPass();
			const state = createFillState();
			batcher.beginFrame();
			batcher.setBatching(true);

			batcher.appendFill(
				pass.encoder,
				state,
				{ firstVertex: 0, vertexCount: 3 },
				{ byteOffset: 0, vertexCount: 6 },
				null,
				worldBounds({ minX: 0, minY: 0, maxX: 10, maxY: 10 }),
			);
			batcher.appendFill(
				pass.encoder,
				state,
				{ firstVertex: 10, vertexCount: 3 },
				{ byteOffset: 12 * 36, vertexCount: 6 }, // gap in the batch buffer
				null,
				worldBounds({ minX: 20, minY: 0, maxX: 30, maxY: 10 }),
			);
			batcher.flush();

			expect(pass.draw).toHaveBeenCalledTimes(4);
		});

		it("should keep paint order between a fill group and a stroke run", () => {
			const { batcher } = createBatcher();
			const pass = createPass();
			const fillState = createFillState();
			const runState = createState();
			batcher.beginFrame();
			batcher.setBatching(true);

			batcher.appendFill(
				pass.encoder,
				fillState,
				{ firstVertex: 0, vertexCount: 3 },
				{ byteOffset: 0, vertexCount: 6 },
				null,
				worldBounds({ minX: 0, minY: 0, maxX: 10, maxY: 10 }),
			);
			batcher.append(pass.encoder, runState, 100, 2);
			batcher.flush();

			// The fill group's fan + cover were emitted BEFORE the stroke run.
			expect(pass.calls).toEqual([
				"setPipeline:fan",
				"draw",
				"setPipeline:cover",
				"draw",
				"setPipeline:run",
				"draw",
			]);
		});
	});
});

// Helpers

function createPass() {
	const calls: string[] = [];
	const draw = vi.fn(() => {
		calls.push("draw");
	});
	const setPipeline = vi.fn((pipeline: { id?: string }) => {
		calls.push(`setPipeline:${pipeline.id ?? "?"}`);
	});
	const setVertexBuffer = vi.fn();
	const encoder = {
		setPipeline,
		setBindGroup: vi.fn(),
		setVertexBuffer,
		draw,
	} as unknown as GPURenderPassEncoder;
	return { encoder, draw, setPipeline, setVertexBuffer, calls };
}

function worldBounds(bounds: {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}): WorldFillBounds {
	return bounds as WorldFillBounds;
}

function createState() {
	return {
		pipeline: { id: "run" } as unknown as GPURenderPipeline,
		bg0: { id: "bg0" } as unknown as GPUBindGroup,
		bg1: { id: "bg1" } as unknown as GPUBindGroup,
		bg3: { id: "bg3" } as unknown as GPUBindGroup,
		storeBuffer: { id: "store-buffer" } as unknown as GPUBuffer,
	};
}

function createFillState() {
	return {
		fanPipeline: { id: "fan" } as unknown as GPURenderPipeline,
		fringePipeline: { id: "fringe" } as unknown as GPURenderPipeline,
		coverPipeline: { id: "cover" } as unknown as GPURenderPipeline,
		coverBg2: { id: "cover-bg2" } as unknown as GPUBindGroup,
		bg0: { id: "bg0" } as unknown as GPUBindGroup,
		bg1: { id: "bg1" } as unknown as GPUBindGroup,
		bg3: { id: "bg3" } as unknown as GPUBindGroup,
		storeBuffer: { id: "store-buffer" } as unknown as GPUBuffer,
		coverBuffer: { id: "cover-buffer" } as unknown as GPUBuffer,
	};
}

function createDevice() {
	const writes: Array<{ size: number; data: Uint32Array }> = [];
	/** [storeBuffer, chunkGpu] per created pulled bind group, in order. */
	const bindGroupEntries: Array<[unknown, unknown]> = [];
	const device = {
		createBuffer: vi.fn((desc: { size: number }) => ({
			size: desc.size,
			destroy: vi.fn(),
		})),
		createBindGroup: vi.fn(
			(desc: { entries: Array<{ resource: { buffer: unknown } }> }) => {
				bindGroupEntries.push([
					desc.entries[0].resource.buffer,
					desc.entries[1].resource.buffer,
				]);
				return { id: `pulled-bg-${bindGroupEntries.length}` };
			},
		),
		queue: {
			writeBuffer: vi.fn(
				(
					_buffer: unknown,
					_offset: number,
					data: ArrayBuffer,
					dataOffset: number,
					size: number,
				) => {
					writes.push({
						size,
						data: new Uint32Array(data.slice(dataOffset, dataOffset + size)),
					});
				},
			),
		},
	} as unknown as GPUDevice & {
		writes: typeof writes;
		bindGroupEntries: typeof bindGroupEntries;
	};
	(device as { writes: typeof writes }).writes = writes;
	(device as { bindGroupEntries: typeof bindGroupEntries }).bindGroupEntries =
		bindGroupEntries;
	return device;
}

function createBatcher() {
	const device = createDevice();
	const layout = { id: "pulled-layout" } as unknown as GPUBindGroupLayout;
	return { batcher: new RunBatcher(device, layout), device };
}
