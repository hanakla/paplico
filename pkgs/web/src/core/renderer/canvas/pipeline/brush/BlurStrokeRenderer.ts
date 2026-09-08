import { readStoredBrushSize } from "../../../../brush/access";
import type {
	AnyArtObject,
	BrushSettings,
	Path,
	StrokeAppearance,
	Viewport,
} from "../../../../schema";
import {
	calculateElementBounds,
	expandBounds,
} from "../../../../utils/geometry/bounds";
import { compileShaderModule } from "../../../../utils/wgpu-utils";
import type { GPUTimingProfiler } from "../../../GPUTimingProfiler";
import { createFullscreenPipeline } from "../../../PipelineFactory";
import type { BlitLayer } from "../../CanvasLayerTypes";
import type {
	BackdropBlurLevels,
	BackdropEffectCoordinator,
	BackdropEffectRequest,
	FixedRBackdropRegion,
} from "../BackdropEffectCoordinator";
import type { BackdropEffectDriver } from "../FilterRenderer";
import { FrameUniformPool } from "../FrameUniformPool";
import { createFrameTextureRef, createRenderSurface } from "../RenderSurface";
import type { TexturePool } from "../TexturePool";
import type { UniformScope } from "../UniformScope";
import {
	type BrushRenderer,
	findStrokeAppearance,
	type ResolvedStrokeAppearance,
} from "./BrushRenderer";
import { BLUR_STROKE_SHADER } from "./shaders/blurStroke.wgsl";

/** Same cap as the wash accumulators: keeps one stroke's textures bounded. */
const MAX_BLUR_STROKE_TEXTURE_SIDE = 4096;

interface BlurStrokeRendererDeps {
	device: GPUDevice;
	canvasFormat: GPUTextureFormat;
	texturePool: TexturePool;
	coordinator: BackdropEffectCoordinator;
	uniformScope: UniformScope;
	/** The canvas's brush renderer; this driver draws its coverage through
	 *  the dab route. */
	brush: BrushRenderer;
	getTransformIndex: (elementId: string) => number;
	getTransformsBindGroup: () => GPUBindGroup | undefined;
	getMaskBindGroup: () => GPUBindGroup;
	getRasterScale: () => number;
}

/**
 * Backdrop-effect driver for blur strokes. The stroke's dabs are drawn only
 * for their coverage; the picture is the composite below the stroke, blurred
 * by the coordinator's shared pyramid and cut to that coverage. Like mixing
 * it draws inline at its z-order: the caller ends its main pass, the driver
 * captures the fixed-R backdrop, and the result comes back as a BlitLayer
 * whose coverage makes the blit replace the backdrop instead of layering
 * over it.
 */
export class BlurStrokeRenderer implements BackdropEffectDriver {
	private readonly deps: BlurStrokeRendererDeps;
	private readonly pipeline: GPURenderPipeline;
	private readonly bindGroupLayout: GPUBindGroupLayout;
	private readonly uniformView: ReturnType<
		typeof compileShaderModule
	>["uniformViews"][string];
	private readonly uniformPool: FrameUniformPool;
	private readonly sampler: GPUSampler;
	/** This frame's backdrop requests by element, planned ahead so the shared
	 *  batch is captured with a pyramid deep enough for every blur stroke. */
	private frameRequests = new Map<string, BackdropEffectRequest>();
	private frameTextures: GPUTexture[] = [];

	public constructor(deps: BlurStrokeRendererDeps) {
		this.deps = deps;
		const { module, uniformViews } = compileShaderModule(deps.device, {
			label: "Blur Stroke Composite Shader",
			code: BLUR_STROKE_SHADER,
		});
		this.uniformView = uniformViews.u;
		this.uniformPool = new FrameUniformPool(
			deps.device,
			"Blur Stroke Uniforms",
		);
		this.bindGroupLayout = deps.device.createBindGroupLayout({
			label: "Blur Stroke Bind Group Layout",
			entries: [
				{
					binding: 0,
					visibility: GPUShaderStage.FRAGMENT,
					buffer: { type: "uniform" },
				},
				{
					binding: 1,
					visibility: GPUShaderStage.FRAGMENT,
					texture: { sampleType: "float" },
				},
				{
					binding: 2,
					visibility: GPUShaderStage.FRAGMENT,
					texture: { sampleType: "float" },
				},
				{
					binding: 3,
					visibility: GPUShaderStage.FRAGMENT,
					texture: { sampleType: "float" },
				},
				{
					binding: 4,
					visibility: GPUShaderStage.FRAGMENT,
					sampler: { type: "filtering" },
				},
			],
		});
		this.pipeline = createFullscreenPipeline({
			device: deps.device,
			label: "Blur Stroke Composite Pipeline",
			shaderModule: module,
			pipelineLayout: deps.device.createPipelineLayout({
				bindGroupLayouts: [this.bindGroupLayout],
			}),
			targetFormat: deps.canvasFormat,
			multisampleCount: 1,
		});
		this.sampler = deps.device.createSampler({
			magFilter: "linear",
			minFilter: "linear",
			addressModeU: "clamp-to-edge",
			addressModeV: "clamp-to-edge",
		});
	}

	public beginFrame(): void {
		this.frameRequests = new Map();
		this.uniformPool.beginFrame();
	}

	public prepareFrame(
		_encoder: GPUCommandEncoder,
		elementsMap: Map<string, AnyArtObject>,
		_dpiScale: number,
		_backdropScale: number,
		_profiler?: GPUTimingProfiler | null,
		filter?: ReadonlySet<string>,
	): void {
		const rasterScale = this.deps.getRasterScale();
		for (const element of elementsMap.values()) {
			if (element.visible === false) continue;
			if (filter && !filter.has(element.id)) continue;
			const stroke = resolveBackdropBlurStroke(element);
			if (!stroke) continue;
			this.frameRequests.set(
				element.id,
				blurRequestOf(element, stroke.settings, rasterScale),
			);
		}
		this.deps.coordinator.planFrame([...this.frameRequests.values()]);
	}

	public unionSolidBounds(): void {}

	public hasInlineComposite(element: AnyArtObject): boolean {
		return resolveBackdropBlurStroke(element) != null;
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
		const stroke = resolveBackdropBlurStroke(element);
		if (!stroke || !viewport) return;
		const path = element as Path;
		const segments = path.segments ?? [];
		if (segments.length === 0) return;
		const { settings, filter } = stroke;
		const strokeColor = (filter as StrokeAppearance).paramData.params
			.strokeColor;
		if (!strokeColor) return;
		const rasterScale = this.deps.getRasterScale();

		const request =
			this.frameRequests.get(element.id) ??
			blurRequestOf(element, settings, rasterScale);
		const { bounds, blurSigma } = request;
		const below = this.acquireBlurredBackdrop(
			encoder,
			targetTexture,
			viewport,
			width,
			height,
			request,
			profiler,
		);
		// The blit that follows paints into the target, so later backdrop
		// consumers over this region must recapture.
		this.deps.coordinator.noteDraw(bounds);
		if (!below) return;

		const maxDim = Math.min(
			this.deps.device.limits.maxTextureDimension2D,
			MAX_BLUR_STROKE_TEXTURE_SIDE,
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
		const coverageTex = this.acquireStrokeTexture(
			texW,
			texH,
			"Blur Stroke Coverage",
		);
		const resultTex = this.acquireStrokeTexture(texW, texH, "Blur Stroke");

		// The dabs draw into the coverage texture's own world viewport, centred
		// on the bounds.
		const centerX = (bounds.minX + bounds.maxX) / 2;
		const centerY = (bounds.minY + bounds.maxY) / 2;
		const uniformEntry = this.deps.uniformScope.acquire(
			{ x: centerX, y: centerY, zoom: effectiveZoom, rotation: 0 },
			texW,
			texH,
		);
		const coveragePass = encoder.beginRenderPass({
			label: "Blur Stroke Coverage Pass",
			timestampWrites: profiler?.timestampWrites("Blur Stroke Coverage"),
			colorAttachments: [
				{
					view: coverageTex.createView(),
					clearValue: { r: 0, g: 0, b: 0, a: 0 },
					loadOp: "clear",
					storeOp: "store",
				},
			],
		});
		this.deps.brush.dabs.render(
			coveragePass,
			{
				path,
				segments,
				strokeColor,
				settings,
				alphaMultiplier: 1,
				transformIndex: this.deps.getTransformIndex(element.id),
			},
			{
				uniformBuffer: uniformEntry.buffer,
				transformsBindGroup: this.deps.getTransformsBindGroup(),
				maskBindGroup: this.deps.getMaskBindGroup(),
			},
		);
		coveragePass.end();

		const worldW = texW / effectiveZoom;
		const worldH = texH / effectiveZoom;
		this.uniformView.set({
			uvOrigin: [centerX - worldW / 2, centerY + worldH / 2],
			uvSpan: [worldW, -worldH],
			regionMin: [
				below.region.actualBounds.minX,
				below.region.actualBounds.minY,
			],
			regionSize: [
				below.region.actualBounds.width,
				below.region.actualBounds.height,
			],
			remap: below.levels.remap,
			loCtl: below.levels.blurLoCtl,
			hiCtl: below.levels.blurHiCtl,
			blurMix: below.levels.blurMix,
		});
		const uniformBuffer = this.uniformPool.acquire(
			this.uniformView.arrayBuffer.byteLength,
		);
		this.deps.device.queue.writeBuffer(
			uniformBuffer,
			0,
			this.uniformView.arrayBuffer,
		);
		const bindGroup = this.deps.device.createBindGroup({
			label: "Blur Stroke Bind Group",
			layout: this.bindGroupLayout,
			entries: [
				{ binding: 0, resource: { buffer: uniformBuffer } },
				{ binding: 1, resource: coverageTex.createView() },
				{ binding: 2, resource: below.levels.blurLo.createView() },
				{ binding: 3, resource: below.levels.blurHi.createView() },
				{ binding: 4, resource: this.sampler },
			],
		});
		const compositePass = encoder.beginRenderPass({
			label: "Blur Stroke Composite Pass",
			timestampWrites: profiler?.timestampWrites("Blur Stroke Composite"),
			colorAttachments: [
				{
					view: resultTex.createView(),
					clearValue: { r: 0, g: 0, b: 0, a: 0 },
					loadOp: "clear",
					storeOp: "store",
				},
			],
		});
		compositePass.setPipeline(this.pipeline);
		compositePass.setBindGroup(0, bindGroup);
		compositePass.draw(3);
		compositePass.end();

		// The draw viewport is centred on the bounds, so the used region sits in
		// the middle of the texture.
		const usedHalfU = (bounds.width * effectiveZoom) / (2 * texW);
		const usedHalfV = (bounds.height * effectiveZoom) / (2 * texH);
		const placement = {
			kind: "world-aabb" as const,
			bounds,
			uvRect:
				usedHalfU >= 0.5 && usedHalfV >= 0.5
					? { minU: 0, minV: 0, maxU: 1, maxV: 1 }
					: {
							minU: 0.5 - usedHalfU,
							minV: 0.5 - usedHalfV,
							maxU: 0.5 + usedHalfU,
							maxV: 0.5 + usedHalfV,
						},
		};
		const surface = createRenderSurface(
			createFrameTextureRef(resultTex, () => {}),
			placement,
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
			// The blurred backdrop replaces the sharp one within the coverage;
			// without this the blit would key on the blurred alpha and leak
			// the sharp backdrop wherever the composite below is translucent.
			coverage: createFrameTextureRef(coverageTex, () => {}),
		};
	}

	public flushRemaining(): void {}

	public releaseFrame(release: (texture: GPUTexture) => void): void {
		for (const texture of this.frameTextures) release(texture);
		this.frameTextures = [];
	}

	public destroy(): void {
		this.frameTextures = [];
		this.frameRequests.clear();
		this.uniformPool.destroy();
	}

	/**
	 * The fixed-R backdrop under the request with the pyramid levels
	 * bracketing its sigma. A batch captured before this stroke was planned
	 * (a live preview, say) may hold no pyramid or one too shallow for this
	 * sigma; then the batch is dropped and recaptured with this request as
	 * its target, which sizes the pyramid to it.
	 */
	private acquireBlurredBackdrop(
		encoder: GPUCommandEncoder,
		targetTexture: GPUTexture,
		viewport: Viewport,
		width: number,
		height: number,
		request: BackdropEffectRequest,
		profiler?: GPUTimingProfiler | null,
	): { region: FixedRBackdropRegion; levels: BackdropBlurLevels } | null {
		const acquire = () => {
			const region = this.deps.coordinator.acquireFixedRRegion(
				encoder,
				targetTexture,
				viewport,
				width,
				height,
				request,
				profiler,
			);
			if (!region) return null;
			const levels = region.sampleBlur(request.blurSigma);
			return levels ? { region, levels } : null;
		};
		const first = acquire();
		// Identical lo and hi levels mean the sigma ran past the pyramid top.
		if (first && first.levels.blurLo !== first.levels.blurHi) return first;
		if (first && request.blurSigma <= 0) return first;
		this.deps.coordinator.invalidate();
		return acquire();
	}

	private acquireStrokeTexture(
		width: number,
		height: number,
		label: string,
	): GPUTexture {
		const texture = this.deps.texturePool.acquireExact(
			width,
			height,
			this.deps.canvasFormat,
			1,
			GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
			label,
		);
		this.frameTextures.push(texture);
		return texture;
	}
}

/**
 * The element's blur stroke appearance, or null when it has none.
 *
 * Only the dab engine has a coverage to cut the blur with; ribbon and
 * geometric strokes stay on their own routes. Enablement is the explicit
 * boolean alone.
 */
export function resolveBackdropBlurStroke(
	element: AnyArtObject,
): ResolvedStrokeAppearance | null {
	return findStrokeAppearance(element, (r) => r.backdropBlurEnabled);
}

/**
 * The backdrop the stroke reads: its own bounds padded by the brush reach
 * and by the blur kernel, so the blurred pixels under the coverage never
 * sample past the capture edge. Sigma is in fixed-R texels; the radius the
 * settings hold is world px, halved to a sigma the way the blur filter does.
 */
function blurRequestOf(
	element: AnyArtObject,
	settings: BrushSettings,
	rasterScale: number,
): BackdropEffectRequest {
	const sizeBase = readStoredBrushSize(settings) ?? 10;
	const sigmaWorld = (sizeBase * settings.backdropBlur!.radius) / 2;
	return {
		bounds: expandBounds(
			calculateElementBounds(element),
			sizeBase + sigmaWorld * 3,
		),
		blurSigma: sigmaWorld * rasterScale,
		rasterScale,
	};
}
