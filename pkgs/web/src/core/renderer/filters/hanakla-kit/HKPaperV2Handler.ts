import type { StructuredView } from "webgpu-utils";
import type { Appearance, Filter } from "../../../schema";
import { compileShaderModule } from "../../../utils/wgpu-utils";
import type { AppearanceCacheEntry } from "../../canvas/caches/AppearanceCache";
import type {
	FilterHandler,
	FilterProcessorContext,
} from "../../canvas/pipeline/FilterRenderer";
import { HK_PAPER_V2_SHADER } from "./hk-paper-v2.wgsl";
import { buildFiberVertices } from "./hk-paper-v2-fibers";
import { HK_PAPER_V2_GEN_SHADER } from "./hk-paper-v2-gen.wgsl";
import { type HKPaperTypeDef, resolvePaperType } from "./hk-paper-v2-papers";

export interface HKPaperV2Params {
	paperType:
		| "woodfree"
		| "art"
		| "coated"
		| "machine"
		| "lightCoated"
		| "kouzo"
		| "mitsumata"
		| "ganpi"
		| "tengujou"
		| "tousagami";
	beatingDegree: number;
	fiberAmount: number;
	fiberDarkness: number;
	seed: number;
	invert: boolean;
	lightingEnabled: boolean;
	lightIntensity: number;
	lightAngle: number;
	depthEffect: number;
	surfaceRoughness: number;
	maxFiberLength: number;
	/** Formation mottle multiplier over the paper-type default. Absent in older documents. */
	formationStrength?: number;
	/** Laid/chain line multiplier over the paper-type default. Absent in older documents. */
	laidLineStrength?: number;
	/** Sheet opacity multiplier over the paper-type default. Absent in older documents. */
	sheerness?: number;
}
export interface HKPaperV2Filter extends Appearance<HKPaperV2Params> {
	processor: "hk:paper-v2";
}

/** Stage-A output cached per (element, appearance): the unlit paper height
 *  field. Lighting/composite params stay out of its hash so they can be
 *  tweaked without regenerating the sheet. */
interface PaperGenCacheEntry extends AppearanceCacheEntry {
	texture: GPUTexture;
}

export class HKPaperV2Handler implements FilterHandler {
	private genBasePipeline: GPURenderPipeline | null = null;
	private genFiberPipeline: GPURenderPipeline | null = null;
	private lightPipeline: GPURenderPipeline | null = null;
	private genBindGroupLayout: GPUBindGroupLayout | null = null;
	private lightBindGroupLayout: GPUBindGroupLayout | null = null;
	private genUniformView: StructuredView | null = null;
	private lightUniformView: StructuredView | null = null;
	private canvasFormat: GPUTextureFormat = "rgba8unorm";
	private pendingDestroy: (GPUTexture | GPUBuffer)[] = [];

	public async initialize(
		device: GPUDevice,
		canvasFormat: GPUTextureFormat,
	): Promise<void> {
		this.canvasFormat = canvasFormat;

		const gen = compileShaderModule(device, {
			label: "HK Paper V2 Gen Shader",
			code: HK_PAPER_V2_GEN_SHADER,
		});
		this.genUniformView = gen.uniformViews.uniforms;
		this.genBindGroupLayout = device.createBindGroupLayout({
			label: "HK Paper V2 Gen Bind Group Layout",
			entries: [
				{
					binding: 0,
					visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
					buffer: { type: "uniform" },
				},
			],
		});
		const genLayout = device.createPipelineLayout({
			bindGroupLayouts: [this.genBindGroupLayout],
		});
		this.genBasePipeline = device.createRenderPipeline({
			label: "HK Paper V2 Gen Base Pipeline",
			layout: genLayout,
			vertex: { module: gen.module, entryPoint: "vertexMain" },
			fragment: {
				module: gen.module,
				entryPoint: "baseFragmentMain",
				targets: [{ format: this.canvasFormat }],
			},
			primitive: { topology: "triangle-list" },
		});
		this.genFiberPipeline = device.createRenderPipeline({
			label: "HK Paper V2 Gen Fiber Pipeline",
			layout: genLayout,
			vertex: {
				module: gen.module,
				entryPoint: "fiberVertexMain",
				buffers: [
					{
						arrayStride: 3 * 4,
						attributes: [
							{ shaderLocation: 0, offset: 0, format: "float32x2" },
							{ shaderLocation: 1, offset: 8, format: "float32" },
						],
					},
				],
			},
			fragment: {
				module: gen.module,
				entryPoint: "fiberFragmentMain",
				targets: [{ format: this.canvasFormat }],
			},
			primitive: { topology: "triangle-list" },
		});

		const light = compileShaderModule(device, {
			label: "HK Paper V2 Light Shader",
			code: HK_PAPER_V2_SHADER,
		});
		this.lightUniformView = light.uniformViews.uniforms;
		this.lightBindGroupLayout = device.createBindGroupLayout({
			label: "HK Paper V2 Light Bind Group Layout",
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
					sampler: { type: "filtering" },
				},
				{
					binding: 3,
					visibility: GPUShaderStage.FRAGMENT,
					texture: { sampleType: "float" },
				},
			],
		});
		this.lightPipeline = device.createRenderPipeline({
			label: "HK Paper V2 Light Pipeline",
			layout: device.createPipelineLayout({
				bindGroupLayouts: [this.lightBindGroupLayout],
			}),
			vertex: { module: light.module, entryPoint: "vertexMain" },
			fragment: {
				module: light.module,
				entryPoint: "fragmentMain",
				targets: [{ format: this.canvasFormat }],
			},
			primitive: { topology: "triangle-list" },
		});
	}

	/** Deferred scratch destroys — called once per frame by FilterRenderer
	 *  after the previous frame's submit. */
	public flushPendingDestroy(): void {
		for (const resource of this.pendingDestroy) resource.destroy();
		this.pendingDestroy.length = 0;
	}

	public postProcess(context: FilterProcessorContext, filter: Filter): void {
		const f = filter as HKPaperV2Filter;
		const {
			device,
			sourceTexture,
			targetTexture,
			commandEncoder,
			sceneInfo: { textureSize, dpiScale },
		} = context;

		if (
			!this.genBasePipeline ||
			!this.genFiberPipeline ||
			!this.lightPipeline ||
			!this.genBindGroupLayout ||
			!this.lightBindGroupLayout ||
			!this.genUniformView ||
			!this.lightUniformView
		) {
			console.warn("HKPaperV2Handler not initialized");
			return;
		}

		const params = f.paramData.params;
		const paper = resolvePaperType(params.paperType);
		const formationStrength = params.formationStrength ?? 1;
		const laidLineStrength = params.laidLineStrength ?? 1;
		const sheerness = params.sheerness ?? 1;

		const worldSize = context.sourceWorldSize ?? {
			width: textureSize.width / dpiScale,
			height: textureSize.height / dpiScale,
		};
		const contentOffset = context.sourceContentOffset ?? { x: 0, y: 0 };
		// The editor clamps the bake to the viewport, so the source texture may
		// cover only a sub-rect of the element. Plan fibers and anchor noise over
		// the FULL element rect (coordinateSpace) and shift by worldOrigin, or a
		// partially visible element gets its fibers confined to — and re-rolled
		// against — the displayed region.
		const elementWorldSize = context.coordinateSpace?.worldSize ?? worldSize;
		const worldOrigin = context.coordinateSpace?.sourceOffset ?? { x: 0, y: 0 };

		// --- Stage A: generated paper height field (cached) ---
		const round3 = (v: number) => Math.round(v * 1000) / 1000;
		const genHash = JSON.stringify([
			2, // hash layout version
			params.paperType,
			params.beatingDegree,
			params.fiberAmount,
			params.fiberDarkness,
			params.seed,
			params.maxFiberLength,
			formationStrength,
			laidLineStrength,
			textureSize.width,
			textureSize.height,
			dpiScale,
			round3(elementWorldSize.width),
			round3(elementWorldSize.height),
			round3(worldOrigin.x),
			round3(worldOrigin.y),
			round3(contentOffset.x),
			round3(contentOffset.y),
		]);

		let paperTexture: GPUTexture | null = null;
		const cachedEntry = context.appearanceCache?.get(f.uid);
		if (
			cachedEntry &&
			cachedEntry.hash === genHash &&
			isPaperGenCacheEntry(cachedEntry)
		) {
			paperTexture = cachedEntry.texture;
		}

		if (!paperTexture) {
			paperTexture = this.renderPaperTexture(
				context,
				paper,
				params,
				formationStrength,
				laidLineStrength,
				elementWorldSize,
				worldOrigin,
				contentOffset,
			);
			if (context.appearanceCache) {
				const texture = paperTexture;
				const entry: PaperGenCacheEntry = {
					hash: genHash,
					texture,
					destroy: () => texture.destroy(),
				};
				context.appearanceCache.set(f.uid, entry);
			} else {
				// Sub-filter / offscreen callers carry no cache scope: regenerate
				// per frame and destroy after the next submit.
				this.pendingDestroy.push(paperTexture);
			}
		}

		// --- Stage B: lighting + composite into the element silhouette ---
		this.lightUniformView.set({
			resolution: [textureSize.width, textureSize.height],
			contentOffset: [contentOffset.x, contentOffset.y],
			worldOrigin: [worldOrigin.x, worldOrigin.y],
			baseColor: paper.baseColor,
			dpiScale: dpiScale,
			lightingEnabled: params.lightingEnabled ? 1.0 : 0.0,
			lightIntensity: params.lightIntensity,
			lightAngle: params.lightAngle,
			depthEffect: params.depthEffect,
			surfaceRoughness: params.surfaceRoughness,
			invert: params.invert ? 1.0 : 0.0,
			coating: paper.coating,
			gloss: paper.gloss,
			paperOpacity: paper.opacity * sheerness,
		});
		const lightUniformBuffer = device.createBuffer({
			label: "HK Paper V2 Light Uniform Buffer",
			size: this.lightUniformView.arrayBuffer.byteLength,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		});
		device.queue.writeBuffer(
			lightUniformBuffer,
			0,
			this.lightUniformView.arrayBuffer,
		);

		const sampler = device.createSampler({
			magFilter: "linear",
			minFilter: "linear",
			addressModeU: "clamp-to-edge",
			addressModeV: "clamp-to-edge",
		});

		const lightBindGroup = device.createBindGroup({
			label: "HK Paper V2 Light Bind Group",
			layout: this.lightBindGroupLayout,
			entries: [
				{ binding: 0, resource: { buffer: lightUniformBuffer } },
				{ binding: 1, resource: paperTexture.createView() },
				{ binding: 2, resource: sampler },
				{ binding: 3, resource: sourceTexture.createView() },
			],
		});

		const pass = commandEncoder.beginRenderPass({
			label: "HK Paper V2 Light Pass",
			colorAttachments: [
				{
					view: targetTexture.createView(),
					loadOp: "clear",
					storeOp: "store",
					clearValue: { r: 0, g: 0, b: 0, a: 0 },
				},
			],
		});
		pass.setPipeline(this.lightPipeline);
		pass.setBindGroup(0, lightBindGroup);
		pass.draw(3, 1, 0, 0);
		pass.end();
	}

	public getExpansionMargin(_filter: Filter): number {
		return 0;
	}

	public onScaleFilter(
		params: Filter,
		[scaleX, scaleY]: [number, number],
	): Filter {
		const f = params as HKPaperV2Filter;
		const uniformScale = Math.sqrt(scaleX * scaleY);
		return {
			...f,
			paramData: {
				...f.paramData,
				params: {
					...f.paramData.params,
					fiberAmount: f.paramData.params.fiberAmount * uniformScale,
					maxFiberLength: f.paramData.params.maxFiberLength * uniformScale,
				},
			},
		};
	}

	public onInterpolate(paramsA: unknown, paramsB: unknown, t: number): unknown {
		const a = paramsA as HKPaperV2Params;
		const b = paramsB as HKPaperV2Params;
		return {
			paperType: t < 0.5 ? a.paperType : b.paperType,
			beatingDegree: a.beatingDegree + (b.beatingDegree - a.beatingDegree) * t,
			fiberAmount: a.fiberAmount + (b.fiberAmount - a.fiberAmount) * t,
			fiberDarkness: a.fiberDarkness + (b.fiberDarkness - a.fiberDarkness) * t,
			seed: Math.round(a.seed + (b.seed - a.seed) * t),
			invert: t < 0.5 ? a.invert : b.invert,
			lightingEnabled: t < 0.5 ? a.lightingEnabled : b.lightingEnabled,
			lightIntensity:
				a.lightIntensity + (b.lightIntensity - a.lightIntensity) * t,
			lightAngle: a.lightAngle + (b.lightAngle - a.lightAngle) * t,
			depthEffect: a.depthEffect + (b.depthEffect - a.depthEffect) * t,
			surfaceRoughness:
				a.surfaceRoughness + (b.surfaceRoughness - a.surfaceRoughness) * t,
			maxFiberLength:
				a.maxFiberLength + (b.maxFiberLength - a.maxFiberLength) * t,
			formationStrength:
				(a.formationStrength ?? 1) +
				((b.formationStrength ?? 1) - (a.formationStrength ?? 1)) * t,
			laidLineStrength:
				(a.laidLineStrength ?? 1) +
				((b.laidLineStrength ?? 1) - (a.laidLineStrength ?? 1)) * t,
			sheerness:
				(a.sheerness ?? 1) + ((b.sheerness ?? 1) - (a.sheerness ?? 1)) * t,
		};
	}

	public destroy(): void {
		this.flushPendingDestroy();
		this.genBasePipeline = null;
		this.genFiberPipeline = null;
		this.lightPipeline = null;
		this.genBindGroupLayout = null;
		this.lightBindGroupLayout = null;
		this.genUniformView = null;
		this.lightUniformView = null;
	}

	/** Encode stage A: the base field plus fiber strokes into a fresh texture. */
	private renderPaperTexture(
		context: FilterProcessorContext,
		paper: HKPaperTypeDef,
		params: HKPaperV2Params,
		formationStrength: number,
		laidLineStrength: number,
		elementWorldSize: { width: number; height: number },
		worldOrigin: { x: number; y: number },
		contentOffset: { x: number; y: number },
	): GPUTexture {
		const {
			device,
			commandEncoder,
			sceneInfo: { textureSize, dpiScale },
		} = context;

		const texture = device.createTexture({
			label: "HK Paper V2 Paper Texture",
			size: { width: textureSize.width, height: textureSize.height },
			format: this.canvasFormat,
			usage:
				GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
		});

		// biome-ignore lint/style/noNonNullAssertion: guarded in postProcess.
		const genUniformView = this.genUniformView!;
		genUniformView.set({
			resolution: [textureSize.width, textureSize.height],
			contentOffset: [contentOffset.x, contentOffset.y],
			worldOrigin: [worldOrigin.x, worldOrigin.y],
			dpiScale: dpiScale,
			seed: params.seed,
			roughnessAmp: paper.roughness,
			formationAmp:
				paper.formation * (1 - 0.5 * params.beatingDegree) * formationStrength,
			laidAmp: paper.laid ? paper.laid.amp * laidLineStrength : 0,
			laidSpacingPx: paper.laid?.spacingPx ?? 3,
			chainSpacingPx: paper.laid?.chainSpacingPx ?? 85,
			chainAmp: paper.laid ? paper.laid.chainAmp * laidLineStrength : 0,
			wireAmp: paper.wireMark?.amp ?? 0,
			wireSpacingPx: paper.wireMark?.spacingPx ?? 2,
			mdStretch: paper.wireMark?.mdStretch ?? 1,
			speckDensity: paper.speck.density,
			speckDarkness: paper.speck.darkness,
		});
		const genUniformBuffer = device.createBuffer({
			label: "HK Paper V2 Gen Uniform Buffer",
			size: genUniformView.arrayBuffer.byteLength,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		});
		device.queue.writeBuffer(genUniformBuffer, 0, genUniformView.arrayBuffer);

		const fiberData = buildFiberVertices({
			worldWidth: elementWorldSize.width,
			worldHeight: elementWorldSize.height,
			paper,
			beatingDegree: params.beatingDegree,
			fiberAmount: params.fiberAmount,
			fiberDarkness: params.fiberDarkness,
			maxFiberLength: params.maxFiberLength,
			seed: params.seed,
		});
		const fiberVertexCount = fiberData.length / 3;
		let fiberBuffer: GPUBuffer | null = null;
		if (fiberVertexCount > 0) {
			fiberBuffer = device.createBuffer({
				label: "HK Paper V2 Fiber Vertex Buffer",
				size: fiberData.byteLength,
				usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
			});
			device.queue.writeBuffer(fiberBuffer, 0, fiberData);
			this.pendingDestroy.push(fiberBuffer);
		}

		const genBindGroup = device.createBindGroup({
			label: "HK Paper V2 Gen Bind Group",
			// biome-ignore lint/style/noNonNullAssertion: guarded in postProcess.
			layout: this.genBindGroupLayout!,
			entries: [{ binding: 0, resource: { buffer: genUniformBuffer } }],
		});

		const pass = commandEncoder.beginRenderPass({
			label: "HK Paper V2 Gen Pass",
			colorAttachments: [
				{
					view: texture.createView(),
					loadOp: "clear",
					storeOp: "store",
					clearValue: { r: 1, g: 1, b: 1, a: 1 },
				},
			],
		});
		// biome-ignore lint/style/noNonNullAssertion: guarded in postProcess.
		pass.setPipeline(this.genBasePipeline!);
		pass.setBindGroup(0, genBindGroup);
		pass.draw(3, 1, 0, 0);
		if (fiberBuffer) {
			// biome-ignore lint/style/noNonNullAssertion: guarded in postProcess.
			pass.setPipeline(this.genFiberPipeline!);
			pass.setBindGroup(0, genBindGroup);
			pass.setVertexBuffer(0, fiberBuffer);
			pass.draw(fiberVertexCount, 1, 0, 0);
		}
		pass.end();

		return texture;
	}
}

function isPaperGenCacheEntry(
	entry: AppearanceCacheEntry,
): entry is PaperGenCacheEntry {
	return "texture" in entry;
}
