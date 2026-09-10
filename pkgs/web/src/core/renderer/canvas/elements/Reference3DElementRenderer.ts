import type { Reference3DServiceApi } from "../../../reference3d/types";
import {
	type AnyArtObject,
	type Document,
	type EmbeddedFile,
	getTransform,
	isIdentityTransform,
	type Reference3DDef,
	type Reference3DElement,
} from "../../../schema";
import {
	applyTransformToPoint,
	composeTransforms,
} from "../../../utils/geometry/geometry";
import type {
	AssetState,
	BlitQuadToCanvasFn,
	BlitTextureToCanvasFn,
	Reference3DTextureCacheEntry,
} from "../CanvasLayerTypes";

/**
 * Reference3D subsystem access handed to the renderer. The Paplico facade wires
 * this once the lazily-loaded service is available; a null context means
 * reference3d elements are skipped entirely.
 */
export interface Reference3DRenderContext {
	service: Reference3DServiceApi;
	references3d: Readonly<Record<string, Reference3DDef>>;
}

interface Reference3DRendererDeps {
	device: GPUDevice;
	strokePipeline: GPURenderPipeline;
	dummyGradientBindGroup: GPUBindGroup;
	getMaskBindGroup: () => GPUBindGroup;
	assetState: AssetState;
	/** Document rasterization scale R (rasterizationDpi / 72). */
	getRasterScale: () => number;
	blitTextureToCanvas: BlitTextureToCanvasFn;
	blitQuadToCanvas: BlitQuadToCanvasFn;
	getBindGroup: () => GPUBindGroup;
	getTransformsBindGroup: () => GPUBindGroup | null;
	getParentGroupMap: () => ReadonlyMap<string, string>;
	getReference3DContext: () => Reference3DRenderContext | null;
}

/**
 * Renders Reference3DElements by blitting textures produced by the (lazily
 * loaded) three.js Reference3DService. Follows the ImageElementRenderer model:
 * synchronous cache hit → blit; miss → kick an async render and keep
 * blitting the previous texture until the new one lands (no flicker).
 */
export class Reference3DElementRenderer {
	/** In-flight scene renders keyed by element id. */
	private readonly pendingRenders = new Map<
		string,
		{ hash: string; promise: Promise<void> }
	>();

	public constructor(private readonly deps: Reference3DRendererDeps) {}

	public renderReference3D(
		passEncoder: GPURenderPassEncoder,
		element: Reference3DElement,
		elementsMap: Map<string, AnyArtObject>,
		alphaMultiplier: number = 1.0,
	): void {
		const context = this.deps.getReference3DContext();
		if (!context) return;

		const def = context.references3d[element.sceneId];
		if (!def) return;

		const rasterScale = clampReference3DRasterScale(this.deps.getRasterScale());
		const hash = this.computeHash(def, element, rasterScale, context.service);

		const cached = this.deps.assetState.reference3dTextureCache?.get(
			element.id,
		);
		if (cached?.hash !== hash) {
			void this.ensureSceneTexture(
				context.service,
				def,
				element,
				rasterScale,
				this.deps.assetState.currentFiles,
			);
		}
		// While the (re-)render is in flight, blit the stale texture if any.
		if (!cached) return;

		// Same center-rect world placement as ImageElementRenderer's AABB path.
		const halfWidth = element.width / 2;
		const halfHeight = element.height / 2;
		const localBounds = {
			minX: element.x - halfWidth,
			minY: element.y - halfHeight,
			maxX: element.x + halfWidth,
			maxY: element.y + halfHeight,
			width: element.width,
			height: element.height,
		};

		let composedTransform = getTransform(element);
		const parentGroupMap = this.deps.getParentGroupMap();
		let parentId = parentGroupMap.get(element.id);
		while (parentId) {
			const ancestor = elementsMap.get(parentId);
			if (ancestor) {
				composedTransform = composeTransforms(
					getTransform(ancestor),
					composedTransform,
				);
			}
			parentId = parentGroupMap.get(parentId);
		}

		if (isIdentityTransform(composedTransform)) {
			this.deps.blitTextureToCanvas(
				passEncoder,
				cached.texture,
				localBounds,
				alphaMultiplier,
			);
		} else {
			// Rotation/scale-exact placement: transform the 4 rect corners
			// (TL → TR → BR → BL, same convention as ImageElementRenderer's
			// deformed-quad path) around the local rect center.
			const corner = (x: number, y: number) =>
				applyTransformToPoint(x, y, composedTransform, element.x, element.y);
			this.deps.blitQuadToCanvas(
				passEncoder,
				cached.texture,
				[
					corner(localBounds.minX, localBounds.maxY),
					corner(localBounds.maxX, localBounds.maxY),
					corner(localBounds.maxX, localBounds.minY),
					corner(localBounds.minX, localBounds.minY),
				],
				alphaMultiplier,
			);
		}

		// Restore stroke pipeline after blit
		passEncoder.setPipeline(this.deps.strokePipeline);
		passEncoder.setBindGroup(0, this.deps.getBindGroup());
		passEncoder.setBindGroup(1, this.deps.getTransformsBindGroup()!);
		passEncoder.setBindGroup(2, this.deps.dummyGradientBindGroup);
		passEncoder.setBindGroup(3, this.deps.getMaskBindGroup());
	}

	/**
	 * Pre-warm textures for every reference3d element in the document at the
	 * document rasterization scale (export path — renderReference3D only serves
	 * cache hits, and export output shares the interactive R-sized textures).
	 * Scenes not flagged for export are skipped (they stay out of the output).
	 */
	public async ensureTextures(
		document: Document,
		elementFilter: ReadonlySet<string> | undefined,
	): Promise<void> {
		const context = this.deps.getReference3DContext();
		if (!context) return;

		const references3d = document.references3d ?? {};
		const rasterScale = clampReference3DRasterScale(this.deps.getRasterScale());
		const elements = Object.values(document.objects).filter(
			(el): el is Reference3DElement =>
				el.type === "reference3d" &&
				el.includeInExport === true &&
				(!elementFilter || elementFilter.has(el.id)),
		);

		await Promise.all(
			elements.map((element) => {
				const def = references3d[element.sceneId];
				if (!def) return null;
				return this.ensureSceneTexture(
					context.service,
					def,
					element,
					rasterScale,
					document.files,
				);
			}),
		);
	}

	/** Destroy all cached textures. Pending renders re-populate on demand. */
	public destroyTextures(): void {
		this.pendingRenders.clear();
		const cache = this.deps.assetState.reference3dTextureCache;
		if (!cache) return;
		for (const entry of cache.values()) {
			entry.texture.destroy();
		}
		cache.clear();
	}

	private async ensureSceneTexture(
		service: Reference3DServiceApi,
		def: Reference3DDef,
		element: Reference3DElement,
		rasterScale: number,
		files: readonly EmbeddedFile[],
	): Promise<void> {
		const hash = this.computeHash(def, element, rasterScale, service);
		const cache = this.getOrCreateCache();
		if (cache.get(element.id)?.hash === hash) return;

		const pending = this.pendingRenders.get(element.id);
		if (pending?.hash === hash) return pending.promise;

		const { width, height } = computeReference3DTextureSize(
			element.width,
			element.height,
			rasterScale,
		);

		const promise = (async () => {
			try {
				const pixels = await service.renderScene({
					sceneId: def.id,
					nodes: def.nodes,
					camera: element.camera,
					displayMode: element.displayMode,
					lineart: element.lineart,
					lightDir: element.lightDir,
					width,
					height,
					rasterScale,
					getFileBytes: (fileUid) =>
						files.find((file) => file.uid === fileUid)?.bin ?? null,
				});
				const texture = this.deps.device.createTexture({
					label: `Reference3D Texture: ${element.id}`,
					size: { width: pixels.width, height: pixels.height },
					format: "rgba8unorm",
					usage:
						GPUTextureUsage.TEXTURE_BINDING |
						GPUTextureUsage.COPY_DST |
						GPUTextureUsage.RENDER_ATTACHMENT,
				});
				// The scene pixels are already premultiplied — the same convention
				// as ImageElementRenderer, whose blit pipeline blends with srcFactor "one".
				this.deps.device.queue.writeTexture(
					{ texture },
					pixels.data,
					{ bytesPerRow: pixels.width * 4 },
					{ width: pixels.width, height: pixels.height },
				);
				cache.get(element.id)?.texture.destroy();
				cache.set(element.id, { texture, hash });
				this.deps.assetState.onRequestRender?.();
			} catch (error) {
				console.error(
					`Failed to render reference3d element: ${element.id}`,
					error,
				);
			} finally {
				if (this.pendingRenders.get(element.id)?.hash === hash) {
					this.pendingRenders.delete(element.id);
				}
			}
		})();

		this.pendingRenders.set(element.id, { hash, promise });
		return promise;
	}

	private getOrCreateCache(): Map<string, Reference3DTextureCacheEntry> {
		this.deps.assetState.reference3dTextureCache ??= new Map();
		return this.deps.assetState.reference3dTextureCache;
	}

	private computeHash(
		def: Reference3DDef,
		element: Reference3DElement,
		rasterScale: number,
		service: Reference3DServiceApi,
	): string {
		const { width, height } = computeReference3DTextureSize(
			element.width,
			element.height,
			rasterScale,
		);
		return computeReference3DTextureHash({
			nodes: def.nodes,
			camera: element.camera,
			displayMode: element.displayMode,
			lineart: element.lineart,
			lightDir: element.lightDir,
			textureWidth: width,
			textureHeight: height,
			rasterScale,
			contextEpoch: service.getContextEpoch(),
			assetsEpoch: service.getAssetsEpoch(),
		});
	}
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/** Longest allowed texture side (px). Oversized requests are shrunk uniformly. */
const MAX_REFERENCE3D_TEXTURE_SIDE = 2048;

/**
 * Clamp the document rasterization scale (rasterizationDpi / 72) into the
 * texture-size sanity range [0.25, 4]. R is fixed per document, so scene
 * textures never re-render on zoom.
 */
export function clampReference3DRasterScale(scale: number): number {
	return Math.min(Math.max(scale, 0.25), 4);
}

/** Element rect × raster scale, shrunk uniformly so no side exceeds the cap. */
export function computeReference3DTextureSize(
	elementWidth: number,
	elementHeight: number,
	rasterScale: number,
): { width: number; height: number } {
	let width = Math.max(1, Math.ceil(elementWidth * rasterScale));
	let height = Math.max(1, Math.ceil(elementHeight * rasterScale));
	const overflow = Math.max(width, height) / MAX_REFERENCE3D_TEXTURE_SIDE;
	if (overflow > 1) {
		width = Math.max(1, Math.round(width / overflow));
		height = Math.max(1, Math.round(height / overflow));
	}
	return { width, height };
}

/** FNV-1a hash over every input that affects the rendered scene texture. */
export function computeReference3DTextureHash(inputs: {
	nodes: Reference3DDef["nodes"];
	camera: Reference3DElement["camera"];
	displayMode: Reference3DElement["displayMode"];
	lineart: Reference3DElement["lineart"];
	lightDir: Reference3DElement["lightDir"];
	textureWidth: number;
	textureHeight: number;
	rasterScale: number;
	contextEpoch: number;
	/** Async-asset (VRM) arrival counter — re-renders pending figures. */
	assetsEpoch: number;
}): string {
	return fnv1aHash(
		[
			JSON.stringify(inputs.nodes),
			JSON.stringify(inputs.camera),
			inputs.displayMode,
			JSON.stringify(inputs.lineart ?? null),
			JSON.stringify(inputs.lightDir ?? null),
			`${inputs.textureWidth}x${inputs.textureHeight}`,
			String(inputs.rasterScale),
			String(inputs.contextEpoch),
			String(inputs.assetsEpoch),
		].join("\n"),
	);
}

function fnv1aHash(input: string): string {
	let hash = 0x811c_9dc5;
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		hash = Math.imul(hash, 0x0100_0193);
	}
	return (hash >>> 0).toString(16);
}
