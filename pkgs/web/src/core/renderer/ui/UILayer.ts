import type { Artboard, Viewport } from "../../schema";
import { compileShaderModule } from "../../utils/wgpu-utils";
import type { GPUTimingProfiler } from "../GPUTimingProfiler";
import { createGeometryPipeline } from "../PipelineFactory";
import { BEZIER_PATH_SHADER } from "../shaders/bezierPath.wgsl";
import { FILL_TRIANGLE_SHADER } from "../shaders/fillTriangle.wgsl";
import { SIMPLE_BLIT_SHADER } from "../shaders/simpleBlit.wgsl";
import type { UIOverlayState } from "../types";
import { buildArtboardOverlay } from "./builders/artboard";
import {
	BEZIER_INSTANCE_FLOATS,
	FILL_TRIANGLE_INSTANCE_FLOATS,
	LoweringScratch,
	lowerScene,
	type OverlayGroup,
} from "./lowering";
import { OVERLAY_Z, UI_THEME } from "./theme";

/**
 * UI Layer - Renders interactive UI elements (selection, handles, etc.)
 *
 * Rendering is a three-stage pipeline:
 * 1. collect — gather pre-built UIPrimitives from the generic overlay channel
 *    (`UIOverlayState.overlays`, produced via builders/ + overlaySink) plus the
 *    system artboard frames (document artboards in artboard edit mode).
 * 2. lower — lowering.ts sorts primitives by (z, insertion order) and emits
 *    ordered triangle-fill and cubic-bezier-stroke instance runs.
 * 3. draw — upload both instance streams, replay their ordered runs, then blit
 *    the resolved overlay onto the canvas.
 *
 * Strokes are cubic Bezier segments expanded to quads on the GPU. Closed fills
 * are triangulated on the CPU and rendered as instanced triangles; only their
 * contour edges receive fragment-shader anti-aliasing.
 *
 * References:
 * - Vello's unified fill/stroke pipeline: https://github.com/linebender/vello/blob/main/vello_shaders/shader/flatten.wgsl
 * - GPU-friendly Stroke Expansion: https://arxiv.org/abs/2405.00127
 */

// Instanced bezier path rendering constants
const BEZIER_STEPS = 20;
// triangle-list quad strip: 20 steps × 6 vertices (2 triangles per quad)
const UNIT_BEZIER_VERTEX_COUNT = BEZIER_STEPS * 6;
const PREMULTIPLIED_ALPHA_BLEND: GPUBlendState = {
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
};

export class UILayer {
	private device: GPUDevice;
	private canvasFormat: GPUTextureFormat;
	private strokeBezierPipeline: GPURenderPipeline;
	private fillTrianglePipeline: GPURenderPipeline;
	private bindGroup: GPUBindGroup;

	private currentViewport: Viewport | null = null;

	/** Persistent CPU-side instance scratch (grow-only, reused every frame). */
	private scratch = new LoweringScratch();
	/** Persistent GPU instance buffers (grown 1.5x on demand). */
	private strokeInstanceBuffer: GPUBuffer | null = null;
	private strokeInstanceBufferCapacity = 0;
	private fillInstanceBuffer: GPUBuffer | null = null;
	private fillInstanceBufferCapacity = 0;

	/** Static parametric vertex buffer for bezier path instanced rendering. Never re-created. */
	private unitBezierBuffer: GPUBuffer;

	private resolveTexture: GPUTexture | null = null;
	private resolveTextureWidth = 0;
	private resolveTextureHeight = 0;
	private blitPipeline: GPURenderPipeline | null = null;
	private blitBindGroupLayout: GPUBindGroupLayout | null = null;
	private blitSampler: GPUSampler | null = null;
	private blitBindGroup: GPUBindGroup | null = null;

	public constructor(
		device: GPUDevice,
		viewportBindGroupLayout: GPUBindGroupLayout,
		bindGroup: GPUBindGroup,
		canvasFormat: GPUTextureFormat,
	) {
		this.device = device;
		this.canvasFormat = canvasFormat;
		this.bindGroup = bindGroup;
		this.strokeBezierPipeline = this.createStrokeBezierPipeline(
			viewportBindGroupLayout,
		);
		this.fillTrianglePipeline = this.createFillTrianglePipeline(
			viewportBindGroupLayout,
		);

		// Bezier quad strip: BEZIER_STEPS quads, each = 6 vertices [t, side].
		const bezierVerts = new Float32Array(UNIT_BEZIER_VERTEX_COUNT * 2);
		let bIdx = 0;
		for (let i = 0; i < BEZIER_STEPS; i++) {
			const t0 = i / BEZIER_STEPS;
			const t1 = (i + 1) / BEZIER_STEPS;
			// Triangle 1: (t0, -1), (t0, +1), (t1, +1)
			bezierVerts[bIdx++] = t0;
			bezierVerts[bIdx++] = -1;
			bezierVerts[bIdx++] = t0;
			bezierVerts[bIdx++] = 1;
			bezierVerts[bIdx++] = t1;
			bezierVerts[bIdx++] = 1;
			// Triangle 2: (t0, -1), (t1, +1), (t1, -1)
			bezierVerts[bIdx++] = t0;
			bezierVerts[bIdx++] = -1;
			bezierVerts[bIdx++] = t1;
			bezierVerts[bIdx++] = 1;
			bezierVerts[bIdx++] = t1;
			bezierVerts[bIdx++] = -1;
		}
		this.unitBezierBuffer = device.createBuffer({
			label: "Unit Bezier Vertex Buffer",
			size: bezierVerts.byteLength,
			usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
			mappedAtCreation: true,
		});
		new Float32Array(this.unitBezierBuffer.getMappedRange()).set(bezierVerts);
		this.unitBezierBuffer.unmap();
	}

	public updateViewport(viewport: Viewport): void {
		this.currentViewport = viewport;
	}

	public destroy(): void {
		this.strokeInstanceBuffer?.destroy();
		this.strokeInstanceBuffer = null;
		this.fillInstanceBuffer?.destroy();
		this.fillInstanceBuffer = null;
		this.unitBezierBuffer.destroy();
		this.resolveTexture?.destroy();
		this.resolveTexture = null;
	}

	public render(
		encoder: GPUCommandEncoder,
		textureView: GPUTextureView,
		uiState: UIOverlayState,
		artboards?: Artboard[] | null,
		canvasWidth?: number,
		canvasHeight?: number,
		profiler?: GPUTimingProfiler | null,
	): void {
		const { isArtboardEditMode, overlays } = uiState;

		const overlayEntries = overlays ? Object.entries(overlays) : [];
		const hasArtboardUI =
			isArtboardEditMode && artboards && artboards.length > 0;
		if (!hasArtboardUI && overlayEntries.length === 0) return;

		const w = canvasWidth ?? 1;
		const h = canvasHeight ?? 1;
		this.ensureRenderTextures(w, h);

		// --- Collect: system artboard frames + generic overlay channel ---
		const groups: OverlayGroup[] = [];
		if (hasArtboardUI && artboards) {
			// Per-artboard frames in edit mode are system-driven (document
			// artboards), not tool overlays; selection handles arrive via the
			// generic overlay channel.
			groups.push({
				z: OVERLAY_Z.artboard,
				prims: buildArtboardOverlay(artboards, null, UI_THEME),
			});
		}
		// Generic overlay channel: entries join a stable (z, insertion order) sort.
		for (const [, overlay] of overlayEntries) {
			if (!overlay) continue;
			groups.push({
				z: overlay.zIndex ?? OVERLAY_Z.default,
				prims: overlay.primitives,
			});
		}

		// --- Lower: primitives → single instance stream ---
		const zoom = this.currentViewport?.zoom ?? 1;
		const runs = lowerScene(groups, zoom, this.scratch);
		const strokeData = this.scratch.strokes.view;
		const fillData = this.scratch.fills.view;
		const strokeInstanceBuffer =
			strokeData.byteLength > 0
				? this.ensureInstanceBuffer("stroke", strokeData.byteLength)
				: null;
		const fillInstanceBuffer =
			fillData.byteLength > 0
				? this.ensureInstanceBuffer("fill", fillData.byteLength)
				: null;
		if (strokeInstanceBuffer) {
			this.device.queue.writeBuffer(strokeInstanceBuffer, 0, strokeData);
		}
		if (fillInstanceBuffer) {
			this.device.queue.writeBuffer(fillInstanceBuffer, 0, fillData);
		}

		// --- Draw: one writeBuffer + one draw call ---
		const renderView = this.resolveTexture!.createView();
		const passDescriptor: GPURenderPassDescriptor = {
			label: "UI Layer Render Pass",
			colorAttachments: [
				{
					view: renderView,
					clearValue: { r: 0, g: 0, b: 0, a: 0 },
					loadOp: "clear",
					storeOp: "store",
				},
			],
			timestampWrites: profiler?.timestampWrites("UI"),
		};

		const passEncoder = encoder.beginRenderPass(passDescriptor);
		if (runs.length > 0) {
			passEncoder.setBindGroup(0, this.bindGroup);
			for (const run of runs) {
				if (run.kind === "fill") {
					passEncoder.setPipeline(this.fillTrianglePipeline);
					passEncoder.setVertexBuffer(0, fillInstanceBuffer!);
					passEncoder.draw(3, run.instanceCount, 0, run.firstInstance);
					continue;
				}
				passEncoder.setPipeline(this.strokeBezierPipeline);
				passEncoder.setVertexBuffer(0, this.unitBezierBuffer);
				passEncoder.setVertexBuffer(1, strokeInstanceBuffer!);
				passEncoder.draw(
					UNIT_BEZIER_VERTEX_COUNT,
					run.instanceCount,
					0,
					run.firstInstance,
				);
			}
		}
		passEncoder.end();

		// Pass 2: Blit resolved (anti-aliased) texture onto canvas with alpha blending.
		// loadOp "load" preserves CanvasLayer content beneath the UI overlay.
		const { pipeline, bindGroup } = this.ensureBlitPipeline();

		const blitPassDescriptor: GPURenderPassDescriptor = {
			label: "UI Layer Blit Pass",
			colorAttachments: [
				{
					view: textureView,
					loadOp: "load",
					storeOp: "store",
				},
			],
			timestampWrites: profiler?.timestampWrites("UI Blit"),
		};

		const blitPass = encoder.beginRenderPass(blitPassDescriptor);
		blitPass.setPipeline(pipeline);
		blitPass.setBindGroup(0, bindGroup);
		blitPass.draw(3);
		blitPass.end();
	}

	// --- Private helpers ---

	/** UI-owned instanced bezier pipeline (UILayer is the sole consumer). */
	private createFillTrianglePipeline(
		viewportBindGroupLayout: GPUBindGroupLayout,
	): GPURenderPipeline {
		const pipelineLayout = this.device.createPipelineLayout({
			bindGroupLayouts: [viewportBindGroupLayout],
		});
		const { module: fillShaderModule } = compileShaderModule(this.device, {
			label: "UI Fill Triangle Shader",
			code: FILL_TRIANGLE_SHADER,
		});
		const instanceLayout: GPUVertexBufferLayout = {
			arrayStride: FILL_TRIANGLE_INSTANCE_FLOATS * 4,
			stepMode: "instance",
			attributes: [
				{ shaderLocation: 0, offset: 0, format: "float32x2" },
				{ shaderLocation: 1, offset: 8, format: "float32x2" },
				{ shaderLocation: 2, offset: 16, format: "float32x2" },
				{ shaderLocation: 3, offset: 24, format: "float32x4" },
				{ shaderLocation: 4, offset: 40, format: "float32" },
			],
		};
		return createGeometryPipeline({
			device: this.device,
			label: "UI Fill Triangle Pipeline",
			shaderModule: fillShaderModule,
			vertexBufferLayouts: [instanceLayout],
			pipelineLayout,
			topology: "triangle-list",
			targetFormat: this.canvasFormat,
			blend: PREMULTIPLIED_ALPHA_BLEND,
			multisampleCount: 1,
			vertexEntryPoint: "vertexMain",
			fragmentEntryPoint: "fragmentMain",
		});
	}

	private createStrokeBezierPipeline(
		viewportBindGroupLayout: GPUBindGroupLayout,
	): GPURenderPipeline {
		const pipelineLayout = this.device.createPipelineLayout({
			bindGroupLayouts: [viewportBindGroupLayout],
		});
		const { module: bezierShaderModule } = compileShaderModule(this.device, {
			label: "Bezier Path Shader",
			code: BEZIER_PATH_SHADER,
		});
		const unitVertexLayout: GPUVertexBufferLayout = {
			arrayStride: 2 * 4,
			stepMode: "vertex",
			attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }],
		};
		const instanceLayout: GPUVertexBufferLayout = {
			arrayStride: BEZIER_INSTANCE_FLOATS * 4,
			stepMode: "instance",
			attributes: [
				{ shaderLocation: 1, offset: 0, format: "float32x2" }, // p0
				{ shaderLocation: 2, offset: 8, format: "float32x2" }, // cp1
				{ shaderLocation: 3, offset: 16, format: "float32x2" }, // cp2
				{ shaderLocation: 4, offset: 24, format: "float32x2" }, // p1
				{ shaderLocation: 5, offset: 32, format: "float32x4" }, // color
				{ shaderLocation: 6, offset: 48, format: "float32" }, // halfWidth0
				{ shaderLocation: 7, offset: 52, format: "float32" }, // halfWidth1
			],
		};
		return createGeometryPipeline({
			device: this.device,
			label: "Stroke Bezier Pipeline",
			shaderModule: bezierShaderModule,
			vertexBufferLayouts: [unitVertexLayout, instanceLayout],
			pipelineLayout,
			topology: "triangle-list",
			targetFormat: this.canvasFormat,
			blend: PREMULTIPLIED_ALPHA_BLEND,
			multisampleCount: 1,
			vertexEntryPoint: "vertexMain",
			fragmentEntryPoint: "fragmentMain",
		});
	}

	/**
	 * Returns the persistent GPU instance buffer, grown to at least `byteSize`
	 * bytes (1.5x over-allocation to amortize future reallocations).
	 */
	private ensureInstanceBuffer(
		kind: "fill" | "stroke",
		byteSize: number,
	): GPUBuffer {
		const buffer =
			kind === "fill" ? this.fillInstanceBuffer : this.strokeInstanceBuffer;
		const currentCapacity =
			kind === "fill"
				? this.fillInstanceBufferCapacity
				: this.strokeInstanceBufferCapacity;
		if (buffer && currentCapacity >= byteSize) return buffer;

		buffer?.destroy();
		const capacity = Math.ceil(byteSize * 1.5);
		const nextBuffer = this.device.createBuffer({
			label: `UI ${kind} Instance Buffer`,
			size: capacity,
			usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
		});
		if (kind === "fill") {
			this.fillInstanceBuffer = nextBuffer;
			this.fillInstanceBufferCapacity = capacity;
		} else {
			this.strokeInstanceBuffer = nextBuffer;
			this.strokeInstanceBufferCapacity = capacity;
		}
		return nextBuffer;
	}

	/** Create or resize the UI render texture. */
	private ensureRenderTextures(width: number, height: number): void {
		if (
			this.resolveTexture &&
			this.resolveTextureWidth === width &&
			this.resolveTextureHeight === height
		)
			return;

		this.resolveTexture?.destroy();

		this.resolveTexture = this.device.createTexture({
			label: "UI Render Texture",
			size: { width, height },
			format: this.canvasFormat,
			sampleCount: 1,
			usage:
				GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
		});

		this.resolveTextureWidth = width;
		this.resolveTextureHeight = height;

		// Invalidate bind group — resolveTexture changed
		this.blitBindGroup = null;
	}

	/** Lazily create the fullscreen blit pipeline and bind group for compositing resolved MSAA output. */
	private ensureBlitPipeline(): {
		pipeline: GPURenderPipeline;
		bindGroup: GPUBindGroup;
	} {
		if (!this.blitPipeline || !this.blitBindGroupLayout) {
			const { module } = compileShaderModule(this.device, {
				label: "UI Blit Shader",
				code: SIMPLE_BLIT_SHADER,
			});

			this.blitBindGroupLayout = this.device.createBindGroupLayout({
				label: "UI Blit Bind Group Layout",
				entries: [
					{
						binding: 0,
						visibility: GPUShaderStage.FRAGMENT,
						sampler: { type: "filtering" },
					},
					{
						binding: 1,
						visibility: GPUShaderStage.FRAGMENT,
						texture: { sampleType: "float" },
					},
				],
			});

			this.blitPipeline = this.device.createRenderPipeline({
				label: "UI Blit Pipeline",
				layout: this.device.createPipelineLayout({
					bindGroupLayouts: [this.blitBindGroupLayout],
				}),
				vertex: { module, entryPoint: "vertexMain" },
				fragment: {
					module,
					entryPoint: "fragmentMain",
					targets: [
						{
							format: this.canvasFormat,
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

			this.blitSampler = this.device.createSampler({
				label: "UI Blit Sampler",
				magFilter: "linear",
				minFilter: "linear",
			});
		}

		if (!this.blitBindGroup) {
			this.blitBindGroup = this.device.createBindGroup({
				label: "UI Blit Bind Group",
				layout: this.blitBindGroupLayout!,
				entries: [
					{ binding: 0, resource: this.blitSampler! },
					{
						binding: 1,
						resource: this.resolveTexture!.createView(),
					},
				],
			});
		}

		return { pipeline: this.blitPipeline, bindGroup: this.blitBindGroup };
	}
}
