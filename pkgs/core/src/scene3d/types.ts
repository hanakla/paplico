import type {
	Lineart3DParams,
	Scene3DCamera,
	Scene3DNode,
	Vec3,
} from "../schema";
import type { IKRigData } from "./vrm/ikSolver";

/** Resolves an EmbeddedFile's bytes for figure nodes (VRM binaries). */
export type Scene3DFileResolver = (fileUid: string) => Uint8Array | null;

/**
 * The part of a camera's view to render, in the NDC of the full view (-1..1,
 * Y up). It may reach past the full view, which renders the scene around it.
 */
export interface Scene3DViewWindow {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
	/** Aspect ratio (width / height) of the full view. */
	aspect: number;
}

/** Inputs for a single scene view render. Sizes are in physical pixels. */
export interface Scene3DRenderRequest {
	sceneId: string;
	nodes: readonly Scene3DNode[];
	camera: Scene3DCamera;
	displayMode: "lineart" | "flat";
	/** Undefined falls back to the factory default lineart parameters. */
	lineart?: Lineart3DParams;
	/** Direction toward the shadow-casting key light. Undefined = default. */
	lightDir?: [number, number, number];
	width: number;
	height: number;
	/** Absent = the camera's full view, whose aspect is width / height. */
	window?: Scene3DViewWindow;
	/** Rasterization scale (texels per world px). Scales the lineart edge
	 *  kernel radius so line weight stays constant in world space. */
	rasterScale: number;
	/** Byte access for figure node files; absent = figures render empty. */
	getFileBytes?: Scene3DFileResolver;
}

/** Rendered scene view: premultiplied RGBA8, rows top-down, no row padding. */
export interface Scene3DPixels {
	width: number;
	height: number;
	data: Uint8Array;
}

/** Inputs for picking a scene node through a camera view. */
export interface Scene3DRaycastRequest {
	sceneId: string;
	nodes: readonly Scene3DNode[];
	camera: Scene3DCamera;
	/** Pick point in normalized device coordinates (-1..1, Y up). */
	ndcX: number;
	ndcY: number;
	/** Aspect ratio (width / height) of the viewing element rect. */
	aspect: number;
}

/** Axis-aligned box in scene space (meters). */
export interface Scene3DBounds {
	min: Vec3;
	max: Vec3;
}

/** Which nodes of a scene to measure. */
export interface Scene3DBoundsRequest {
	sceneId: string;
	nodes: readonly Scene3DNode[];
	/** Measure this node alone. Absent = every node of the scene. */
	nodeId?: string;
}

/**
 * Boundary interface of the lazily-loaded three.js runtime.
 *
 * Signatures must not expose three.js types — callers (renderer, tools)
 * stay off the heavy chunk and are tested against fakes of this interface.
 */
export interface Scene3DServiceApi {
	/** Render a scene view and hand back its pixels. */
	renderScene(request: Scene3DRenderRequest): Promise<Scene3DPixels>;
	/** Pick the front-most scene node under an NDC point, or null. */
	raycastNode(request: Scene3DRaycastRequest): string | null;
	/**
	 * The box around the requested nodes as they are built, or null while
	 * none of them has geometry (e.g. a figure that is still loading).
	 */
	getNodeBounds(request: Scene3DBoundsRequest): Scene3DBounds | null;
	/**
	 * Monotonic GPU-device-loss epoch. Included in texture hashes so a lost
	 * device invalidates every cached Scene3D texture.
	 */
	getContextEpoch(): number;
	/**
	 * Monotonic async-asset epoch, bumped when a VRM figure finishes loading.
	 * Included in texture hashes so pending figures re-render on arrival.
	 */
	getAssetsEpoch(): number;
	/**
	 * Normalized rest-rig of a loaded VRM figure (for pose handles / IK).
	 * Null until the figure's first render has loaded it.
	 */
	getFigureRig(fileUid: string): IKRigData | null;
	/** Drop the runtime scene instance for a scene definition. */
	disposeScene(sceneId: string): void;
	destroy(): void;
}
