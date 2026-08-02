import {
	type VRM,
	VRMHumanBoneName,
	VRMLoaderPlugin,
	VRMUtils,
} from "@pixiv/three-vrm";
import type * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { Vec3 } from "../../schema";
import type { IKRigBone, IKRigData } from "./ikSolver";

/** Parses VRM bytes into a model. Injectable for loader-free unit tests. */
export type VrmParser = (bytes: Uint8Array) => Promise<VRM | null>;

interface FigureEntry {
	fileUid: string;
	vrm: VRM | null;
	promise: Promise<VRM | null>;
}

/**
 * Figure-node-keyed VRM instances for the Reference3D runtime (lazy three chunk).
 *
 * Every figure node gets its own parsed VRM — three-vrm has no
 * official clone, and multiple nodes sharing one fileUid must coexist in the
 * scene, so the parse runs per node (figure counts are small by design).
 * Bytes/hash dedup stays at the EmbeddedFile layer.
 *
 * Loading is asynchronous; `getLoaded` serves the render path synchronously
 * and `requestLoad` kicks a parse. A changed fileUid on the same node
 * disposes the old instance and re-parses. On completion `onFigureLoaded`
 * lets the service bump its assets epoch so cached textures regenerate.
 * Node deletions are pruned via `retainForScene` after each scene sync.
 */
export class VRMFigureManager {
	private readonly entries = new Map<string, FigureEntry>();
	/** Normalized rest rigs shared per file (model-shaped, not per instance). */
	private readonly rigsByFile = new Map<string, IKRigData>();
	/** Figure node ids seen in each scene's last sync (for pruning). */
	private readonly nodesByScene = new Map<string, Set<string>>();
	private readonly parser: VrmParser;

	public constructor(
		private readonly options: {
			onFigureLoaded?: () => void;
			parser?: VrmParser;
		} = {},
	) {
		this.parser = options.parser ?? parseVrm;
	}

	/** Synchronously return the node's loaded VRM, or null while loading. */
	public getLoaded(nodeId: string): VRM | null {
		return this.entries.get(nodeId)?.vrm ?? null;
	}

	/** Normalized rest rig of a loaded figure file (null until loaded). */
	public getRig(fileUid: string): IKRigData | null {
		return this.rigsByFile.get(fileUid) ?? null;
	}

	/**
	 * Kick an async parse for the node unless it already has (or is loading)
	 * an instance of the same file. A different fileUid re-parses.
	 */
	public requestLoad(
		nodeId: string,
		fileUid: string,
		bytes: Uint8Array | null,
	): void {
		const existing = this.entries.get(nodeId);
		if (existing) {
			if (existing.fileUid === fileUid) return;
			this.disposeNode(nodeId);
		}
		if (!bytes) return;

		const entry: FigureEntry = {
			fileUid,
			vrm: null,
			promise: this.parser(bytes)
				.then((vrm) => {
					// The node may have been deleted (or re-pointed) while
					// parsing — dispose the orphan instead of leaking it.
					if (this.entries.get(nodeId) !== entry) {
						if (vrm) VRMUtils.deepDispose(vrm.scene);
						return null;
					}
					entry.vrm = vrm;
					if (vrm) {
						if (!this.rigsByFile.has(fileUid)) {
							this.rigsByFile.set(fileUid, buildNormalizedRig(vrm));
						}
						this.options.onFigureLoaded?.();
					}
					return vrm;
				})
				.catch((error) => {
					console.error("Failed to load VRM figure:", error);
					return null;
				}),
		};
		this.entries.set(nodeId, entry);
	}

	/**
	 * Prune instances whose figure nodes disappeared from the scene since the
	 * previous sync. Call after every SceneInstanceStore.sync (node ids are
	 * globally unique, so per-scene bookkeeping cannot cross-free).
	 */
	public retainForScene(
		sceneId: string,
		liveNodeIds: ReadonlySet<string>,
	): void {
		const previous = this.nodesByScene.get(sceneId);
		if (previous) {
			for (const nodeId of previous) {
				if (!liveNodeIds.has(nodeId)) this.disposeNode(nodeId);
			}
		}
		this.nodesByScene.set(sceneId, new Set(liveNodeIds));
	}

	/** Dispose the single node's VRM instance (others stay untouched). */
	public disposeNode(nodeId: string): void {
		const entry = this.entries.get(nodeId);
		if (!entry) return;
		if (entry.vrm) VRMUtils.deepDispose(entry.vrm.scene);
		this.entries.delete(nodeId);
	}

	/** Dispose every instance tracked for the scene. */
	public disposeScene(sceneId: string): void {
		const nodeIds = this.nodesByScene.get(sceneId);
		if (!nodeIds) return;
		for (const nodeId of nodeIds) this.disposeNode(nodeId);
		this.nodesByScene.delete(sceneId);
	}

	public disposeAll(): void {
		for (const nodeId of [...this.entries.keys()]) {
			this.disposeNode(nodeId);
		}
		this.nodesByScene.clear();
		this.rigsByFile.clear();
	}
}

// Helpers

async function parseVrm(bytes: Uint8Array): Promise<VRM | null> {
	const loader = new GLTFLoader();
	loader.register((parser) => new VRMLoaderPlugin(parser));

	// Detached copy: parse() transfers/reads the buffer and Yjs must not see
	// any mutation of the stored bytes.
	const buffer = bytes.slice().buffer as ArrayBuffer;
	const gltf = await loader.parseAsync(buffer, "");
	const vrm = (gltf.userData.vrm as VRM | undefined) ?? null;
	if (!vrm) return null;

	// Lighten the model for atari use.
	VRMUtils.removeUnnecessaryVertices(gltf.scene);
	VRMUtils.combineSkeletons(gltf.scene);
	return vrm;
}

/**
 * Extract the normalized (T-pose, world-aligned) rest rig as plain data for
 * the three-free IK solver and pose handles.
 */
function buildNormalizedRig(vrm: VRM): IKRigData {
	const nodeToName = new Map<THREE.Object3D, string>();
	for (const name of Object.values(VRMHumanBoneName)) {
		const node = vrm.humanoid.getNormalizedBoneNode(name);
		if (node) nodeToName.set(node, name);
	}

	const bones: IKRigBone[] = [];
	for (const [node, name] of nodeToName) {
		// Parent = nearest ancestor that is itself a human bone; rest position
		// accumulates intermediate non-humanoid nodes in between.
		const rest: Vec3 = [node.position.x, node.position.y, node.position.z];
		let ancestor = node.parent;
		let parentName: string | null = null;
		while (ancestor) {
			const ancestorName = nodeToName.get(ancestor);
			if (ancestorName) {
				parentName = ancestorName;
				break;
			}
			rest[0] += ancestor.position.x;
			rest[1] += ancestor.position.y;
			rest[2] += ancestor.position.z;
			ancestor = ancestor.parent;
		}
		bones.push({ name, parent: parentName, restPosition: rest });
	}
	return { bones };
}
