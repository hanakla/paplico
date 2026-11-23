/** Bytes of a stroke meta page one draw can address from its offset. A page
 *  buffer is twice this, so the window of the last draw still fits. */
const STROKE_META_WINDOW_BYTES = 65_536;

/** Dynamic offsets of a storage binding are multiples of the device's
 *  `minStorageBufferOffsetAlignment`, which is 256 or a smaller power of two. */
const STORAGE_OFFSET_ALIGNMENT = 256;

/** A pooled buffer larger than the need by this factor is replaced with a
 *  smaller one, so a burst does not pin its peak. Two power-of-two steps of
 *  slack keep oscillating sizes from reallocating every frame. */
const SHRINK_RATIO = 4;

/** Where one draw's PathMetas and ColorStops sit in a stroke meta page. */
export interface StrokeMetaSlot {
	/** Group(1) of the stroke meta layout. Bind it with `dynamicOffsets`. */
	bindGroup: GPUBindGroup;
	/** The two offsets in the binding order of the stroke meta layout. */
	dynamicOffsets: [pathMetaOffset: number, colorStopsOffset: number];
	pathMetaBuffer: GPUBuffer;
	pathMetaOffset: number;
	colorStopsBuffer: GPUBuffer;
	colorStopsOffset: number;
}

/**
 * Per-frame GPU buffers shared by the dab and ribbon renderers: an instance
 * data pool, and pages that hold the PathMetas and ColorStops of many draws.
 * Both rewind at the start of each frame, so every draw of a frame keeps its
 * own data until the frame is submitted.
 */
export class BrushFrameBuffers {
	private readonly device: GPUDevice;
	private readonly strokeMetaBindGroupLayout: GPUBindGroupLayout;
	private readonly instancePool: PooledBuffer[] = [];
	private readonly strokeMetaPages: StrokeMetaPage[] = [];
	private instanceIdx = 0;
	/** Pages this frame has written to. The last of them takes the next draw. */
	private strokeMetaPageCount = 0;

	public constructor(
		device: GPUDevice,
		strokeMetaBindGroupLayout: GPUBindGroupLayout,
	) {
		this.device = device;
		this.strokeMetaBindGroupLayout = strokeMetaBindGroupLayout;
	}

	/** Rewind the pool and the pages. Call at the start of each frame. */
	public beginFrame(): void {
		this.instanceIdx = 0;
		this.strokeMetaPageCount = 0;
	}

	public acquireInstances(requiredSize: number): GPUBuffer {
		let entry = this.instancePool[this.instanceIdx];
		const size = poolBufferSize(requiredSize, 4096);
		if (!entry || !pooledSizeServes(entry.size, size)) {
			entry?.buffer.destroy();
			entry = {
				buffer: this.device.createBuffer({
					label: "Brush Instance Buffer (Pooled)",
					size,
					usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
				}),
				size,
			};
			this.instancePool[this.instanceIdx] = entry;
		}
		this.instanceIdx++;
		return entry.buffer;
	}

	/** Upload one draw's PathMetas and ColorStops into the current page. */
	public uploadStrokeMeta(
		pathMetas: Float32Array,
		colorStops: Float32Array,
	): StrokeMetaSlot {
		const page = this.strokeMetaPageFor(
			pathMetas.byteLength,
			colorStops.byteLength,
		);
		const pathMetaOffset = this.appendToPage(page.pathMetas, pathMetas);
		const colorStopsOffset = this.appendToPage(page.colorStops, colorStops);
		return {
			bindGroup: page.bindGroup,
			dynamicOffsets: [pathMetaOffset, colorStopsOffset],
			pathMetaBuffer: page.pathMetas.buffer,
			pathMetaOffset,
			colorStopsBuffer: page.colorStops.buffer,
			colorStopsOffset,
		};
	}

	public destroy(): void {
		for (const entry of this.instancePool) entry.buffer.destroy();
		this.instancePool.length = 0;
		for (const page of this.strokeMetaPages) destroyPage(page);
		this.strokeMetaPages.length = 0;
		this.strokeMetaPageCount = 0;
	}

	/** The page the next draw writes to: the current one while both of its
	 *  buffers have room, otherwise the next page of the pool. */
	private strokeMetaPageFor(
		pathMetaBytes: number,
		colorStopsBytes: number,
	): StrokeMetaPage {
		const current = this.strokeMetaPages[this.strokeMetaPageCount - 1];
		if (
			current &&
			pageBufferFits(current.pathMetas, pathMetaBytes) &&
			pageBufferFits(current.colorStops, colorStopsBytes)
		) {
			return current;
		}

		const pathMetaWindow = poolBufferSize(
			pathMetaBytes,
			STROKE_META_WINDOW_BYTES,
		);
		const colorStopsWindow = poolBufferSize(
			colorStopsBytes,
			STROKE_META_WINDOW_BYTES,
		);
		let page = this.strokeMetaPages[this.strokeMetaPageCount];
		if (
			!page ||
			!pooledSizeServes(page.pathMetas.window, pathMetaWindow) ||
			!pooledSizeServes(page.colorStops.window, colorStopsWindow)
		) {
			if (page) destroyPage(page);
			page = this.createStrokeMetaPage(pathMetaWindow, colorStopsWindow);
			this.strokeMetaPages[this.strokeMetaPageCount] = page;
		}
		page.pathMetas.used = 0;
		page.colorStops.used = 0;
		this.strokeMetaPageCount++;
		return page;
	}

	private createStrokeMetaPage(
		pathMetaWindow: number,
		colorStopsWindow: number,
	): StrokeMetaPage {
		const pathMetas = this.createPageBuffer(
			"PathMeta Storage Buffer (Page)",
			pathMetaWindow,
		);
		const colorStops = this.createPageBuffer(
			"Color Stops Storage Buffer (Page)",
			colorStopsWindow,
		);
		return {
			pathMetas,
			colorStops,
			bindGroup: this.device.createBindGroup({
				label: "Stroke Meta Page Bind Group",
				layout: this.strokeMetaBindGroupLayout,
				entries: [
					{
						binding: 0,
						resource: { buffer: pathMetas.buffer, size: pathMetaWindow },
					},
					{
						binding: 1,
						resource: { buffer: colorStops.buffer, size: colorStopsWindow },
					},
				],
			}),
		};
	}

	private createPageBuffer(label: string, window: number): PageBuffer {
		return {
			buffer: this.device.createBuffer({
				label,
				size: window * 2,
				usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
			}),
			window,
			used: 0,
		};
	}

	/** Write `data` at the page buffer's next free offset and return it. */
	private appendToPage(target: PageBuffer, data: Float32Array): number {
		const offset = target.used;
		if (data.byteLength > 0) {
			this.device.queue.writeBuffer(
				target.buffer,
				offset,
				data.buffer as ArrayBuffer,
				data.byteOffset,
				data.byteLength,
			);
		}
		target.used =
			Math.ceil((offset + data.byteLength) / STORAGE_OFFSET_ALIGNMENT) *
			STORAGE_OFFSET_ALIGNMENT;
		return offset;
	}
}

interface PooledBuffer {
	buffer: GPUBuffer;
	size: number;
}

/** One buffer of a stroke meta page. Draws take offsets up to `window`, and
 *  each addresses `window` bytes from its offset. */
interface PageBuffer {
	buffer: GPUBuffer;
	window: number;
	used: number;
}

interface StrokeMetaPage {
	pathMetas: PageBuffer;
	colorStops: PageBuffer;
	/** Binds both buffers with a window each, for use with dynamic offsets. */
	bindGroup: GPUBindGroup;
}

/** Round pooled buffer sizes up to a power of two so gradual size growth
 *  reuses buffers instead of destroying/recreating them every frame. */
function poolBufferSize(requiredSize: number, minSize: number): number {
	return Math.max(2 ** Math.ceil(Math.log2(requiredSize)), minSize);
}

function pageBufferFits(target: PageBuffer, bytes: number): boolean {
	return bytes <= target.window && target.used <= target.window;
}

/** Whether a pooled buffer of `size` bytes serves a need of `needed` bytes. */
function pooledSizeServes(size: number, needed: number): boolean {
	return size >= needed && size <= needed * SHRINK_RATIO;
}

function destroyPage(page: StrokeMetaPage): void {
	page.pathMetas.buffer.destroy();
	page.colorStops.buffer.destroy();
}
