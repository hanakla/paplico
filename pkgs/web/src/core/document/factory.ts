import {
	type Artboard,
	type BrushSettings,
	type BrushStroking,
	BUILTIN_BRUSH_IDS,
	type Document,
	type ElementTransform,
	type EmbeddedFile,
	generateUid,
	type HSVColor,
	IDENTITY_TRANSFORM,
	type ImageObject,
	type Layer,
	type Lineart3DParams,
	type MeshArtObject,
	type Reference3DCamera,
	type Reference3DElement,
	type RepeatObject,
	type Viewport,
} from "../schema";
import { createWarpCageFromRect } from "../utils/geometry/meshWarp";

export async function createEmbeddedImageFile(
	file: File,
): Promise<EmbeddedFile> {
	const arrayBuffer = await file.arrayBuffer();
	const bin = new Uint8Array(arrayBuffer);
	return createEmbeddedFileFromBytes(bin, file.name, file.type || "image/png");
}

/** Create an EmbeddedFile from raw bytes, computing the SHA-256 hash. */
export async function createEmbeddedFileFromBytes(
	bin: Uint8Array<ArrayBuffer>,
	name: string,
	type: string,
): Promise<EmbeddedFile> {
	const hashBuffer = await crypto.subtle.digest("SHA-256", bin);
	const hash = Array.from(new Uint8Array(hashBuffer))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");

	return {
		uid: generateUid("file"),
		name,
		type,
		hash,
		bin,
	};
}

/** Create the application default color (black, fully opaque, HSVA). */
export function createDefaultColor(): HSVColor {
	return { type: "hsv", h: 0, s: 0, v: 0, a: 1 };
}

export function createIdentityTransform(): ElementTransform {
	return { ...IDENTITY_TRANSFORM };
}

export function createDefaultViewport(): Viewport {
	return {
		x: 0,
		y: 0,
		zoom: 1.0,
		rotation: 0,
	};
}

export function createDefaultTransform(): ElementTransform {
	return {
		x: 0,
		y: 0,
		rotation: 0,
		scaleX: 1,
		scaleY: 1,
		skewX: 0,
		skewY: 0,
	};
}

/**
 * Create a Repeat element wrapping the given source element IDs. All three
 * arrangement modes are initialized so switching mode keeps each mode's
 * settings; `grid` is the default active mode.
 */
export function createRepeatObject(
	sourceIds: string[],
	overrides?: Partial<Pick<RepeatObject, "mode" | "transform" | "name">>,
): RepeatObject {
	return {
		id: generateUid("repeat"),
		type: "repeat",
		name: overrides?.name,
		sourceIds,
		mode: overrides?.mode ?? "grid",
		grid: {
			width: 240,
			height: 240,
			spacingX: 120,
			spacingY: 120,
			offsetX: 0,
			offsetY: 0,
		},
		radial: {
			count: 6,
			radius: 160,
			startAngle: 0,
			sweep: Math.PI * 2,
			rotateInstances: true,
		},
		mirror: { axisAngle: Math.PI / 2, offset: 80 },
		opacity: 1,
		blendMode: "normal",
		transform: overrides?.transform ?? createIdentityTransform(),
	};
}

/**
 * Create a mesh warp container wrapping the given child element IDs. The
 * initial cage is one quad covering `cageRect` with every vertex at rest
 * (src == position, implicit straight edges), so the warp starts as identity.
 */
export function createMeshWarpObject(
	childIds: string[],
	cageRect: { minX: number; minY: number; maxX: number; maxY: number },
): MeshArtObject {
	const { vertices, faces } = createWarpCageFromRect(cageRect);
	return {
		id: generateUid("mesh"),
		type: "mesh",
		childIds,
		vertices,
		faces,
		opacity: 1,
		blendMode: "normal",
		transform: createIdentityTransform(),
	};
}

export function createDefaultLayer(id: string, name: string): Layer {
	return {
		id,
		name,
		visible: true,
		locked: false,
		opacity: 1.0,
		elementIds: [],
	};
}

export function createDefaultDocument(id: string): Document {
	return {
		id,
		objects: {},
		layers: [createDefaultLayer("layer-0", "Layer 1")],
		viewport: createDefaultViewport(),
		files: [],
		artboards: [],
		brushPresets: [],
		appearancePresets: [],
		defs: {},
		units: "px",
	};
}

/**
 * Create a new artboard with the given parameters.
 * @param x - Center X position in world coordinates
 * @param y - Center Y position in world coordinates
 * @param width - Width in world units
 * @param height - Height in world units
 */
export function createArtboard(
	id: string,
	name: string,
	x: number,
	y: number,
	width: number,
	height: number,
): Artboard {
	return { id, name, x, y, width, height };
}

export function createImageObject(
	params: {
		fileUid: string;
		x: number;
		y: number;
		width: number;
		height: number;
	} & Partial<
		Omit<
			ImageObject,
			"type" | "id" | "fileUid" | "x" | "y" | "width" | "height"
		>
	>,
): ImageObject {
	return {
		id: generateUid("image"),
		type: "image",
		opacity: 1,
		blendMode: "normal",
		transform: {
			x: 0,
			y: 0,
			rotation: 0,
			scaleX: 1,
			scaleY: 1,
			skewX: 0,
			skewY: 0,
		},
		...params,
	};
}

export function createReference3DElement(
	params: {
		sceneId: string;
		x: number;
		y: number;
		width: number;
		height: number;
	} & Partial<
		Omit<
			Reference3DElement,
			"type" | "id" | "sceneId" | "x" | "y" | "width" | "height"
		>
	>,
): Reference3DElement {
	return {
		id: generateUid("reference3d"),
		type: "reference3d",
		opacity: 1,
		blendMode: "normal",
		transform: createIdentityTransform(),
		camera: createDefaultReference3DCamera(),
		displayMode: "lineart",
		lineart: createDefaultLineart3DParams(),
		...params,
	};
}

/** Visually tuned starting values for the lineart edge-detection pass. */
export function createDefaultLineart3DParams(): Lineart3DParams {
	return {
		lineWidthPx: 1.5,
		depthEdgeThreshold: 0.02,
		normalEdgeThreshold: 0.4,
		creaseAngleDeg: 40,
		color: { type: "rgb", r: 0, g: 0, b: 0, a: 1 },
	};
}

/**
 * Create default brush settings.
 */
export function createDefaultBrushSettings(): BrushSettings {
	return {
		version: 2,
		engine: "dab",
		strokeOpacity: 1,
		paintMode: "buildup",
		properties: {
			size: {
				base: 10,
				curves: [{ input: "pressure", points: [[1, 0.5]] }],
			},
			flow: { base: 1 },
			alphaRate: {
				base: 1,
				curves: [{ input: "pressure", points: [[1, 0.3]] }],
			},
			spacing: { base: 0.15 },
		},
		tip: {
			kind: "image",
			sources: [{ kind: "file", fileUid: BUILTIN_BRUSH_IDS.softCircle }],
			selection: "random",
			angleMode: "fixed",
		},
		randomSeed: (Math.random() * 0xffff_ffff) >>> 0,
	};
}

/**
 * Create SVG brush settings (geometric stroke with lineCap/lineJoin).
 */
export function createStrokeBrushSettings(
	width: number,
	stroking?: BrushStroking,
): BrushSettings {
	return {
		version: 2,
		engine: "geometric",
		strokeOpacity: 1,
		paintMode: "buildup",
		properties: { size: { base: width }, flow: { base: 1 } },
		stroking,
		randomSeed: (Math.random() * 0xffff_ffff) >>> 0,
	};
}

// Helpers

/** Oblique overhead view framed for human-scale scenes (1 unit = 1 m). */
function createDefaultReference3DCamera(): Reference3DCamera {
	return {
		projection: "perspective",
		position: [4, 3, 6],
		target: [0, 1, 0],
		fovDeg: 50,
	};
}
