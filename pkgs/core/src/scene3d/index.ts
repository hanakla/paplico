import type { Scene3DServiceApi } from "./types";

export type {
	Scene3DBounds,
	Scene3DBoundsRequest,
	Scene3DRaycastRequest,
	Scene3DRenderRequest,
	Scene3DServiceApi,
} from "./types";

let servicePromise: Promise<Scene3DServiceApi> | null = null;
let serviceInstance: Scene3DServiceApi | null = null;

/**
 * Load the three.js-backed Scene3D runtime. This is the single dynamic
 * import point of the 3D subsystem — every module importing three.js lives
 * in the lazy chunk behind it, keeping three out of the core bundle.
 */
export function loadScene3DService(): Promise<Scene3DServiceApi> {
	servicePromise ??= import("./Scene3DService").then((mod) => {
		serviceInstance = new mod.Scene3DService();
		return serviceInstance;
	});
	return servicePromise;
}

/**
 * Synchronous accessor for render paths. Returns null until
 * loadScene3DService() has resolved at least once.
 */
export function getScene3DServiceSync(): Scene3DServiceApi | null {
	return serviceInstance;
}
