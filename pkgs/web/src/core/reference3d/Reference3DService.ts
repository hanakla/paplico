import * as THREE from "three/webgpu";
import { createDefaultLineart3DParams } from "../document/factory";
import type { Reference3DCamera, Reference3DNode } from "../schema";
import { LineartPipeline } from "./lineart/LineartPipeline";
import { GLBMeshCache } from "./runtime/GLBMeshCache";
import {
	applyTransform3D,
	buildPrimitiveObject,
	buildShadowRig,
	DEFAULT_SHADOW_LIGHT_DIR,
	disposeObject3D,
	SHADOW_CATCHER_LAYER,
	type ShadowRig,
	setShadowLightDir,
} from "./runtime/primitives";
import {
	SceneInstanceStore,
	type SceneRuntimeAdapter,
} from "./runtime/SceneInstanceStore";
import type {
	Reference3DFileResolver,
	Reference3DRaycastRequest,
	Reference3DRenderRequest,
	Reference3DScenePixels,
	Reference3DServiceApi,
} from "./types";
import type { IKRigData } from "./vrm/ikSolver";
import { toThreeVrmPose } from "./vrm/pose";
import { VRMFigureManager } from "./vrm/VRMFigureManager";

interface Reference3DServiceOptions {
	/** GPU device to render with. Absent: three.js requests its own. */
	device?: GPUDevice;
}

// Clip planes framed for room-scale scenes (1 unit = 1 m).
const CAMERA_NEAR = 0.05;
const CAMERA_FAR = 200;

/**
 * three.js runtime behind the Reference3DServiceApi boundary. Owns a single
 * WebGPURenderer that draws every request into an offscreen render target
 * and reads the pixels back — no canvas is ever involved, which keeps the
 * runtime usable outside a browser (Node tests) and off the per-page context
 * limits.
 */
export class Reference3DService implements Reference3DServiceApi {
	private rendererPromise: Promise<THREE.WebGPURenderer> | null = null;
	private contextEpoch = 0;
	private assetsEpoch = 0;
	private lineartPipeline: LineartPipeline | null = null;
	private flatTarget: THREE.RenderTarget | null = null;
	private flatLight: THREE.HemisphereLight | null = null;
	private shadowRig: ShadowRig | null = null;
	private readonly vrmManager = new VRMFigureManager({
		onFigureLoaded: () => {
			// A figure arrived after its scene was already built/rendered:
			// bump the asset epoch (invalidates cached textures via hash) and
			// drop scene instances so the next sync rebuilds with the figure.
			this.assetsEpoch++;
			this.sceneStore.disposeAll();
		},
	});
	private readonly glbCache = new GLBMeshCache({
		onLoaded: () => {
			// Same flow as VRM figures: the async asset landed after its scene
			// was built — invalidate cached textures and rebuild instances.
			this.assetsEpoch++;
			this.sceneStore.disposeAll();
		},
	});
	private readonly adapter = new ThreeSceneAdapter(
		this.vrmManager,
		this.glbCache,
	);
	private readonly sceneStore = new SceneInstanceStore<
		THREE.Scene,
		THREE.Object3D
	>(this.adapter);

	public constructor(
		private readonly options: Reference3DServiceOptions = {},
	) {}

	public async renderScene(
		request: Reference3DRenderRequest,
	): Promise<Reference3DScenePixels> {
		const renderer = await this.ensureRenderer();

		this.adapter.setFileResolver(request.getFileBytes ?? null);
		const scene = this.sceneStore.sync(request.sceneId, request.nodes);
		this.pruneFigures(request.sceneId, request.nodes);
		const camera = createCamera(request.camera, request.width / request.height);

		// Ground shadows without a floor node: an invisible catcher plane on
		// its own layer plus a shadow-casting key light steered by the request.
		this.shadowRig ??= buildShadowRig();
		setShadowLightDir(
			this.shadowRig.light,
			request.lightDir ?? DEFAULT_SHADOW_LIGHT_DIR,
		);
		scene.add(this.shadowRig.group);

		let target: THREE.RenderTarget;
		try {
			if (request.displayMode === "lineart") {
				this.lineartPipeline ??= new LineartPipeline();
				target = this.lineartPipeline.render(renderer, scene, camera, {
					width: request.width,
					height: request.height,
					rasterScale: request.rasterScale,
					params: request.lineart ?? createDefaultLineart3DParams(),
					cameraNear: CAMERA_NEAR,
					cameraFar: CAMERA_FAR,
				});
			} else {
				// Flat preview: Lambert materials + a hardcoded hemisphere light
				// (light editing is out of scope for the atari use case). The
				// camera additionally renders the shadow catcher's layer.
				this.flatLight ??= new THREE.HemisphereLight(0xffffff, 0x665f55, 3);
				scene.add(this.flatLight);
				camera.layers.enable(SHADOW_CATCHER_LAYER);
				target = this.ensureFlatTarget(request.width, request.height);
				renderer.setRenderTarget(target);
				renderer.render(scene, camera);
				camera.layers.disable(SHADOW_CATCHER_LAYER);
				scene.remove(this.flatLight);
			}
		} finally {
			scene.remove(this.shadowRig.group);
		}

		const padded = (await renderer.readRenderTargetPixelsAsync(
			target,
			0,
			0,
			request.width,
			request.height,
		)) as Uint8Array;
		return {
			width: request.width,
			height: request.height,
			data: unpackRows(padded, request.width, request.height),
		};
	}

	public raycastNode(request: Reference3DRaycastRequest): string | null {
		const scene = this.sceneStore.sync(request.sceneId, request.nodes);
		this.pruneFigures(request.sceneId, request.nodes);
		const camera = createCamera(request.camera, request.aspect);

		const raycaster = new THREE.Raycaster();
		raycaster.setFromCamera(
			new THREE.Vector2(request.ndcX, request.ndcY),
			camera,
		);

		for (const hit of raycaster.intersectObjects(scene.children, true)) {
			// Walk up to the node root tagged by ThreeSceneAdapter.buildNode.
			let object: THREE.Object3D | null = hit.object;
			while (object) {
				const nodeId = object.userData.sceneNodeId;
				if (typeof nodeId === "string") return nodeId;
				object = object.parent;
			}
		}
		return null;
	}

	public getContextEpoch(): number {
		return this.contextEpoch;
	}

	public getAssetsEpoch(): number {
		return this.assetsEpoch;
	}

	public getFigureRig(fileUid: string): IKRigData | null {
		return this.vrmManager.getRig(fileUid);
	}

	public disposeScene(sceneId: string): void {
		this.sceneStore.dispose(sceneId);
		this.vrmManager.disposeScene(sceneId);
	}

	public destroy(): void {
		this.sceneStore.disposeAll();
		this.vrmManager.disposeAll();
		this.glbCache.disposeAll();
		this.lineartPipeline?.dispose();
		this.lineartPipeline = null;
		this.flatTarget?.dispose();
		this.flatTarget = null;
		if (this.shadowRig) {
			disposeObject3D(this.shadowRig.group);
			this.shadowRig = null;
		}
		void this.rendererPromise?.then((renderer) => renderer.dispose());
		this.rendererPromise = null;
	}

	/** Free VRM instances for figure nodes removed from the scene. */
	private pruneFigures(
		sceneId: string,
		nodes: readonly Reference3DNode[],
	): void {
		const liveIds = new Set<string>();
		for (const node of nodes) {
			if (node.kind === "figure") liveIds.add(node.id);
		}
		this.vrmManager.retainForScene(sceneId, liveIds);
	}

	private ensureRenderer(): Promise<THREE.WebGPURenderer> {
		this.rendererPromise ??= this.createRenderer();
		return this.rendererPromise;
	}

	private async createRenderer(): Promise<THREE.WebGPURenderer> {
		const renderer = new THREE.WebGPURenderer({
			device: this.options.device,
			// Fixed byte output type keeps the renderer off navigator.gpu's
			// preferred canvas format query (there is no canvas).
			outputType: THREE.UnsignedByteType,
		});
		renderer.onDeviceLost = () => {
			// Renders issued on the lost device produced blank output under the
			// old epoch; the next request builds a fresh renderer and re-renders.
			this.contextEpoch++;
			this.rendererPromise = null;
			renderer.dispose();
		};
		renderer.setPixelRatio(1);
		renderer.setClearColor(0x000000, 0);
		renderer.shadowMap.enabled = true;
		renderer.shadowMap.type = THREE.PCFSoftShadowMap;
		await renderer.init();
		return renderer;
	}

	private ensureFlatTarget(width: number, height: number): THREE.RenderTarget {
		if (this.flatTarget?.width === width && this.flatTarget.height === height) {
			return this.flatTarget;
		}
		this.flatTarget?.dispose();
		// sRGB target: the hardware applies the display transfer on write, the
		// same as the canvas output of a screen-space render.
		this.flatTarget = new THREE.RenderTarget(width, height, {
			samples: 4,
			colorSpace: THREE.SRGBColorSpace,
		});
		return this.flatTarget;
	}
}

// Helpers

/** Readback rows are padded to 256 bytes; repack them tightly. */
function unpackRows(
	padded: Uint8Array,
	width: number,
	height: number,
): Uint8Array {
	const rowBytes = width * 4;
	const paddedRowBytes = Math.ceil(rowBytes / 256) * 256;
	if (paddedRowBytes === rowBytes) return padded;
	const data = new Uint8Array(rowBytes * height);
	for (let y = 0; y < height; y++) {
		const src = y * paddedRowBytes;
		data.set(padded.subarray(src, src + rowBytes), y * rowBytes);
	}
	return data;
}

class ThreeSceneAdapter
	implements SceneRuntimeAdapter<THREE.Scene, THREE.Object3D>
{
	private fileResolver: Reference3DFileResolver | null = null;

	public constructor(
		private readonly vrmManager: VRMFigureManager,
		private readonly glbCache: GLBMeshCache,
	) {}

	/** Byte access for figure files, taken from the current render request. */
	public setFileResolver(resolver: Reference3DFileResolver | null): void {
		this.fileResolver = resolver;
	}

	public createScene(): THREE.Scene {
		return new THREE.Scene();
	}

	public buildNode(node: Reference3DNode): THREE.Object3D | null {
		const object = this.buildNodeObject(node);
		if (object) object.userData.sceneNodeId = node.id;
		return object;
	}

	public addToScene(scene: THREE.Scene, object: THREE.Object3D): void {
		scene.add(object);
	}

	public removeFromScene(scene: THREE.Scene, object: THREE.Object3D): void {
		scene.remove(object);
	}

	public disposeNodeObject(object: THREE.Object3D): void {
		// Figure containers only borrow the cached VRM scene — detach it so
		// the shared model's GPU resources survive node rebuilds.
		const vrmScene = object.userData.vrmScene as THREE.Object3D | undefined;
		if (vrmScene) {
			object.remove(vrmScene);
			return;
		}
		// GLB clones share geometry/materials with the parse cache — the
		// shared resources are freed in GLBMeshCache.disposeAll instead.
		if (object.userData.glbInstance) return;
		disposeObject3D(object);
	}

	public disposeScene(scene: THREE.Scene): void {
		scene.clear();
	}

	private buildNodeObject(node: Reference3DNode): THREE.Object3D | null {
		switch (node.kind) {
			case "primitive":
				return buildPrimitiveObject(node);
			case "figure":
				return this.buildFigureObject(node);
			case "mesh":
				return this.buildMeshObject(node);
		}
	}

	private buildMeshObject(
		node: Extract<Reference3DNode, { kind: "mesh" }>,
	): THREE.Object3D | null {
		this.glbCache.requestLoad(
			node.fileUid,
			this.fileResolver?.(node.fileUid) ?? null,
		);
		const instance = this.glbCache.getInstance(node.fileUid);
		// Still parsing (or failed): nothing to place. onLoaded rebuilds the
		// scene once the model arrives.
		if (!instance) return null;

		const container = new THREE.Group();
		applyTransform3D(container, node.transform);
		container.add(instance);
		container.userData.glbInstance = true;
		return container;
	}

	private buildFigureObject(
		node: Extract<Reference3DNode, { kind: "figure" }>,
	): THREE.Object3D | null {
		// Per-node instances: the same fileUid parses once per figure
		// node so multiple figures sharing a model coexist in the scene.
		this.vrmManager.requestLoad(
			node.id,
			node.fileUid,
			this.fileResolver?.(node.fileUid) ?? null,
		);
		const vrm = this.vrmManager.getLoaded(node.id);
		// Still loading (or failed): nothing to place. onFigureLoaded will
		// rebuild the scene once the model arrives.
		if (!vrm) return null;

		// Figures ground themselves via the shadow rig (idempotent on the
		// shared scene across node rebuilds).
		vrm.scene.traverse((child) => {
			if ((child as THREE.Mesh).isMesh) child.castShadow = true;
		});

		const container = new THREE.Group();
		applyTransform3D(container, node.transform);

		vrm.humanoid.resetNormalizedPose();
		vrm.humanoid.setNormalizedPose(toThreeVrmPose(node.pose));
		vrm.humanoid.update();

		container.add(vrm.scene);
		container.userData.vrmScene = vrm.scene;
		return container;
	}
}

function createCamera(view: Reference3DCamera, aspect: number): THREE.Camera {
	const camera =
		view.projection === "orthographic"
			? createOrthographicCamera(view, aspect)
			: new THREE.PerspectiveCamera(
					view.fovDeg,
					aspect,
					CAMERA_NEAR,
					CAMERA_FAR,
				);
	camera.position.set(...view.position);
	if (view.up) camera.up.set(...view.up);
	camera.lookAt(new THREE.Vector3(...view.target));
	camera.updateMatrixWorld();
	return camera;
}

function createOrthographicCamera(
	view: Reference3DCamera,
	aspect: number,
): THREE.OrthographicCamera {
	const height = view.orthoHeight ?? 2;
	const width = height * aspect;
	return new THREE.OrthographicCamera(
		-width / 2,
		width / 2,
		height / 2,
		-height / 2,
		CAMERA_NEAR,
		CAMERA_FAR,
	);
}
