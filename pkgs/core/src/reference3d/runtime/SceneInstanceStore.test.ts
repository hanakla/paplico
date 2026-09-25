import { describe, expect, it } from "vitest";
import type { Reference3DNode } from "../../schema";
import {
	SceneInstanceStore,
	type SceneRuntimeAdapter,
} from "./SceneInstanceStore";

interface FakeScene {
	children: Set<FakeObject>;
	disposed: boolean;
}

interface FakeObject {
	nodeId: string;
	buildIndex: number;
	disposed: boolean;
}

/**
 * three.js-free adapter double. Tracks build/dispose counts so the tests can
 * assert which nodes were rebuilt by a sync.
 */
function createFakeAdapter() {
	let buildCount = 0;
	const builds: string[] = [];

	const adapter: SceneRuntimeAdapter<FakeScene, FakeObject> = {
		createScene: () => ({ children: new Set(), disposed: false }),
		buildNode: (node: Reference3DNode) => {
			// Stand-in for an async/hidden node that builds to nothing (e.g. a
			// figure still loading): primitive marked params.hidden === 1.
			if (node.kind === "primitive" && node.params?.hidden === 1) return null;
			builds.push(node.id);
			return { nodeId: node.id, buildIndex: buildCount++, disposed: false };
		},
		addToScene: (scene, object) => {
			scene.children.add(object);
		},
		removeFromScene: (scene, object) => {
			scene.children.delete(object);
		},
		disposeNodeObject: (object) => {
			object.disposed = true;
		},
		disposeScene: (scene) => {
			scene.disposed = true;
		},
	};

	return { adapter, builds };
}

function primitiveNode(id: string, x: number): Reference3DNode {
	return {
		id,
		kind: "primitive",
		shape: "box",
		transform: {
			position: [x, 0.5, 0],
			rotation: [0, 0, 0, 1],
			scale: [1, 1, 1],
		},
	};
}

describe("SceneInstanceStore", () => {
	it("should build and add objects for every node on first sync", () => {
		const { adapter, builds } = createFakeAdapter();
		const store = new SceneInstanceStore(adapter);

		const scene = store.sync("scene-1", [
			primitiveNode("a", 0),
			primitiveNode("b", 1),
		]);

		expect(builds).toEqual(["a", "b"]);
		expect(scene.children.size).toBe(2);
	});

	it("should reuse the same scene instance across syncs of one sceneId", () => {
		const { adapter } = createFakeAdapter();
		const store = new SceneInstanceStore(adapter);

		const first = store.sync("scene-1", [primitiveNode("a", 0)]);
		const second = store.sync("scene-1", [primitiveNode("a", 0)]);

		expect(second).toBe(first);
	});

	it("should not rebuild unchanged nodes on re-sync", () => {
		const { adapter, builds } = createFakeAdapter();
		const store = new SceneInstanceStore(adapter);
		const nodes = [primitiveNode("a", 0), primitiveNode("b", 1)];

		store.sync("scene-1", nodes);
		store.sync(
			"scene-1",
			nodes.map((n) => ({ ...n })),
		);

		expect(builds).toEqual(["a", "b"]);
	});

	it("should rebuild only the changed node, disposing its old object", () => {
		const { adapter, builds } = createFakeAdapter();
		const store = new SceneInstanceStore(adapter);

		const scene = store.sync("scene-1", [
			primitiveNode("a", 0),
			primitiveNode("b", 1),
		]);
		const oldObjects = [...scene.children];

		store.sync("scene-1", [primitiveNode("a", 0), primitiveNode("b", 5)]);

		expect(builds).toEqual(["a", "b", "b"]);
		const oldB = oldObjects.find((o) => o.nodeId === "b")!;
		expect(oldB.disposed).toBe(true);
		expect(scene.children.size).toBe(2);
		expect([...scene.children].some((o) => o === oldB)).toBe(false);
	});

	it("should remove and dispose objects for deleted nodes", () => {
		const { adapter } = createFakeAdapter();
		const store = new SceneInstanceStore(adapter);

		const scene = store.sync("scene-1", [
			primitiveNode("a", 0),
			primitiveNode("b", 1),
		]);
		const oldB = [...scene.children].find((o) => o.nodeId === "b")!;

		store.sync("scene-1", [primitiveNode("a", 0)]);

		expect(scene.children.size).toBe(1);
		expect(oldB.disposed).toBe(true);

		// A deleted node that comes back must be rebuilt from scratch.
		store.sync("scene-1", [primitiveNode("a", 0), primitiveNode("b", 1)]);
		expect(scene.children.size).toBe(2);
	});

	it("should track null-built nodes and build them once they become visible", () => {
		const { adapter, builds } = createFakeAdapter();
		const store = new SceneInstanceStore(adapter);
		const hidden: Reference3DNode = {
			id: "hidden",
			kind: "primitive",
			shape: "box",
			transform: {
				position: [0, 0.5, 0],
				rotation: [0, 0, 0, 1],
				scale: [1, 1, 1],
			},
			params: { hidden: 1 },
		};

		const scene = store.sync("scene-1", [hidden]);
		expect(scene.children.size).toBe(0);

		// Unchanged hidden node: no build attempt on re-sync.
		store.sync("scene-1", [hidden]);
		expect(builds).toEqual([]);

		store.sync("scene-1", [{ ...hidden, params: { hidden: 0 } }]);
		expect(builds).toEqual(["hidden"]);
		expect(scene.children.size).toBe(1);
	});

	it("should rebuild a figure node when only its pose changes", () => {
		const { adapter, builds } = createFakeAdapter();
		const store = new SceneInstanceStore(adapter);
		const figure: Reference3DNode = {
			id: "fig",
			kind: "figure",
			fileUid: "vrm-1",
			transform: {
				position: [0, 0, 0],
				rotation: [0, 0, 0, 1],
				scale: [1, 1, 1],
			},
			pose: { bones: {} },
		};

		const scene = store.sync("scene-1", [figure]);
		store.sync("scene-1", [{ ...figure }]);
		expect(builds).toEqual(["fig"]);

		const posed: Reference3DNode = {
			...figure,
			pose: { bones: { leftUpperArm: [0, 0, 0.383, 0.924] } },
		};
		store.sync("scene-1", [posed]);

		expect(builds).toEqual(["fig", "fig"]);
		expect(scene.children.size).toBe(1);
	});

	it("should dispose all objects and the scene on dispose(sceneId)", () => {
		const { adapter } = createFakeAdapter();
		const store = new SceneInstanceStore(adapter);

		const scene = store.sync("scene-1", [primitiveNode("a", 0)]);
		const object = [...scene.children][0]!;

		store.dispose("scene-1");

		expect(object.disposed).toBe(true);
		expect(scene.disposed).toBe(true);

		// A later sync starts a fresh instance.
		const fresh = store.sync("scene-1", [primitiveNode("a", 0)]);
		expect(fresh).not.toBe(scene);
	});

	it("should dispose every instance on disposeAll()", () => {
		const { adapter } = createFakeAdapter();
		const store = new SceneInstanceStore(adapter);

		const sceneA = store.sync("scene-a", [primitiveNode("a", 0)]);
		const sceneB = store.sync("scene-b", [primitiveNode("b", 0)]);

		store.disposeAll();

		expect(sceneA.disposed).toBe(true);
		expect(sceneB.disposed).toBe(true);
	});
});
