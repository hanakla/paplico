import { afterAll, describe, expect, it, vi } from "vitest";
import { RenderOrchestrator } from "../renderer/RenderOrchestrator";
import { createTestRenderer } from "./visualRegression";

describe("createTestRenderer", () => {
	let renderer: RenderOrchestrator;
	const destroy = vi.spyOn(RenderOrchestrator.prototype, "destroy");
	afterAll(() => destroy.mockRestore());

	it("should keep the renderer alive for the current test", async () => {
		({ renderer } = await createTestRenderer());

		expect(renderer.getDevice()).not.toBeNull();
		expect(destroy).not.toHaveBeenCalled();
	});

	it("should destroy renderers after the test that created them", () => {
		expect(destroy).toHaveBeenCalledTimes(1);
		expect(renderer.getDevice()).toBeNull();
	});
});
