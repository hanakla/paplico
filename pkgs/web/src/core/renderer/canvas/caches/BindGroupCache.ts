/**
 * Pool-indexed bind group cache keyed by a single GPUTexture identity.
 * Reuses immutable GPUBindGroup objects when the same texture appears
 * at the same pool slot across frames.
 */
export class BlitBindGroupCache {
	private slots: Array<{
		texture: GPUTexture;
		bindGroup: GPUBindGroup;
	} | null> = [];

	public getOrCreate(
		index: number,
		texture: GPUTexture,
		create: () => GPUBindGroup,
	): GPUBindGroup {
		const slot = this.slots[index];
		if (slot?.texture === texture) return slot.bindGroup;
		const bindGroup = create();
		this.slots[index] = { texture, bindGroup };
		return bindGroup;
	}
}

/**
 * Pool-indexed bind group cache keyed by two GPUTexture identities
 * (e.g. source + destination, or source + mask).
 */
export class MaskedBlitBindGroupCache {
	private slots: Array<{
		source: GPUTexture;
		secondary: GPUTexture;
		bindGroup: GPUBindGroup;
	} | null> = [];

	public getOrCreate(
		index: number,
		source: GPUTexture,
		secondary: GPUTexture,
		create: () => GPUBindGroup,
	): GPUBindGroup {
		const slot = this.slots[index];
		if (slot?.source === source && slot?.secondary === secondary) {
			return slot.bindGroup;
		}
		const bindGroup = create();
		this.slots[index] = { source, secondary, bindGroup };
		return bindGroup;
	}
}

/**
 * Pool-indexed bind group cache keyed by three GPUTexture identities
 * (source + dest + base).  Used by CompositeRenderer for the composite
 * pipeline which includes a canvas-base texture for offscreen layer
 * blend mode correction.
 */
export class TripleTextureBindGroupCache {
	private slots: Array<{
		t0: GPUTexture;
		t1: GPUTexture;
		t2: GPUTexture;
		bindGroup: GPUBindGroup;
	} | null> = [];

	public getOrCreate(
		index: number,
		t0: GPUTexture,
		t1: GPUTexture,
		t2: GPUTexture,
		create: () => GPUBindGroup,
	): GPUBindGroup {
		const slot = this.slots[index];
		if (slot?.t0 === t0 && slot?.t1 === t1 && slot?.t2 === t2) {
			return slot.bindGroup;
		}
		const bindGroup = create();
		this.slots[index] = { t0, t1, t2, bindGroup };
		return bindGroup;
	}
}
