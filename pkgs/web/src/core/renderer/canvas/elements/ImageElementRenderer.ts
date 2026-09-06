import { localAppearances } from "../../../document/appearancePresets";
import {
	type AnyArtObject,
	type CubicBezierSegment,
	type EmbeddedFile,
	getTransform,
	type ImageObject,
	isIdentityTransform,
	type Vec2,
} from "../../../schema";
import {
	applyTransformToBounds,
	applyTransformToPoint,
	composeTransforms,
} from "../../../utils/geometry/geometry";
import { getStartAnchor } from "../../../utils/geometry/segmentOps";
import { splitIntoSubPaths } from "../CanvasLayer.helpers";
import type {
	AssetState,
	BlitMeshToCanvasFn,
	BlitQuadToCanvasFn,
	BlitTextureToCanvasFn,
} from "../CanvasLayerTypes";
import type { FilterRenderer } from "../pipeline/FilterRenderer";
import { applyPreFilters } from "../pipeline/PreFilterRenderer";

interface ImageRendererDeps {
	device: GPUDevice;
	strokePipeline: GPURenderPipeline;
	dummyGradientBindGroup: GPUBindGroup;
	getMaskBindGroup: () => GPUBindGroup;
	assetState: AssetState;
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
		const texture = this.deps.assetState.imageTextureCache.get(file.uid);
		if (!texture) {
			// Start async load, will render on next frame
			this.ensureImageTexture(file);
			return;
		}

		// Calculate image bounds in world space, applying element transform
		const halfWidth = image.width / 2;
		const halfHeight = image.height / 2;
		const localBounds = {
			minX: image.x - halfWidth,
			minY: image.y - halfHeight,
			maxX: image.x + halfWidth,
			maxY: image.y + halfHeight,
			width: image.width,
			height: image.height,
		};
		const selfT = getTransform(image);

		// Compose ancestor group transforms using the cached parentGroupMap
		// (avoids O(N) parentMap rebuild that resolveAncestorTransform does).
		let ancestorT = selfT;
		const parentGroupMap = this.deps.getParentGroupMap();
		let pid = parentGroupMap.get(image.id);
		while (pid) {
			const ancestor = elementsMap.get(pid);
			if (ancestor) {
				ancestorT = composeTransforms(getTransform(ancestor), ancestorT);
			}
			pid = parentGroupMap.get(pid);
		}
		const t = ancestorT;

		// Attempt preProcess filter path (e.g. 3D rotate). The image rectangle is
		// treated as a 4-sided closed sub-path so geometry filters can deform
		// its corners. applyPreFilters returns the input by reference when no
		// enabled preProcess filter applies, so reference equality is the cheapest
		// way to detect the common no-op case.
		const quadSegments = buildImageQuadSegments(localBounds, image.corners);
		const deformed = applyPreFilters(
			quadSegments,
			localAppearances(image.filters),
			this.deps.filterRenderer,
		);

		// Warped corner vertices need the perspective quad blit even when no
		// geometry filter deformed the quad further.
		if (
			image.corners !== undefined ||
			(deformed !== quadSegments &&
				!hasSameSegmentGeometry(deformed, quadSegments))
		) {
			const localCorners = extractQuadCorners(deformed);
			if (localCorners) {
				const originX = (localBounds.minX + localBounds.maxX) / 2;
				const originY = (localBounds.minY + localBounds.maxY) / 2;
				const worldCorners: QuadCorners = isIdentityTransform(t)
					? localCorners
					: [
							applyTransformToPoint(
								localCorners[0].x,
								localCorners[0].y,
								t,
								originX,
								originY,
							),
							applyTransformToPoint(
								localCorners[1].x,
								localCorners[1].y,
								t,
								originX,
								originY,
							),
							applyTransformToPoint(
								localCorners[2].x,
								localCorners[2].y,
								t,
								originX,
								originY,
							),
							applyTransformToPoint(
								localCorners[3].x,
								localCorners[3].y,
								t,
								originX,
								originY,
							),
						];

				this.deps.blitQuadToCanvas(
					passEncoder,
					texture,
					worldCorners,
					alphaMultiplier,
				);

				this.restoreStrokePipeline(passEncoder);
				return;
			}
			// Corner extraction failed: fall through to standard AABB blit.
		}

		const bounds = isIdentityTransform(t)
			? localBounds
			: applyTransformToBounds(localBounds, t);

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

		const texture = this.deps.assetState.imageTextureCache.get(file.uid);
		if (!texture) {
			// Start async load, will render on next frame
			this.ensureImageTexture(file);
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

	public async ensureImageTexture(
		file: EmbeddedFile,
	): Promise<GPUTexture | null> {
		// Check cache first
		const cached = this.deps.assetState.imageTextureCache.get(file.uid);
		if (cached) return cached;

		// Check if already loading
		const pending = this.deps.assetState.pendingImageLoads.get(file.uid);
		if (pending) return pending;

		// Start loading
		const loadPromise = (async () => {
			try {
				// Create Blob from Uint8Array (cast to ensure ArrayBuffer compatibility)
				const blob = new Blob([file.bin as BlobPart], { type: file.type });

				// Create ImageBitmap from Blob
				const imageBitmap = await createImageBitmap(blob);

				// Create GPUTexture
				const texture = this.deps.device.createTexture({
					label: `Image Texture: ${file.name}`,
					size: { width: imageBitmap.width, height: imageBitmap.height },
					format: "rgba8unorm",
					usage:
						GPUTextureUsage.TEXTURE_BINDING |
						GPUTextureUsage.COPY_DST |
						GPUTextureUsage.RENDER_ATTACHMENT,
				});

				// Copy ImageBitmap to GPUTexture with premultiplied alpha.
				// The blit pipeline uses premultiplied alpha blending
				// (srcFactor: "one"), so the texture must store premultiplied values.
				try {
					this.deps.device.queue.copyExternalImageToTexture(
						{ source: imageBitmap },
						{ texture, premultipliedAlpha: true },
						{ width: imageBitmap.width, height: imageBitmap.height },
					);
				} catch {
					// dawn-node doesn't support copyExternalImageToTexture with ImageBitmap.
					// Decode with pngjs and write raw RGBA pixels via writeTexture.
					const { PNG } = await import("pngjs");
					const png = PNG.sync.read(Buffer.from(file.bin));
					const pixelData = Uint8Array.from(png.data);
					// Premultiply alpha to match blit pipeline expectations
					for (let i = 0; i < pixelData.length; i += 4) {
						const a = pixelData[i + 3] / 255;
						pixelData[i] = Math.round(pixelData[i] * a);
						pixelData[i + 1] = Math.round(pixelData[i + 1] * a);
						pixelData[i + 2] = Math.round(pixelData[i + 2] * a);
					}
					this.deps.device.queue.writeTexture(
						{ texture },
						pixelData,
						{
							bytesPerRow: imageBitmap.width * 4,
							rowsPerImage: imageBitmap.height,
						},
						[imageBitmap.width, imageBitmap.height, 1],
					);
				}

				// Cache the texture
				this.deps.assetState.imageTextureCache.set(file.uid, texture);
				this.deps.assetState.pendingImageLoads.delete(file.uid);
				this.deps.assetState.onRequestRender?.();

				return texture;
			} catch (error) {
				console.error(`Failed to load image texture: ${file.name}`, error);
				this.deps.assetState.pendingImageLoads.delete(file.uid);
				return null;
			}
		})();

		this.deps.assetState.pendingImageLoads.set(file.uid, loadPromise);
		return loadPromise;
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
 * Build 4 separate cubic bezier sub-paths (one per side) tracing TL→TR→BR→BL→TL.
 * Each side is its own isMoved sub-path so preProcess output can be split back
 * into exactly 4 pieces after any adaptive subdivision. Control points are
 * offset by ±1/3 of the side vector so that non-linear deformations (e.g.
 * perspective projection) produce visually smooth curves.
 */
export function buildImageQuadSegments(
	bounds: {
		minX: number;
		minY: number;
		maxX: number;
		maxY: number;
	},
	corners?: [Vec2, Vec2, Vec2, Vec2],
): CubicBezierSegment[] {
	// Free-transform vertex data replaces the rectangle's corners; geometry
	// filters (e.g. 3d-rotate) still compose on top of the warped quad.
	const tl = corners
		? { x: corners[0][0], y: corners[0][1] }
		: { x: bounds.minX, y: bounds.maxY };
	const tr = corners
		? { x: corners[1][0], y: corners[1][1] }
		: { x: bounds.maxX, y: bounds.maxY };
	const br = corners
		? { x: corners[2][0], y: corners[2][1] }
		: { x: bounds.maxX, y: bounds.minY };
	const bl = corners
		? { x: corners[3][0], y: corners[3][1] }
		: { x: bounds.minX, y: bounds.minY };

	const sideSegment = (
		from: { x: number; y: number },
		to: { x: number; y: number },
		isLast: boolean,
	): CubicBezierSegment => {
		const dx = (to.x - from.x) / 3;
		const dy = (to.y - from.y) / 3;
		return {
			start: { x: from.x, y: from.y },
			cp1: { x: dx, y: dy },
			cp2: { x: -dx, y: -dy },
			end: { x: to.x, y: to.y },
			startTiltX: 0,
			startTiltY: 0,
			endTiltX: 0,
			endTiltY: 0,
			startDeltaTime: 0,
			endDeltaTime: 0,
			isMoved: true,
			isClosed: isLast ? true : undefined,
		};
	};

	return [
		sideSegment(tl, tr, false),
		sideSegment(tr, br, false),
		sideSegment(br, bl, false),
		sideSegment(bl, tl, true),
	];
}

/**
 * Extract the 4 deformed corners from preProcess output. Each input side is an
 * isMoved sub-path, so the output splits into 4 sub-paths whose first segments
 * carry the deformed corner as `start`. Returns null if the split produced an
 * unexpected shape (e.g. a filter collapsed a sub-path).
 */
function extractQuadCorners(
	segments: CubicBezierSegment[],
): QuadCorners | null {
	const subPaths = splitIntoSubPaths(segments);
	if (subPaths.length !== 4) return null;

	const corners: { x: number; y: number }[] = [];
	for (const sp of subPaths) {
		if (sp.length === 0) return null;
		const anchor = getStartAnchor(sp[0], undefined);
		corners.push({ x: anchor.x, y: anchor.y });
	}

	return [corners[0], corners[1], corners[2], corners[3]] as const;
}

function hasSameSegmentGeometry(
	a: CubicBezierSegment[],
	b: CubicBezierSegment[],
): boolean {
	if (a.length !== b.length) return false;

	for (let i = 0; i < a.length; i++) {
		if (!hasSamePointGeometry(a[i].start, b[i].start)) return false;
		if (!hasSamePointGeometry(a[i].cp1, b[i].cp1)) return false;
		if (!hasSamePointGeometry(a[i].cp2, b[i].cp2)) return false;
		if (!hasSamePointGeometry(a[i].end, b[i].end)) return false;
		if (a[i].isMoved !== b[i].isMoved) return false;
		if (a[i].isClosed !== b[i].isClosed) return false;
	}

	return true;
}

function hasSamePointGeometry(
	a: { x: number; y: number } | undefined,
	b: { x: number; y: number } | undefined,
): boolean {
	return a?.x === b?.x && a?.y === b?.y;
}
