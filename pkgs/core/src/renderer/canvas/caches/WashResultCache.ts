import { localAppearances } from "../../../document/appearancePresets";
import { PREVIEW_ELEMENT_SENTINEL_ID } from "../../../document/constants";
import type { WorldBBox } from "../../../utils/geometry/bounds";
import { hashSegmentsWithMetadata } from "../../../utils/geometry/segmentOps";
import type { BlitUVRect, FilteredTextureInfo } from "../CanvasLayerTypes";
import { IdleClock, type UseStamp } from "../pipeline/IdleClock";
import type { ElementFilterPlan } from "../pipeline/RenderPlanner";
import {
	createBorrowedTextureRef,
	createRenderSurface,
} from "../pipeline/RenderSurface";

// Sized with the texture pool: fixed-R accumulators run a few MB per stroke
// and an undersized budget thrashes (one eviction + rerun per frame, observed
// at 10% zoom on a stroke-heavy document).
const MAX_BYTES = 384 * 1024 * 1024;

interface WashResultCacheResources {
	/** Returns an evicted result's texture to the pool at the frame boundary. */
	releaseTexture(texture: GPUTexture): void;
	/** Destroys a held result's texture immediately, between frames. */
	discardTexture(texture: GPUTexture): void;
}

export interface WashResult {
	key: string;
	texture: GPUTexture;
	placement: { bounds: WorldBBox; uvRect: BlitUVRect };
	elementBounds: WorldBBox;
	textureBounds: WorldBBox;
	bytes: number;
}

/**
 * Isolated wash results reused across frames (fixed content key). Each entry
 * holds a texture leased from the texture pool until it is evicted. Frame
 * resource release never sees these textures: callers get borrowed references.
 */
export class WashResultCache {
	private readonly entries = new Map<
		string,
		WashResult & { lastUsed: UseStamp }
	>();
	private totalBytes = 0;
	/** Document-frame clock for idle eviction. */
	private readonly clock = new IdleClock();
	/** Filters-array -> JSON fingerprint (documents update immutably). */
	private readonly filtersFingerprints = new WeakMap<object, string>();
	/** Element -> content key (elements update immutably; the key also embeds
	 *  scale/bounds, revalidated cheaply by string comparison). */
	private readonly keys = new WeakMap<object, string>();

	public constructor(private readonly resources: WashResultCacheResources) {}

	/** Content key of a cacheable wash plan, or null when not cacheable
	 *  (non-wash plans, previews, non-path elements). */
	public keyFor(fp: ElementFilterPlan, rasterScale: number): string | null {
		const element = fp.element;
		if (element.id === PREVIEW_ELEMENT_SENTINEL_ID) return null;
		if (element.type !== "path") return null;
		if (!fp.allAppearancePlans?.some((p) => p.washStrokeOpacity != null)) {
			return null;
		}
		const cached = this.keys.get(element);
		if (cached != null) return cached;
		const filters = localAppearances(element.filters);
		let filtersFp = this.filtersFingerprints.get(filters);
		if (filtersFp == null) {
			filtersFp = JSON.stringify(filters);
			this.filtersFingerprints.set(filters, filtersFp);
		}
		const key = [
			hashSegmentsWithMetadata(element.segments).toString(36),
			filtersFp,
			element.opacity,
			JSON.stringify(element.transform),
			rasterScale,
			fp.textureBounds.minX,
			fp.textureBounds.minY,
			fp.textureBounds.maxX,
			fp.textureBounds.maxY,
		].join(":");
		this.keys.set(element, key);
		return key;
	}

	public get(elementId: string, key: string): FilteredTextureInfo | null {
		const hit = this.entries.get(elementId);
		if (!hit || hit.key !== key) return null;
		this.entries.delete(elementId);
		this.entries.set(elementId, hit);
		hit.lastUsed = this.clock.stamp();
		return toTextureInfo(hit);
	}

	public store(elementId: string, result: WashResult): FilteredTextureInfo {
		const previous = this.entries.get(elementId);
		if (previous) this.retire(elementId, previous);
		this.entries.set(elementId, { ...result, lastUsed: this.clock.stamp() });
		this.totalBytes += result.bytes;
		this.evictOverBudget();
		return toTextureInfo(result);
	}

	/** Advances the clock for a document frame and evicts expired results. */
	public beginDocumentFrame(): void {
		this.clock.tick();
		const now = performance.now();
		for (const [id, entry] of this.entries) {
			if (!this.clock.isExpired(entry.lastUsed, now)) break;
			this.retire(id, entry);
		}
	}

	public prune(liveIds: Readonly<Record<string, unknown>>): void {
		for (const [id, entry] of this.entries) {
			if (!(id in liveIds)) this.retire(id, entry);
		}
	}

	/** Frees results that sat out the last `minIdleFrames` document frames;
	 *  0 frees all. Call between frames only. */
	public trimIdle(minIdleFrames: number): void {
		for (const [id, entry] of this.entries) {
			if (!this.clock.isIdleFor(entry.lastUsed, minIdleFrames)) continue;
			this.discard(id, entry);
		}
	}

	public destroy(): void {
		for (const [id, entry] of this.entries) this.discard(id, entry);
	}

	private evictOverBudget(): void {
		while (this.totalBytes > MAX_BYTES) {
			const oldest = this.entries.entries().next().value;
			if (!oldest) break;
			this.retire(oldest[0], oldest[1]);
		}
	}

	private retire(id: string, entry: WashResult): void {
		this.totalBytes -= entry.bytes;
		this.entries.delete(id);
		this.resources.releaseTexture(entry.texture);
	}

	private discard(id: string, entry: WashResult): void {
		this.totalBytes -= entry.bytes;
		this.entries.delete(id);
		this.resources.discardTexture(entry.texture);
	}
}

function toTextureInfo(result: WashResult): FilteredTextureInfo {
	const surface = createRenderSurface(
		createBorrowedTextureRef(result.texture, "external"),
		{
			kind: "world-aabb",
			bounds: result.placement.bounds,
			uvRect: result.placement.uvRect,
		},
		{
			role: "color",
			alphaMode: "premultiplied",
			opacityState: "intrinsic",
		},
	);
	return {
		source: surface,
		output: surface,
		elementBounds: result.elementBounds,
		textureBounds: result.textureBounds,
	};
}
