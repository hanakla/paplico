import type { Reference3DNode } from "../../schema";

/**
 * Runtime bridge used by SceneInstanceStore to materialize scene nodes.
 * The diff-sync logic itself stays three.js-free behind this interface, so
 * it is unit-testable with a fake adapter (happy-dom has no WebGL).
 */
export interface SceneRuntimeAdapter<TScene, TObject> {
	createScene(): TScene;
	/** Build the runtime object for a node. Null = no visual (e.g. hidden floor). */
	buildNode(node: Reference3DNode): TObject | null;
	addToScene(scene: TScene, object: TObject): void;
	removeFromScene(scene: TScene, object: TObject): void;
	disposeNodeObject(object: TObject): void;
	disposeScene(scene: TScene): void;
}

interface SceneInstance<TScene, TObject> {
	scene: TScene;
	/** Last applied serialized form per node id — the diff baseline. */
	appliedJson: Map<string, string>;
	objects: Map<string, TObject>;
}

/**
 * Holds one runtime scene per Reference3DDef and applies node-list changes
 * incrementally: each node's JSON.stringify is compared against the last
 * applied form; only changed nodes are rebuilt and removed ids disposed.
 * Node counts are at most a few dozen, so a full scan per sync is fine.
 */
export class SceneInstanceStore<TScene, TObject> {
	private readonly instances = new Map<
		string,
		SceneInstance<TScene, TObject>
	>();

	public constructor(
		private readonly adapter: SceneRuntimeAdapter<TScene, TObject>,
	) {}

	/** Sync the node list into the scene instance, returning the scene. */
	public sync(sceneId: string, nodes: readonly Reference3DNode[]): TScene {
		let instance = this.instances.get(sceneId);
		if (!instance) {
			instance = {
				scene: this.adapter.createScene(),
				appliedJson: new Map(),
				objects: new Map(),
			};
			this.instances.set(sceneId, instance);
		}

		const seen = new Set<string>();
		for (const node of nodes) {
			seen.add(node.id);
			const json = JSON.stringify(node);
			if (instance.appliedJson.get(node.id) === json) continue;

			this.removeNodeObject(instance, node.id);
			const built = this.adapter.buildNode(node);
			if (built) {
				this.adapter.addToScene(instance.scene, built);
				instance.objects.set(node.id, built);
			}
			instance.appliedJson.set(node.id, json);
		}

		for (const nodeId of [...instance.appliedJson.keys()]) {
			if (seen.has(nodeId)) continue;
			this.removeNodeObject(instance, nodeId);
			instance.appliedJson.delete(nodeId);
		}

		return instance.scene;
	}

	/** Dispose the runtime instance for a scene definition. */
	public dispose(sceneId: string): void {
		const instance = this.instances.get(sceneId);
		if (!instance) return;
		for (const object of instance.objects.values()) {
			this.adapter.removeFromScene(instance.scene, object);
			this.adapter.disposeNodeObject(object);
		}
		this.adapter.disposeScene(instance.scene);
		this.instances.delete(sceneId);
	}

	public disposeAll(): void {
		for (const sceneId of [...this.instances.keys()]) {
			this.dispose(sceneId);
		}
	}

	private removeNodeObject(
		instance: SceneInstance<TScene, TObject>,
		nodeId: string,
	): void {
		const object = instance.objects.get(nodeId);
		if (!object) return;
		this.adapter.removeFromScene(instance.scene, object);
		this.adapter.disposeNodeObject(object);
		instance.objects.delete(nodeId);
	}
}
