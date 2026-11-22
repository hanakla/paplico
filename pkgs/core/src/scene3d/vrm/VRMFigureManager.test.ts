import type { VRM } from "@pixiv/three-vrm";
import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { VRMFigureManager } from "./VRMFigureManager";

const BYTES = new Uint8Array([1, 2, 3]);

describe("VRMFigureManager (per-figure-node instances)", () => {
	it("should parse a separate instance per figure node even for the same fileUid", async () => {
		const { manager, parser } = createManager();

		manager.requestLoad("node-a", "vrm-1", BYTES);
		manager.requestLoad("node-b", "vrm-1", BYTES);
		await flush();

		// No official three-vrm clone — the parse runs once per node.
		expect(parser).toHaveBeenCalledTimes(2);
		const a = manager.getLoaded("node-a");
		const b = manager.getLoaded("node-b");
		expect(a).not.toBeNull();
		expect(b).not.toBeNull();
		expect(a).not.toBe(b);
		expect(a!.scene).not.toBe(b!.scene);
	});

	it("should keep the other figure alive when one node is disposed", async () => {
		const { manager } = createManager();
		manager.requestLoad("node-a", "vrm-1", BYTES);
		manager.requestLoad("node-b", "vrm-1", BYTES);
		await flush();
		const surviving = manager.getLoaded("node-b");

		manager.disposeNode("node-a");

		expect(manager.getLoaded("node-a")).toBeNull();
		expect(manager.getLoaded("node-b")).toBe(surviving);
	});

	it("should not re-parse for the same fileUid, but re-parse when it changes", async () => {
		const { manager, parser } = createManager();
		manager.requestLoad("node-a", "vrm-1", BYTES);
		await flush();
		const first = manager.getLoaded("node-a");

		manager.requestLoad("node-a", "vrm-1", BYTES);
		expect(parser).toHaveBeenCalledTimes(1);
		expect(manager.getLoaded("node-a")).toBe(first);

		manager.requestLoad("node-a", "vrm-2", BYTES);
		await flush();
		expect(parser).toHaveBeenCalledTimes(2);
		const second = manager.getLoaded("node-a");
		expect(second).not.toBeNull();
		expect(second).not.toBe(first);
	});

	it("should prune only the scene's departed nodes via retainForScene", async () => {
		const { manager } = createManager();
		manager.requestLoad("node-a", "vrm-1", BYTES);
		manager.requestLoad("node-b", "vrm-1", BYTES);
		await flush();

		manager.retainForScene("scene-1", new Set(["node-a", "node-b"]));
		// Another scene's bookkeeping must not free scene-1 instances.
		manager.retainForScene("scene-2", new Set<string>());
		expect(manager.getLoaded("node-a")).not.toBeNull();

		manager.retainForScene("scene-1", new Set(["node-b"]));
		expect(manager.getLoaded("node-a")).toBeNull();
		expect(manager.getLoaded("node-b")).not.toBeNull();
	});

	it("should discard a parse that completes after its node was removed", async () => {
		const resolvers: Array<(vrm: VRM) => void> = [];
		const parser = vi.fn(
			() => new Promise<VRM | null>((resolve) => resolvers.push(resolve)),
		);
		const manager = new VRMFigureManager({ parser });

		manager.requestLoad("node-a", "vrm-1", BYTES);
		manager.disposeNode("node-a");
		resolvers[0]!(makeFakeVrm());
		await flush();

		expect(manager.getLoaded("node-a")).toBeNull();
	});

	it("should notify onFigureLoaded per parsed figure", async () => {
		const { manager, onFigureLoaded } = createManager();
		manager.requestLoad("node-a", "vrm-1", BYTES);
		manager.requestLoad("node-b", "vrm-1", BYTES);
		await flush();

		expect(onFigureLoaded).toHaveBeenCalledTimes(2);
	});
});

// Helpers

function makeFakeVrm(): VRM {
	return {
		scene: new THREE.Group(),
		humanoid: {
			getNormalizedBoneNode: () => null,
		},
	} as unknown as VRM;
}

function createManager() {
	const parser = vi.fn(async () => makeFakeVrm());
	const onFigureLoaded = vi.fn();
	const manager = new VRMFigureManager({ parser, onFigureLoaded });
	return { manager, parser, onFigureLoaded };
}

async function flush(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}
