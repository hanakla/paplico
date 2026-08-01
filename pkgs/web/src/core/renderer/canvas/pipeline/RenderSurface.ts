import type { BoundingBox } from "../../../schema";
import type { BlitQuad, BlitUVRect } from "../CanvasLayerTypes";

export type TextureRef = FrameTextureRef | BorrowedTextureRef;

export type RenderSurfaceRole =
	| "color"
	| "destination-snapshot"
	| "parent-backdrop"
	| "coverage";

export type RenderSurfaceAlpha = "premultiplied" | "straight" | "scalar";

export type RenderSurfaceOpacity = "intrinsic" | "placement-baked";

declare const placementOpacityBrand: unique symbol;

export type PlacementOpacity = number & {
	readonly [placementOpacityBrand]: "PlacementOpacity";
};

export interface FrameTextureRef {
	kind: "frame-owned";
	texture: GPUTexture;
	release: () => void;
}

export interface BorrowedTextureRef {
	kind: "borrowed";
	texture: GPUTexture;
	owner: "appearance-cache" | "mask-atlas" | "external";
}

export type SurfacePlacement =
	| {
			kind: "world-aabb";
			bounds: BoundingBox;
			uvRect: BlitUVRect;
	  }
	| {
			kind: "world-quad";
			bounds: BoundingBox;
			quad: BlitQuad;
			uvRect: BlitUVRect;
	  };

export interface RenderSurface<
	Role extends RenderSurfaceRole = RenderSurfaceRole,
	Alpha extends RenderSurfaceAlpha = RenderSurfaceAlpha,
	Opacity extends RenderSurfaceOpacity = RenderSurfaceOpacity,
> {
	texture: TextureRef;
	placement: SurfacePlacement;
	readonly role: Role;
	readonly alphaMode: Alpha;
	readonly opacityState: Opacity;
}

export type ColorRenderSurface = RenderSurface<
	"color",
	"premultiplied",
	"intrinsic"
>;

export type RasterizedRenderSurface = ColorRenderSurface & {
	readonly effectiveZoom: number;
};

export function createRenderSurface<
	const Role extends RenderSurfaceRole,
	const Alpha extends RenderSurfaceAlpha,
	const Opacity extends RenderSurfaceOpacity,
>(
	texture: TextureRef,
	placement: SurfacePlacement,
	metadata: {
		role: Role;
		alphaMode: Alpha;
		opacityState: Opacity;
	},
): RenderSurface<Role, Alpha, Opacity> {
	return { texture, placement, ...metadata };
}

export function createPlacementOpacity(value: number): PlacementOpacity {
	if (!Number.isFinite(value) || value < 0 || value > 1) {
		throw new RangeError(
			"Placement opacity must be finite and between 0 and 1",
		);
	}
	return value as PlacementOpacity;
}

export function combinePlacementOpacity(
	...opacities: readonly PlacementOpacity[]
): PlacementOpacity {
	return createPlacementOpacity(
		opacities.reduce((combined, opacity) => combined * opacity, 1),
	);
}

export function createFrameTextureRef(
	texture: GPUTexture,
	releaseTexture: (texture: GPUTexture) => void,
): FrameTextureRef {
	let released = false;
	return {
		kind: "frame-owned",
		texture,
		release: () => {
			if (released) return;
			released = true;
			releaseTexture(texture);
		},
	};
}

export function createBorrowedTextureRef(
	texture: GPUTexture,
	owner: BorrowedTextureRef["owner"],
): BorrowedTextureRef {
	return { kind: "borrowed", texture, owner };
}

export function releaseRenderSurface(surface: RenderSurface): void {
	if (surface.texture.kind === "frame-owned") {
		surface.texture.release();
	}
}

export function replaceRenderSurface<
	const Role extends RenderSurfaceRole,
	const Alpha extends RenderSurfaceAlpha,
	const Opacity extends RenderSurfaceOpacity,
>(
	current: RenderSurface<Role, Alpha, Opacity>,
	replacement: Pick<RenderSurface, "texture" | "placement">,
): RenderSurface<Role, Alpha, Opacity> {
	if (current.texture.texture !== replacement.texture.texture) {
		releaseRenderSurface(current);
	}
	return {
		...replacement,
		role: current.role,
		alphaMode: current.alphaMode,
		opacityState: current.opacityState,
	};
}
