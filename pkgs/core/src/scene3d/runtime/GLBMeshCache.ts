import type * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { disposeObject3D } from "./primitives";

/**
 * Parse-once cache for static GLB meshes keyed by fileUid. Mesh nodes get a
 * clone of the cached scene (geometries/materials stay shared), so one file
 * can appear multiple times in a scene. Parsing is async — `onLoaded` fires
 * when a model lands so the service can invalidate textures and rebuild
 * scene instances, mirroring the VRM figure flow.
 */
export class GLBMeshCache {
	private readonly loaded = new Map<string, THREE.Group>();
	private readonly pending = new Set<string>();
	private readonly failed = new Set<string>();

	public constructor(private readonly options: { onLoaded: () => void }) {}

	/**
	 * Cloned, shadow-casting instance of the parsed model, or null while the
	 * file is still parsing (or failed to parse).
	 */
	public getInstance(fileUid: string): THREE.Object3D | null {
		const scene = this.loaded.get(fileUid);
		if (!scene) return null;
		const instance = scene.clone(true);
		instance.traverse((child) => {
			if ((child as THREE.Mesh).isMesh) child.castShadow = true;
		});
		return instance;
	}

	public requestLoad(fileUid: string, bytes: Uint8Array | null): void {
		if (
			!bytes ||
			this.loaded.has(fileUid) ||
			this.pending.has(fileUid) ||
			this.failed.has(fileUid)
		) {
			return;
		}
		this.pending.add(fileUid);

		// Detached copy: parse() reads the buffer and Yjs must not see any
		// mutation of the stored bytes (same rule as the VRM loader).
		const buffer = bytes.slice().buffer as ArrayBuffer;
		new GLTFLoader().parse(
			buffer,
			"",
			(gltf) => {
				this.pending.delete(fileUid);
				this.loaded.set(fileUid, gltf.scene);
				this.options.onLoaded();
			},
			(error) => {
				this.pending.delete(fileUid);
				this.failed.add(fileUid);
				console.error(`Failed to parse GLB mesh: ${fileUid}`, error);
			},
		);
	}

	public disposeAll(): void {
		for (const scene of this.loaded.values()) disposeObject3D(scene);
		this.loaded.clear();
		this.pending.clear();
		this.failed.clear();
	}
}
