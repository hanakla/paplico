import { STRIP_INSTANCE_BYTES, STRIP_PAGE_WIDTH } from "./stripInstanceLayout";

/** Alpha texel rows of a standard page: 1M slots, 4 MiB. */
const PAGE_ROWS = 256;
/** Strip instances of a standard page: 2 MiB. */
const PAGE_STRIPS = 1 << 17;
/** Alpha bytes the pool grows to before it reuses idle pages instead. */
const ALPHA_BUDGET_BYTES = 64 * 1024 * 1024;

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
	lastUsedFrame: number;
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
 * coverage dispatch runs before its draws and would overwrite them.
 */
export class StripPagePool {
	private readonly pages: StripPage[] = [];
	private current: StripPage | null = null;
	private frame = 0;

	public constructor(private readonly device: GPUDevice) {}

	public get currentFrame(): number {
		return this.frame;
	}

	public beginFrame(): void {
		this.frame++;
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
		if (!page || !fits(page, slots, strips)) {
			page = this.reusablePage(slots, strips) ?? this.createPage(slots, strips);
			if (!page) return null;
			this.current = page;
		}
		if (wantParams && !page.params) this.addParams(page);
		const firstSlot = page.usedSlots;
		const firstStrip = page.usedStrips;
		page.usedSlots += slots;
		page.usedStrips += strips;
		page.lastUsedFrame = this.frame;
		return { page, firstSlot, firstStrip };
	}

	public touch(page: StripPage): void {
		page.lastUsedFrame = this.frame;
	}

	public destroy(): void {
		for (const page of this.pages) destroyPage(page);
		this.pages.length = 0;
		this.current = null;
	}

	/** The page idle the longest that can hold the batch, once the budget is spent. */
	private reusablePage(slots: number, strips: number): StripPage | null {
		const alphaBytes = this.pages.reduce(
			(sum, p) => sum + p.slotCapacity * 4,
			0,
		);
		if (alphaBytes + PAGE_ROWS * STRIP_PAGE_WIDTH * 4 <= ALPHA_BUDGET_BYTES) {
			return null;
		}
		let oldest: StripPage | null = null;
		for (const page of this.pages) {
			if (page.lastUsedFrame >= this.frame) continue;
			if (page.slotCapacity < slots || page.stripCapacity < strips) continue;
			if (!oldest || page.lastUsedFrame < oldest.lastUsedFrame) oldest = page;
		}
		if (!oldest) return null;
		oldest.generation++;
		oldest.usedSlots = 0;
		oldest.usedStrips = 0;
		return oldest;
	}

	private createPage(slots: number, strips: number): StripPage | null {
		const rows = Math.max(PAGE_ROWS, Math.ceil(slots / STRIP_PAGE_WIDTH));
		if (rows * 2 > this.device.limits.maxTextureDimension2D) return null;
		const stripCapacity = Math.max(PAGE_STRIPS, strips);
		if (
			stripCapacity * STRIP_INSTANCE_BYTES >
			this.device.limits.maxBufferSize
		) {
			return null;
		}
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
			slotCapacity: rows * STRIP_PAGE_WIDTH,
			stripCapacity,
			usedSlots: 0,
			usedStrips: 0,
			generation: 0,
			lastUsedFrame: this.frame,
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
				height: (page.slotCapacity / STRIP_PAGE_WIDTH) * 2,
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

function destroyPage(page: StripPage): void {
	page.destroyed = true;
	page.alpha.destroy();
	page.params?.destroy();
	page.instances.destroy();
}
