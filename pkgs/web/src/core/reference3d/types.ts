import type {
	Lineart3DParams,
	Reference3DCamera,
	Reference3DNode,
} from "../schema";
import type { IKRigData } from "./vrm/ikSolver";

/** Resolves an EmbeddedFile's bytes for figure nodes (VRM binaries). */
export type Reference3DFileResolver = (fileUid: string) => Uint8Array | null;

/** Inputs for a single scene view render. Sizes are in physical pixels. */
export interface Reference3DRenderRequest {
	sceneId: string;
	nodes: readonly Reference3DNode[];
	camera: Reference3DCamera;
	displayMode: "lineart" | "flat";
	/** Undefined falls back to the factory default lineart parameters. */
	lineart?: Lineart3DParams;
	/** Direction toward the shadow-casting key light. Undefined = default. */
	lightDir?: [number, number, number];
	width: number;
	height: number;
	/** Rasterization scale (texels per world px). Scales the lineart edge
	 *  kernel radius so line weight stays constant in world space. */
	rasterScale: number;
	/** Byte access for figure node files; absent = figures render empty. */
	getFileBytes?: Reference3DFileResolver;
}

/** Inputs for picking a scene node through a camera view. */
export interface Reference3DRaycastRequest {
	sceneId: string;
	nodes: readonly Reference3DNode[];
	camera: Reference3DCamera;
	/** Pick point in normalized device coordinates (-1..1, Y up). */
	ndcX: number;
	ndcY: number;
	/** Aspect ratio (width / height) of the viewing element rect. */
	aspect: number;
}

/**
 * Boundary interface of the lazily-loaded three.js runtime.
 *
 * Signatures must not expose three.js types — callers (renderer, tools)
 * stay off the heavy chunk and are tested against fakes of this interface.
 */
export interface Reference3DServiceApi {
	/**
	 * Render a scene view and hand back the pixels. The returned bitmap is
	 * owned by the caller (close() it after upload).
	 */
	renderScene(request: Reference3DRenderRequest): Promise<ImageBitmap>;
	/** Pick the front-most scene node under an NDC point, or null. */
	raycastNode(request: Reference3DRaycastRequest): string | null;
	/**
	 * Monotonic GL-context-loss epoch. Included in texture hashes so a lost /
	 * restored WebGL context invalidates every cached Reference3D texture.
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
