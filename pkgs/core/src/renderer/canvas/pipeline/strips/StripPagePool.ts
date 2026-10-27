import { IdleClock, type UseStamp } from "../IdleClock";
import {
	STRIP_INSTANCE_BYTES,
	STRIP_PAGE_WIDTH,
	STRIP_PARAMS_ROWS_PER_ALPHA_ROW,
} from "./stripInstanceLayout";

/** Alpha texel rows of a standard page: 1M slots, 4 MiB. */
const PAGE_ROWS = 256;
/** Strip instances of a standard page: 2 MiB. */
const PAGE_STRIPS = 1 << 17;
/** Bytes of alpha, params and instances the pool grows to before it reuses idle pages instead. */
const PAGE_BUDGET_BYTES = 64 * 1024 * 1024;

/** One page: alpha (and on demand params) texels plus the strip instances that index them. */
export interface StripPage {
	alpha: GPUTexture;
	alphaStorage: GPUTextureView;
	params: GPUTexture | null;
	paramsStorage: GPUTextureView | null;
	instances: GPUBuffer;
	slotCapacity: number;
	stripCapacity: number;
	usedSlots: number;
	usedStrips: number;
	/** Bumped when the page is reset; allocations of older generations are gone. */
	generation: number;
	lastUsed: UseStamp;
	destroyed: boolean;
	/** Draw bind groups keyed by the transforms buffer they were built with. */
	bindGroups: WeakMap<GPUBuffer, GPUBindGroup>;
}

/** Strips one cache entry owns in a page. */
export class ResidentStrips {
	/** Set when the coverage that fills the allocation was never dispatched. */
	public abandoned = false;

	public constructor(
		public readonly page: StripPage | null,
		private readonly generation: number,
		/** First alpha slot of the batch in the page. */
		public readonly firstSlot: number,
		public readonly firstStrip: number,
		public readonly stripCount: number,
		public readonly hasParams: boolean,
	) {}

	/** Whether the page still holds what was written for this entry. */
	public isLive(): boolean {
		if (this.abandoned) return false;
		if (!this.page) return true;
		return !this.page.destroyed && this.page.generation === this.generation;
	}
}

/**
 * Resident pages of strip coverage and instances, shared by every cache
 * entry of one canvas.
 *
 * Allocations bump-allocate inside a page and are never freed one by one:
 * entries that leave the strip cache simply stop being drawn. When a new
 * page would exceed the budget, the page idle the longest is reset whole,
 * which invalidates every entry it held (they re-rasterize on their next
 * draw). A page used in the current frame is never reset, because the frame's
 * coverage dispatch runs before its draws and would overwrite them. A frame
 * whose pages do not fit the budget grows the pool past it; at frame start,
 * pages idle long enough are freed until the pool fits again.
 */
export class StripPagePool {
	private readonly pages: StripPage[] = [];
	private current: StripPage | null = null;
	private readonly clock = new IdleClock();
	private budgetBytes = PAGE_BUDGET_BYTES;

	public constructor(private readonly device: GPUDevice) {}

	/** Change the bytes the pool grows to. Pages past it are freed once idle. */
	public setBudgetBytes(bytes: number): void {
		this.budgetBytes = bytes;
	}

	public beginFrame(): void {
		this.clock.tick();
		this.trimIdlePages();
	}

	/**
	 * Reserve `slots` alpha slots and `strips` instances in one page. Null when
	 * the batch exceeds what one texture can hold.
	 */
	public allocate(
		slots: number,
		strips: number,
		wantParams: boolean,
	): { page: StripPage; firstSlot: number; firstStrip: number } | null {
		let page = this.current;
		if (
			!page ||
			!fits(page, slots, strips) ||
			!this.paramsFit(page, wantParams)
		) {
			page =
				this.reusablePage(slots, strips, wantParams) ??
				this.createPage(slots, strips, wantParams);
			if (!page) return null;
			this.current = page;
		}
		if (wantParams && !page.params) this.addParams(page);
		const firstSlot = page.usedSlots;
		const firstStrip = page.usedStrips;
		page.usedSlots += slots;
		page.usedStrips += strips;
		page.lastUsed = this.clock.stamp();
		return { page, firstSlot, firstStrip };
	}

	/** Whether one page can hold a batch of this size. */
	public canHold(slots: number, strips: number, wantParams: boolean): boolean {
		const { slotCapacity, stripCapacity } = newPageCapacity(slots, strips);
		const rows = slotCapacity / STRIP_PAGE_WIDTH;
		const textureRows = wantParams
			? rows * STRIP_PARAMS_ROWS_PER_ALPHA_ROW
			: rows;
		return (
			textureRows <= this.device.limits.maxTextureDimension2D &&
			stripCapacity * STRIP_INSTANCE_BYTES <= this.device.limits.maxBufferSize
		);
	}

	public touch(page: StripPage): void {
		page.lastUsed = this.clock.stamp();
	}

	public destroy(): void {
		for (const page of this.pages) destroyPage(page);
		this.pages.length = 0;
		this.current = null;
	}

	/** The page idle the longest that can hold the batch, once a new page would exceed the budget. */
	private reusablePage(
		slots: number,
		strips: number,
		wantParams: boolean,
	): StripPage | null {
		const capacity = newPageCapacity(slots, strips);
		const newBytes = capacityBytes(
			capacity.slotCapacity,
			capacity.stripCapacity,
			wantParams,
		);
		if (this.totalBytes() + newBytes <= this.budgetBytes) return null;
		let oldest: StripPage | null = null;
		for (const page of this.pages) {
			if (page.lastUsed.frame >= this.clock.frame) continue;
			if (page.slotCapacity < slots || page.stripCapacity < strips) continue;
			if (!this.paramsFit(page, wantParams)) continue;
			if (!oldest || page.lastUsed.frame < oldest.lastUsed.frame) {
				oldest = page;
			}
		}
		if (!oldest) return null;
		oldest.generation++;
		oldest.usedSlots = 0;
		oldest.usedStrips = 0;
		return oldest;
	}

	/** Free pages idle long enough, oldest first, until the pool fits its budget. */
	private trimIdlePages(): void {
		let bytes = this.totalBytes();
		if (bytes <= this.budgetBytes) return;
		const now = performance.now();
		const idle = this.pages
			.filter((page) => this.clock.isExpired(page.lastUsed, now))
			.toSorted((a, b) => a.lastUsed.frame - b.lastUsed.frame);
		for (const page of idle) {
			if (bytes <= this.budgetBytes) return;
			bytes -= pageBytes(page);
			destroyPage(page);
			this.pages.splice(this.pages.indexOf(page), 1);
			if (page === this.current) this.current = null;
		}
	}

	private totalBytes(): number {
		return this.pages.reduce((sum, page) => sum + pageBytes(page), 0);
	}

	/** Whether a page can take params: it has them, or its params texture fits the device. */
	private paramsFit(page: StripPage, wantParams: boolean): boolean {
		if (!wantParams || page.params) return true;
		return this.canHold(page.slotCapacity, page.stripCapacity, true);
	}

	private createPage(
		slots: number,
		strips: number,
		wantParams: boolean,
	): StripPage | null {
		if (!this.canHold(slots, strips, wantParams)) return null;
		const { slotCapacity, stripCapacity } = newPageCapacity(slots, strips);
		const rows = slotCapacity / STRIP_PAGE_WIDTH;
		const index = this.pages.length;
		const alpha = this.device.createTexture({
			label: `Strip Alpha Page #${index}`,
			size: { width: STRIP_PAGE_WIDTH, height: rows },
			format: "rgba8unorm",
			usage:
				GPUTextureUsage.TEXTURE_BINDING |
				GPUTextureUsage.STORAGE_BINDING |
				GPUTextureUsage.COPY_SRC,
		});
		const page: StripPage = {
			alpha,
			alphaStorage: alpha.createView(),
			params: null,
			paramsStorage: null,
			instances: this.device.createBuffer({
				label: `Strip Instances #${index}`,
				size: stripCapacity * STRIP_INSTANCE_BYTES,
				usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
			}),
			slotCapacity,
			stripCapacity,
			usedSlots: 0,
			usedStrips: 0,
			generation: 0,
			lastUsed: this.clock.stamp(),
			destroyed: false,
			bindGroups: new WeakMap(),
		};
		this.pages.push(page);
		return page;
	}

	private addParams(page: StripPage): void {
		page.params = this.device.createTexture({
			label: `Strip Params Page #${this.pages.indexOf(page)}`,
			size: {
				width: STRIP_PAGE_WIDTH,
				height:
					(page.slotCapacity / STRIP_PAGE_WIDTH) *
					STRIP_PARAMS_ROWS_PER_ALPHA_ROW,
			},
			format: "rgba8unorm",
			usage:
				GPUTextureUsage.TEXTURE_BINDING |
				GPUTextureUsage.STORAGE_BINDING |
				GPUTextureUsage.COPY_SRC,
		});
		page.paramsStorage = page.params.createView();
		page.bindGroups = new WeakMap();
	}
}

function fits(page: StripPage, slots: number, strips: number): boolean {
	return (
		page.usedSlots + slots <= page.slotCapacity &&
		page.usedStrips + strips <= page.stripCapacity
	);
}

/** Capacity of a new page that holds a batch: a standard page, or one just big enough. */
function newPageCapacity(
	slots: number,
	strips: number,
): { slotCapacity: number; stripCapacity: number } {
	const rows = Math.max(PAGE_ROWS, Math.ceil(slots / STRIP_PAGE_WIDTH));
	return {
		slotCapacity: rows * STRIP_PAGE_WIDTH,
		stripCapacity: Math.max(PAGE_STRIPS, strips),
	};
}

function pageBytes(page: StripPage): number {
	return capacityBytes(
		page.slotCapacity,
		page.stripCapacity,
		page.params !== null,
	);
}

/** GPU bytes of a page: one rgba8 alpha texel per slot, its params texels and its instances. */
function capacityBytes(
	slotCapacity: number,
	stripCapacity: number,
	hasParams: boolean,
): number {
	const alphaBytes = slotCapacity * 4;
	const paramsBytes = hasParams
		? alphaBytes * STRIP_PARAMS_ROWS_PER_ALPHA_ROW
		: 0;
	return alphaBytes + paramsBytes + stripCapacity * STRIP_INSTANCE_BYTES;
}

function destroyPage(page: StripPage): void {
	page.destroyed = true;
	page.alpha.destroy();
	page.params?.destroy();
	page.instances.destroy();
}
