import {
	colorToRawRGBA,
	type FreeGradient,
	type LinearGradient,
	type MeshGradient,
	type PatternFill,
	type RadialGradient,
} from "../../../schema";

interface GradientCacheEntry {
	uniformBuffer: GPUBuffer;
	stopsBuffer: GPUBuffer;
	vertexBuffer: GPUBuffer;
	vertexBufferSize: number;
	bindGroup: GPUBindGroup;
	vertexCount: number;
	fingerprint: number;
}

/**
 * Caches gradient GPU resources (uniform/stops/vertex buffers + bind group)
 * per element draw. Validated by a numeric fingerprint derived from gradient
 * parameters, bounds, and geometry hash. Cache hits skip all writeBuffer calls.
 *
 * The cached `vertexBuffer` has the draw's resolved alpha baked into its
 * vertices (appearance × element × layer opacity, folded together upstream),
 * so that alpha has to be part of the fingerprint. Leaving it out makes an
 * opacity change reuse the previous frame's vertices and never appear on
 * screen — the same trap `StrokeCache` and `StencilFillCache` each had to
 * grow a paint key for.
 */
export class GradientCache {
	private cache = new Map<string, GradientCacheEntry>();

	public get(key: string): GradientCacheEntry | undefined {
		return this.cache.get(key);
	}

	public set(key: string, entry: GradientCacheEntry): void {
		this.destroyEntry(this.cache.get(key));
		this.cache.set(key, entry);
	}

	public delete(key: string): void {
		this.destroyEntry(this.cache.get(key));
		this.cache.delete(key);
	}

	public clear(): void {
		for (const entry of this.cache.values()) this.destroyEntry(entry);
		this.cache.clear();
	}

	public deleteMany(ids: readonly string[]): void {
		for (const id of ids) this.delete(id);
	}

	public keys(): MapIterator<string> {
		return this.cache.keys();
	}

	private destroyEntry(entry: GradientCacheEntry | undefined): void {
		if (!entry) return;
		entry.uniformBuffer.destroy();
		entry.stopsBuffer.destroy();
		entry.vertexBuffer.destroy();
	}
}

const _f32 = new Float32Array(1);
const _u32 = new Uint32Array(_f32.buffer);
function floatBits(v: number): number {
	_f32[0] = v;
	return _u32[0];
}

/**
 * Compute a numeric fingerprint combining gradient parameters, bounds,
 * and geometry hash. Used to detect when any input to the gradient draw
 * has changed and GPU buffers need to be rebuilt.
 */
export function hashGradientDraw(
	fill:
		| LinearGradient
		| RadialGradient
		| FreeGradient
		| MeshGradient
		| PatternFill,
	boundsMin: [number, number],
	boundsMax: [number, number],
	geometryHash: number,
	transformIndex?: number,
	/**
	 * Per-def revision (DefIndex.getRevision). Including this in the
	 * fingerprint lets pattern caches self-invalidate when a def member
	 * is edited without DefRasterizer having to push.
	 */
	patternDefRevision?: number,
	/**
	 * Alpha the caller baked into the vertices it is about to hand over. Part
	 * of the fingerprint because the cached vertex buffer carries it; see the
	 * class doc.
	 */
	alphaMultiplier?: number,
): number {
	let h = geometryHash;
	if (transformIndex != null) {
		h = (h * 31 + transformIndex) | 0;
	}
	if (alphaMultiplier != null) {
		h = (h * 31 + floatBits(alphaMultiplier)) | 0;
	}
	h =
		(h * 31 +
			(fill.type === "linear"
				? 1
				: fill.type === "radial"
					? 2
					: fill.type === "free"
						? 3
						: fill.type === "mesh"
							? 4
							: 5)) |
		0;

	if (fill.type === "linear") {
		h = (h * 31 + floatBits(fill.x1)) | 0;
		h = (h * 31 + floatBits(fill.y1)) | 0;
		h = (h * 31 + floatBits(fill.x2)) | 0;
		h = (h * 31 + floatBits(fill.y2)) | 0;
	} else if (fill.type === "radial") {
		h = (h * 31 + floatBits(fill.cx)) | 0;
		h = (h * 31 + floatBits(fill.cy)) | 0;
		h = (h * 31 + floatBits(fill.radiusX)) | 0;
		h = (h * 31 + floatBits(fill.radiusY)) | 0;
		h = (h * 31 + floatBits(fill.rotation)) | 0;
	}

	if (fill.type === "linear" || fill.type === "radial") {
		h = (h * 31 + fill.stops.length) | 0;
		for (let i = 0; i < fill.stops.length && i < 16; i++) {
			const s = fill.stops[i];
			h = (h * 31 + floatBits(s.offset)) | 0;
			h = (h * 31 + floatBits(s.midpoint)) | 0;
			const c = colorToRawRGBA(s.color);
			h = (h * 31 + floatBits(c.r)) | 0;
			h = (h * 31 + floatBits(c.g)) | 0;
			h = (h * 31 + floatBits(c.b)) | 0;
			h = (h * 31 + floatBits(c.a)) | 0;
		}
	}

	if (fill.type === "pattern") {
		h = (h * 31 + floatBits(fill.offsetX)) | 0;
		h = (h * 31 + floatBits(fill.offsetY)) | 0;
		h = (h * 31 + floatBits(fill.scaleX)) | 0;
		h = (h * 31 + floatBits(fill.scaleY)) | 0;
		h = (h * 31 + floatBits(fill.rotation)) | 0;
		const id = fill.defId;
		if (id) {
			for (let i = 0; i < id.length; i++) {
				h = (h * 31 + id.charCodeAt(i)) | 0;
			}
		}
		if (patternDefRevision != null) {
			h = (h * 31 + (patternDefRevision | 0)) | 0;
		}
	}

	h = (h * 31 + floatBits(boundsMin[0])) | 0;
	h = (h * 31 + floatBits(boundsMin[1])) | 0;
	h = (h * 31 + floatBits(boundsMax[0])) | 0;
	h = (h * 31 + floatBits(boundsMax[1])) | 0;

	return h;
}
