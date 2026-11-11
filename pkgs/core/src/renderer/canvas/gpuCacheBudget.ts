/** Total cache budget when the host passes none. It splits into each cache's
 *  standalone default. */
export const DEFAULT_GPU_CACHE_BUDGET_BYTES = 1600 * 1024 * 1024;

/**
 * Split one canvas's GPU cache budget among the caches that hold results or
 * idle allocations across frames. Textures a frame is still drawing with
 * count against none of these shares.
 */
export function splitGpuCacheBudget(totalBytes: number) {
	const share = (ratio: number) => Math.floor(totalBytes * ratio);
	return {
		/** Floor of the idle offscreen textures kept for reuse. */
		texturePool: share(0.24),
		mixStrokeResults: share(0.24),
		washResults: share(0.24),
		filteredElements: share(0.16),
		residentDabs: share(0.08),
		stripPages: share(0.04),
	};
}

/**
 * Bytes the filtered-element cache may hold: its own share, or whatever of
 * the whole budget the other caches leave while they hold `otherCachesBytes`,
 * whichever is larger. A filtered bake is the costliest result to rebuild
 * when a pan brings it back, so the room the others leave goes to it.
 */
export function filteredElementBudgetBytes(
	totalBytes: number,
	otherCachesBytes: number,
): number {
	return Math.max(
		splitGpuCacheBudget(totalBytes).filteredElements,
		totalBytes - otherCachesBytes,
	);
}
