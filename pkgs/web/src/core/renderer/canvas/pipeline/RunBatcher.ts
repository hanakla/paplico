import type { BoundingBox, ElementTransform } from "../../../schema";
import { applyTransformToPoint } from "../../../utils/geometry/geometry";
import { UNIFIED_VERTEX_BYTES } from "./unifiedVertexLayout";

/** GPU state shared by every draw in one run. Compared by identity. */
interface RunState {
	/** A vertex-pulling pipeline (plain or stencil-fan-write). */
	pipeline: GPURenderPipeline;
	bg0: GPUBindGroup;
	bg1: GPUBindGroup;
	bg3: GPUBindGroup;
	/** The GeometryStore buffer the run's absolute vertex numbers point into.
	 *  Captured per append so a store regrowth mid-frame splits the run
	 *  instead of mixing old-buffer vertices with the new buffer. */
	storeBuffer: GPUBuffer;
}

/** GPU state shared by every element of one fill group. Compared by identity. */
interface FillGroupState {
	/** Vertex-pulling stencil-fan-write pipeline. */
	fanPipeline: GPURenderPipeline;
	/** Vertex-pulling plain pipeline (AA fringe). */
	fringePipeline: GPURenderPipeline;
	/** CLASSIC stencil-cover pipeline — covers stay on the frame batch's
	 *  vertex buffer (their quads are rebuilt every frame with baked color). */
	coverPipeline: GPURenderPipeline;
	/** The classic pipeline's BG2 (dummy gradient). */
	coverBg2: GPUBindGroup;
	bg0: GPUBindGroup;
	bg1: GPUBindGroup;
	bg3: GPUBindGroup;
	storeBuffer: GPUBuffer;
	coverBuffer: GPUBuffer;
}

interface FillBounds {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

declare const localFillBoundsBrand: unique symbol;
declare const worldFillBoundsBrand: unique symbol;

export type LocalFillBounds = FillBounds & {
	readonly [localFillBoundsBrand]: true;
};

export type WorldFillBounds = FillBounds & {
	readonly [worldFillBoundsBrand]: true;
};

/** vec2u run-table entries accumulated CPU-side, uploaded once per frame. */
interface TableChunk {
	cpu: Uint32Array;
	gpu: GPUBuffer;
	/** Entries used (each entry is 2 u32). */
	used: number;
}

/** 16k entries (128KB). One member per merged draw participant. */
const INITIAL_CHUNK_CAPACITY_ENTRIES = 16_384;

/**
 * Merges consecutive unified-geometry draws that share identical GPU state
 * into ONE vertex-pulling draw. Vertices stay in the shared GeometryStore
 * (bound as storage); a run is described by a run-table slice — a header
 * { memberCount } followed by { cumulativeStart, storeFirstVertex } entries
 * — and issued as draw(totalVertexCount, 1, 0, tableStartEntry). The
 * shader receives the table start via @builtin(instance_index) and binary-
 * searches each vertex's member (see unifiedPulled.wgsl.ts), so the CPU
 * uploads ~8 bytes per member instead of 4 bytes per vertex.
 *
 * Ordering contract: members are appended in submission order — painter's
 * order is preserved exactly, no reordering, no overlap analysis. BUT the
 * pending run is EMITTED lazily, so every draw issued to the same pass by
 * any other path (fills, gradients, blits, brush batches) and every
 * pass.end() MUST call flush() first, or the merged draw would land after
 * them and break paint order. flush() is idempotent and cheap when empty.
 *
 * Upload timing: table data accumulates in CPU chunks and uploads once per
 * frame in finishFrame() — queue.writeBuffer executes before the encoded
 * commands at submit, so draws recorded earlier in the frame read the
 * right data. A chunk's GPUBuffer is never recreated mid-frame (encoded
 * draws reference it); overflow opens a new, larger chunk instead.
 */
export class RunBatcher {
	private readonly device: GPUDevice;
	private readonly pulledBindGroupLayout: GPUBindGroupLayout;
	private chunks: TableChunk[] = [];
	private currentChunk = -1;
	private batchingEnabled = false;
	/** (chunk gpu buffer → store buffer → BG2) — recreated lazily; chunk
	 *  buffers persist across frames and store buffers change only on grow. */
	private readonly bindGroupCache = new Map<
		GPUBuffer,
		Map<GPUBuffer, GPUBindGroup>
	>();
	private pending: {
		pass: GPURenderPassEncoder;
		state: RunState;
		/** Flat pairs: [cumulativeStart, storeFirstVertex] per member. */
		members: number[];
		totalVertexCount: number;
	} | null = null;
	/** A pending stencil-fill group (fan/cover/fringe of NON-OVERLAPPING
	 *  consecutive fills, re-sequenced into three merged draws). Mutually
	 *  exclusive with `pending` — appending to one flushes the other. */
	private pendingFill: {
		pass: GPURenderPassEncoder;
		state: FillGroupState;
		fanMembers: number[];
		fanVertexCount: number;
		fringeMembers: number[];
		fringeVertexCount: number;
		coverByteOffset: number;
		coverVertexCount: number;
		bounds: FillBounds;
	} | null = null;

	public constructor(
		device: GPUDevice,
		pulledBindGroupLayout: GPUBindGroupLayout,
	) {
		this.device = device;
		this.pulledBindGroupLayout = pulledBindGroupLayout;
	}

	/**
	 * Enable cross-draw merging for the main element loop. While disabled
	 * (the default — offscreen, mask, and export passes), append() emits its
	 * draw immediately, so those passes need no flush discipline at all.
	 * Disabling flushes whatever is pending.
	 */
	public setBatching(enabled: boolean): void {
		if (!enabled) this.flush();
		this.batchingEnabled = enabled;
	}

	/**
	 * Flush and suspend merging around a pass interruption (offscreen render,
	 * backdrop capture, layer composite). Nested offscreen passes end without
	 * any flush discipline, so a run must never accumulate inside them.
	 * Returns the previous mode for resumeBatching — the interruption may
	 * itself be running inside an offscreen render that never batched.
	 */
	public pauseBatching(): boolean {
		const wasBatching = this.batchingEnabled;
		this.setBatching(false);
		return wasBatching;
	}

	/** Restore the merging mode saved by pauseBatching. */
	public resumeBatching(previous: boolean): void {
		this.batchingEnabled = previous;
	}

	/** Reset accumulation. Call once per frame BEFORE encoding starts —
	 *  chunk contents from the previous frame were already submitted. */
	public beginFrame(): void {
		this.pending = null;
		this.pendingFill = null;
		this.batchingEnabled = false;
		// Keep only the largest chunk: a frame that overflowed into extra
		// chunks teaches us the real demand, so next frame starts with one
		// chunk big enough for all of it.
		if (this.chunks.length > 1) {
			let largest = this.chunks[0];
			for (const chunk of this.chunks) {
				if (chunk.cpu.length > largest.cpu.length) largest = chunk;
			}
			for (const chunk of this.chunks) {
				if (chunk !== largest) {
					this.bindGroupCache.delete(chunk.gpu);
					chunk.gpu.destroy();
				}
			}
			this.chunks = [largest];
		}
		for (const chunk of this.chunks) chunk.used = 0;
		this.currentChunk = this.chunks.length > 0 ? 0 : -1;
	}

	/**
	 * Queue `vertexCount` vertices starting at absolute store vertex
	 * `firstVertex` for the given pass/state. Extends the pending run when
	 * everything matches; otherwise flushes it and starts a new one.
	 */
	public append(
		pass: GPURenderPassEncoder,
		state: RunState,
		firstVertex: number,
		vertexCount: number,
	): void {
		if (vertexCount <= 0) return;
		this.flushFill();
		if (
			this.pending &&
			(this.pending.pass !== pass || !sameRunState(this.pending.state, state))
		) {
			this.flushRun();
		}
		if (!this.pending) {
			this.pending = { pass, state, members: [], totalVertexCount: 0 };
		}
		const run = this.pending;
		run.members.push(run.totalVertexCount, firstVertex);
		run.totalVertexCount += vertexCount;

		if (!this.batchingEnabled) this.flushRun();
	}

	/**
	 * Queue one stencil-fill element (fan triangles + cover quad + optional
	 * AA fringe) for group emission. Consecutive fills whose state matches,
	 * whose cover quads are contiguous in the batch buffer, and whose bounds
	 * do NOT intersect the group's accumulated bounds are re-sequenced into
	 * three merged draws: all fans → all covers → all fringes. Non-overlap
	 * makes the re-sequencing invisible: over-blending is only order-sensitive
	 * where fragments overlap, and each cover resets exactly its own fan's
	 * stencil region.
	 */
	public appendFill(
		pass: GPURenderPassEncoder,
		state: FillGroupState,
		fan: { firstVertex: number; vertexCount: number },
		cover: { byteOffset: number; vertexCount: number },
		fringe: { firstVertex: number; vertexCount: number } | null,
		bounds: WorldFillBounds,
	): void {
		this.flushRun();
		if (this.pendingFill) {
			const group = this.pendingFill;
			const compatible =
				group.pass === pass &&
				sameFillGroupState(group.state, state) &&
				group.coverByteOffset +
					group.coverVertexCount * UNIFIED_VERTEX_BYTES ===
					cover.byteOffset &&
				!boundsIntersect(group.bounds, bounds);
			if (!compatible) this.flushFill();
		}
		if (!this.pendingFill) {
			this.pendingFill = {
				pass,
				state,
				fanMembers: [],
				fanVertexCount: 0,
				fringeMembers: [],
				fringeVertexCount: 0,
				coverByteOffset: cover.byteOffset,
				coverVertexCount: 0,
				bounds: { ...bounds },
			};
		}

		const group = this.pendingFill;
		group.fanMembers.push(group.fanVertexCount, fan.firstVertex);
		group.fanVertexCount += fan.vertexCount;
		if (fringe && fringe.vertexCount > 0) {
			group.fringeMembers.push(group.fringeVertexCount, fringe.firstVertex);
			group.fringeVertexCount += fringe.vertexCount;
		}
		group.coverVertexCount += cover.vertexCount;
		group.bounds.minX = Math.min(group.bounds.minX, bounds.minX);
		group.bounds.minY = Math.min(group.bounds.minY, bounds.minY);
		group.bounds.maxX = Math.max(group.bounds.maxX, bounds.maxX);
		group.bounds.maxY = Math.max(group.bounds.maxY, bounds.maxY);

		if (!this.batchingEnabled) this.flushFill();
	}

	/** Emit everything pending (plain run and fill group). Safe to call
	 *  anytime, from anywhere. */
	public flush(): void {
		this.flushRun();
		this.flushFill();
	}

	/** Upload this frame's accumulated run tables. Call after encoding ends
	 *  (every pass closed) and before submit. */
	public finishFrame(): void {
		// A live pending here means a pass ended without flushing — the run
		// would target a closed encoder, so drop it loudly for diagnosis.
		if (this.pending || this.pendingFill) {
			console.error("RunBatcher: pending run survived to finishFrame");
			this.pending = null;
			this.pendingFill = null;
		}
		for (const chunk of this.chunks) {
			if (chunk.used === 0) continue;
			this.device.queue.writeBuffer(
				chunk.gpu,
				0,
				chunk.cpu.buffer,
				0,
				chunk.used * 8,
			);
		}
	}

	public destroy(): void {
		for (const chunk of this.chunks) chunk.gpu.destroy();
		this.chunks = [];
		this.currentChunk = -1;
		this.bindGroupCache.clear();
		this.pending = null;
		this.pendingFill = null;
	}

	private flushRun(): void {
		const run = this.pending;
		if (!run) return;
		this.pending = null;

		const { pass, state } = run;
		const table = this.writeRunTable(run.members);
		pass.setPipeline(state.pipeline);
		pass.setBindGroup(0, state.bg0);
		pass.setBindGroup(1, state.bg1);
		pass.setBindGroup(2, this.getPulledBindGroup(state.storeBuffer, table.gpu));
		pass.setBindGroup(3, state.bg3);
		pass.draw(run.totalVertexCount, 1, 0, table.startEntry);
	}

	private flushFill(): void {
		const group = this.pendingFill;
		if (!group) return;
		this.pendingFill = null;

		const { pass, state } = group;

		// 1) Every fan — non-overlapping windings never interfere.
		const fanTable = this.writeRunTable(group.fanMembers);
		pass.setPipeline(state.fanPipeline);
		pass.setBindGroup(0, state.bg0);
		pass.setBindGroup(1, state.bg1);
		pass.setBindGroup(
			2,
			this.getPulledBindGroup(state.storeBuffer, fanTable.gpu),
		);
		pass.setBindGroup(3, state.bg3);
		pass.draw(group.fanVertexCount, 1, 0, fanTable.startEntry);

		// 2) Every cover — one contiguous batch-buffer range through the
		// CLASSIC pipeline; each quad colors and zero-resets exactly its own
		// fan's stencil region. Switching pipeline layouts invalidates BG2+,
		// so those two slots are re-bound around it.
		pass.setPipeline(state.coverPipeline);
		pass.setBindGroup(2, state.coverBg2);
		pass.setBindGroup(3, state.bg3);
		pass.setVertexBuffer(0, state.coverBuffer, group.coverByteOffset);
		pass.draw(group.coverVertexCount, 1, 0, 0);

		// 3) Every fringe.
		if (group.fringeMembers.length > 0) {
			const fringeTable = this.writeRunTable(group.fringeMembers);
			pass.setPipeline(state.fringePipeline);
			pass.setBindGroup(
				2,
				this.getPulledBindGroup(state.storeBuffer, fringeTable.gpu),
			);
			pass.setBindGroup(3, state.bg3);
			pass.draw(group.fringeVertexCount, 1, 0, fringeTable.startEntry);
		}
	}

	/** Write a run table (header entry + members) into the current chunk,
	 *  opening a bigger one on overflow, and return where it landed. */
	private writeRunTable(members: number[]): {
		gpu: GPUBuffer;
		startEntry: number;
	} {
		const memberCount = members.length / 2;
		const entryCount = 1 + memberCount;
		let chunk = this.currentChunk >= 0 ? this.chunks[this.currentChunk] : null;
		if (!chunk || (chunk.used + entryCount) * 2 > chunk.cpu.length) {
			chunk = this.openChunk(entryCount);
		}
		const startEntry = chunk.used;
		const cpu = chunk.cpu;
		let cursor = startEntry * 2;
		cpu[cursor++] = memberCount;
		cpu[cursor++] = 0;
		cpu.set(members, cursor);
		chunk.used += entryCount;
		return { gpu: chunk.gpu, startEntry };
	}

	private getPulledBindGroup(
		storeBuffer: GPUBuffer,
		chunkGpu: GPUBuffer,
	): GPUBindGroup {
		let byStore = this.bindGroupCache.get(chunkGpu);
		if (!byStore) {
			byStore = new Map();
			this.bindGroupCache.set(chunkGpu, byStore);
		}
		let bindGroup = byStore.get(storeBuffer);
		if (!bindGroup) {
			bindGroup = this.device.createBindGroup({
				label: "Pulled Geometry Bind Group",
				layout: this.pulledBindGroupLayout,
				entries: [
					{ binding: 0, resource: { buffer: storeBuffer } },
					{ binding: 1, resource: { buffer: chunkGpu } },
				],
			});
			byStore.set(storeBuffer, bindGroup);
		}
		return bindGroup;
	}

	private openChunk(minCapacityEntries: number): TableChunk {
		// Advance to a pre-existing chunk first (beginFrame keeps one big one).
		if (this.currentChunk + 1 < this.chunks.length) {
			this.currentChunk++;
			return this.chunks[this.currentChunk];
		}
		const lastCapacity = (this.chunks.at(-1)?.cpu.length ?? 0) / 2;
		const capacityEntries = Math.max(
			INITIAL_CHUNK_CAPACITY_ENTRIES,
			lastCapacity * 2,
			minCapacityEntries,
		);
		const chunk: TableChunk = {
			cpu: new Uint32Array(capacityEntries * 2),
			gpu: this.device.createBuffer({
				label: "Run Table Buffer",
				size: capacityEntries * 8,
				usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
			}),
			used: 0,
		};
		this.chunks.push(chunk);
		this.currentChunk = this.chunks.length - 1;
		return chunk;
	}
}

// Helpers

function sameRunState(a: RunState, b: RunState): boolean {
	return (
		a.pipeline === b.pipeline &&
		a.bg0 === b.bg0 &&
		a.bg1 === b.bg1 &&
		a.bg3 === b.bg3 &&
		a.storeBuffer === b.storeBuffer
	);
}

function sameFillGroupState(a: FillGroupState, b: FillGroupState): boolean {
	return (
		a.fanPipeline === b.fanPipeline &&
		a.fringePipeline === b.fringePipeline &&
		a.coverPipeline === b.coverPipeline &&
		a.coverBg2 === b.coverBg2 &&
		a.bg0 === b.bg0 &&
		a.bg1 === b.bg1 &&
		a.bg3 === b.bg3 &&
		a.storeBuffer === b.storeBuffer &&
		a.coverBuffer === b.coverBuffer
	);
}

/** Inclusive AABB overlap — touching bounds count as intersecting, keeping
 *  the non-overlap re-sequencing guarantee strict. */
export function createLocalFillBounds(bounds: FillBounds): LocalFillBounds {
	return bounds as LocalFillBounds;
}

export function transformFillBoundsToWorld(
	bounds: LocalFillBounds,
	transform: ElementTransform,
	transformOrigin: BoundingBox,
): WorldFillBounds {
	const originX = (transformOrigin.minX + transformOrigin.maxX) / 2;
	const originY = (transformOrigin.minY + transformOrigin.maxY) / 2;
	const corners = [
		applyTransformToPoint(
			bounds.minX,
			bounds.minY,
			transform,
			originX,
			originY,
		),
		applyTransformToPoint(
			bounds.maxX,
			bounds.minY,
			transform,
			originX,
			originY,
		),
		applyTransformToPoint(
			bounds.maxX,
			bounds.maxY,
			transform,
			originX,
			originY,
		),
		applyTransformToPoint(
			bounds.minX,
			bounds.maxY,
			transform,
			originX,
			originY,
		),
	];

	return {
		minX: Math.min(...corners.map(({ x }) => x)),
		minY: Math.min(...corners.map(({ y }) => y)),
		maxX: Math.max(...corners.map(({ x }) => x)),
		maxY: Math.max(...corners.map(({ y }) => y)),
	} as WorldFillBounds;
}

function boundsIntersect(a: FillBounds, b: FillBounds): boolean {
	return (
		a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY
	);
}
