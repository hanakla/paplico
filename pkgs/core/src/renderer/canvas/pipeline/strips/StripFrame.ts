import type { StripBatch } from "../../../geometry/strips/stripTypes";
import { StripCoverage } from "./StripCoverage";
import { ResidentStrips, type StripPage, StripPagePool } from "./StripPagePool";
import {
	STRIP_DRAW_BYTES,
	STRIP_DRAW_HAS_PARAMS,
	STRIP_DRAW_U32S,
	STRIP_INSTANCE_BYTES,
	STRIP_INSTANCE_U32S,
} from "./stripInstanceLayout";

/** Draw records per chunk buffer. */
const RECORD_CAPACITY = 4096;

/** Strip instances written to one page this frame, uploaded together in `finishFrame`. */
interface PendingInstances {
	page: StripPage;
	firstStrip: number;
	stripCount: number;
	data: Uint32Array<ArrayBuffer>;
}

interface RecordChunk {
	cpu: Uint32Array<ArrayBuffer>;
	cpuI32: Int32Array<ArrayBuffer>;
	cpuF32: Float32Array<ArrayBuffer>;
	gpu: GPUBuffer;
	count: number;
}

/** Straight RGBA whose alpha carries the opacity multiplier. */
export type StripColor = readonly [number, number, number, number];

/**
 * Per-canvas strip storage and the draw that consumes it.
 *
 * `upload` places a batch in a resident page: its strip instances are
 * staged once, and its coverage is queued for the GPU. A frame uploads
 * thousands of small batches, so the instances staged into one page go up
 * in a single write in `finishFrame`. A cache entry keeps
 * the returned `ResidentStrips` and draws them in later frames without
 * touching the CPU copy again. Each draw only appends a draw record (anchor,
 * transform slot, paint colour), uploaded with the queued coverage in
 * `finishFrame`, which runs before the frame's submit.
 */
export class StripFrame {
	private readonly pool: StripPagePool;
	private readonly coverage: StripCoverage;
	private readonly chunks: RecordChunk[] = [];
	private readonly pendingInstances: PendingInstances[] = [];
	private chunkIndex = 0;
	/** Bound in place of a page's params texture when it has none, by the draw and by the coverage pass. */
	private readonly paramsFallback: GPUTexture;
	private readonly paramsFallbackView: GPUTextureView;

	public constructor(
		private readonly device: GPUDevice,
		private readonly pipeline: GPURenderPipeline,
		private readonly geometryLayout: GPUBindGroupLayout,
	) {
		this.pool = new StripPagePool(device);
		this.paramsFallback = device.createTexture({
			label: "Strip Params Fallback",
			size: { width: 1, height: 1 },
			format: "rgba8unorm",
			usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
		});
		this.paramsFallbackView = this.paramsFallback.createView();
		this.coverage = new StripCoverage(device, this.paramsFallbackView);
	}

	/** Bytes the resident pages hold now. */
	public get residentBytes(): number {
		return this.pool.residentBytes;
	}

	/** Bytes the resident pages may grow to. */
	public setPageBudgetBytes(bytes: number): void {
		this.pool.setBudgetBytes(bytes);
	}

	public beginFrame(): void {
		this.coverage.discardPending();
		this.pendingInstances.length = 0;
		this.pool.beginFrame();
		for (const chunk of this.chunks) chunk.count = 0;
		this.chunkIndex = 0;
	}

	/** Whether one page can hold a batch of this size; `upload` fails otherwise. */
	public canHold(slots: number, strips: number, wantParams: boolean): boolean {
		return this.pool.canHold(slots, strips, wantParams);
	}

	/**
	 * Make a batch resident and queue its coverage. Null when the batch is
	 * larger than one page can hold.
	 */
	public upload(batch: StripBatch): ResidentStrips | null {
		const hasParams = batch.params !== null;
		if (batch.stripCount === 0) {
			return new ResidentStrips(null, 0, 0, 0, 0, hasParams);
		}
		const allocation = this.pool.allocate(
			batch.slotCount,
			batch.stripCount,
			hasParams,
		);
		if (!allocation) return null;
		const { page, firstSlot, firstStrip } = allocation;
		const strips = new ResidentStrips(
			page,
			page.generation,
			firstSlot,
			firstStrip,
			batch.stripCount,
			hasParams,
		);

		const instances = this.stageInstances(page, firstStrip, batch.stripCount);
		const instancesI32 = new Int32Array(
			instances.buffer,
			instances.byteOffset,
			instances.length,
		);
		for (let s = 0; s < batch.stripCount; s++) {
			const at = s * STRIP_INSTANCE_U32S;
			instancesI32[at] = batch.strips[s * 4];
			instancesI32[at + 1] = batch.strips[s * 4 + 1];
			instances[at + 2] =
				batch.strips[s * 4 + 2] | (batch.strips[s * 4 + 3] << 16);
			instances[at + 3] = batch.slots[s] + firstSlot;
		}
		this.coverage.enqueue(batch, strips);
		return strips;
	}

	/** Draw resident strips placed at `anchor` (pass pixels). */
	public draw(
		pass: GPURenderPassEncoder,
		strips: ResidentStrips,
		anchorX: number,
		anchorY: number,
		elementIndex: number,
		color: StripColor,
		viewportBindGroup: GPUBindGroup,
		transformsBuffer: GPUBuffer,
		paintBindGroup: GPUBindGroup,
		maskBindGroup: GPUBindGroup,
	): void {
		const page = strips.page;
		if (!page || strips.stripCount === 0) return;
		this.pool.touch(page);

		const chunk = this.chunkFor();
		const record = chunk.count++;
		const at = record * STRIP_DRAW_U32S;
		chunk.cpuI32[at] = anchorX;
		chunk.cpuI32[at + 1] = anchorY;
		chunk.cpu[at + 2] = elementIndex;
		chunk.cpu[at + 3] = strips.hasParams ? STRIP_DRAW_HAS_PARAMS : 0;
		chunk.cpuF32[at + 4] = color[0];
		chunk.cpuF32[at + 5] = color[1];
		chunk.cpuF32[at + 6] = color[2];
		chunk.cpuF32[at + 7] = color[3];

		pass.setPipeline(this.pipeline);
		pass.setBindGroup(0, viewportBindGroup);
		pass.setBindGroup(1, this.geometryBindGroup(page, transformsBuffer));
		pass.setBindGroup(2, paintBindGroup);
		pass.setBindGroup(3, maskBindGroup);
		pass.setVertexBuffer(
			0,
			page.instances,
			strips.firstStrip * STRIP_INSTANCE_BYTES,
			strips.stripCount * STRIP_INSTANCE_BYTES,
		);
		pass.setVertexBuffer(
			1,
			chunk.gpu,
			record * STRIP_DRAW_BYTES,
			STRIP_DRAW_BYTES,
		);
		pass.draw(4, strips.stripCount);
	}

	/** Upload the frame's strip instances and draw records and submit its coverage. Call before the frame's submit. */
	public finishFrame(): void {
		for (const pending of this.pendingInstances) {
			this.device.queue.writeBuffer(
				pending.page.instances,
				pending.firstStrip * STRIP_INSTANCE_BYTES,
				pending.data.buffer,
				0,
				pending.stripCount * STRIP_INSTANCE_BYTES,
			);
		}
		this.pendingInstances.length = 0;
		for (const chunk of this.chunks) {
			if (chunk.count === 0) continue;
			this.device.queue.writeBuffer(
				chunk.gpu,
				0,
				chunk.cpu.buffer,
				0,
				chunk.count * STRIP_DRAW_BYTES,
			);
		}
		this.coverage.flush();
	}

	public destroy(): void {
		for (const chunk of this.chunks) chunk.gpu.destroy();
		this.chunks.length = 0;
		this.pool.destroy();
		this.coverage.destroy();
		this.paramsFallback.destroy();
	}

	/**
	 * The staging words for `stripCount` instances placed at `firstStrip` of
	 * `page`. Allocations within a page are contiguous, so they extend the
	 * page's pending run; a page reused from its start begins a new run.
	 */
	private stageInstances(
		page: StripPage,
		firstStrip: number,
		stripCount: number,
	): Uint32Array<ArrayBuffer> {
		let pending = this.pendingInstances.findLast((run) => run.page === page);
		if (!pending || pending.firstStrip + pending.stripCount !== firstStrip) {
			pending = {
				page,
				firstStrip,
				stripCount: 0,
				data: new Uint32Array(Math.max(stripCount, 1024) * STRIP_INSTANCE_U32S),
			};
			this.pendingInstances.push(pending);
		}
		const start = pending.stripCount * STRIP_INSTANCE_U32S;
		const end = start + stripCount * STRIP_INSTANCE_U32S;
		if (end > pending.data.length) {
			const grown = new Uint32Array(Math.max(end, pending.data.length * 2));
			grown.set(pending.data.subarray(0, start));
			pending.data = grown;
		}
		pending.stripCount += stripCount;
		return pending.data.subarray(start, end);
	}

	private chunkFor(): RecordChunk {
		let chunk = this.chunks[this.chunkIndex];
		if (chunk && chunk.count === RECORD_CAPACITY) {
			this.chunkIndex++;
			chunk = this.chunks[this.chunkIndex];
		}
		if (!chunk) {
			const cpu = new Uint32Array(RECORD_CAPACITY * STRIP_DRAW_U32S);
			chunk = {
				cpu,
				cpuI32: new Int32Array(cpu.buffer),
				cpuF32: new Float32Array(cpu.buffer),
				gpu: this.device.createBuffer({
					label: `Strip Draw Records #${this.chunks.length}`,
					size: cpu.byteLength,
					usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
				}),
				count: 0,
			};
			this.chunks.push(chunk);
		}
		return chunk;
	}

	private geometryBindGroup(
		page: StripPage,
		transformsBuffer: GPUBuffer,
	): GPUBindGroup {
		let bindGroup = page.bindGroups.get(transformsBuffer);
		if (bindGroup) return bindGroup;
		bindGroup = this.device.createBindGroup({
			label: "Strip Geometry Bind Group",
			layout: this.geometryLayout,
			entries: [
				{ binding: 0, resource: { buffer: transformsBuffer } },
				{ binding: 1, resource: page.alpha.createView() },
				{
					binding: 2,
					resource: page.params?.createView() ?? this.paramsFallbackView,
				},
			],
		});
		page.bindGroups.set(transformsBuffer, bindGroup);
		return bindGroup;
	}
}
