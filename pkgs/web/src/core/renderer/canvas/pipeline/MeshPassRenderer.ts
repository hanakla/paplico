import {
	compileShaderModule,
	type StructuredView,
} from "../../../utils/wgpu-utils";
import type { GPUTimingProfiler } from "../../GPUTimingProfiler";
import { MESH_LIT_SHADER } from "../../shaders/meshLit.wgsl";
import { FrameUniformPool } from "./FrameUniformPool";
import { TexturePool } from "./TexturePool";

/**
 * GPU geometry consumed by the mesh pass (interleaved pos3 + normal3 + fill-uv2
 * + wrap-uv2, 10 floats/vertex).
 */
export interface MeshPassGeometry {
	vertexBuffer: GPUBuffer;
	indexBuffer: GPUBuffer;
	indexCount: number;
}

export interface MeshPassParams {
	/** Column-major 4x4 clip transform. */
	mvp: Float32Array;
	/** Column-major rotation-only model matrix (doubles as normal matrix). */
	model: Float32Array;
	baseColor: [number, number, number, number];
	/** Direction toward the light (world space). */
	lightDir: [number, number, number];
	/** Light color tinting diffuse/specular. Absent = white. */
	lightColor?: [number, number, number, number];
	/** Shaded-side (ambient) color. Absent = neutral 0.25 gray. */
	shadowColor?: [number, number, number, number];
	/** 0 = flat, 1 = lambert, 2 = blinn-phong. */
	shadingMode: number;
	specularPower: number;
	/** Premultiplied albedo texture sampled via the vertex uv. Absent = baseColor. */
	fillTexture?: GPUTexture | null;
	/** Used sub-rect of `fillTexture` (minU, minV, maxU, maxV). Samples are
	 *  clamped to it. Default full. */
	texUvRect?: [number, number, number, number];
	/**
	 * Affine vertex-uv → texture-uv remap rows: texU = dot((u, v, 1), uvRemapU),
	 * texV likewise. Absent = plain texUvRect mapping. Lets a caller whose baked
	 * content lives in a different affine frame (e.g. rotated/scaled world bake)
	 * address it from the mesh's own uv space.
	 */
	uvRemapU?: [number, number, number];
	uvRemapV?: [number, number, number];
	/** PBR-ish surface. Absent = neutral (roughness 0.5, metal/reflect/glass 0). */
	pbr?: MeshPassPbr;
	/** Rim (fresnel) term. Absent/null = disabled. */
	fresnel?: MeshPassFresnel | null;
	/**
	 * Tiled surface pattern (Illustrator "Materials" style), sampled via the
	 * wrap uv (uv2) with a repeat address mode. Absent = no surface texture.
	 * When present it takes priority over `fillTexture` as the albedo.
	 */
	patternTexture?: GPUTexture | null;
	/** Inverse effective tile size in world units: [1/(tileW·scaleX), 1/(tileH·scaleY)]. */
	patternInvTile?: [number, number];
	/** Tile rotation in radians. Default 0. */
	patternRotation?: number;
	/** Tile uv offset [x, y]. Default [0, 0]. */
	patternOffset?: [number, number];
	/** Pattern opacity, independent of the surface/fill alpha. Default 1. */
	patternOpacity?: number;
}

interface MeshPassPbr {
	/** Analytic-env reflection sharpness (0 = mirror, 1 = flat). */
	roughness: number;
	/** 0 = dielectric, 1 = metal. */
	metalness: number;
	/** Analytic hemisphere-env reflection strength (0 = off). */
	reflectivity: number;
	/** Coverage reduction so the backdrop shows through (0 = opaque). */
	glass: number;
}

interface MeshPassFresnel {
	/** Rim color (rgb; alpha is ignored — presence is the enable). */
	color: [number, number, number];
	bias: number;
	scale: number;
	intensity: number;
	factor: number;
}

export const MESH_PASS_DEPTH_FORMAT: GPUTextureFormat = "depth24plus";
/**
 * MSAA sample count for the mesh pass. The rest of the document renderer
 * antialiases analytically in the fragment shader (distance-to-edge
 * smoothstep, see bezierPath.wgsl.ts) rather than via hardware MSAA — but a
 * raster 3D mesh silhouette carries no such distance field, so its edges are
 * hard 0/1 coverage. That let a sliver of backdrop show through at face
 * seams and the solid's outline (reported as a faint background-colored
 * artifact there). 4 is the WebGPU-guaranteed-supported multisample count.
 */
const MESH_MSAA_SAMPLE_COUNT = 4;

/**
 * Generic lit-mesh offscreen pass: mesh + Material3D-shaped params + matrix
 * → one depth-tested draw into the configured color attachment (premultiplied
 * alpha). Deliberately free of extrude-specific logic so a future
 * Mesh3DObject renderer can reuse it as-is.
 */
export class MeshPassRenderer {
	private pipeline: GPURenderPipeline | null = null;
	/** Two-target variant (color + screen-space normal), built on demand. */
	private pipelineMRT: GPURenderPipeline | null = null;
	/** Depth-only pre-pass so the color pass draws just the front-most surface. */
	private depthPrepassPipeline: GPURenderPipeline | null = null;
	private module: GPUShaderModule | null = null;
	private bindGroupLayout: GPUBindGroupLayout | null = null;
	private uniformsView: StructuredView | null = null;
	private sampler: GPUSampler | null = null;
	/** Repeat-address sampler for the tiled surface pattern. */
	private patternSampler: GPUSampler | null = null;
	/** 1x1 transparent stand-in bound when a draw has no fill/pattern texture. */
	private placeholderTexture: GPUTexture | null = null;
	private readonly uniformPool: FrameUniformPool;
	/** Private pool for the MSAA color/depth/normal scratch attachments (see
	 *  encodePass) — never exposed to callers, resolved into their single-
	 *  sample color/normal textures before returning. */
	private readonly msaaPool: TexturePool;

	/** Normal MRT attachment format (screen-space normal xy + coverage). */
	public static readonly NORMAL_FORMAT: GPUTextureFormat = "rgba8unorm";

	public constructor(
		private readonly device: GPUDevice,
		public readonly colorFormat: GPUTextureFormat = "rgba8unorm",
	) {
		this.msaaPool = new TexturePool(device);
		this.uniformPool = new FrameUniformPool(device, "Mesh Pass Uniforms");
	}

	public initialize(): void {
		if (this.pipeline) return;

		const { module, uniformViews } = compileShaderModule(this.device, {
			label: "Mesh Lit Shader",
			code: MESH_LIT_SHADER,
		});
		this.uniformsView = uniformViews.uniforms;
		this.module = module;

		this.sampler = this.device.createSampler({
			label: "Mesh Pass Albedo Sampler",
			magFilter: "linear",
			minFilter: "linear",
			addressModeU: "clamp-to-edge",
			addressModeV: "clamp-to-edge",
		});
		this.patternSampler = this.device.createSampler({
			label: "Mesh Pass Pattern Sampler",
			magFilter: "linear",
			minFilter: "linear",
			addressModeU: "repeat",
			addressModeV: "repeat",
		});
		this.placeholderTexture = this.device.createTexture({
			label: "Mesh Pass Albedo Placeholder",
			size: [1, 1],
			format: "rgba8unorm",
			usage: GPUTextureUsage.TEXTURE_BINDING,
		});

		this.bindGroupLayout = this.device.createBindGroupLayout({
			label: "Mesh Pass Bind Group Layout",
			entries: [
				{
					binding: 0,
					visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
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
				{
					binding: 4,
					visibility: GPUShaderStage.FRAGMENT,
					sampler: { type: "filtering" },
				},
			],
		});

		this.pipeline = this.device.createRenderPipeline({
			label: "Mesh Pass Pipeline",
			layout: this.device.createPipelineLayout({
				bindGroupLayouts: [this.bindGroupLayout],
			}),
			vertex: {
				module,
				entryPoint: "vertexMain",
				buffers: [
					{
						arrayStride: 10 * 4,
						attributes: [
							{ shaderLocation: 0, offset: 0, format: "float32x3" },
							{ shaderLocation: 1, offset: 12, format: "float32x3" },
							{ shaderLocation: 2, offset: 24, format: "float32x2" },
							{ shaderLocation: 3, offset: 32, format: "float32x2" },
						],
					},
				],
			},
			fragment: {
				module,
				entryPoint: "fragmentMain",
				targets: [
					{
						format: this.colorFormat,
						blend: {
							color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
							alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
						},
					},
				],
			},
			primitive: { topology: "triangle-list", cullMode: "none" },
			// The depth pre-pass has already written the nearest depth; only
			// front-most fragments pass, so back faces never blend through
			// transparent albedo regardless of triangle order.
			depthStencil: {
				format: MESH_PASS_DEPTH_FORMAT,
				depthWriteEnabled: false,
				depthCompare: "less-equal",
			},
			multisample: { count: MESH_MSAA_SAMPLE_COUNT },
		});

		// Depth-only pre-pass: write the whole mesh's nearest depth before any
		// color is blended. No fragment stage — vertex position + depth only.
		this.depthPrepassPipeline = this.device.createRenderPipeline({
			label: "Mesh Pass Depth Pre-pass Pipeline",
			layout: this.device.createPipelineLayout({
				bindGroupLayouts: [this.bindGroupLayout],
			}),
			vertex: {
				module,
				entryPoint: "vertexMain",
				buffers: [
					{
						arrayStride: 10 * 4,
						attributes: [
							{ shaderLocation: 0, offset: 0, format: "float32x3" },
							{ shaderLocation: 1, offset: 12, format: "float32x3" },
							{ shaderLocation: 2, offset: 24, format: "float32x2" },
							{ shaderLocation: 3, offset: 32, format: "float32x2" },
						],
					},
				],
			},
			primitive: { topology: "triangle-list", cullMode: "none" },
			depthStencil: {
				format: MESH_PASS_DEPTH_FORMAT,
				depthWriteEnabled: true,
				depthCompare: "less",
			},
			multisample: { count: MESH_MSAA_SAMPLE_COUNT },
		});
	}

	/** Reset the per-draw uniform buffer pool. Call once per frame. */
	public beginFrame(): void {
		this.uniformPool.beginFrame();
		this.msaaPool.resetFrame();
	}

	/** Lazily build the color+normal MRT pipeline (glass refraction only). */
	private getMRTPipeline(): GPURenderPipeline {
		if (this.pipelineMRT) return this.pipelineMRT;
		this.pipelineMRT = this.device.createRenderPipeline({
			label: "Mesh Pass Pipeline (MRT)",
			layout: this.device.createPipelineLayout({
				bindGroupLayouts: [this.bindGroupLayout!],
			}),
			vertex: {
				module: this.module!,
				entryPoint: "vertexMain",
				buffers: [
					{
						arrayStride: 10 * 4,
						attributes: [
							{ shaderLocation: 0, offset: 0, format: "float32x3" },
							{ shaderLocation: 1, offset: 12, format: "float32x3" },
							{ shaderLocation: 2, offset: 24, format: "float32x2" },
							{ shaderLocation: 3, offset: 32, format: "float32x2" },
						],
					},
				],
			},
			fragment: {
				module: this.module!,
				entryPoint: "fragmentMainMRT",
				targets: [
					{
						format: this.colorFormat,
						blend: {
							color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
							alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
						},
					},
					// Normal target: no blend — the front-most fragment wins via
					// depth, so its normal/coverage is what survives.
					{ format: MeshPassRenderer.NORMAL_FORMAT },
				],
			},
			primitive: { topology: "triangle-list", cullMode: "none" },
			// Front-most only, via the shared depth pre-pass (see the color pipeline).
			depthStencil: {
				format: MESH_PASS_DEPTH_FORMAT,
				depthWriteEnabled: false,
				depthCompare: "less-equal",
			},
			multisample: { count: MESH_MSAA_SAMPLE_COUNT },
		});
		return this.pipelineMRT;
	}

	/**
	 * Encode a full pass drawing the mesh into `colorTexture` (and
	 * `normalTexture`, MRT variant). The textures may be pool-quantized larger
	 * than the used area — the viewport restricts rasterization to the
	 * top-left `used` region. Internally renders MSAA and resolves into these
	 * single-sample targets; depth is pass-private and never exposed.
	 */
	public encodePass(
		encoder: GPUCommandEncoder,
		colorTexture: GPUTexture,
		used: { width: number; height: number },
		geometry: MeshPassGeometry,
		params: MeshPassParams,
		/** Present = MRT variant: also write the screen-space normal here. */
		normalTexture?: GPUTexture | null,
		profiler?: GPUTimingProfiler | null,
	): void {
		if (!this.pipeline || !this.bindGroupLayout || !this.uniformsView) {
			console.warn("MeshPassRenderer used before initialize()");
			return;
		}

		const rect = params.texUvRect ?? [0, 0, 1, 1];
		this.uniformsView.set({
			mvp: params.mvp,
			model: params.model,
			baseColor: params.baseColor,
			lightDir: [...params.lightDir, 0],
			lightColor: params.lightColor ?? [1, 1, 1, 1],
			shadowColor: params.shadowColor ?? [0.25, 0.25, 0.25, 1],
			shadingParams: [
				params.shadingMode,
				params.specularPower,
				params.fillTexture ? 1 : 0,
				params.patternTexture ? 1 : 0,
			],
			texUvRect: rect,
			uvRemapU: params.uvRemapU
				? [...params.uvRemapU, 0]
				: [rect[2] - rect[0], 0, rect[0], 0],
			uvRemapV: params.uvRemapV
				? [...params.uvRemapV, 0]
				: [0, rect[3] - rect[1], rect[1], 0],
			pbrParams: [
				params.pbr?.roughness ?? 0.5,
				params.pbr?.metalness ?? 0,
				params.pbr?.reflectivity ?? 0,
				params.pbr?.glass ?? 0,
			],
			fresnelParams: [
				params.fresnel?.bias ?? 0,
				params.fresnel?.scale ?? 1,
				params.fresnel?.intensity ?? 1,
				params.fresnel?.factor ?? 5,
			],
			fresnelColor: params.fresnel
				? [...params.fresnel.color, 1]
				: [1, 1, 1, 0],
			patternParams: [
				...(params.patternInvTile ?? [0, 0]),
				Math.cos(params.patternRotation ?? 0),
				Math.sin(params.patternRotation ?? 0),
			],
			patternOffset: [
				...(params.patternOffset ?? [0, 0]),
				params.patternOpacity ?? 1,
				0,
			],
		});
		const uniformBuffer = this.uniformPool.write(this.uniformsView.arrayBuffer);

		const bindGroup = this.device.createBindGroup({
			label: "Mesh Pass Bind Group",
			layout: this.bindGroupLayout,
			entries: [
				{ binding: 0, resource: { buffer: uniformBuffer } },
				{
					binding: 1,
					resource: (
						params.fillTexture ?? this.placeholderTexture!
					).createView(),
				},
				{ binding: 2, resource: this.sampler! },
				{
					binding: 3,
					resource: (
						params.patternTexture ?? this.placeholderTexture!
					).createView(),
				},
				{ binding: 4, resource: this.patternSampler! },
			],
		});

		// MSAA scratch attachments, sized to match the resolve targets exactly
		// (resolveTarget and its MSAA attachment must be the same size — the
		// resolve targets may be pool-quantized larger than `used`). Acquired
		// from a private pool and released right after use; safe within the
		// same command encoder since recorded commands execute in submission
		// order (see TexturePool's release() doc).
		const msaaColor = this.msaaPool.acquire(
			colorTexture.width,
			colorTexture.height,
			this.colorFormat,
			MESH_MSAA_SAMPLE_COUNT,
			GPUTextureUsage.RENDER_ATTACHMENT,
			"Mesh Pass MSAA Color",
		);
		const msaaDepth = this.msaaPool.acquire(
			colorTexture.width,
			colorTexture.height,
			MESH_PASS_DEPTH_FORMAT,
			MESH_MSAA_SAMPLE_COUNT,
			GPUTextureUsage.RENDER_ATTACHMENT,
			"Mesh Pass MSAA Depth",
		);
		const msaaNormal = normalTexture
			? this.msaaPool.acquire(
					normalTexture.width,
					normalTexture.height,
					MeshPassRenderer.NORMAL_FORMAT,
					MESH_MSAA_SAMPLE_COUNT,
					GPUTextureUsage.RENDER_ATTACHMENT,
					"Mesh Pass MSAA Normal",
				)
			: null;
		const msaaDepthView = msaaDepth.createView();

		// Depth pre-pass: establish the nearest surface for the whole mesh so the
		// color pass below only draws front-most fragments (back faces stay
		// hidden through transparent albedo, independent of triangle order).
		const depthPass = encoder.beginRenderPass({
			label: "Mesh Depth Pre-pass",
			colorAttachments: [],
			depthStencilAttachment: {
				view: msaaDepthView,
				depthClearValue: 1.0,
				depthLoadOp: "clear",
				depthStoreOp: "store",
			},
		});
		depthPass.setViewport(0, 0, used.width, used.height, 0, 1);
		depthPass.setPipeline(this.depthPrepassPipeline!);
		depthPass.setBindGroup(0, bindGroup);
		depthPass.setVertexBuffer(0, geometry.vertexBuffer);
		depthPass.setIndexBuffer(geometry.indexBuffer, "uint32");
		depthPass.drawIndexed(geometry.indexCount);
		depthPass.end();

		const colorAttachments: GPURenderPassColorAttachment[] = [
			{
				view: msaaColor.createView(),
				resolveTarget: colorTexture.createView(),
				clearValue: { r: 0, g: 0, b: 0, a: 0 },
				loadOp: "clear",
				storeOp: "discard",
			},
		];
		if (msaaNormal && normalTexture) {
			colorAttachments.push({
				view: msaaNormal.createView(),
				resolveTarget: normalTexture.createView(),
				clearValue: { r: 0, g: 0, b: 0, a: 0 },
				loadOp: "clear",
				storeOp: "discard",
			});
		}
		const pass = encoder.beginRenderPass({
			label: "Mesh Pass",
			colorAttachments,
			depthStencilAttachment: {
				view: msaaDepthView,
				depthLoadOp: "load",
				depthStoreOp: "discard",
			},
			timestampWrites: profiler?.timestampWrites("Extrude Mesh"),
		});
		pass.setViewport(0, 0, used.width, used.height, 0, 1);
		pass.setPipeline(msaaNormal ? this.getMRTPipeline() : this.pipeline);
		pass.setBindGroup(0, bindGroup);
		pass.setVertexBuffer(0, geometry.vertexBuffer);
		pass.setIndexBuffer(geometry.indexBuffer, "uint32");
		pass.drawIndexed(geometry.indexCount);
		pass.end();

		this.msaaPool.release(msaaColor);
		this.msaaPool.release(msaaDepth);
		this.msaaPool.release(msaaNormal);
	}

	public destroy(): void {
		this.msaaPool.destroy();
		this.uniformPool.destroy();
		this.placeholderTexture?.destroy();
		this.placeholderTexture = null;
		this.sampler = null;
		this.patternSampler = null;
		this.pipeline = null;
		this.pipelineMRT = null;
		this.depthPrepassPipeline = null;
		this.bindGroupLayout = null;
		this.uniformsView = null;
	}
}
