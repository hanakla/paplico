import { describe, expect, it } from "vitest";
import { getScene3DServiceSync, loadScene3DService } from "./index";

describe("loadScene3DService", () => {
	it("should load the runtime lazily and expose a single shared instance", async () => {
		// Before the first load, the sync accessor has nothing to hand out.
		expect(getScene3DServiceSync()).toBeNull();

		const service = await loadScene3DService();

		// Repeated loads resolve to the same instance (promise is memoized).
		expect(await loadScene3DService()).toBe(service);
		expect(getScene3DServiceSync()).toBe(service);

		// The freshly loaded service starts at epoch 0 and its non-GL entry
		// points are safe to call without a WebGL context (happy-dom has none).
		expect(service.getContextEpoch()).toBe(0);
		service.disposeScene("unknown-scene");
		service.destroy();
	});
});
