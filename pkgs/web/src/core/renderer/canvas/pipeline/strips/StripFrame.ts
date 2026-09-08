import type { StripBatch } from "../../../geometry/strips/stripTypes";
import { TILE_SIZE } from "../../../geometry/strips/stripTypes";
import {
	STRIP_HAS_PARAMS_BIT,
	STRIP_HEIGHT_SHIFT,
	STRIP_INSTANCE_BYTES,
	STRIP_INSTANCE_U32S,
	STRIP_PAGE_WIDTH,
	STRIP_PAGE_WIDTH_BITS,
	STRIP_ROW_OFFSET_SHIFT,
} from "./stripInstanceLayout";

/** Instances per chunk buffer. */
const CHUNK_CAPACITY = 16_384;
/** Alpha slots per page: a 4096 × 1024 r8 texture. */
const PAGE_SLOTS = 1 << 20;
const PAGE_HEIGHT = (PAGE_SLOTS >> STRIP_PAGE_WIDTH_BITS) * TILE_SIZE;

interface InstanceChunk {
	cpu: Uint32Array;
	cpuF32: Float32Array;
	gpu: GPUBuffer;
	count: number;
}

interface Page {
	alpha: GPUTexture;
	params: GPUTexture | null;
	cpuAlpha: Uint8Array;
	cpuParams: Uint8Array | null;
	usedSlots: number;
	/** Bind groups keyed by the transforms buffer they were built with. */
	bindGroups: WeakMap<GPUBuffer, GPUBindGroup>;
}

/** One instanced draw's worth of strips inside the frame's buffers. */
interface StripDrawRange {
	chunk: InstanceChunk;
	page: Page;
	firstInstance: number;
	instanceCount: number;
}

/** Straight RGBA whose alpha carries the opacity multiplier. */
export type StripColor = readonly [number, number, number, number];

/**
 * Per-canvas frame storage for strip instances and their coverage pages,
 * plus the draw that consumes them.
 *
 * Instances are packed into fixed-capacity chunks and alphas into fixed-size
 * pages; a full one opens the next. Both persist across frames (bounded by
 * peak use) and are uploaded once per frame in `finishFrame`, which runs
 * before the frame's submit, so draws recorded earlier see the data.
 */
export class StripFrame {
	private readonly chunks: InstanceChunk[] = [];
	private chunkIndex = 0;
	private readonly pages: Page[] = [];
	private pageIndex = 0;
	private paramsDummy: GPUTexture | null = null;

	public constructor(
		private readonly device: GPUDevice,
		private readonly pipeline: GPURenderPipeline,
		private readonly geometryLayout: GPUBindGroupLayout,
	) {}

	public beginFrame(): void {
		for (const chunk of this.chunks) chunk.count = 0;
		for (const page of this.pages) page.usedSlots = 0;
		this.chunkIndex = 0;
		this.pageIndex = 0;
	}

	/**
	 * Place a batch at `anchor` into a `passWidth × passHeight` pass,
	 * dropping strips outside it and trimming those crossing its edges.
	 * Returns one range per (chunk, page) pair the strips landed in; empty
	 * when nothing is visible.
	 */
	public append(
		batch: StripBatch,
		anchorX: number,
		anchorY: number,
		passWidth: number,
		passHeight: number,
		elementIndex: number,
		color: StripColor,
	): StripDrawRange[] {
		const ranges: StripDrawRange[] = [];
		if (batch.stripCount === 0) return ranges;
		const hasParams = batch.params !== null;
		let range: StripDrawRange | null = null;

		for (let s = 0; s < batch.stripCount; s++) {
			let x = batch.strips[s * 4] + anchorX;
			let y = batch.strips[s * 4 + 1] + anchorY;
			let width = batch.strips[s * 4 + 2];
			let dense = batch.strips[s * 4 + 3];
			let slot = batch.slots[s];
			let rowOffset = 0;
			let height = TILE_SIZE;

			if (y >= passHeight || y + height <= 0) continue;
			if (x >= passWidth || x + width <= 0) continue;
			if (x < 0) {
				const cut = -x;
				slot += Math.min(cut, dense);
				dense = Math.max(0, dense - cut);
				width -= cut;
				x = 0;
			}
			if (x + width > passWidth) {
				width = passWidth - x;
				dense = Math.min(dense, width);
			}
			if (y < 0) {
				rowOffset = -y;
				height -= rowOffset;
				y = 0;
			}
			if (y + height > passHeight) height = passHeight - y;
			if (width <= 0 || height <= 0) continue;

			// Strips of one draw share a chunk and a page; when either fills
			// up, the draw so far is closed and a new range starts.
			const page = this.pageFor(dense, hasParams);
			const chunk = this.chunkFor();
			if (range && (range.chunk !== chunk || range.page !== page)) {
				range = null;
			}
			if (!range) {
				range = { chunk, page, firstInstance: chunk.count, instanceCount: 0 };
				ranges.push(range);
			}

			const pageSlot = page.usedSlots;
			if (dense > 0) {
				copySlots(batch, slot, dense, page, pageSlot);
				page.usedSlots += dense;
			}

			const at = chunk.count * STRIP_INSTANCE_U32S;
			chunk.cpu[at] = x | (y << 16);
			chunk.cpu[at + 1] = width | (dense << 16);
			chunk.cpu[at + 2] = pageSlot;
			chunk.cpu[at + 3] =
				(pageSlot & 0x00ff_ffff) |
				(rowOffset << STRIP_ROW_OFFSET_SHIFT) |
				(height << STRIP_HEIGHT_SHIFT) |
				(hasParams ? STRIP_HAS_PARAMS_BIT : 0);
			chunk.cpu[at + 4] = elementIndex;
			chunk.cpuF32[at + 5] = color[0];
			chunk.cpuF32[at + 6] = color[1];
			chunk.cpuF32[at + 7] = color[2];
			chunk.cpuF32[at + 8] = color[3];
			chunk.count++;
			range.instanceCount++;
		}
		return ranges;
	}

	public draw(
		pass: GPURenderPassEncoder,
		range: StripDrawRange,
		viewportBindGroup: GPUBindGroup,
		transformsBuffer: GPUBuffer,
		paintBindGroup: GPUBindGroup,
		maskBindGroup: GPUBindGroup,
	): void {
		pass.setPipeline(this.pipeline);
		pass.setBindGroup(0, viewportBindGroup);
		pass.setBindGroup(1, this.geometryBindGroup(range.page, transformsBuffer));
		pass.setBindGroup(2, paintBindGroup);
		pass.setBindGroup(3, maskBindGroup);
		pass.setVertexBuffer(0, range.chunk.gpu);
		pass.draw(4, range.instanceCount, 0, range.firstInstance);
	}

	/** Upload what the frame appended. Call before the frame's submit. */
	public finishFrame(): void {
		for (const chunk of this.chunks) {
			if (chunk.count === 0) continue;
			this.device.queue.writeBuffer(
				chunk.gpu,
				0,
				chunk.cpu.buffer,
				0,
				chunk.count * STRIP_INSTANCE_BYTES,
			);
		}
		for (const page of this.pages) {
			if (page.usedSlots === 0) continue;
			const rows = Math.ceil(page.usedSlots / STRIP_PAGE_WIDTH) * TILE_SIZE;
			this.device.queue.writeTexture(
				{ texture: page.alpha },
				page.cpuAlpha,
				{ bytesPerRow: STRIP_PAGE_WIDTH },
				{ width: STRIP_PAGE_WIDTH, height: rows },
			);
			if (page.params && page.cpuParams) {
				this.device.queue.writeTexture(
					{ texture: page.params },
					page.cpuParams,
					{ bytesPerRow: STRIP_PAGE_WIDTH * 2 },
					{ width: STRIP_PAGE_WIDTH, height: rows },
				);
			}
		}
	}

	public destroy(): void {
		for (const chunk of this.chunks) chunk.gpu.destroy();
		this.chunks.length = 0;
		for (const page of this.pages) {
			page.alpha.destroy();
			page.params?.destroy();
		}
		this.pages.length = 0;
		this.paramsDummy?.destroy();
		this.paramsDummy = null;
	}

	private chunkFor(): InstanceChunk {
		let chunk = this.chunks[this.chunkIndex];
		if (chunk && chunk.count === CHUNK_CAPACITY) {
			this.chunkIndex++;
			chunk = this.chunks[this.chunkIndex];
		}
		if (!chunk) {
			const cpu = new Uint32Array(CHUNK_CAPACITY * STRIP_INSTANCE_U32S);
			chunk = {
				cpu,
				cpuF32: new Float32Array(cpu.buffer),
				gpu: this.device.createBuffer({
					label: `Strip Instances #${this.chunks.length}`,
					size: cpu.byteLength,
					usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
				}),
				count: 0,
			};
			this.chunks.push(chunk);
		}
		return chunk;
	}

	private pageFor(slots: number, wantParams: boolean): Page {
		let page = this.pages[this.pageIndex];
		if (page && page.usedSlots + slots > PAGE_SLOTS) {
			this.pageIndex++;
			page = this.pages[this.pageIndex];
		}
		if (!page) {
			page = {
				alpha: this.device.createTexture({
					label: `Strip Alpha Page #${this.pages.length}`,
					size: { width: STRIP_PAGE_WIDTH, height: PAGE_HEIGHT },
					format: "r8unorm",
					usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
				}),
				params: null,
				cpuAlpha: new Uint8Array(STRIP_PAGE_WIDTH * PAGE_HEIGHT),
				cpuParams: null,
				usedSlots: 0,
				bindGroups: new WeakMap(),
			};
			this.pages.push(page);
		}
		if (wantParams && !page.params) {
			page.params = this.device.createTexture({
				label: `Strip Params Page #${this.pages.indexOf(page)}`,
				size: { width: STRIP_PAGE_WIDTH, height: PAGE_HEIGHT },
				format: "rg8unorm",
				usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
			});
			page.cpuParams = new Uint8Array(STRIP_PAGE_WIDTH * PAGE_HEIGHT * 2);
			page.bindGroups = new WeakMap();
		}
		return page;
	}

	private geometryBindGroup(
		page: Page,
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
					resource: (page.params ?? this.paramsDummyTexture()).createView(),
				},
			],
		});
		page.bindGroups.set(transformsBuffer, bindGroup);
		return bindGroup;
	}

	private paramsDummyTexture(): GPUTexture {
		this.paramsDummy ??= this.device.createTexture({
			label: "Strip Params Dummy",
			size: { width: 1, height: 1 },
			format: "rg8unorm",
			usage: GPUTextureUsage.TEXTURE_BINDING,
		});
		return this.paramsDummy;
	}
}

/** Scatter `count` slots of a batch into the page's row-major texel layout. */
function copySlots(
	batch: StripBatch,
	from: number,
	count: number,
	page: Page,
	to: number,
): void {
	const alphas = batch.alphas;
	const params = batch.params;
	const cpuAlpha = page.cpuAlpha;
	const cpuParams = page.cpuParams;
	for (let i = 0; i < count; i++) {
		const src = (from + i) * 4;
		const slot = to + i;
		const column = slot & (STRIP_PAGE_WIDTH - 1);
		const rowBase = (slot >> STRIP_PAGE_WIDTH_BITS) * TILE_SIZE;
		for (let r = 0; r < TILE_SIZE; r++) {
			cpuAlpha[(rowBase + r) * STRIP_PAGE_WIDTH + column] = alphas[src + r];
		}
		if (params && cpuParams) {
			const psrc = (from + i) * 8;
			for (let r = 0; r < TILE_SIZE; r++) {
				const dst = ((rowBase + r) * STRIP_PAGE_WIDTH + column) * 2;
				cpuParams[dst] = params[psrc + r * 2];
				cpuParams[dst + 1] = params[psrc + r * 2 + 1];
			}
		}
	}
}
