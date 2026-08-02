/**
 * Renders MeshArtObject warp containers: resolves the children into warped
 * transient elements (via MeshWarpCache / warpMeshChildren) and dispatches
 * each transient through the regular element renderers under the mesh's own
 * transform index — the non-destructive Coons warp never touches child data.
 * Image transients render through the tessellated texture warp so their
 * interior bends along the cage.
 */

import {
	type AnyArtObject,
	type BoundingBox,
	type ElementTransform,
	type ImageObject,
	isIdentityTransform,
	type MeshArtObject,
	type Path,
	type TextElement,
} from "../../../schema";
import { applyTransformToPoint } from "../../../utils/geometry/geometry";
import type { MeshWarpResolution } from "../../../utils/geometry/meshWarp";
import type { PipelineType } from "../CanvasLayerTypes";
import type { MeshWarpCache } from "../caches/MeshWarpCache";

/** How much of the warp result stays visible behind the children being edited. */
const WARP_GHOST_ALPHA = 0.1;

const EMPTY_RESOLUTION: MeshWarpResolution = {
	transients: [],
	imageWarpGrids: new Map(),
	clipGroups: [],
};

interface MeshRendererDeps {
	getMeshWarpCache: () => MeshWarpCache;
	/** Render one transient through the regular per-type element renderers. */
	dispatchElement: (
		passEncoder: GPURenderPassEncoder,
		element: AnyArtObject,
		elementsMap: Map<string, AnyArtObject>,
		alpha: number,
		pipelineType: PipelineType,
	) => void;
	/** Render an image transient through the tessellated texture warp. */
	renderWarpedImage: (
		passEncoder: GPURenderPassEncoder,
		image: ImageObject,
		alpha: number,
		gridVertices: Float32Array,
	) => void;
	/** Warp-ready glyph paths for text children (null while layout is pending). */
	getTextGlyphPaths: (element: TextElement) => Path[] | null;
	/** The element's transform composed with its ancestors' (identity if none). */
	getComposedTransform: (elementId: string) => ElementTransform;
	/** Local bounds the GPU transform entry takes its origin from. */
	getLocalBounds: (elementId: string) => BoundingBox | null;
	/** The element's own GPU transform entry. */
	getTransformIndex: (elementId: string) => number;
	/** Mask bind group reserved for a transient, or null when it has none. */
	getTransientMask: (
		transientId: string,
	) => { bindGroup: GPUBindGroup; transformIndex: number } | null;
	/** Live render state: transient masking swaps these for one draw. */
	renderState: {
		currentTransformIndex: number;
		currentMaskBindGroup: GPUBindGroup;
		/** Containers the user has stepped into, outermost first. */
		editingScopeStack: string[];
	};
}

export class MeshElementRenderer {
	private readonly deps: MeshRendererDeps;

	public constructor(deps: MeshRendererDeps) {
		this.deps = deps;
	}

	public resolve(
		mesh: MeshArtObject,
		elementsMap: Map<string, AnyArtObject>,
	): MeshWarpResolution {
		if (
			mesh.childIds.length === 0 ||
			mesh.vertices.length < 4 ||
			mesh.faces.length === 0
		) {
			return EMPTY_RESOLUTION;
		}
		return this.deps.getMeshWarpCache().resolve(mesh, {
			resolve: (id) => elementsMap.get(id) ?? null,
			getTextGlyphPaths: this.deps.getTextGlyphPaths,
		});
	}

	public render(
		passEncoder: GPURenderPassEncoder,
		mesh: MeshArtObject,
		elementsMap: Map<string, AnyArtObject>,
		alphaMultiplier: number,
		pipelineType: PipelineType,
	): void {
		const { transients, imageWarpGrids } = this.resolve(mesh, elementsMap);
		const meshAlpha = alphaMultiplier * mesh.opacity;
		const { renderState } = this.deps;
		// Inside the container the children are edited where they are stored, so
		// they are drawn unwarped and the warp result stays as a faint ghost of
		// what the cage is making of them.
		const editingInside = renderState.editingScopeStack.includes(mesh.id);
		const warpAlpha = editingInside ? meshAlpha * WARP_GHOST_ALPHA : meshAlpha;
		if (transients.length === 0 && !editingInside) return;

		const meshTransformIndex = renderState.currentTransformIndex;
		const meshMaskBindGroup = renderState.currentMaskBindGroup;

		for (const transient of transients) {
			// A transient inside a clip group draws through its own slot, which
			// carries the warped clip path as its mask.
			const mask = this.deps.getTransientMask(transient.id);
			if (mask) {
				renderState.currentTransformIndex = mask.transformIndex;
				renderState.currentMaskBindGroup = mask.bindGroup;
			}

			const grid =
				transient.type === "image"
					? imageWarpGrids.get(transient.id)
					: undefined;
			if (transient.type === "image" && grid) {
				// The transient's opacity carries the child (and flattened group)
				// opacity — the warped blit has no other place to apply it.
				this.deps.renderWarpedImage(
					passEncoder,
					transient,
					warpAlpha * transient.opacity,
					this.toWorldGrid(mesh, grid),
				);
			} else {
				this.deps.dispatchElement(
					passEncoder,
					transient,
					elementsMap,
					warpAlpha,
					pipelineType,
				);
			}

			if (mask) {
				renderState.currentTransformIndex = meshTransformIndex;
				renderState.currentMaskBindGroup = meshMaskBindGroup;
			}
		}

		if (!editingInside) return;
		// The children as they are stored, on top of their own ghost: what the
		// tools select, drag and reshape while the user is in here.
		for (const childId of mesh.childIds) {
			this.renderAsStored(
				passEncoder,
				childId,
				elementsMap,
				meshAlpha,
				pipelineType,
			);
		}
		renderState.currentTransformIndex = meshTransformIndex;
	}

	/**
	 * Draw one child where its own data puts it, warp left out. Each element
	 * goes through its own GPU transform entry — the container's entry only
	 * carries the warped transients, which are baked into its space already.
	 */
	private renderAsStored(
		passEncoder: GPURenderPassEncoder,
		elementId: string,
		elementsMap: Map<string, AnyArtObject>,
		alpha: number,
		pipelineType: PipelineType,
	): void {
		const element = elementsMap.get(elementId);
		if (!element || element.visible === false) return;

		if (element.type === "group") {
			for (const childId of element.childIds) {
				this.renderAsStored(
					passEncoder,
					childId,
					elementsMap,
					alpha * element.opacity,
					pipelineType,
				);
			}
			return;
		}

		this.deps.renderState.currentTransformIndex = this.deps.getTransformIndex(
			element.id,
		);
		this.deps.dispatchElement(
			passEncoder,
			element,
			elementsMap,
			alpha,
			pipelineType,
		);
	}

	/**
	 * Bake the container's transform into a warp grid.
	 *
	 * Transients are resolved in the mesh's local space and the vector ones
	 * reach the canvas through the mesh's GPU transform entry. The warped image
	 * blit has no transform input at all (like every other blit), so without
	 * this the image would stay behind wherever the container was moved,
	 * rotated or scaled to.
	 */
	private toWorldGrid(mesh: MeshArtObject, grid: Float32Array): Float32Array {
		const transform = this.deps.getComposedTransform(mesh.id);
		if (isIdentityTransform(transform)) return grid;
		const bounds = this.deps.getLocalBounds(mesh.id);
		if (!bounds) return grid;

		const originX = (bounds.minX + bounds.maxX) / 2;
		const originY = (bounds.minY + bounds.maxY) / 2;
		// (x, y, u, v) per vertex: only the position pair is transformed.
		const out = new Float32Array(grid);
		for (let i = 0; i < out.length; i += 4) {
			const world = applyTransformToPoint(
				out[i],
				out[i + 1],
				transform,
				originX,
				originY,
			);
			out[i] = world.x;
			out[i + 1] = world.y;
		}
		return out;
	}
}
