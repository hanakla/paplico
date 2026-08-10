import { compileShaderModule } from "../../../../utils/wgpu-utils";
import { WET_LAYER_DIFFUSE_SHADER } from "../../../shaders/wetLayerDiffuse.wgsl";
import { WET_LAYER_FINISH_SHADER } from "../../../shaders/wetLayerFinish.wgsl";
import { WET_LAYER_SEED_SHADER } from "../../../shaders/wetLayerSeed.wgsl";

/**
 * Fixed iteration count. dt = 1 / this, so the total effect a stroke shows is
 * independent of it; raising it only refines the time resolution.
 */
export const WET_LAYER_ITERATIONS = 32;

/**
 * Seed texels per field texel. The diffusion reaches `sqrt(2 * D * N)` grid
 * cells whatever the coefficients are — under four cells at the stability
 * limit — so a bleed wider than that comes from a coarser grid, not from more
 * iterations and not from stepping the stencil out (which splits the grid into
 * independent lattices and prints them as a grid of blobs).
 *
 * Reach is `cells * scale`, so the factor is the stencil width the stepped
 * kernel used: the bleed lands the same distance out as before.
 */
export function resolveWetFieldScale(
	bleedRadius: number,
	brushRadiusPx: number,
): number {
	const reach = Math.max(
		1,
		bleedRadius * brushRadiusPx * WET_BLEED_TEXELS_PER_SIZE,
	);
	// The grid still has to resolve the stroke itself. Coarser than this and
	// the brush spans a handful of cells, so the upsample spreads it into a
	// blob that buries whatever it was painted over.
	const cap = Math.max(
		1,
		Math.floor((brushRadiusPx * 2) / MIN_FIELD_CELLS_ACROSS_BRUSH),
	);
	return Math.min(cap, Math.max(1, Math.round(reach * WET_STEPPED_MEAN)));
}

/** Bleed reach in seed texels per unit of `bleedRadius * brushRadius`. */
const WET_BLEED_TEXELS_PER_SIZE = 0.32;
/** The stepped kernel alternated full and 0.55 width; its mean set the reach. */
const WET_STEPPED_MEAN = (1 + 0.55) / 2;
/** Field cells the brush diameter must keep, whatever the bleed asks for. */
const MIN_FIELD_CELLS_ACROSS_BRUSH = 12;

/** The coarser grid the fields run on, in field texels. */
type WetFieldGrid = { width: number; height: number; scale: number };

/** The dab pass's seed targets, in location order (see WET_SEED_TARGETS). */
export interface WetLayerSeedTextures {
	pigment: GPUTexture;
	fluidVelocity: GPUTexture;
	moisture: GPUTexture;
	absorptionGranulation: GPUTexture;
	softnessEdgeDarkening: GPUTexture;
	edgeRoughness: GPUTexture;
}

export interface WetLayerApplyParams {
	seeds: WetLayerSeedTextures;
	/** Simulation domain size in texels. */
	domain: { width: number; height: number };
	/** World position of the domain's top-left texel and its world scale. */
	domainWorldOrigin: { x: number; y: number };
	domainWorldPerPixel: number;
	/** Where the result composites, and how its pixels map to the world. */
	target: GPUTextureView;
	targetResolution: { width: number; height: number };
	targetWorldOrigin: { x: number; y: number };
	targetWorldPerPixel: number;
	/** Brush radius in domain texels; the advection reach references it. */
	brushRadiusPx: number;
	/** WetConfig, the stroke-level half of the wet settings. */
	bleedRadius: number;
	pigmentLoad: number;
	grainScale: number;
	randomSeed: number;
	/** Paper grain strength applied at composite time. */
	paperGrain: number;
	/** Random per-texel displacement of the pigment read, in domain texels. */
	scatter: number;
}

/**
 * The wet layer simulation (design §13): seed the fields from a stroke's dab
 * pass, diffuse them, and composite the result.
 *
 * Structurally this is v1's WetInkPass with the coefficients moved out of the
 * uniforms and into the fields, which is what lets one stroke behave
 * differently along its length. Everything the pass allocates is sized to the
 * simulation domain, which is resolved from the stroke's own bounds and brush
 * size (appendix B-2) and never from the viewport, so the result stays a pure
 * function of the stroke.
 */
export class WetLayerPass {
	private readonly device: GPUDevice;
	private readonly colorFormat: GPUTextureFormat;
	private pipelines: {
		seed: GPUComputePipeline;
		diffuse: GPUComputePipeline;
		finish: GPURenderPipeline;
		seedLayout: GPUBindGroupLayout;
		diffuseLayout: GPUBindGroupLayout;
		finishLayout: GPUBindGroupLayout;
		sampler: GPUSampler;
		uniformViews: {
			seed: ReturnType<typeof compileShaderModule>["uniformViews"][string];
			diffuse: ReturnType<typeof compileShaderModule>["uniformViews"][string];
			finish: ReturnType<typeof compileShaderModule>["uniformViews"][string];
		};
	} | null = null;
	private fields: {
		width: number;
		height: number;
		pigmentA: GPUTexture;
		pigmentB: GPUTexture;
		moistureA: GPUTexture;
		moistureB: GPUTexture;
	} | null = null;
	private retiredBuffers: GPUBuffer[] = [];
	private frameBuffers: GPUBuffer[] = [];
	private retiredFields: GPUTexture[] = [];
	private frameFields: GPUTexture[] = [];

	public constructor(device: GPUDevice, colorFormat: GPUTextureFormat) {
		this.device = device;
		this.colorFormat = colorFormat;
	}

	/** Run one stroke's simulation and composite it onto `params.target`. */
	public apply(encoder: GPUCommandEncoder, params: WetLayerApplyParams): void {
		const { width, height } = params.domain;
		if (width <= 0 || height <= 0) return;

		const scale = resolveWetFieldScale(
			params.bleedRadius,
			params.brushRadiusPx,
		);
		const field = {
			width: Math.ceil(width / scale),
			height: Math.ceil(height / scale),
			scale,
		};

		const pipelines = this.ensurePipelines();
		const fields = this.ensureFields(field.width, field.height);

		this.seedFields(encoder, params, pipelines, fields, field);
		const diffused = this.diffuse(encoder, params, pipelines, fields, field);
		this.composite(encoder, params, pipelines, diffused, field);
	}

	/** Free the buffers this frame's dispatches referenced. Called one frame
	 *  late: at end of frame the encoder has not been submitted yet. */
	public releaseFrame(): void {
		for (const buffer of this.retiredBuffers) buffer.destroy();
		this.retiredBuffers = this.frameBuffers;
		this.frameBuffers = [];
		for (const texture of this.retiredFields) texture.destroy();
		this.retiredFields = this.frameFields;
		this.frameFields = [];
	}

	public destroy(): void {
		for (const buffer of [...this.retiredBuffers, ...this.frameBuffers]) {
			buffer.destroy();
		}
		this.retiredBuffers = [];
		this.frameBuffers = [];
		for (const texture of [
			...this.retiredFields,
			...this.frameFields,
			this.fields?.pigmentA,
			this.fields?.pigmentB,
			this.fields?.moistureA,
			this.fields?.moistureB,
		]) {
			texture?.destroy();
		}
		this.retiredFields = [];
		this.frameFields = [];
		this.fields = null;
		this.pipelines = null;
	}

	private seedFields(
		encoder: GPUCommandEncoder,
		params: WetLayerApplyParams,
		pipelines: NonNullable<WetLayerPass["pipelines"]>,
		fields: NonNullable<WetLayerPass["fields"]>,
		field: WetFieldGrid,
	): void {
		const view = pipelines.uniformViews.seed;
		view.set({
			resolution: [field.width, field.height],
			seedResolution: [params.domain.width, params.domain.height],
			scale: field.scale,
		});
		const uniforms = this.uploadUniforms(view.arrayBuffer, "Wet Layer Seed");

		const pass = encoder.beginComputePass({ label: "Wet Layer Seed" });
		pass.setPipeline(pipelines.seed);
		pass.setBindGroup(
			0,
			this.device.createBindGroup({
				layout: pipelines.seedLayout,
				entries: [
					{ binding: 0, resource: { buffer: uniforms } },
					{ binding: 1, resource: params.seeds.pigment.createView() },
					{ binding: 2, resource: params.seeds.fluidVelocity.createView() },
					{ binding: 3, resource: params.seeds.moisture.createView() },
					{ binding: 4, resource: fields.pigmentA.createView() },
					{ binding: 5, resource: fields.moistureA.createView() },
				],
			}),
		);
		pass.dispatchWorkgroups(
			Math.ceil(field.width / 16),
			Math.ceil(field.height / 16),
			1,
		);
		pass.end();
	}

	private diffuse(
		encoder: GPUCommandEncoder,
		params: WetLayerApplyParams,
		pipelines: NonNullable<WetLayerPass["pipelines"]>,
		fields: NonNullable<WetLayerPass["fields"]>,
		field: WetFieldGrid,
	): { pigment: GPUTexture; moisture: GPUTexture } {
		const view = pipelines.uniformViews.diffuse;
		view.set({
			resolution: [field.width, field.height],
			seedResolution: [params.domain.width, params.domain.height],
			scale: field.scale,
			paperScale: params.grainScale,
			randomSeed: (params.randomSeed % 65521) / 65521,
			dt: 1 / WET_LAYER_ITERATIONS,
			brushRadiusPx: params.brushRadiusPx,
			bleedRadius: params.bleedRadius,
		});
		const uniforms = this.uploadUniforms(view.arrayBuffer, "Wet Layer Diffuse");

		// Two bind groups swapped each step; only the pigment and moisture
		// fields ping-pong, the seeds stay bound read-only throughout.
		const bindGroupFor = (
			srcPigment: GPUTexture,
			srcMoisture: GPUTexture,
			dstPigment: GPUTexture,
			dstMoisture: GPUTexture,
		) =>
			this.device.createBindGroup({
				layout: pipelines.diffuseLayout,
				entries: [
					{ binding: 0, resource: { buffer: uniforms } },
					{ binding: 1, resource: srcPigment.createView() },
					{ binding: 2, resource: srcMoisture.createView() },
					{ binding: 3, resource: params.seeds.fluidVelocity.createView() },
					{ binding: 4, resource: params.seeds.moisture.createView() },
					{
						binding: 5,
						resource: params.seeds.absorptionGranulation.createView(),
					},
					{
						binding: 6,
						resource: params.seeds.softnessEdgeDarkening.createView(),
					},
					{ binding: 7, resource: dstPigment.createView() },
					{ binding: 8, resource: dstMoisture.createView() },
				],
			});

		const forward = bindGroupFor(
			fields.pigmentA,
			fields.moistureA,
			fields.pigmentB,
			fields.moistureB,
		);
		const backward = bindGroupFor(
			fields.pigmentB,
			fields.moistureB,
			fields.pigmentA,
			fields.moistureA,
		);

		const pass = encoder.beginComputePass({ label: "Wet Layer Diffuse" });
		pass.setPipeline(pipelines.diffuse);
		for (let i = 0; i < WET_LAYER_ITERATIONS; i++) {
			pass.setBindGroup(0, i % 2 === 0 ? forward : backward);
			pass.dispatchWorkgroups(
				Math.ceil(field.width / 16),
				Math.ceil(field.height / 16),
				1,
			);
		}
		pass.end();

		return WET_LAYER_ITERATIONS % 2 === 0
			? { pigment: fields.pigmentA, moisture: fields.moistureA }
			: { pigment: fields.pigmentB, moisture: fields.moistureB };
	}

	private composite(
		encoder: GPUCommandEncoder,
		params: WetLayerApplyParams,
		pipelines: NonNullable<WetLayerPass["pipelines"]>,
		diffused: { pigment: GPUTexture; moisture: GPUTexture },
		field: WetFieldGrid,
	): void {
		const view = pipelines.uniformViews.finish;
		view.set({
			targetResolution: [
				params.targetResolution.width,
				params.targetResolution.height,
			],
			domainResolution: [params.domain.width, params.domain.height],
			targetWorldOrigin: [
				params.targetWorldOrigin.x,
				params.targetWorldOrigin.y,
			],
			domainWorldOrigin: [
				params.domainWorldOrigin.x,
				params.domainWorldOrigin.y,
			],
			targetWorldPerPixel: params.targetWorldPerPixel,
			domainWorldPerPixel: params.domainWorldPerPixel,
			paperGrain: params.paperGrain,
			paperScale: params.grainScale,
			scatter: params.scatter,
			pigmentLoad: params.pigmentLoad,
			randomSeed: (params.randomSeed % 65521) / 65521,
			fieldScale: field.scale,
		});
		const uniforms = this.uploadUniforms(view.arrayBuffer, "Wet Layer Finish");

		const pass = encoder.beginRenderPass({
			label: "Wet Layer Composite",
			colorAttachments: [
				{ view: params.target, loadOp: "load", storeOp: "store" },
			],
		});
		pass.setPipeline(pipelines.finish);
		pass.setBindGroup(
			0,
			this.device.createBindGroup({
				layout: pipelines.finishLayout,
				entries: [
					{ binding: 0, resource: { buffer: uniforms } },
					{ binding: 1, resource: diffused.pigment.createView() },
					{ binding: 2, resource: diffused.moisture.createView() },
					{
						binding: 3,
						resource: params.seeds.absorptionGranulation.createView(),
					},
					{
						binding: 4,
						resource: params.seeds.softnessEdgeDarkening.createView(),
					},
					{ binding: 5, resource: params.seeds.edgeRoughness.createView() },
					{ binding: 6, resource: pipelines.sampler },
				],
			}),
		);
		pass.draw(3);
		pass.end();
	}

	private uploadUniforms(data: ArrayBuffer, label: string): GPUBuffer {
		const buffer = this.device.createBuffer({
			label,
			size: data.byteLength,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		});
		this.device.queue.writeBuffer(buffer, 0, data);
		this.frameBuffers.push(buffer);
		return buffer;
	}

	/** Fields grow to fit and are never shrunk; the shaders bound every read
	 *  by the logical resolution, so a larger texture is harmless. */
	private ensureFields(
		width: number,
		height: number,
	): NonNullable<WetLayerPass["fields"]> {
		const current = this.fields;
		if (current && current.width >= width && current.height >= height) {
			return current;
		}
		const w = Math.max(width, current?.width ?? 0);
		const h = Math.max(height, current?.height ?? 0);
		// Retired, not destroyed: this frame's commands still reference the old
		// fields and have not been submitted yet. A second wet stroke wanting a
		// bigger domain would otherwise take the textures out from under the
		// first one and lose the whole frame.
		for (const texture of [
			current?.pigmentA,
			current?.pigmentB,
			current?.moistureA,
			current?.moistureB,
		]) {
			if (texture) this.frameFields.push(texture);
		}
		const field = (label: string) =>
			this.device.createTexture({
				label,
				size: [w, h],
				format: "rgba16float",
				usage:
					GPUTextureUsage.TEXTURE_BINDING |
					GPUTextureUsage.STORAGE_BINDING |
					GPUTextureUsage.COPY_SRC |
					GPUTextureUsage.COPY_DST,
			});
		this.fields = {
			width: w,
			height: h,
			pigmentA: field("Wet Layer Pigment A"),
			pigmentB: field("Wet Layer Pigment B"),
			moistureA: field("Wet Layer Moisture A"),
			moistureB: field("Wet Layer Moisture B"),
		};
		return this.fields;
	}

	private ensurePipelines(): NonNullable<WetLayerPass["pipelines"]> {
		if (this.pipelines) return this.pipelines;
		const device = this.device;

		const seed = compileShaderModule(device, {
			label: "Wet Layer Seed",
			code: WET_LAYER_SEED_SHADER,
		});
		const diffuse = compileShaderModule(device, {
			label: "Wet Layer Diffuse",
			code: WET_LAYER_DIFFUSE_SHADER,
		});
		const finish = compileShaderModule(device, {
			label: "Wet Layer Finish",
			code: WET_LAYER_FINISH_SHADER,
		});

		const computeTexture = {
			visibility: GPUShaderStage.COMPUTE,
			texture: { sampleType: "float" as const },
		};
		const storageTexture = {
			visibility: GPUShaderStage.COMPUTE,
			storageTexture: {
				access: "write-only" as const,
				format: "rgba16float" as const,
			},
		};
		const seedLayout = device.createBindGroupLayout({
			label: "Wet Layer Seed Layout",
			entries: [
				{
					binding: 0,
					visibility: GPUShaderStage.COMPUTE,
					buffer: { type: "uniform" },
				},
				{ binding: 1, ...computeTexture },
				{ binding: 2, ...computeTexture },
				{ binding: 3, ...computeTexture },
				{ binding: 4, ...storageTexture },
				{ binding: 5, ...storageTexture },
			],
		});
		const diffuseLayout = device.createBindGroupLayout({
			label: "Wet Layer Diffuse Layout",
			entries: [
				{
					binding: 0,
					visibility: GPUShaderStage.COMPUTE,
					buffer: { type: "uniform" },
				},
				{ binding: 1, ...computeTexture },
				{ binding: 2, ...computeTexture },
				{ binding: 3, ...computeTexture },
				{ binding: 4, ...computeTexture },
				{ binding: 5, ...computeTexture },
				{ binding: 6, ...computeTexture },
				{ binding: 7, ...storageTexture },
				{ binding: 8, ...storageTexture },
			],
		});
		const fragmentTexture = {
			visibility: GPUShaderStage.FRAGMENT,
			texture: { sampleType: "float" as const },
		};
		const finishLayout = device.createBindGroupLayout({
			label: "Wet Layer Finish Layout",
			entries: [
				{
					binding: 0,
					visibility: GPUShaderStage.FRAGMENT,
					buffer: { type: "uniform" },
				},
				{ binding: 1, ...fragmentTexture },
				{ binding: 2, ...fragmentTexture },
				{ binding: 3, ...fragmentTexture },
				{ binding: 4, ...fragmentTexture },
				{ binding: 5, ...fragmentTexture },
				{
					binding: 6,
					visibility: GPUShaderStage.FRAGMENT,
					sampler: { type: "filtering" },
				},
			],
		});

		this.pipelines = {
			seed: device.createComputePipeline({
				label: "Wet Layer Seed Pipeline",
				layout: device.createPipelineLayout({
					bindGroupLayouts: [seedLayout],
				}),
				compute: { module: seed.module, entryPoint: "main" },
			}),
			diffuse: device.createComputePipeline({
				label: "Wet Layer Diffuse Pipeline",
				layout: device.createPipelineLayout({
					bindGroupLayouts: [diffuseLayout],
				}),
				compute: { module: diffuse.module, entryPoint: "main" },
			}),
			finish: device.createRenderPipeline({
				label: "Wet Layer Finish Pipeline",
				layout: device.createPipelineLayout({
					bindGroupLayouts: [finishLayout],
				}),
				vertex: { module: finish.module, entryPoint: "vertexMain" },
				fragment: {
					module: finish.module,
					entryPoint: "fragmentMain",
					targets: [
						{
							format: this.colorFormat,
							blend: {
								color: {
									srcFactor: "one",
									dstFactor: "one-minus-src-alpha",
									operation: "add",
								},
								alpha: {
									srcFactor: "one",
									dstFactor: "one-minus-src-alpha",
									operation: "add",
								},
							},
						},
					],
				},
				primitive: { topology: "triangle-list" },
			}),
			seedLayout,
			diffuseLayout,
			finishLayout,
			sampler: device.createSampler({
				label: "Wet Layer Sampler",
				magFilter: "linear",
				minFilter: "linear",
			}),
			uniformViews: {
				seed: seed.uniformViews.uniforms,
				diffuse: diffuse.uniformViews.uniforms,
				finish: finish.uniformViews.uniforms,
			},
		};
		return this.pipelines;
	}
}
