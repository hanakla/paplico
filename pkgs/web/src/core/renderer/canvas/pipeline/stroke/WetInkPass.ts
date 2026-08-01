import {
	DEFAULT_WET_INK_ABSORPTION,
	DEFAULT_WET_INK_DIFFUSION,
	DEFAULT_WET_INK_GRANULATION,
	DEFAULT_WET_INK_PICKUP_DECAY,
	DEFAULT_WET_INK_PICKUP_STRENGTH,
	DEFAULT_WET_INK_PIGMENT_LOAD,
	type WetInkSettings,
} from "../../../../schema";
import { compileShaderModule } from "../../../../utils/wgpu-utils";
import type { GPUTimingProfiler } from "../../../GPUTimingProfiler";
import { WET_INK_SHADER } from "../../../shaders/wetInk.wgsl";
import { WET_INK_DIFFUSE_SHADER } from "../../../shaders/wetInkDiffuse.wgsl";
import { WET_INK_DIFFUSE_SEED_SHADER } from "../../../shaders/wetInkDiffuseBlit.wgsl";
import { quantizeSize } from "../TexturePool";

interface SimCacheEntry {
	key: string;
	resultTexture: GPUTexture | null;
	width: number;
	height: number;
	bytes: number;
}

interface DriedCacheEntry {
	resultTexture: GPUTexture;
	width: number;
	height: number;
	bytes: number;
}

interface GroupResultCacheEntry {
	key: string;
	texture: GPUTexture;
	width: number;
	height: number;
	worldOrigin: { x: number; y: number };
	worldPerPixel: number;
	bytes: number;
}

interface GroupResultLayout {
	key: string;
	width: number;
	height: number;
	worldOrigin: { x: number; y: number };
	worldPerPixel: number;
	targetBboxPixelRect: WetInkCompositeParams["bboxPixelRect"];
	bytes: number;
}

export interface WetInkApplyParams {
	target: GPUTexture;
	pigmentView: GPUTextureView;
	flowView: GPUTextureView;
	fluidView: GPUTextureView;
	maskView: GPUTextureView;
	renderBufferView: GPUTextureView;
	bboxPixelRect: WetInkCompositeParams["bboxPixelRect"];
	domainTextureSize: WetInkCompositeParams["domainTextureSize"];
	domainWorldOrigin: WetInkCompositeParams["domainWorldOrigin"];
	domainWorldPerPixel: number;
	targetWorldOrigin: WetInkCompositeParams["targetWorldOrigin"];
	targetWorldPerPixel: number;
	randomSeed: number;
	settings: WetInkSettings;
	brushSize: number;
	cacheKey: string;
}

export interface WetInkCompositeParams {
	target: GPUTexture;
	bboxPixelRect: {
		x: number;
		y: number;
		width: number;
		height: number;
	};
	domainTextureSize: { width: number; height: number };
	domainWorldOrigin: { x: number; y: number };
	domainWorldPerPixel: number;
	targetWorldOrigin: { x: number; y: number };
	targetWorldPerPixel: number;
	randomSeed: number;
	settings: WetInkSettings;
	cacheKey: string;
}

export interface WetInkCachedResultComposite {
	params: WetInkCompositeParams;
	resultTexture: GPUTexture;
}

const SIM_CACHE_CAPACITY = 128;
const SIM_CACHE_MAX_BYTES = 192 * 1024 * 1024;
const DRYING_THRESHOLD_FRAMES = 2;
const DRIED_CACHE_MAX_BYTES = 512 * 1024 * 1024;
const GROUP_RESULT_CACHE_MIN_COMPOSITES = 2;
const GROUP_RESULT_CACHE_CAPACITY = 48;
const GROUP_RESULT_CACHE_MAX_BYTES = 128 * 1024 * 1024;
const GROUP_RESULT_CACHE_MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const DIFFUSE_WG = 16;
/**
 * Fixed diffuse iteration count (quality constant). The shader is
 * dt-normalized (dt = 1 / N), so this only sets the temporal resolution of the
 * simulation, not the total effect strength.
 */
const WET_INK_DIFFUSE_ITERATIONS = 32;
const WET_RGBA16_BYTES_PER_PIXEL = 8;

type DeferredSubmitQueue = {
	textures: Set<GPUTexture>;
	callbacks: Set<() => void>;
	scheduled: boolean;
};

const deferredSubmitQueues = new WeakMap<GPUDevice, DeferredSubmitQueue>();

function getDeferredSubmitQueue(device: GPUDevice): DeferredSubmitQueue {
	let queue = deferredSubmitQueues.get(device);
	if (queue) return queue;
	queue = {
		textures: new Set(),
		callbacks: new Set(),
		scheduled: false,
	};
	deferredSubmitQueues.set(device, queue);
	return queue;
}

function scheduleDeferredSubmitQueue(
	device: GPUDevice,
	queue: DeferredSubmitQueue,
): void {
	if (queue.scheduled) return;
	queue.scheduled = true;
	globalThis.setTimeout(() => {
		queue.scheduled = false;
		const textures = [...queue.textures];
		const callbacks = [...queue.callbacks];
		queue.textures.clear();
		queue.callbacks.clear();
		if (textures.length === 0 && callbacks.length === 0) return;
		const flush = () => {
			for (const texture of textures) {
				texture.destroy();
			}
			for (const callback of callbacks) {
				callback();
			}
		};
		void device.queue.onSubmittedWorkDone().then(
			() => flush(),
			() => flush(),
		);
	}, 0);
}

function destroyTexturesAfterCurrentSubmit(
	device: GPUDevice,
	...textures: Array<GPUTexture | null>
): void {
	const queue = getDeferredSubmitQueue(device);
	for (const texture of textures) {
		if (texture) queue.textures.add(texture);
	}
	scheduleDeferredSubmitQueue(device, queue);
}

function runAfterCurrentSubmit(device: GPUDevice, callback: () => void): void {
	const queue = getDeferredSubmitQueue(device);
	queue.callbacks.add(callback);
	scheduleDeferredSubmitQueue(device, queue);
}

/**
 * The simulation has no visible effect when bleed, directionality, absorption,
 * and speed drying are all ~0, so skip the compute passes entirely (perf
 * early-out). Otherwise always run the fixed iteration count.
 */
function resolveWetInkDiffuseIterations(settings: WetInkSettings): number {
	const eps = 0.001;
	const active =
		settings.bleedWidth > eps ||
		settings.directionality > eps ||
		(settings.absorption ?? DEFAULT_WET_INK_ABSORPTION) > eps ||
		settings.speedInfluence > eps;
	return active ? WET_INK_DIFFUSE_ITERATIONS : 0;
}

function clamp01(value: number): number {
	return Math.max(0, Math.min(1, value));
}

function wetInkTextureBytes(width: number, height: number): number {
	return width * height * WET_RGBA16_BYTES_PER_PIXEL;
}

function gpuTextureFormatBytesPerPixel(format: GPUTextureFormat): number {
	switch (format) {
		case "rgba16float":
			return 8;
		case "rgba8unorm":
		case "bgra8unorm":
			return 4;
		default:
			return 4;
	}
}

function usesRenderBufferPickup(settings: WetInkSettings): boolean {
	return (
		settings.pickupUnderlyingColor === true &&
		(settings.pickupStrength ?? DEFAULT_WET_INK_PICKUP_STRENGTH) > 0
	);
}

export function buildWetInkSimCacheKey(params: {
	pathKey: string;
	settings: WetInkSettings;
	randomSeed: number;
	brushSize: number;
	domainWorldOrigin: { x: number; y: number };
	domainWorldSize: { width: number; height: number };
	domainTextureSize: { width: number; height: number };
	domainWorldPerPixel: number;
	renderBufferKey?: string;
}): string {
	const {
		pathKey,
		settings,
		randomSeed,
		brushSize,
		domainWorldOrigin,
		domainWorldSize,
		domainTextureSize,
		domainWorldPerPixel,
		renderBufferKey = "",
	} = params;
	return [
		pathKey,
		JSON.stringify(settings),
		randomSeed,
		brushSize,
		domainWorldOrigin.x.toFixed(5),
		domainWorldOrigin.y.toFixed(5),
		domainWorldSize.width.toFixed(5),
		domainWorldSize.height.toFixed(5),
		domainTextureSize.width,
		domainTextureSize.height,
		domainWorldPerPixel.toFixed(5),
		renderBufferKey,
	].join(":");
}

const WET_INK_RESULT_COMPOSITE_SHADER = /* wgsl */ `
struct Uniforms {
	domainResolution: vec2f,
	pixelScale: vec2f,
	pixelOffset: vec2f,
	pad0: vec2f,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var wetOverlay: texture_2d<f32>;
@group(0) @binding(2) var inputSampler: sampler;

struct VertexOutput {
	@builtin(position) position: vec4f,
}

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
	var output: VertexOutput;
	let x = f32((vertexIndex & 1u) << 1u);
	let y = f32(vertexIndex & 2u);
	output.position = vec4f(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);
	return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
	let domainPx = input.position.xy * uniforms.pixelScale + uniforms.pixelOffset;
	if (
		domainPx.x < 0.0 ||
		domainPx.y < 0.0 ||
		domainPx.x >= uniforms.domainResolution.x ||
		domainPx.y >= uniforms.domainResolution.y
	) {
		return vec4f(0.0);
	}
	let texSize = vec2f(textureDimensions(wetOverlay, 0));
	let logicalMaxPx = max(uniforms.domainResolution - vec2f(1.0), vec2f(0.0));
	let samplePx = clamp(domainPx, vec2f(0.0), logicalMaxPx);
	let domainUv = (samplePx + vec2f(0.5)) / texSize;
	return textureSampleLevel(wetOverlay, inputSampler, domainUv, 0.0);
}
`;

export class WetInkPass {
	private pigmentA: GPUTexture | null = null;
	private pigmentB: GPUTexture | null = null;
	private waterA: GPUTexture | null = null;
	private waterB: GPUTexture | null = null;
	private simulationWidth = 0;
	private simulationHeight = 0;
	private sampler: GPUSampler | null = null;
	private seedPipeline: GPUComputePipeline | null = null;
	private seedBindGroupLayout: GPUBindGroupLayout | null = null;
	private diffusePipeline: GPUComputePipeline | null = null;
	private diffuseBindGroupLayout: GPUBindGroupLayout | null = null;
	private finishPipeline: GPURenderPipeline | null = null;
	private finishBindGroupLayout: GPUBindGroupLayout | null = null;
	private resultCompositePipeline: GPURenderPipeline | null = null;
	private resultCompositeBindGroupLayout: GPUBindGroupLayout | null = null;
	private simCache: Map<string, SimCacheEntry> = new Map();
	private simCacheBytes = 0;
	private driedCache: Map<string, DriedCacheEntry> = new Map();
	private driedCacheBytes = 0;
	private stableFrameCount: Map<string, number> = new Map();
	private groupResultCache: Map<string, GroupResultCacheEntry> = new Map();
	private groupResultCacheBytes = 0;
	private readonly seedUniformData = new Float32Array(20);
	private readonly diffuseUniformData = new Float32Array(16);
	private readonly finishUniformData = new Float32Array(24);
	private readonly resultCompositeUniformData = new Float32Array(16);
	private readonly uniformBufferPool = new Map<number, GPUBuffer[]>();
	private uniformPoolGeneration = 0;

	public constructor(
		private readonly device: GPUDevice,
		private readonly colorFormat: GPUTextureFormat,
	) {}

	public apply(
		encoder: GPUCommandEncoder,
		params: WetInkApplyParams,
		profiler?: GPUTimingProfiler | null,
	): void {
		if (!params.settings.enabled) return;
		const width = params.domainTextureSize.width;
		const height = params.domainTextureSize.height;
		if (width <= 0 || height <= 0) return;
		if (params.target.width <= 0 || params.target.height <= 0) return;
		if (this.compositeCached(encoder, params, profiler)) return;

		this.ensurePipelines();
		this.ensureSimulationTextures(width, height);

		let currentPigment = this.pigmentA!;
		let currentWater = this.waterA!;
		this.seedSimulationGrid(
			encoder,
			params,
			currentPigment,
			currentWater,
			profiler,
		);

		const iterations = resolveWetInkDiffuseIterations(params.settings);
		if (iterations > 0) {
			const uniformBuffer = this.createDiffuseUniformBuffer(
				params,
				width,
				height,
			);
			const pigmentAView = this.pigmentA!.createView();
			const pigmentBView = this.pigmentB!.createView();
			const waterAView = this.waterA!.createView();
			const waterBView = this.waterB!.createView();
			const diffuseBindGroupAB = this.createDiffuseBindGroup(
				uniformBuffer,
				pigmentAView,
				waterAView,
				params.flowView,
				params.fluidView,
				params.maskView,
				pigmentBView,
				waterBView,
			);
			const diffuseBindGroupBA = this.createDiffuseBindGroup(
				uniformBuffer,
				pigmentBView,
				waterBView,
				params.flowView,
				params.fluidView,
				params.maskView,
				pigmentAView,
				waterAView,
			);
			const workgroupWidth = Math.ceil(width / DIFFUSE_WG);
			const workgroupHeight = Math.ceil(height / DIFFUSE_WG);
			const pass = encoder.beginComputePass({
				label: "WetInk Diffuse Pass",
				timestampWrites: profiler?.timestampWrites("WetInk Diffuse"),
			});
			pass.setPipeline(this.diffusePipeline!);
			for (let i = 0; i < iterations; i++) {
				const bindGroup = i % 2 === 0 ? diffuseBindGroupAB : diffuseBindGroupBA;
				pass.setBindGroup(0, bindGroup);
				pass.dispatchWorkgroups(workgroupWidth, workgroupHeight, 1);
			}
			pass.end();
			currentPigment = iterations % 2 === 0 ? this.pigmentA! : this.pigmentB!;
			currentWater = iterations % 2 === 0 ? this.waterA! : this.waterB!;
		}

		const cachedResult = this.storeResultCache(
			encoder,
			params,
			currentPigment,
			currentWater,
			width,
			height,
		);
		if (cachedResult) {
			this.compositeCachedResult(encoder, params, cachedResult, profiler);
		} else {
			this.compositeDiffusedPigment(
				encoder,
				params,
				currentPigment,
				currentWater,
				"load",
				profiler,
			);
		}
	}

	public compositeCached(
		encoder: GPUCommandEncoder,
		params: WetInkCompositeParams,
		profiler?: GPUTimingProfiler | null,
	): boolean {
		const cachedResult = this.lookupCachedResult(params);
		if (cachedResult) {
			this.compositeCachedResults(encoder, [cachedResult], profiler);
			return true;
		}
		return false;
	}

	public lookupCachedResult(
		params: WetInkCompositeParams,
	): WetInkCachedResultComposite | null {
		if (!params.settings.enabled) return null;
		const width = params.domainTextureSize.width;
		const height = params.domainTextureSize.height;
		if (width <= 0 || height <= 0) return null;
		if (params.target.width <= 0 || params.target.height <= 0) return null;
		const cached = this.lookupSimCache(params.cacheKey);
		if (
			!cached?.resultTexture ||
			cached.width !== width ||
			cached.height !== height
		) {
			return null;
		}
		return { params, resultTexture: cached.resultTexture };
	}

	public lookupDried(
		contentKey: string,
		params: WetInkCompositeParams,
	): WetInkCachedResultComposite | null {
		const entry = this.driedCache.get(contentKey);
		if (!entry) return null;
		const { width, height } = params.domainTextureSize;
		if (entry.width !== width || entry.height !== height) {
			this.evictDriedEntry(contentKey, entry);
			return null;
		}
		return { params, resultTexture: entry.resultTexture };
	}

	public trackStability(contentKey: string, cacheKey: string): void {
		const count = (this.stableFrameCount.get(contentKey) ?? 0) + 1;
		if (count >= DRYING_THRESHOLD_FRAMES) {
			this.promoteToDried(contentKey, cacheKey);
			this.stableFrameCount.delete(contentKey);
			return;
		}
		this.stableFrameCount.set(contentKey, count);
	}

	public compositeCachedResults(
		encoder: GPUCommandEncoder,
		composites: readonly WetInkCachedResultComposite[],
		profiler?: GPUTimingProfiler | null,
	): void {
		if (composites.length === 0) return;
		this.ensurePipelines();
		if (this.compositeCachedResultGroup(encoder, composites, profiler)) return;
		this.compositeCachedResultsDirect(encoder, composites, "load", profiler);
	}

	private compositeCachedResultsDirect(
		encoder: GPUCommandEncoder,
		composites: readonly WetInkCachedResultComposite[],
		loadOp: GPULoadOp,
		profiler?: GPUTimingProfiler | null,
	): void {
		const target = composites[0]!.params.target;
		const pass = encoder.beginRenderPass({
			label: "WetInk Cached Result Composite Pass",
			colorAttachments: [
				{
					view: target.createView(),
					loadOp,
					storeOp: "store",
					clearValue:
						loadOp === "clear" ? { r: 0, g: 0, b: 0, a: 0 } : undefined,
				},
			],
			timestampWrites: profiler?.timestampWrites("WetInk CachedComposite"),
		});
		pass.setPipeline(this.resultCompositePipeline!);
		for (const composite of composites) {
			const { params, resultTexture } = composite;
			const uniformBuffer = this.createResultCompositeUniformBuffer(params);
			const bindGroup = this.createResultCompositeBindGroup(
				uniformBuffer,
				resultTexture,
			);
			pass.setBindGroup(0, bindGroup);
			pass.setScissorRect(
				params.bboxPixelRect.x,
				params.bboxPixelRect.y,
				params.bboxPixelRect.width,
				params.bboxPixelRect.height,
			);
			pass.draw(3, 1, 0, 0);
		}
		pass.end();
	}

	public destroy(): void {
		this.retireTexture(this.pigmentA);
		this.retireTexture(this.pigmentB);
		this.retireTexture(this.waterA);
		this.retireTexture(this.waterB);
		this.pigmentA = null;
		this.pigmentB = null;
		this.waterA = null;
		this.waterB = null;
		this.seedPipeline = null;
		this.seedBindGroupLayout = null;
		this.diffusePipeline = null;
		this.diffuseBindGroupLayout = null;
		this.finishPipeline = null;
		this.finishBindGroupLayout = null;
		this.resultCompositePipeline = null;
		this.resultCompositeBindGroupLayout = null;
		this.sampler = null;
		this.releaseUniformBuffers();
		for (const entry of this.simCache.values()) {
			this.retireTexture(entry.resultTexture);
		}
		for (const entry of this.driedCache.values()) {
			this.retireTexture(entry.resultTexture);
		}
		for (const entry of this.groupResultCache.values()) {
			this.retireTexture(entry.texture);
		}
		this.simCache.clear();
		this.simCacheBytes = 0;
		this.driedCache.clear();
		this.driedCacheBytes = 0;
		this.stableFrameCount.clear();
		this.groupResultCache.clear();
		this.groupResultCacheBytes = 0;
	}

	private ensurePipelines(): void {
		if (
			this.seedPipeline &&
			this.diffusePipeline &&
			this.finishPipeline &&
			this.resultCompositePipeline &&
			this.sampler
		) {
			return;
		}

		this.sampler = this.device.createSampler({
			label: "WetInk Sampler",
			magFilter: "linear",
			minFilter: "linear",
			addressModeU: "clamp-to-edge",
			addressModeV: "clamp-to-edge",
		});

		const { module: seedModule } = compileShaderModule(this.device, {
			label: "WetInk Seed Shader",
			code: WET_INK_DIFFUSE_SEED_SHADER,
		});
		this.seedBindGroupLayout = this.device.createBindGroupLayout({
			label: "WetInk Seed Bind Group Layout",
			entries: [
				{
					binding: 0,
					visibility: GPUShaderStage.COMPUTE,
					buffer: { type: "uniform" },
				},
				{
					binding: 1,
					visibility: GPUShaderStage.COMPUTE,
					texture: { sampleType: "float" },
				},
				{
					binding: 2,
					visibility: GPUShaderStage.COMPUTE,
					texture: { sampleType: "float" },
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
					texture: { sampleType: "float" },
				},
				{
					binding: 6,
					visibility: GPUShaderStage.COMPUTE,
					sampler: { type: "filtering" },
				},
				{
					binding: 7,
					visibility: GPUShaderStage.COMPUTE,
					storageTexture: {
						access: "write-only",
						format: "rgba16float",
						viewDimension: "2d",
					},
				},
				{
					binding: 8,
					visibility: GPUShaderStage.COMPUTE,
					storageTexture: {
						access: "write-only",
						format: "rgba16float",
						viewDimension: "2d",
					},
				},
			],
		});
		this.seedPipeline = this.device.createComputePipeline({
			label: "WetInk Seed Pipeline",
			layout: this.device.createPipelineLayout({
				bindGroupLayouts: [this.seedBindGroupLayout],
			}),
			compute: { module: seedModule, entryPoint: "main" },
		});

		const { module: diffuseModule } = compileShaderModule(this.device, {
			label: "WetInk Diffuse Shader",
			code: WET_INK_DIFFUSE_SHADER,
		});
		this.diffuseBindGroupLayout = this.device.createBindGroupLayout({
			label: "WetInk Diffuse Bind Group Layout",
			entries: [
				{
					binding: 0,
					visibility: GPUShaderStage.COMPUTE,
					buffer: { type: "uniform" },
				},
				{
					binding: 1,
					visibility: GPUShaderStage.COMPUTE,
					texture: { sampleType: "float" },
				},
				{
					binding: 2,
					visibility: GPUShaderStage.COMPUTE,
					texture: { sampleType: "float" },
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
					texture: { sampleType: "float" },
				},
				{
					binding: 6,
					visibility: GPUShaderStage.COMPUTE,
					sampler: { type: "filtering" },
				},
				{
					binding: 7,
					visibility: GPUShaderStage.COMPUTE,
					storageTexture: {
						access: "write-only",
						format: "rgba16float",
						viewDimension: "2d",
					},
				},
				{
					binding: 8,
					visibility: GPUShaderStage.COMPUTE,
					storageTexture: {
						access: "write-only",
						format: "rgba16float",
						viewDimension: "2d",
					},
				},
			],
		});
		this.diffusePipeline = this.device.createComputePipeline({
			label: "WetInk Diffuse Pipeline",
			layout: this.device.createPipelineLayout({
				bindGroupLayouts: [this.diffuseBindGroupLayout],
			}),
			compute: { module: diffuseModule, entryPoint: "main" },
		});

		const { module: finishModule } = compileShaderModule(this.device, {
			label: "WetInk Finish Shader",
			code: WET_INK_SHADER,
		});
		this.finishBindGroupLayout = this.device.createBindGroupLayout({
			label: "WetInk Finish Bind Group Layout",
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
					sampler: { type: "filtering" },
				},
			],
		});
		this.finishPipeline = this.device.createRenderPipeline({
			label: "WetInk Finish Pipeline",
			layout: this.device.createPipelineLayout({
				bindGroupLayouts: [this.finishBindGroupLayout],
			}),
			vertex: { module: finishModule, entryPoint: "vertexMain" },
			fragment: {
				module: finishModule,
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
		});

		const { module: resultCompositeModule } = compileShaderModule(this.device, {
			label: "WetInk Result Composite Shader",
			code: WET_INK_RESULT_COMPOSITE_SHADER,
		});
		this.resultCompositeBindGroupLayout = this.device.createBindGroupLayout({
			label: "WetInk Result Composite Bind Group Layout",
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
			],
		});
		this.resultCompositePipeline = this.device.createRenderPipeline({
			label: "WetInk Result Composite Pipeline",
			layout: this.device.createPipelineLayout({
				bindGroupLayouts: [this.resultCompositeBindGroupLayout],
			}),
			vertex: { module: resultCompositeModule, entryPoint: "vertexMain" },
			fragment: {
				module: resultCompositeModule,
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
		});
	}

	private ensureSimulationTextures(width: number, height: number): void {
		if (
			this.pigmentA &&
			this.pigmentB &&
			this.waterA &&
			this.waterB &&
			this.simulationWidth >= width &&
			this.simulationHeight >= height
		) {
			return;
		}
		this.retireTexture(this.pigmentA);
		this.retireTexture(this.pigmentB);
		this.retireTexture(this.waterA);
		this.retireTexture(this.waterB);
		const textureWidth = quantizeSize(Math.max(width, this.simulationWidth));
		const textureHeight = quantizeSize(Math.max(height, this.simulationHeight));
		const usage =
			GPUTextureUsage.TEXTURE_BINDING |
			GPUTextureUsage.STORAGE_BINDING |
			GPUTextureUsage.COPY_SRC |
			GPUTextureUsage.COPY_DST;
		this.pigmentA = this.device.createTexture({
			label: "WetInk Pigment A",
			size: {
				width: textureWidth,
				height: textureHeight,
				depthOrArrayLayers: 1,
			},
			format: "rgba16float",
			usage,
		});
		this.pigmentB = this.device.createTexture({
			label: "WetInk Pigment B",
			size: {
				width: textureWidth,
				height: textureHeight,
				depthOrArrayLayers: 1,
			},
			format: "rgba16float",
			usage,
		});
		this.waterA = this.device.createTexture({
			label: "WetInk Water A",
			size: {
				width: textureWidth,
				height: textureHeight,
				depthOrArrayLayers: 1,
			},
			format: "rgba16float",
			usage,
		});
		this.waterB = this.device.createTexture({
			label: "WetInk Water B",
			size: {
				width: textureWidth,
				height: textureHeight,
				depthOrArrayLayers: 1,
			},
			format: "rgba16float",
			usage,
		});
		this.simulationWidth = textureWidth;
		this.simulationHeight = textureHeight;
	}

	private seedSimulationGrid(
		encoder: GPUCommandEncoder,
		params: WetInkApplyParams,
		pigmentTarget: GPUTexture,
		waterTarget: GPUTexture,
		profiler?: GPUTimingProfiler | null,
	): void {
		const width = params.domainTextureSize.width;
		const height = params.domainTextureSize.height;
		const uniformBuffer = this.createSeedUniformBuffer(params, width, height);
		const bindGroup = this.device.createBindGroup({
			label: "WetInk Seed Bind Group",
			layout: this.seedBindGroupLayout!,
			entries: [
				{ binding: 0, resource: { buffer: uniformBuffer } },
				{ binding: 1, resource: params.pigmentView },
				{ binding: 2, resource: params.flowView },
				{ binding: 3, resource: params.fluidView },
				{ binding: 4, resource: params.maskView },
				{ binding: 5, resource: params.renderBufferView },
				{ binding: 6, resource: this.sampler! },
				{ binding: 7, resource: pigmentTarget.createView() },
				{ binding: 8, resource: waterTarget.createView() },
			],
		});
		const pass = encoder.beginComputePass({
			label: "WetInk Seed Compute Pass",
			timestampWrites: profiler?.timestampWrites("WetInk Seed"),
		});
		pass.setPipeline(this.seedPipeline!);
		pass.setBindGroup(0, bindGroup);
		pass.dispatchWorkgroups(
			Math.ceil(width / DIFFUSE_WG),
			Math.ceil(height / DIFFUSE_WG),
			1,
		);
		pass.end();
	}

	private compositeDiffusedPigment(
		encoder: GPUCommandEncoder,
		params: WetInkCompositeParams,
		pigmentSource: GPUTexture,
		waterSource: GPUTexture,
		loadOp: GPULoadOp = "load",
		profiler?: GPUTimingProfiler | null,
	): void {
		const uniformBuffer = this.createFinishUniformBuffer(params);
		const bindGroup = this.device.createBindGroup({
			label: "WetInk Finish Bind Group",
			layout: this.finishBindGroupLayout!,
			entries: [
				{ binding: 0, resource: { buffer: uniformBuffer } },
				{ binding: 1, resource: pigmentSource.createView() },
				{ binding: 2, resource: waterSource.createView() },
				{ binding: 3, resource: this.sampler! },
			],
		});
		const pass = encoder.beginRenderPass({
			label: "WetInk Finish Pass",
			colorAttachments: [
				{
					view: params.target.createView(),
					loadOp,
					storeOp: "store",
					clearValue:
						loadOp === "clear" ? { r: 0, g: 0, b: 0, a: 0 } : undefined,
				},
			],
			timestampWrites: profiler?.timestampWrites("WetInk Finish"),
		});
		pass.setPipeline(this.finishPipeline!);
		pass.setBindGroup(0, bindGroup);
		pass.setScissorRect(
			params.bboxPixelRect.x,
			params.bboxPixelRect.y,
			params.bboxPixelRect.width,
			params.bboxPixelRect.height,
		);
		pass.draw(3, 1, 0, 0);
		pass.end();
	}

	private compositeCachedResultGroup(
		encoder: GPUCommandEncoder,
		composites: readonly WetInkCachedResultComposite[],
		profiler?: GPUTimingProfiler | null,
	): boolean {
		if (composites.length < GROUP_RESULT_CACHE_MIN_COMPOSITES) return false;
		const layout = this.resolveGroupResultLayout(composites);
		if (!layout) return false;

		let entry = this.lookupGroupResultCache(layout.key);
		if (!entry) {
			entry = this.createGroupResultCacheEntry(encoder, layout, composites);
			if (!entry) return false;
		}

		const first = composites[0]!.params;
		this.compositeCachedResultsDirect(
			encoder,
			[
				{
					params: {
						...first,
						domainTextureSize: {
							width: entry.width,
							height: entry.height,
						},
						domainWorldOrigin: entry.worldOrigin,
						domainWorldPerPixel: entry.worldPerPixel,
						bboxPixelRect: layout.targetBboxPixelRect,
						cacheKey: entry.key,
					},
					resultTexture: entry.texture,
				},
			],
			"load",
			profiler,
		);
		return true;
	}

	private createGroupResultCacheEntry(
		encoder: GPUCommandEncoder,
		layout: GroupResultLayout,
		composites: readonly WetInkCachedResultComposite[],
	): GroupResultCacheEntry | null {
		if (layout.bytes > GROUP_RESULT_CACHE_MAX_ENTRY_BYTES) return null;
		if (!this.evictGroupResultCacheFor(layout.bytes)) return null;

		const texture = this.device.createTexture({
			label: "WetInk Group Result Cache",
			size: {
				width: layout.width,
				height: layout.height,
				depthOrArrayLayers: 1,
			},
			format: this.colorFormat,
			usage:
				GPUTextureUsage.RENDER_ATTACHMENT |
				GPUTextureUsage.TEXTURE_BINDING |
				GPUTextureUsage.COPY_SRC,
		});
		const groupComposites = composites.map((composite) => {
			return {
				params: {
					...composite.params,
					target: texture,
					targetWorldOrigin: layout.worldOrigin,
					targetWorldPerPixel: layout.worldPerPixel,
					bboxPixelRect: offsetPixelRect(
						composite.params.bboxPixelRect,
						layout.targetBboxPixelRect.x,
						layout.targetBboxPixelRect.y,
					),
				},
				resultTexture: composite.resultTexture,
			};
		});
		this.compositeCachedResultsDirect(encoder, groupComposites, "clear");

		const entry = {
			key: layout.key,
			texture,
			width: layout.width,
			height: layout.height,
			worldOrigin: layout.worldOrigin,
			worldPerPixel: layout.worldPerPixel,
			bytes: layout.bytes,
		};
		this.groupResultCache.set(layout.key, entry);
		this.groupResultCacheBytes += layout.bytes;
		return entry;
	}

	private resolveGroupResultLayout(
		composites: readonly WetInkCachedResultComposite[],
	): GroupResultLayout | null {
		const first = composites[0]?.params;
		if (!first) return null;
		let targetBbox = emptyPixelRect();
		const keyParts: string[] = [];

		for (const composite of composites) {
			const params = composite.params;
			if (params.target !== first.target) return null;
			if (params.targetWorldPerPixel !== first.targetWorldPerPixel) return null;
			if (params.targetWorldOrigin.x !== first.targetWorldOrigin.x) return null;
			if (params.targetWorldOrigin.y !== first.targetWorldOrigin.y) return null;
			targetBbox = unionPixelRect(targetBbox, params.bboxPixelRect);
			keyParts.push(params.cacheKey);
		}

		if (targetBbox.width <= 0 || targetBbox.height <= 0) return null;
		const width = targetBbox.width;
		const height = targetBbox.height;
		const maxSide = this.device.limits.maxTextureDimension2D;
		if (width > maxSide || height > maxSide) return null;
		const bytes = wetInkTextureBytes(width, height);
		if (
			bytes > GROUP_RESULT_CACHE_MAX_ENTRY_BYTES ||
			bytes > GROUP_RESULT_CACHE_MAX_BYTES
		) {
			return null;
		}

		const worldOrigin = {
			x: first.targetWorldOrigin.x + targetBbox.x * first.targetWorldPerPixel,
			y: first.targetWorldOrigin.y - targetBbox.y * first.targetWorldPerPixel,
		};
		const key = [
			first.target.width,
			first.target.height,
			width,
			height,
			targetBbox.x,
			targetBbox.y,
			worldOrigin.x.toFixed(5),
			worldOrigin.y.toFixed(5),
			first.targetWorldPerPixel.toFixed(5),
			...keyParts,
		].join(":");
		return {
			key,
			width,
			height,
			worldOrigin,
			worldPerPixel: first.targetWorldPerPixel,
			targetBboxPixelRect: targetBbox,
			bytes,
		};
	}

	private compositeCachedResult(
		encoder: GPUCommandEncoder,
		params: WetInkCompositeParams,
		resultSource: GPUTexture,
		profiler?: GPUTimingProfiler | null,
	): void {
		this.compositeCachedResults(
			encoder,
			[{ params, resultTexture: resultSource }],
			profiler,
		);
	}

	private createDiffuseBindGroup(
		uniformBuffer: GPUBuffer,
		sourcePigmentView: GPUTextureView,
		sourceWaterView: GPUTextureView,
		flowView: GPUTextureView,
		fluidView: GPUTextureView,
		maskView: GPUTextureView,
		targetPigmentView: GPUTextureView,
		targetWaterView: GPUTextureView,
	): GPUBindGroup {
		return this.device.createBindGroup({
			label: "WetInk Diffuse Bind Group",
			layout: this.diffuseBindGroupLayout!,
			entries: [
				{ binding: 0, resource: { buffer: uniformBuffer } },
				{ binding: 1, resource: sourcePigmentView },
				{ binding: 2, resource: sourceWaterView },
				{ binding: 3, resource: flowView },
				{ binding: 4, resource: fluidView },
				{ binding: 5, resource: maskView },
				{ binding: 6, resource: this.sampler! },
				{ binding: 7, resource: targetPigmentView },
				{ binding: 8, resource: targetWaterView },
			],
		});
	}

	private createSeedUniformBuffer(
		params: WetInkApplyParams,
		width: number,
		height: number,
	): GPUBuffer {
		const u = this.seedUniformData;
		u.fill(0);
		u[0] = width;
		u[1] = height;
		u[2] = params.target.width;
		u[3] = params.target.height;
		u[4] = params.domainWorldOrigin.x;
		u[5] = params.domainWorldOrigin.y;
		u[6] = params.targetWorldOrigin.x;
		u[7] = params.targetWorldOrigin.y;
		u[8] = params.targetWorldPerPixel;
		u[9] = params.domainWorldPerPixel;
		u[10] = params.settings.wetness;
		u[11] = params.settings.pigmentLoad ?? DEFAULT_WET_INK_PIGMENT_LOAD;
		u[12] = usesRenderBufferPickup(params.settings) ? 1 : 0;
		u[13] = params.settings.pickupStrength ?? DEFAULT_WET_INK_PICKUP_STRENGTH;
		u[14] = Math.max(params.brushSize * 0.5, 1) / params.domainWorldPerPixel;
		u[15] = params.settings.bleedWidth;
		u[16] = params.settings.pickupDecay ?? DEFAULT_WET_INK_PICKUP_DECAY;
		u[17] = params.settings.pickupBlendMode ?? 0;
		return this.writeUniformBuffer("WetInk Seed Uniform", u);
	}

	private createDiffuseUniformBuffer(
		params: WetInkApplyParams,
		width: number,
		height: number,
	): GPUBuffer {
		const u = this.diffuseUniformData;
		u.fill(0);
		u[0] = width;
		u[1] = height;
		u[2] = params.settings.bleedWidth;
		u[3] = params.settings.directionality;
		u[4] = params.settings.wetness;
		u[5] = params.settings.accelInfluence;
		u[6] = params.settings.speedInfluence;
		u[7] = params.settings.absorption ?? DEFAULT_WET_INK_ABSORPTION;
		u[8] = params.settings.granulation ?? DEFAULT_WET_INK_GRANULATION;
		u[9] = params.settings.paperScale;
		u[10] = (params.randomSeed % 65521) / 65521;
		const dt = 1 / WET_INK_DIFFUSE_ITERATIONS;
		const rawSoftness = params.settings.diffusion ?? DEFAULT_WET_INK_DIFFUSION;
		const softness = clamp01(
			Number.isFinite(rawSoftness) ? rawSoftness : DEFAULT_WET_INK_DIFFUSION,
		);
		const absorption = clamp01(
			params.settings.absorption ?? DEFAULT_WET_INK_ABSORPTION,
		);
		u[11] = dt;
		u[12] = Math.max(params.brushSize * 0.5, 1) / params.domainWorldPerPixel;
		u[13] = softness;
		u[14] = -Math.log(1 - 0.85 * absorption);
		u[15] = (0.75 - 0.35 * absorption) ** dt;
		return this.writeUniformBuffer("WetInk Diffuse Uniform", u);
	}

	private createFinishUniformBuffer(params: WetInkCompositeParams): GPUBuffer {
		const u = this.finishUniformData;
		u.fill(0);
		u[0] = params.target.width;
		u[1] = params.target.height;
		u[2] = params.domainTextureSize.width;
		u[3] = params.domainTextureSize.height;
		u[4] = params.bboxPixelRect.x;
		u[5] = params.bboxPixelRect.y;
		u[6] = params.targetWorldOrigin.x;
		u[7] = params.targetWorldOrigin.y;
		u[8] = params.domainWorldOrigin.x;
		u[9] = params.domainWorldOrigin.y;
		u[10] = params.targetWorldPerPixel;
		u[11] = params.domainWorldPerPixel;
		u[12] = params.settings.edgeDarkening;
		u[13] = params.settings.edgeRoughness;
		u[14] = params.settings.paperGrain;
		u[15] = params.settings.paperScale;
		u[16] = params.settings.wetness;
		u[17] = params.settings.pigmentLoad ?? DEFAULT_WET_INK_PIGMENT_LOAD;
		u[18] = params.settings.absorption ?? DEFAULT_WET_INK_ABSORPTION;
		u[19] = params.settings.granulation ?? DEFAULT_WET_INK_GRANULATION;
		u[20] = (params.randomSeed % 65521) / 65521;
		return this.writeUniformBuffer("WetInk Finish Uniform", u);
	}

	private createResultCompositeUniformBuffer(
		params: WetInkCompositeParams,
	): GPUBuffer {
		const u = this.resultCompositeUniformData;
		u.fill(0);
		const scaleX = params.targetWorldPerPixel / params.domainWorldPerPixel;
		const scaleY = scaleX;
		const offsetX =
			(params.targetWorldOrigin.x - params.domainWorldOrigin.x) /
			params.domainWorldPerPixel;
		const offsetY =
			(params.domainWorldOrigin.y - params.targetWorldOrigin.y) /
			params.domainWorldPerPixel;
		u[0] = params.domainTextureSize.width;
		u[1] = params.domainTextureSize.height;
		u[2] = scaleX;
		u[3] = scaleY;
		u[4] = offsetX;
		u[5] = offsetY;
		return this.writeUniformBuffer("WetInk Result Composite Uniform", u);
	}

	private createResultCompositeBindGroup(
		uniformBuffer: GPUBuffer,
		resultSource: GPUTexture,
	): GPUBindGroup {
		return this.device.createBindGroup({
			label: "WetInk Result Composite Bind Group",
			layout: this.resultCompositeBindGroupLayout!,
			entries: [
				{ binding: 0, resource: { buffer: uniformBuffer } },
				{ binding: 1, resource: resultSource.createView() },
				{ binding: 2, resource: this.sampler! },
			],
		});
	}

	private writeUniformBuffer(label: string, data: Float32Array): GPUBuffer {
		const buffer = this.acquireUniformBuffer(label, data.byteLength);
		this.device.queue.writeBuffer(buffer, 0, data);
		const generation = this.uniformPoolGeneration;
		runAfterCurrentSubmit(this.device, () => {
			this.recycleUniformBuffer(buffer, data.byteLength, generation);
		});
		return buffer;
	}

	private acquireUniformBuffer(label: string, byteLength: number): GPUBuffer {
		const buffers = this.uniformBufferPool.get(byteLength);
		const reusableBuffer = buffers?.pop();
		if (reusableBuffer) return reusableBuffer;
		const buffer = this.device.createBuffer({
			label,
			size: byteLength,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		});
		return buffer;
	}

	private recycleUniformBuffer(
		buffer: GPUBuffer,
		byteLength: number,
		generation: number,
	): void {
		if (generation !== this.uniformPoolGeneration) {
			buffer.destroy();
			return;
		}
		let buffers = this.uniformBufferPool.get(byteLength);
		if (!buffers) {
			buffers = [];
			this.uniformBufferPool.set(byteLength, buffers);
		}
		buffers.push(buffer);
	}

	private releaseUniformBuffers(): void {
		this.uniformPoolGeneration++;
		for (const buffers of this.uniformBufferPool.values()) {
			for (const buffer of buffers) {
				buffer.destroy();
			}
		}
		this.uniformBufferPool.clear();
	}

	private lookupSimCache(key: string): SimCacheEntry | null {
		const entry = this.simCache.get(key);
		if (!entry) return null;
		this.simCache.delete(key);
		this.simCache.set(key, entry);
		return entry;
	}

	private storeResultCache(
		encoder: GPUCommandEncoder,
		params: WetInkCompositeParams,
		pigmentSource: GPUTexture,
		waterSource: GPUTexture,
		width: number,
		height: number,
	): GPUTexture | null {
		const entryBytes =
			width * height * gpuTextureFormatBytesPerPixel(this.colorFormat);
		if (entryBytes > SIM_CACHE_MAX_BYTES) return null;

		const existing = this.simCache.get(params.cacheKey);
		if (existing && (existing.width !== width || existing.height !== height)) {
			this.retireSimCacheEntry(params.cacheKey, existing);
		}
		const entry = this.ensureCacheEntry(params.cacheKey, width, height);
		if (entry.resultTexture) {
			this.promoteSimCacheEntry(params.cacheKey, entry);
			return entry.resultTexture;
		}
		if (!this.evictSimCacheFor(entryBytes, false, params.cacheKey)) {
			return null;
		}

		const resultTexture = this.device.createTexture({
			label: "WetInk Result Cache",
			size: { width, height, depthOrArrayLayers: 1 },
			format: this.colorFormat,
			usage:
				GPUTextureUsage.RENDER_ATTACHMENT |
				GPUTextureUsage.TEXTURE_BINDING |
				GPUTextureUsage.COPY_SRC,
		});
		this.compositeDiffusedPigment(
			encoder,
			{
				...params,
				target: resultTexture,
				bboxPixelRect: { x: 0, y: 0, width, height },
				targetWorldOrigin: params.domainWorldOrigin,
				targetWorldPerPixel: params.domainWorldPerPixel,
			},
			pigmentSource,
			waterSource,
			"clear",
		);
		entry.resultTexture = resultTexture;
		entry.bytes += entryBytes;
		this.simCacheBytes += entryBytes;
		this.promoteSimCacheEntry(params.cacheKey, entry);
		return resultTexture;
	}

	private evictSimCacheFor(
		incomingBytes: number,
		addsEntry: boolean,
		protectedKey?: string,
	): boolean {
		while (
			(addsEntry && this.simCache.size >= SIM_CACHE_CAPACITY) ||
			this.simCacheBytes + incomingBytes > SIM_CACHE_MAX_BYTES
		) {
			const oldestKey = this.simCache.keys().next().value;
			if (oldestKey === undefined) return incomingBytes <= SIM_CACHE_MAX_BYTES;
			if (oldestKey === protectedKey) {
				const protectedEntry = this.simCache.get(oldestKey);
				if (!protectedEntry || this.simCache.size <= 1) return false;
				this.promoteSimCacheEntry(oldestKey, protectedEntry);
				continue;
			}
			const oldest = this.simCache.get(oldestKey);
			if (!oldest) {
				this.simCache.delete(oldestKey);
				continue;
			}
			this.retireSimCacheEntry(oldestKey, oldest);
		}
		return true;
	}

	private ensureCacheEntry(
		key: string,
		width: number,
		height: number,
	): SimCacheEntry {
		const existing = this.simCache.get(key);
		if (existing) {
			this.promoteSimCacheEntry(key, existing);
			return existing;
		}
		const entry: SimCacheEntry = {
			key,
			resultTexture: null,
			width,
			height,
			bytes: 0,
		};
		if (!this.evictSimCacheFor(0, true, key)) return entry;
		this.simCache.set(key, entry);
		return entry;
	}

	private promoteSimCacheEntry(key: string, entry: SimCacheEntry): void {
		this.simCache.delete(key);
		this.simCache.set(key, entry);
	}

	private lookupGroupResultCache(key: string): GroupResultCacheEntry | null {
		const entry = this.groupResultCache.get(key);
		if (!entry) return null;
		this.groupResultCache.delete(key);
		this.groupResultCache.set(key, entry);
		return entry;
	}

	private evictGroupResultCacheFor(incomingBytes: number): boolean {
		while (
			this.groupResultCache.size >= GROUP_RESULT_CACHE_CAPACITY ||
			this.groupResultCacheBytes + incomingBytes > GROUP_RESULT_CACHE_MAX_BYTES
		) {
			const oldestKey = this.groupResultCache.keys().next().value;
			if (oldestKey === undefined) {
				return incomingBytes <= GROUP_RESULT_CACHE_MAX_BYTES;
			}
			const oldest = this.groupResultCache.get(oldestKey);
			if (!oldest) {
				this.groupResultCache.delete(oldestKey);
				continue;
			}
			this.retireTexture(oldest.texture);
			this.groupResultCache.delete(oldestKey);
			this.groupResultCacheBytes = Math.max(
				0,
				this.groupResultCacheBytes - oldest.bytes,
			);
		}
		return true;
	}

	private retireSimCacheEntry(key: string, entry: SimCacheEntry): void {
		this.retireTexture(entry.resultTexture);
		this.simCache.delete(key);
		this.simCacheBytes = Math.max(0, this.simCacheBytes - entry.bytes);
	}

	private promoteToDried(contentKey: string, cacheKey: string): void {
		const entry = this.simCache.get(cacheKey);
		if (!entry?.resultTexture) return;

		this.evictDriedCacheFor(entry.bytes);

		this.driedCache.set(contentKey, {
			resultTexture: entry.resultTexture,
			width: entry.width,
			height: entry.height,
			bytes: entry.bytes,
		});
		this.driedCacheBytes += entry.bytes;

		this.simCacheBytes -= entry.bytes;
		entry.resultTexture = null;
		entry.bytes = 0;
		this.simCache.delete(cacheKey);
	}

	private evictDriedCacheFor(incomingBytes: number): void {
		while (
			this.driedCacheBytes + incomingBytes > DRIED_CACHE_MAX_BYTES &&
			this.driedCache.size > 0
		) {
			const oldestKey = this.driedCache.keys().next().value;
			if (oldestKey === undefined) break;
			const oldest = this.driedCache.get(oldestKey);
			if (!oldest) {
				this.driedCache.delete(oldestKey);
				continue;
			}
			this.evictDriedEntry(oldestKey, oldest);
		}
	}

	private evictDriedEntry(key: string, entry: DriedCacheEntry): void {
		this.retireTexture(entry.resultTexture);
		this.driedCache.delete(key);
		this.driedCacheBytes = Math.max(0, this.driedCacheBytes - entry.bytes);
	}

	private retireTexture(texture: GPUTexture | null): void {
		if (!texture) return;
		destroyTexturesAfterCurrentSubmit(this.device, texture);
	}
}

function offsetPixelRect(
	rect: WetInkCompositeParams["bboxPixelRect"],
	originX: number,
	originY: number,
): WetInkCompositeParams["bboxPixelRect"] {
	return {
		x: rect.x - originX,
		y: rect.y - originY,
		width: rect.width,
		height: rect.height,
	};
}

function emptyPixelRect(): WetInkCompositeParams["bboxPixelRect"] {
	return {
		x: Number.POSITIVE_INFINITY,
		y: Number.POSITIVE_INFINITY,
		width: 0,
		height: 0,
	};
}

function unionPixelRect(
	a: WetInkCompositeParams["bboxPixelRect"],
	b: WetInkCompositeParams["bboxPixelRect"],
): WetInkCompositeParams["bboxPixelRect"] {
	if (a.x === Number.POSITIVE_INFINITY) return { ...b };
	const x = Math.min(a.x, b.x);
	const y = Math.min(a.y, b.y);
	const xEnd = Math.max(a.x + a.width, b.x + b.width);
	const yEnd = Math.max(a.y + a.height, b.y + b.height);
	return {
		x,
		y,
		width: Math.max(0, xEnd - x),
		height: Math.max(0, yEnd - y),
	};
}
