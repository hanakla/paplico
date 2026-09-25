import type { Reference3DServiceApi } from "./types";

export type {
	Reference3DRaycastRequest,
	Reference3DRenderRequest,
	Reference3DServiceApi,
} from "./types";

let servicePromise: Promise<Reference3DServiceApi> | null = null;
let serviceInstance: Reference3DServiceApi | null = null;

/**
 * Load the three.js-backed Reference3D runtime. This is the single dynamic
 * import point of the 3D subsystem — every module importing three.js lives
 * in the lazy chunk behind it, keeping three out of the core bundle.
 */
export function loadReference3DService(): Promise<Reference3DServiceApi> {
	servicePromise ??= import("./Reference3DService").then((mod) => {
		serviceInstance = new mod.Reference3DService();
		return serviceInstance;
	});
	return servicePromise;
}

/**
 * Synchronous accessor for render paths. Returns null until
 * loadReference3DService() has resolved at least once.
 */
export function getReference3DServiceSync(): Reference3DServiceApi | null {
	return serviceInstance;
}
