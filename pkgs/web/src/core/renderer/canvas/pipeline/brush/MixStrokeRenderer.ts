import { resolveBrushRenderRoute } from "../../../../brush/renderRoute";
import type {
	AnyArtObject,
	BrushSettingsV2,
	Filter,
	Path,
	StrokeAppearance,
	Viewport,
} from "../../../../schema";
import { isFilterEnabled } from "../../../../schema";
import {
	calculateElementBounds,
	expandBounds,
} from "../../../../utils/geometry/bounds";
import type { GPUTimingProfiler } from "../../../GPUTimingProfiler";
import type { BlitLayer } from "../../CanvasLayerTypes";
import type {
	BackdropEffectCoordinator,
	BackdropEffectRequest,
} from "../BackdropEffectCoordinator";
import type { BackdropEffectDriver } from "../FilterRenderer";
import { createFrameTextureRef, createRenderSurface } from "../RenderSurface";
import type { StrokeBatchContext } from "../stroke/StrokeBatchContext";
import type { TexturePool } from "../TexturePool";
import type { UniformScope } from "../UniformScope";
import { evaluateDabs } from "./DabEvaluator";
import { DAB_INSTANCE_FLOATS } from "./DabInstanceLayout";
import { MIX_CHUNK_SIZE, MixPass } from "./MixPass";

/** Same cap as the wash accumulators: keeps one stroke's buffer bounded. */
const MAX_MIX_STROKE_TEXTURE_SIDE = 4096;

export interface MixStrokeRendererDeps {
	device: GPUDevice;
	canvasFormat: GPUTextureFormat;
	texturePool: TexturePool;
	coordinator: BackdropEffectCoordinator;
	uniformScope: UniformScope;
	getBatchContext: () => StrokeBatchContext | null;
	getTransformIndex: (elementId: string) => number;
	getTransformsBindGroup: () => GPUBindGroup | undefined;
	getRasterScale: () => number;
}

/**
 * Backdrop-effect driver for color-mixing strokes (design §10). A mixing
 * stroke reads the live composite below itself, so — like glass — it draws
 * inline at its z-order: the caller ends its main pass, composeInline
 * captures the backdrop at the fixed-R grid and alternates the mix pass's
 * color-resolving compute with ranged dab draws chunk by chunk (each chunk
 * samples the stroke buffer the previous chunks painted), and the resolved
 * stroke comes back as a BlitLayer for the restarted pass.
 */
export class MixStrokeRenderer implements BackdropEffectDriver {
	private readonly deps: MixStrokeRendererDeps;
	private mixPass: MixPass | null = null;
	private frameBuffers: GPUBuffer[] = [];
	private retiredBuffers: GPUBuffer[] = [];
	private frameTextures: GPUTexture[] = [];

	public constructor(deps: MixStrokeRendererDeps) {
		this.deps = deps;
	}

	public beginFrame(): void {
		// The frame that owned these buffers has been submitted by now (the
		// orchestrator submits after render returns, i.e. after releaseFrame),
		// so this is the first safe point to free them.
		for (const buffer of this.retiredBuffers) buffer.destroy();
		this.retiredBuffers = [];
	}

	public prepareFrame(): void {}

	public unionSolidBounds(): void {}

	public hasInlineComposite(element: AnyArtObject): boolean {
		return this.mixStrokeOf(element) != null;
	}

	public composeInline(
		element: AnyArtObject,
		encoder: GPUCommandEncoder,
		targetTexture: GPUTexture,
		viewport: Viewport | null,
		width: number,
		height: number,
		profiler?: GPUTimingProfiler | null,
	): BlitLayer | void {
		const stroke = this.mixStrokeOf(element);
		if (!stroke || !viewport) return;
		const path = element as Path;
		const segments = path.segments ?? [];
		if (segments.length === 0) return;
		const batchContext = this.deps.getBatchContext();
		if (!batchContext) return;
		const { settings, filter } = stroke;
		const mixing = settings.mixing!;
		const rasterScale = this.deps.getRasterScale();

		// Stroke world bounds padded by the brush reach.
		const sizeBase = settings.properties.size?.base ?? 10;
		const bounds = expandBounds(calculateElementBounds(element), sizeBase);

		// Backdrop below this stroke, on the fixed-R raster grid (§B-2).
		const request: BackdropEffectRequest = {
			bounds,
			blurSigma: 0,
			rasterScale,
		};
		const below = this.deps.coordinator.acquireFixedRRegion(
			encoder,
			targetTexture,
			viewport,
			width,
			height,
			request,
			profiler,
		);
		if (!below) return;

		const brushColor = solidBrushColorOf(filter);
		if (!brushColor) return;
		const dabs = evaluateDabs(segments, settings, {
			pathStart: path.pathStart ?? 0,
			pathEnd: path.pathEnd ?? 1,
			strokeWidths: path.strokeWidths,
			color: brushColor,
		});
		if (dabs.count === 0) return;

		const dabBuffer = this.uploadFrameBuffer(
			dabs.data.subarray(0, dabs.count * DAB_INSTANCE_FLOATS),
			"Mix Dab Instances",
		);
		const mixParamsBuffer = this.uploadFrameBuffer(
			dabs.mixParams.subarray(0, dabs.count * 4),
			"Mix Dab Params",
		);
		const mixedColors = this.deps.device.createBuffer({
			label: "Mix Resolved Colors",
			size: dabs.count * 16,
			usage: GPUBufferUsage.STORAGE,
		});
		this.frameBuffers.push(mixedColors);
		this.mixPass ??= new MixPass(this.deps.device);
		const bucket = this.mixPass.createBucket();
		this.frameBuffers.push(bucket);

		// Stroke buffer texture on the same DPI grid, capped like wash.
		const maxDim = Math.min(
			this.deps.device.limits.maxTextureDimension2D,
			MAX_MIX_STROKE_TEXTURE_SIDE,
		);
		const texW = Math.max(
			1,
			Math.min(Math.ceil(bounds.width * rasterScale), maxDim),
		);
		const texH = Math.max(
			1,
			Math.min(Math.ceil(bounds.height * rasterScale), maxDim),
		);
		const effectiveZoom = Math.min(texW / bounds.width, texH / bounds.height);
		const strokeTex = this.deps.texturePool.acquireExact(
			texW,
			texH,
			this.deps.canvasFormat,
			1,
			GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
			"Mix Stroke Buffer",
		);
		const depthTex = this.deps.texturePool.acquireExact(
			texW,
			texH,
			"depth24plus-stencil8",
			1,
			GPUTextureUsage.RENDER_ATTACHMENT,
			"Mix Stroke Stencil",
		);
		this.frameTextures.push(strokeTex, depthTex);
		const strokeView = strokeTex.createView();
		const depthView = depthTex.createView();

		// Dab draws target the stroke texture's own world viewport.
		const uniformEntry = this.deps.uniformScope.acquire(
			{
				x: (bounds.minX + bounds.maxX) / 2,
				y: (bounds.minY + bounds.maxY) / 2,
				zoom: effectiveZoom,
				rotation: 0,
			},
			texW,
			texH,
		);
		batchContext.setActiveUniformBuffer(uniformEntry.buffer);
		const drawState = batchContext.prepareMixedDabStroke({
			path,
			settings,
			dabBuffer,
			mixedColors,
			alphaMultiplier: 1,
			transformIndex: this.deps.getTransformIndex(element.id),
		});
		batchContext.setActiveUniformBuffer(null);
		if (!drawState) return;

		const falloffLut = batchContext.getFalloffLutTexture();
		const transformsBindGroup = this.deps.getTransformsBindGroup();

		for (let firstDab = 0; firstDab < dabs.count; firstDab += MIX_CHUNK_SIZE) {
			const chunkLen = Math.min(MIX_CHUNK_SIZE, dabs.count - firstDab);
			this.mixPass.resolveChunk(encoder, {
				dabBuffer,
				firstDab,
				dabCount: chunkLen,
				mixParams: mixParamsBuffer,
				mixParamsOffsetBytes: firstDab * 16,
				below: below.texture,
				belowBounds: below.actualBounds,
				stroke: firstDab === 0 ? null : strokeTex,
				strokeBounds: bounds,
				brushColor,
				sampleRadiusRatio: mixing.sampleRadius,
				sampleTrail: mixing.sampleTrail,
				blendStyle: mixing.blendStyle,
				falloffLut,
				bucket,
				outColors: mixedColors,
				outColorsOffsetBytes: firstDab * 16,
			});
			const pass = encoder.beginRenderPass({
				label: "Mix Stroke Chunk Pass",
				colorAttachments: [
					{
						view: strokeView,
						clearValue: { r: 0, g: 0, b: 0, a: 0 },
						loadOp: firstDab === 0 ? "clear" : "load",
						storeOp: "store",
					},
				],
				depthStencilAttachment: {
					view: depthView,
					depthClearValue: 1,
					depthLoadOp: "clear",
					depthStoreOp: "discard",
					stencilClearValue: 0,
					stencilLoadOp: "clear",
					stencilStoreOp: "discard",
				},
			});
			batchContext.drawMixedDabChunk(
				pass,
				drawState,
				firstDab,
				chunkLen,
				transformsBindGroup ?? undefined,
			);
			pass.end();
		}

		this.deps.coordinator.noteDraw(bounds);

		const surface = createRenderSurface(
			// releaseFrame owns the texture's return to the pool.
			createFrameTextureRef(strokeTex, () => {}),
			{
				kind: "world-aabb",
				bounds,
				uvRect: { minU: 0, minV: 0, maxU: 1, maxV: 1 },
			},
			{
				role: "color",
				alphaMode: "premultiplied",
				opacityState: "intrinsic",
			},
		);
		return {
			...surface,
			// Wash semantics: strokeOpacity applies exactly once, here.
			opacity:
				filter.opacity *
				(settings.paintMode === "wash" ? settings.strokeOpacity : 1),
		};
	}

	public flushRemaining(): void {}

	public releaseFrame(release: (texture: GPUTexture) => void): void {
		for (const texture of this.frameTextures) release(texture);
		this.frameTextures = [];
		// Destroying here would hit the still-unsubmitted encoder; hand them
		// to the next frame instead.
		this.retiredBuffers.push(...this.frameBuffers);
		this.frameBuffers = [];
		this.mixPass?.retireChunkResources();
	}

	public destroy(): void {
		for (const buffer of [...this.retiredBuffers, ...this.frameBuffers]) {
			buffer.destroy();
		}
		this.retiredBuffers = [];
		this.frameBuffers = [];
		this.frameTextures = [];
		this.mixPass?.destroy();
		this.mixPass = null;
	}

	private mixStrokeOf(
		element: AnyArtObject,
	): { settings: BrushSettingsV2; filter: Filter } | null {
		if (element.type !== "path") return null;
		for (const filter of element.filters ?? []) {
			if (!isFilterEnabled(filter) || filter.processor !== "stroke") continue;
			const raw = (filter as StrokeAppearance).paramData.params.brushSettings;
			if (raw == null) continue;
			const route = resolveBrushRenderRoute(raw);
			if (route.kind !== "dab-v2" || route.settings.mixing?.enabled !== true) {
				continue;
			}
			// The mix pass resolves one color per dab from a single brush color,
			// so a gradient/pattern stroke would lose its color mapping. Those
			// keep their normal route until per-dab gradient sampling feeds the
			// mix pass (the dab shader still holds the gradient switch).
			if (!solidBrushColorOf(filter)) continue;
			return { settings: route.settings, filter };
		}
		return null;
	}

	private uploadFrameBuffer(data: Float32Array, label: string): GPUBuffer {
		const buffer = this.deps.device.createBuffer({
			label,
			size: Math.max(data.byteLength, 16),
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
		});
		this.deps.device.queue.writeBuffer(
			buffer,
			0,
			data.buffer as ArrayBuffer,
			data.byteOffset,
			data.byteLength,
		);
		this.frameBuffers.push(buffer);
		return buffer;
	}
}

/** The stroke appearance's solid color, or null for gradient/pattern fills. */
function solidBrushColorOf(
	filter: Filter,
): { r: number; g: number; b: number; a: number } | null {
	const strokeColor = (filter as StrokeAppearance).paramData.params.strokeColor;
	if (strokeColor?.type !== "solid") return null;
	const { color } = strokeColor;
	return color.type === "rgb"
		? { r: color.r, g: color.g, b: color.b, a: color.a }
		: null;
}
