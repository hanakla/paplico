import type { BoundingBox } from "../../../../schema";
import { compileShaderModule } from "../../../../utils/wgpu-utils";
import { BRUSH_MIX_SHADER } from "./shaders/brushMix.wgsl";

/** Fixed chunk length of the mix pipeline. */
export const MIX_CHUNK_SIZE = 64;

export type MixChunkArgs = {
	/** DabInstanceLayout instance buffer holding the whole stroke. */
	dabBuffer: GPUBuffer;
	/** Absolute index of the chunk's first dab inside dabBuffer. */
	firstDab: number;
	/** Number of dabs in this chunk (≤ MIX_CHUNK_SIZE). */
	dabCount: number;
	/** Per-dab {colorRate, alphaRate, smudgeLength, _} vec4s. The binding
	 *  starts at mixParamsOffsetBytes so a whole-stroke buffer can serve
	 *  chunk-local indexing (offset must be 256-byte aligned — chunk stride
	 *  64×16B satisfies this). */
	mixParams: GPUBuffer;
	mixParamsOffsetBytes?: number;
	/** Backdrop snapshot below the stroke (premultiplied). */
	below: GPUTexture;
	/** World rect covered by `below` (and `stroke` when present). */
	belowBounds: BoundingBox;
	/** Current stroke buffer state, composited over `below` when sampling. */
	stroke?: GPUTexture | null;
	/** World rect `stroke` covers; defaults to belowBounds. */
	strokeBounds?: BoundingBox;
	/** PathMeta buffer of the stroke (color / gradient mode / transform index). */
	pathMetas: GPUBuffer;
	/** Gradient color stops referenced by the PathMeta. */
	colorStops: GPUBuffer;
	/** Element transforms buffer, indexed by PathMeta.transformIndex. */
	transforms: GPUBuffer;
	/** Footprint radius as a ratio of the dab radius (MixingConfig.sampleRadius). */
	sampleRadiusRatio: number;
	/** Sample offset along the stroke direction in footprint radii (-2..2). */
	sampleTrail: number;
	/** 0 = vivid (OkLCH), 1 = muted (OkLAB). */
	blendStyle: number;
	/** Tip falloff LUT array (r8unorm 256×1×32) weighting the footprint. */
	falloffLut: GPUTexture;
	/** Persistent bucket state from createBucket(), carried across chunks. */
	bucket: GPUBuffer;
	/** Output: dabCount × vec4f resolved straight-alpha colors, chunk-local
	 *  indexing from outColorsOffsetBytes (same alignment rule as mixParams). */
	outColors: GPUBuffer;
	outColorsOffsetBytes?: number;
};

/**
 * Chunked dab-color resolution for color mixing: per chunk, a
 * footprint-weighted sample compute (one workgroup per dab) followed by a
 * sequential bucket scan that writes per-dab resolved colors. Chunks of one
 * stroke must be resolved in dab order — the bucket buffer carries the smudge
 * state between them, which makes the result a pure function of
 * (backdrop, dab list).
 */
export class MixPass {
	private readonly device: GPUDevice;
	private readonly bindGroupLayout: GPUBindGroupLayout;
	private readonly samplePipeline: GPUComputePipeline;
	private readonly scanPipeline: GPUComputePipeline;
	private readonly sampler: GPUSampler;
	private readonly samples: GPUBuffer;
	private readonly uniformSource: ReturnType<
		typeof compileShaderModule
	>["uniformViews"][string];
	private pendingUniformBuffers: GPUBuffer[] = [];
	private retiredUniformBuffers: GPUBuffer[] = [];

	public constructor(device: GPUDevice) {
		this.device = device;
		const { module, uniformViews } = compileShaderModule(device, {
			label: "Brush Mix Shader",
			code: BRUSH_MIX_SHADER,
		});
		this.uniformSource = uniformViews.u;

		// cs_sample and cs_scan reference different binding subsets, so an
		// "auto" layout would drop bindings from either pipeline; both share
		// one explicit layout instead.
		this.bindGroupLayout = device.createBindGroupLayout({
			label: "Brush Mix Bind Group Layout",
			entries: [
				{
					binding: 0,
					visibility: GPUShaderStage.COMPUTE,
					buffer: { type: "uniform" },
				},
				{
					binding: 1,
					visibility: GPUShaderStage.COMPUTE,
					buffer: { type: "read-only-storage" },
				},
				{
					binding: 2,
					visibility: GPUShaderStage.COMPUTE,
					buffer: { type: "read-only-storage" },
				},
				{
					binding: 3,
					visibility: GPUShaderStage.COMPUTE,
					texture: { sampleType: "float" },
				},
				{
					binding: 4,
					visibility: GPUShaderStage.COMPUTE,
					texture: { sampleType: "float" },
				},
				{
					binding: 5,
					visibility: GPUShaderStage.COMPUTE,
					sampler: { type: "filtering" },
				},
				{
					binding: 6,
					visibility: GPUShaderStage.COMPUTE,
					texture: { sampleType: "float", viewDimension: "2d-array" },
				},
				{
					binding: 7,
					visibility: GPUShaderStage.COMPUTE,
					buffer: { type: "storage" },
				},
				{
					binding: 8,
					visibility: GPUShaderStage.COMPUTE,
					buffer: { type: "storage" },
				},
				{
					binding: 9,
					visibility: GPUShaderStage.COMPUTE,
					buffer: { type: "storage" },
				},
				{
					binding: 10,
					visibility: GPUShaderStage.COMPUTE,
					buffer: { type: "read-only-storage" },
				},
				{
					binding: 11,
					visibility: GPUShaderStage.COMPUTE,
					buffer: { type: "read-only-storage" },
				},
				{
					binding: 12,
					visibility: GPUShaderStage.COMPUTE,
					buffer: { type: "read-only-storage" },
				},
			],
		});
		const layout = device.createPipelineLayout({
			bindGroupLayouts: [this.bindGroupLayout],
		});
		this.samplePipeline = device.createComputePipeline({
			label: "Brush Mix Sample Pipeline",
			layout,
			compute: { module, entryPoint: "cs_sample" },
		});
		this.scanPipeline = device.createComputePipeline({
			label: "Brush Mix Scan Pipeline",
			layout,
			compute: { module, entryPoint: "cs_scan" },
		});
		this.sampler = device.createSampler({
			label: "Brush Mix Sampler",
			minFilter: "linear",
			magFilter: "linear",
		});
		this.samples = device.createBuffer({
			label: "Brush Mix Chunk Samples",
			size: MIX_CHUNK_SIZE * 16,
			usage: GPUBufferUsage.STORAGE,
		});
	}

	/** Fresh persistent bucket; alpha < 0 marks "not yet initialized". */
	public createBucket(): GPUBuffer {
		const bucket = this.device.createBuffer({
			label: "Brush Mix Bucket",
			size: 16,
			usage:
				GPUBufferUsage.STORAGE |
				GPUBufferUsage.COPY_DST |
				GPUBufferUsage.COPY_SRC,
		});
		this.device.queue.writeBuffer(bucket, 0, new Float32Array([0, 0, 0, -1]));
		return bucket;
	}

	public resolveChunk(encoder: GPUCommandEncoder, args: MixChunkArgs): void {
		if (args.dabCount <= 0 || args.dabCount > MIX_CHUNK_SIZE) {
			throw new Error(`Mix chunk size out of range: ${args.dabCount}`);
		}
		// One uniform buffer per chunk: queue.writeBuffer applies before the
		// encoder submits, so reusing one buffer across chunks in the same
		// encoder would make the last write win for every dispatch.
		this.uniformSource.set({
			belowMin: [args.belowBounds.minX, args.belowBounds.minY],
			belowSize: [args.belowBounds.width, args.belowBounds.height],
			strokeMin: [
				(args.strokeBounds ?? args.belowBounds).minX,
				(args.strokeBounds ?? args.belowBounds).minY,
			],
			strokeSize: [
				(args.strokeBounds ?? args.belowBounds).width,
				(args.strokeBounds ?? args.belowBounds).height,
			],
			firstDab: args.firstDab,
			dabCount: args.dabCount,
			sampleRadiusRatio: args.sampleRadiusRatio,
			sampleTrail: args.sampleTrail,
			blendStyle: args.blendStyle,
			hasStroke: args.stroke ? 1 : 0,
		});
		const uniformBuffer = this.device.createBuffer({
			label: "Brush Mix Chunk Uniforms",
			size: this.uniformSource.arrayBuffer.byteLength,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		});
		this.device.queue.writeBuffer(
			uniformBuffer,
			0,
			this.uniformSource.arrayBuffer,
		);
		this.pendingUniformBuffers.push(uniformBuffer);

		const bindGroup = this.device.createBindGroup({
			layout: this.bindGroupLayout,
			entries: [
				{ binding: 0, resource: { buffer: uniformBuffer } },
				{ binding: 1, resource: { buffer: args.dabBuffer } },
				{
					binding: 2,
					resource: {
						buffer: args.mixParams,
						offset: args.mixParamsOffsetBytes ?? 0,
						size: args.dabCount * 16,
					},
				},
				{ binding: 3, resource: args.below.createView() },
				{
					binding: 4,
					resource: (args.stroke ?? args.below).createView(),
				},
				{ binding: 5, resource: this.sampler },
				{ binding: 6, resource: args.falloffLut.createView() },
				{ binding: 7, resource: { buffer: this.samples } },
				{ binding: 8, resource: { buffer: args.bucket } },
				{
					binding: 9,
					resource: {
						buffer: args.outColors,
						offset: args.outColorsOffsetBytes ?? 0,
						size: args.dabCount * 16,
					},
				},
				{ binding: 10, resource: { buffer: args.pathMetas } },
				{ binding: 11, resource: { buffer: args.colorStops } },
				{ binding: 12, resource: { buffer: args.transforms } },
			],
		});

		const pass = encoder.beginComputePass({ label: "Brush Mix Chunk" });
		pass.setBindGroup(0, bindGroup);
		pass.setPipeline(this.samplePipeline);
		pass.dispatchWorkgroups(args.dabCount);
		pass.setPipeline(this.scanPipeline);
		pass.dispatchWorkgroups(1);
		pass.end();
	}

	/**
	 * Hand this frame's per-chunk uniform buffers over for destruction one
	 * frame later: at end-of-frame the encoder that references them has not
	 * been submitted yet, so destroying immediately invalidates the submit.
	 */
	public retireChunkResources(): void {
		for (const buffer of this.retiredUniformBuffers) buffer.destroy();
		this.retiredUniformBuffers = this.pendingUniformBuffers;
		this.pendingUniformBuffers = [];
	}

	public destroy(): void {
		for (const buffer of [
			...this.retiredUniformBuffers,
			...this.pendingUniformBuffers,
		]) {
			buffer.destroy();
		}
		this.retiredUniformBuffers = [];
		this.pendingUniformBuffers = [];
		this.samples.destroy();
	}
}
