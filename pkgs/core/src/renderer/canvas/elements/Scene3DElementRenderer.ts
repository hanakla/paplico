import {
	canvasToLocalPoint,
	localToCanvasPoint,
} from "../../../scene3d/perspective/projection";
import type {
	Scene3DServiceApi,
	Scene3DViewWindow,
} from "../../../scene3d/types";
import {
	type AnyArtObject,
	type Document,
	type EmbeddedFile,
	isIdentityTransform,
	type Point,
	type Scene3DCamera,
	type Scene3DDef,
	type Scene3DElement,
} from "../../../schema";
import {
	applyTransformToPoint,
	composeAncestorTransform,
} from "../../../utils/geometry/space/coordinates";
import type {
	AssetState,
	BlitQuad,
	BlitQuadToCanvasFn,
	BlitTextureToCanvasFn,
	Scene3DTextureCacheEntry,
} from "../CanvasLayerTypes";

/**
 * Scene3D subsystem access handed to the renderer. The Paplico facade wires
 * this once the lazily-loaded service is available; a null context means
 * scene3d elements are skipped entirely.
 */
export interface Scene3DRenderContext {
	service: Scene3DServiceApi;
	scenes3d: Readonly<Record<string, Scene3DDef>>;
}

interface Scene3DRendererDeps {
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
	getScene3DContext: () => Scene3DRenderContext | null;
}

/**
 * One rendered picture of a scene: the cache slot it fills, the camera it is
 * seen through and the texture it is rendered into.
 */
interface Scene3DView {
	cacheKey: string;
	camera: Scene3DCamera;
	width: number;
	height: number;
	/** Texels per world px of the view, which sets the lineart weight. */
	rasterScale: number;
	/** The part of the camera's view the picture holds. Absent = all of it. */
	window?: Scene3DViewWindow;
}

/** Cache slot of the scene editor's view. Element views use their element id. */
const EDITOR_VIEW_CACHE_KEY = "scene3d-editor-view";

/**
 * Renders Scene3DElements by blitting textures produced by the (lazily
 * loaded) three.js Scene3DService. Follows the ImageElementRenderer model:
 * synchronous cache hit → blit; miss → kick an async render and keep
 * blitting the previous texture until the new one lands (no flicker).
 */
export class Scene3DElementRenderer {
	/** In-flight scene renders keyed by Scene3DView.cacheKey. */
	private readonly pendingRenders = new Map<
		string,
		{ hash: string; promise: Promise<void> }
	>();
	/**
	 * Where the cached scene editor view sits on the canvas, and null while
	 * the editor is closed. The view is rendered for one position of the
	 * canvas, so a picture kept through a pan stays where it was rendered for.
	 */
	private editorViewQuad: BlitQuad | null = null;
	/** Whether the scene editor's view is being asked for (see releaseEditorView). */
	private editorViewOpen = false;

	public constructor(private readonly deps: Scene3DRendererDeps) {}

	public renderScene3D(
		passEncoder: GPURenderPassEncoder,
		element: Scene3DElement,
		elementsMap: Map<string, AnyArtObject>,
		alphaMultiplier: number = 1.0,
	): void {
		const context = this.deps.getScene3DContext();
		if (!context) return;

		const def = context.scenes3d[element.sceneId];
		if (!def) return;

		const view = this.elementView(element);
		const hash = this.computeHash(def, element, view, context.service);

		const cached = this.deps.assetState.scene3dTextureCache?.get(element.id);
		if (cached?.hash !== hash) {
			void this.ensureSceneTexture(
				context.service,
				def,
				element,
				view,
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

		const composedTransform = composeAncestorTransform(
			element,
			elementsMap,
			this.deps.getParentGroupMap(),
		);

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
			// deformed-quad path).
			const corner = (x: number, y: number) =>
				applyTransformToPoint(x, y, composedTransform);
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
	 * Draw the scene editor's view: the view `element` shows in its frame,
	 * seen through `camera` and widened until it covers the canvas. A scene
	 * seen through the element's own camera therefore lands exactly on its
	 * picture in the frame. `canvasCorners` are the canvas corners in world
	 * space; `texelsPerWorldUnit` is the density the canvas shows them at.
	 */
	public renderEditorView(
		passEncoder: GPURenderPassEncoder,
		element: Scene3DElement,
		elementsMap: Map<string, AnyArtObject>,
		camera: Scene3DCamera,
		canvasCorners: readonly Point[],
		texelsPerWorldUnit: number,
	): void {
		const context = this.deps.getScene3DContext();
		const def = context?.scenes3d[element.sceneId];
		if (!context || !def) return;

		// The canvas in the element's local space, where its frame is an
		// axis-aligned rect: the box around it is the view to render.
		const transform = composeAncestorTransform(
			element,
			elementsMap,
			this.deps.getParentGroupMap(),
		);
		const local = canvasCorners.map((point) =>
			canvasToLocalPoint(point, transform),
		);
		const minX = Math.min(...local.map((point) => point.x));
		const maxX = Math.max(...local.map((point) => point.x));
		const minY = Math.min(...local.map((point) => point.y));
		const maxY = Math.max(...local.map((point) => point.y));
		const quad: BlitQuad = [
			localToCanvasPoint({ x: minX, y: maxY }, transform),
			localToCanvasPoint({ x: maxX, y: maxY }, transform),
			localToCanvasPoint({ x: maxX, y: minY }, transform),
			localToCanvasPoint({ x: minX, y: minY }, transform),
		];

		this.editorViewOpen = true;
		const size = computeScene3DTextureSize(
			Math.hypot(quad[1].x - quad[0].x, quad[1].y - quad[0].y),
			Math.hypot(quad[3].x - quad[0].x, quad[3].y - quad[0].y),
			texelsPerWorldUnit,
		);
		const halfWidth = element.width / 2;
		const halfHeight = element.height / 2;
		const view: Scene3DView = {
			cacheKey: EDITOR_VIEW_CACHE_KEY,
			camera,
			...size,
			rasterScale: size.width / (maxX - minX),
			window: {
				minX: (minX - element.x) / halfWidth,
				maxX: (maxX - element.x) / halfWidth,
				minY: (minY - element.y) / halfHeight,
				maxY: (maxY - element.y) / halfHeight,
				aspect: element.width / element.height,
			},
		};

		const cached = this.deps.assetState.scene3dTextureCache?.get(
			EDITOR_VIEW_CACHE_KEY,
		);
		if (
			cached?.hash !== this.computeHash(def, element, view, context.service)
		) {
			void this.ensureSceneTexture(
				context.service,
				def,
				element,
				view,
				this.deps.assetState.currentFiles,
				() => {
					this.editorViewQuad = quad;
				},
			);
		}
		if (!cached || !this.editorViewQuad) return;
		this.deps.blitQuadToCanvas(
			passEncoder,
			cached.texture,
			this.editorViewQuad,
		);
	}

	/** Free the scene editor's view once the editor has closed. */
	public releaseEditorView(): void {
		if (!this.editorViewOpen) return;
		this.editorViewOpen = false;
		this.editorViewQuad = null;
		this.pendingRenders.delete(EDITOR_VIEW_CACHE_KEY);
		const cache = this.deps.assetState.scene3dTextureCache;
		cache?.get(EDITOR_VIEW_CACHE_KEY)?.texture.destroy();
		cache?.delete(EDITOR_VIEW_CACHE_KEY);
	}

	/**
	 * Pre-warm textures for every scene3d element in the document at the
	 * document rasterization scale (export path — renderScene3D only serves
	 * cache hits, and export output shares the interactive R-sized textures).
	 * Scenes not flagged for export are skipped (they stay out of the output).
	 */
	public async ensureTextures(
		document: Document,
		elementFilter: ReadonlySet<string> | undefined,
	): Promise<void> {
		const context = this.deps.getScene3DContext();
		if (!context) return;

		const scenes3d = document.scenes3d ?? {};
		const elements = Object.values(document.objects).filter(
			(el): el is Scene3DElement =>
				el.type === "scene3d" &&
				el.includeInExport === true &&
				(!elementFilter || elementFilter.has(el.id)),
		);

		await Promise.all(
			elements.map((element) => {
				const def = scenes3d[element.sceneId];
				if (!def) return null;
				return this.ensureSceneTexture(
					context.service,
					def,
					element,
					this.elementView(element),
					document.files,
				);
			}),
		);
	}

	/** Destroy all cached textures. Pending renders re-populate on demand. */
	public destroyTextures(): void {
		this.pendingRenders.clear();
		const cache = this.deps.assetState.scene3dTextureCache;
		if (!cache) return;
		for (const entry of cache.values()) {
			entry.texture.destroy();
		}
		cache.clear();
	}

	/** The view an element shows inside its own frame. */
	private elementView(element: Scene3DElement): Scene3DView {
		const rasterScale = clampScene3DRasterScale(this.deps.getRasterScale());
		return {
			cacheKey: element.id,
			camera: element.camera,
			...computeScene3DTextureSize(element.width, element.height, rasterScale),
			rasterScale,
		};
	}

	private async ensureSceneTexture(
		service: Scene3DServiceApi,
		def: Scene3DDef,
		element: Scene3DElement,
		view: Scene3DView,
		files: readonly EmbeddedFile[],
		onTextureReady?: () => void,
	): Promise<void> {
		const { cacheKey, width, height, rasterScale } = view;
		const hash = this.computeHash(def, element, view, service);
		const cache = this.getOrCreateCache();
		if (cache.get(cacheKey)?.hash === hash) return;

		const pending = this.pendingRenders.get(cacheKey);
		if (pending?.hash === hash) return pending.promise;

		const promise = (async () => {
			try {
				const pixels = await service.renderScene({
					sceneId: def.id,
					nodes: def.nodes,
					camera: view.camera,
					displayMode: element.displayMode,
					lineart: element.lineart,
					lightDir: element.lightDir,
					width,
					height,
					window: view.window,
					rasterScale,
					getFileBytes: (fileUid) =>
						files.find((file) => file.uid === fileUid)?.bin ?? null,
				});
				// The editor closed while its view was rendering.
				if (cacheKey === EDITOR_VIEW_CACHE_KEY && !this.editorViewOpen) return;
				const texture = this.deps.device.createTexture({
					label: `Scene3D Texture: ${cacheKey}`,
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
				cache.get(cacheKey)?.texture.destroy();
				cache.set(cacheKey, { texture, hash });
				onTextureReady?.();
				this.deps.assetState.onRequestRender?.();
			} catch (error) {
				console.error(`Failed to render scene3d element: ${element.id}`, error);
			} finally {
				if (this.pendingRenders.get(cacheKey)?.hash === hash) {
					this.pendingRenders.delete(cacheKey);
				}
			}
		})();

		this.pendingRenders.set(cacheKey, { hash, promise });
		return promise;
	}

	private getOrCreateCache(): Map<string, Scene3DTextureCacheEntry> {
		this.deps.assetState.scene3dTextureCache ??= new Map();
		return this.deps.assetState.scene3dTextureCache;
	}

	private computeHash(
		def: Scene3DDef,
		element: Scene3DElement,
		view: Scene3DView,
		service: Scene3DServiceApi,
	): string {
		return computeScene3DTextureHash({
			nodes: def.nodes,
			camera: view.camera,
			displayMode: element.displayMode,
			lineart: element.lineart,
			lightDir: element.lightDir,
			textureWidth: view.width,
			textureHeight: view.height,
			rasterScale: view.rasterScale,
			window: view.window,
			contextEpoch: service.getContextEpoch(),
			assetsEpoch: service.getAssetsEpoch(),
		});
	}
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/** Longest allowed texture side (px). Oversized requests are shrunk uniformly. */
const MAX_SCENE3D_TEXTURE_SIDE = 2048;

/**
 * Clamp the document rasterization scale (rasterizationDpi / 72) into the
 * texture-size sanity range [0.25, 4]. R is fixed per document, so scene
 * textures never re-render on zoom.
 */
export function clampScene3DRasterScale(scale: number): number {
	return Math.min(Math.max(scale, 0.25), 4);
}

/** Element rect × raster scale, shrunk uniformly so no side exceeds the cap. */
export function computeScene3DTextureSize(
	elementWidth: number,
	elementHeight: number,
	rasterScale: number,
): { width: number; height: number } {
	let width = Math.max(1, Math.ceil(elementWidth * rasterScale));
	let height = Math.max(1, Math.ceil(elementHeight * rasterScale));
	const overflow = Math.max(width, height) / MAX_SCENE3D_TEXTURE_SIDE;
	if (overflow > 1) {
		width = Math.max(1, Math.round(width / overflow));
		height = Math.max(1, Math.round(height / overflow));
	}
	return { width, height };
}

/** FNV-1a hash over every input that affects the rendered scene texture. */
function computeScene3DTextureHash(inputs: {
	nodes: Scene3DDef["nodes"];
	camera: Scene3DElement["camera"];
	displayMode: Scene3DElement["displayMode"];
	lineart: Scene3DElement["lineart"];
	lightDir: Scene3DElement["lightDir"];
	textureWidth: number;
	textureHeight: number;
	rasterScale: number;
	window: Scene3DViewWindow | undefined;
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
			JSON.stringify(inputs.window ?? null),
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
