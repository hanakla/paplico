import { resolveImageGeometry } from "../../../document/elementGeometry/imageGeometry";
import {
	type AnyArtObject,
	type CubicBezierSegment,
	type EmbeddedFile,
	type ImageObject,
	isIdentityTransform,
} from "../../../schema";
import {
	getStartAnchor,
	splitIntoSubPaths,
} from "../../../utils/geometry/primitives/segment";
import {
	applyTransformToPoint,
	composeAncestorTransform,
	transformBounds,
} from "../../../utils/geometry/space/coordinates";
import type {
	BlitMeshToCanvasFn,
	BlitQuadToCanvasFn,
	BlitTextureToCanvasFn,
} from "../CanvasLayerTypes";
import type { FilterRenderer } from "../pipeline/FilterRenderer";
import type { ImageTextures } from "../pipeline/ImageTextureStore";

interface ImageRendererDeps {
	strokePipeline: GPURenderPipeline;
	dummyGradientBindGroup: GPUBindGroup;
	getMaskBindGroup: () => GPUBindGroup;
	images: ImageTextures;
	blitTextureToCanvas: BlitTextureToCanvasFn;
	blitQuadToCanvas: BlitQuadToCanvasFn;
	blitMeshToCanvas: BlitMeshToCanvasFn;
	filterRenderer: FilterRenderer;
	getBindGroup: () => GPUBindGroup;
	getTransformsBindGroup: () => GPUBindGroup | null;
	getParentGroupMap: () => ReadonlyMap<string, string>;
}

export class ImageElementRenderer {
	public constructor(private readonly deps: ImageRendererDeps) {}

	public renderImage(
		passEncoder: GPURenderPassEncoder,
		image: ImageObject,
		files: EmbeddedFile[],
		elementsMap: Map<string, AnyArtObject>,
		alphaMultiplier: number = 1.0,
	): void {
		// Find the file
		const file = files.find((f) => f.uid === image.fileUid);
		if (!file) {
			console.warn(`Image file not found: ${image.fileUid}`);
			return;
		}

		// Get texture from cache (sync only - async load triggers re-render)
		const texture = this.deps.images.get(file);
		if (!texture) {
			// Start async load, will render on next frame
			this.deps.images.ensure(file);
			return;
		}

		const { localBounds, quad, deformed } = resolveImageGeometry(
			image,
			this.deps.filterRenderer,
		);
		const t = composeAncestorTransform(
			image,
			elementsMap,
			this.deps.getParentGroupMap(),
		);

		// Warped corner vertices need the perspective quad blit even when no
		// geometry filter deformed the quad further.
		if (image.corners !== undefined || deformed !== quad) {
			const quads = extractQuads(deformed);
			if (quads) {
				for (const localCorners of quads) {
					const worldCorners: QuadCorners = isIdentityTransform(t)
						? localCorners
						: (localCorners.map((c) =>
								applyTransformToPoint(c.x, c.y, t),
							) as unknown as QuadCorners);
					this.deps.blitQuadToCanvas(
						passEncoder,
						texture,
						worldCorners,
						alphaMultiplier,
					);
				}

				this.restoreStrokePipeline(passEncoder);
				return;
			}
			// Corner extraction failed: fall through to standard AABB blit.
		}

		const bounds = isIdentityTransform(t)
			? localBounds
			: transformBounds(localBounds, t);

		// Blit texture to canvas at the image position
		this.deps.blitTextureToCanvas(
			passEncoder,
			texture,
			bounds,
			alphaMultiplier,
		);

		this.restoreStrokePipeline(passEncoder);
	}

	/**
	 * Render a mesh-warped image transient: the caller supplies pre-warped
	 * (x, y, u, v) triangle-list vertices, so the texture bends along the warp
	 * cage instead of stretching between 4 corners. `alphaMultiplier` must
	 * already include the transient's own opacity.
	 */
	public renderImageWarped(
		passEncoder: GPURenderPassEncoder,
		image: ImageObject,
		files: EmbeddedFile[],
		alphaMultiplier: number,
		gridVertices: Float32Array,
	): void {
		const file = files.find((f) => f.uid === image.fileUid);
		if (!file) {
			console.warn(`Image file not found: ${image.fileUid}`);
			return;
		}

		const texture = this.deps.images.get(file);
		if (!texture) {
			// Start async load, will render on next frame
			this.deps.images.ensure(file);
			return;
		}

		this.deps.blitMeshToCanvas(
			passEncoder,
			texture,
			gridVertices,
			alphaMultiplier,
		);

		this.restoreStrokePipeline(passEncoder);
	}

	/** Re-arm the stroke pipeline state a blit pass clobbered. */
	private restoreStrokePipeline(passEncoder: GPURenderPassEncoder): void {
		passEncoder.setPipeline(this.deps.strokePipeline);
		passEncoder.setBindGroup(0, this.deps.getBindGroup());
		passEncoder.setBindGroup(1, this.deps.getTransformsBindGroup()!);
		passEncoder.setBindGroup(2, this.deps.dummyGradientBindGroup);
		passEncoder.setBindGroup(3, this.deps.getMaskBindGroup());
	}
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

type QuadCorners = readonly [
	{ x: number; y: number },
	{ x: number; y: number },
	{ x: number; y: number },
	{ x: number; y: number },
];

/**
 * Extract the deformed quads from pre-filter output. Each input side is an
 * isMoved sub-path, so the output splits into groups of 4 sub-paths — one
 * group per copy a filter placed — whose first segments carry the deformed
 * corners as `start`. Returns null if the split produced an unexpected shape
 * (e.g. a filter collapsed a sub-path).
 */
function extractQuads(segments: CubicBezierSegment[]): QuadCorners[] | null {
	const subPaths = splitIntoSubPaths(segments);
	if (subPaths.length === 0 || subPaths.length % 4 !== 0) return null;

	const corners: { x: number; y: number }[] = [];
	for (const sp of subPaths) {
		if (sp.length === 0) return null;
		const anchor = getStartAnchor(sp[0], undefined);
		corners.push({ x: anchor.x, y: anchor.y });
	}

	return Array.from(
		{ length: corners.length / 4 },
		(_, i) =>
			[
				corners[i * 4],
				corners[i * 4 + 1],
				corners[i * 4 + 2],
				corners[i * 4 + 3],
			] as const,
	);
}
