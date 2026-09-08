/**
 * RibbonRenderer - the ribbon route of the brush engine. Each bezier segment
 * becomes one instance that ribbonStroke.wgsl extrudes on the GPU.
 *
 * Consecutive strokes that share a pass, bindings and texture accumulate
 * through enqueue() and draw as one instanced call on flush(); render() draws
 * a single stroke immediately for the routes that never batch.
 */

import { neutralizeSizeCurves } from "../../../../brush/access";
import {
	type BrushSettings,
	BUILTIN_BRUSH_IDS,
	type RibbonConfig,
} from "../../../../schema";
import { compileShaderModule } from "../../../../utils/wgpu-utils";
import { RENDER_SAMPLE_COUNT } from "../../CanvasLayerTypes";
import type { BrushFrameBuffers } from "./BrushFrameBuffers";
import type { BrushDrawBindings, StrokeDrawInput } from "./BrushRenderer";
import type { BrushTextureManager } from "./BrushTextureManager";
import {
	generateRibbonInstances,
	RIBBON_FLOATS_PER_INSTANCE,
	type RibbonOptions,
	type RibbonStrokeInput,
} from "./RibbonGenerator";
import { PATH_META_FLOATS } from "./shaders/dabColor.wgsl";
import { RIBBON_STROKE_SHADER } from "./shaders/ribbonStroke.wgsl";
import {
	COLOR_STOP_FLOATS,
	uploadSingleStrokeMeta,
	writeColorStop,
	writeSinglePathMeta,
} from "./strokeMeta";

/** Ribbon: subdivisions per bezier segment */
const RIBBON_STEPS = 32;
/** Ribbon: vertices per segment instance (triangle list) */
const RIBBON_VERTICES_PER_SEGMENT = RIBBON_STEPS * 6;

interface RibbonRendererDeps {
	device: GPUDevice;
	canvasFormat: GPUTextureFormat;
	textureManager: BrushTextureManager;
	buffers: BrushFrameBuffers;
	/** Group(1) layout shared with the dab pipelines. */
	strokeMetaBindGroupLayout: GPUBindGroupLayout;
	transformsBindGroupLayout: GPUBindGroupLayout;
	maskBindGroupLayout: GPUBindGroupLayout;
}

/** The texture a ribbon stroke samples, resolved against what is loaded. */
interface ResolvedRibbonTexture {
	texture: GPUTexture;
	view: GPUTextureView;
	aspectRatio: number;
}

/** Where the pending batch draws. Any difference from the next stroke's
 *  destination flushes before that stroke is accumulated. */
interface PendingBatchTarget {
	pass: GPURenderPassEncoder;
	bindings: BrushDrawBindings;
	texture: ResolvedRibbonTexture;
}

interface RibbonPipeline {
	pipeline: GPURenderPipeline;
	bindGroupLayout: GPUBindGroupLayout;
	unitVertexBuffer: GPUBuffer;
	sampler: GPUSampler;
}

export class RibbonRenderer {
	private readonly device: GPUDevice;
	private readonly canvasFormat: GPUTextureFormat;
	private readonly textureManager: BrushTextureManager;
	private readonly buffers: BrushFrameBuffers;
	private readonly strokeMetaBindGroupLayout: GPUBindGroupLayout;
	private readonly transformsBindGroupLayout: GPUBindGroupLayout;
	private readonly maskBindGroupLayout: GPUBindGroupLayout;

	private ribbonPipeline: RibbonPipeline | null = null;
	private readonly textureViewCache = new Map<string, GPUTextureView>();

	/** The strokes accumulated since the last flush and where they draw. */
	private readonly batch = {
		target: null as PendingBatchTarget | null,
		instances: new FloatArena(1024),
		pathMetas: new FloatArena(256),
		colorStops: new FloatArena(256),
	};
	/** Group(1) of the last flush, reused while the pooled buffers repeat. */
	private cachedBindGroup1: {
		bindGroup: GPUBindGroup;
		pathMetaBuffer: GPUBuffer;
		colorStopsBuffer: GPUBuffer;
	} | null = null;

	public constructor(deps: RibbonRendererDeps) {
		this.device = deps.device;
		this.canvasFormat = deps.canvasFormat;
		this.textureManager = deps.textureManager;
		this.buffers = deps.buffers;
		this.strokeMetaBindGroupLayout = deps.strokeMetaBindGroupLayout;
		this.transformsBindGroupLayout = deps.transformsBindGroupLayout;
		this.maskBindGroupLayout = deps.maskBindGroupLayout;
	}

	/** Draw one ribbon stroke immediately. */
	public render(
		pass: GPURenderPassEncoder,
		input: StrokeDrawInput,
		bindings: BrushDrawBindings,
	): void {
		const ribbon = ribbonConfigOf(input.settings);
		if (!ribbon) return;
		const texture = this.resolveTexture(ribbon);
		if (!texture) return;
		const { path, segments, settings } = input;
		const ribbonBuf = generateRibbonInstances(
			segments,
			ribbonStrokeInputOf(settings),
			0,
			path.strokeWidths,
			ribbonOptionsWithCurves(settings, ribbon, path.strokeWidthsBaked),
			path.pathStart ?? 0,
			path.pathEnd ?? 1,
		);
		if (ribbonBuf.segmentCount === 0) return;

		const ribbonBuffer = this.uploadInstances(
			ribbonBuf.data.subarray(
				0,
				ribbonBuf.segmentCount * RIBBON_FLOATS_PER_INSTANCE,
			),
		);
		const meta = uploadSingleStrokeMeta(
			this.device,
			this.buffers,
			input,
			texture.aspectRatio,
		);
		const bindGroup1 = this.device.createBindGroup({
			label: "Ribbon Bind Group 1",
			layout: this.strokeMetaBindGroupLayout,
			entries: [
				{ binding: 0, resource: { buffer: meta.pathMetaBuffer } },
				{ binding: 1, resource: { buffer: meta.colorStopsBuffer } },
			],
		});
		this.draw(
			pass,
			bindings,
			texture,
			ribbonBuffer,
			bindGroup1,
			ribbonBuf.segmentCount,
		);
	}

	/**
	 * Queue a ribbon stroke into the batch; flush() draws the whole batch at
	 * once. A stroke whose pass, bindings or texture differ from the pending
	 * batch flushes it first, so paint order is preserved.
	 */
	public enqueue(
		pass: GPURenderPassEncoder,
		input: StrokeDrawInput,
		bindings: BrushDrawBindings,
	): void {
		const ribbon = ribbonConfigOf(input.settings);
		if (!ribbon) return;
		const texture = this.resolveTexture(ribbon);
		if (!texture) return;
		const { batch } = this;
		if (
			batch.target &&
			!sameBatchTarget(batch.target, pass, bindings, texture)
		) {
			this.flush();
		}

		const { path, segments, settings } = input;
		const ribbonBuf = generateRibbonInstances(
			segments,
			ribbonStrokeInputOf(settings),
			batch.pathMetas.used / PATH_META_FLOATS,
			path.strokeWidths,
			ribbonOptionsWithCurves(settings, ribbon, path.strokeWidthsBaked),
			path.pathStart ?? 0,
			path.pathEnd ?? 1,
		);
		if (ribbonBuf.segmentCount === 0) return;

		batch.target ??= { pass, bindings, texture };

		const floatsNeeded = ribbonBuf.segmentCount * RIBBON_FLOATS_PER_INSTANCE;
		const instanceOffset = batch.instances.reserve(floatsNeeded);
		batch.instances.data.set(
			ribbonBuf.data.subarray(0, floatsNeeded),
			instanceOffset,
		);
		this.writePathMeta(input, texture.aspectRatio);
	}

	/** Draw the accumulated batch as one instanced call. */
	public flush(): void {
		const { batch } = this;
		const target = batch.target;
		if (!target) return;
		batch.target = null;
		const segmentCount = batch.instances.used / RIBBON_FLOATS_PER_INSTANCE;
		if (segmentCount === 0) {
			this.resetBatch();
			return;
		}

		const pathMetas = batch.pathMetas.view();
		const pathMetaBuffer = this.buffers.acquirePathMetaBuffer(
			pathMetas.byteLength,
		);
		this.device.queue.writeBuffer(
			pathMetaBuffer,
			0,
			pathMetas.buffer,
			pathMetas.byteOffset,
			pathMetas.byteLength,
		);

		const colorStops = batch.colorStops.view();
		const colorStopsBuffer = this.buffers.acquireColorStopsBuffer(
			Math.max(colorStops.byteLength, COLOR_STOP_FLOATS * 4),
		);
		if (colorStops.length > 0) {
			this.device.queue.writeBuffer(
				colorStopsBuffer,
				0,
				colorStops.buffer,
				colorStops.byteOffset,
				colorStops.byteLength,
			);
		}

		if (
			this.cachedBindGroup1?.pathMetaBuffer !== pathMetaBuffer ||
			this.cachedBindGroup1.colorStopsBuffer !== colorStopsBuffer
		) {
			this.cachedBindGroup1 = {
				bindGroup: this.device.createBindGroup({
					label: "Ribbon Batch Bind Group 1",
					layout: this.strokeMetaBindGroupLayout,
					entries: [
						{ binding: 0, resource: { buffer: pathMetaBuffer } },
						{ binding: 1, resource: { buffer: colorStopsBuffer } },
					],
				}),
				pathMetaBuffer,
				colorStopsBuffer,
			};
		}

		this.draw(
			target.pass,
			target.bindings,
			target.texture,
			this.uploadInstances(batch.instances.view()),
			this.cachedBindGroup1.bindGroup,
			segmentCount,
		);
		this.resetBatch();
	}

	public destroy(): void {
		this.batch.target = null;
		this.resetBatch();
		this.textureViewCache.clear();
		this.cachedBindGroup1 = null;
		this.ribbonPipeline?.unitVertexBuffer.destroy();
		this.ribbonPipeline = null;
	}

	private draw(
		pass: GPURenderPassEncoder,
		bindings: BrushDrawBindings,
		texture: ResolvedRibbonTexture,
		ribbonBuffer: GPUBuffer,
		bindGroup1: GPUBindGroup,
		segmentCount: number,
	): void {
		const { pipeline, bindGroupLayout, unitVertexBuffer, sampler } =
			this.ensureRibbonPipeline();
		const bindGroup0 = this.device.createBindGroup({
			label: "Ribbon Bind Group 0",
			layout: bindGroupLayout,
			entries: [
				{ binding: 0, resource: { buffer: bindings.uniformBuffer } },
				{ binding: 1, resource: { buffer: ribbonBuffer } },
				{ binding: 2, resource: texture.view },
				{ binding: 3, resource: sampler },
			],
		});
		pass.setPipeline(pipeline);
		pass.setVertexBuffer(0, unitVertexBuffer);
		pass.setBindGroup(0, bindGroup0);
		pass.setBindGroup(1, bindGroup1);
		if (bindings.transformsBindGroup) {
			pass.setBindGroup(2, bindings.transformsBindGroup);
		}
		pass.setBindGroup(3, bindings.maskBindGroup);
		pass.draw(RIBBON_VERTICES_PER_SEGMENT, segmentCount, 0, 0);
	}

	private uploadInstances(view: Float32Array): GPUBuffer {
		const buffer = this.buffers.acquireInstances(view.byteLength);
		this.device.queue.writeBuffer(
			buffer,
			0,
			view.buffer as ArrayBuffer,
			view.byteOffset,
			view.byteLength,
		);
		return buffer;
	}

	/** Resolve the ribbon's texture, falling back to the built-in soft circle
	 *  while the requested file is not loaded. Null when nothing is bound. */
	private resolveTexture(ribbon: RibbonConfig): ResolvedRibbonTexture | null {
		const preferredUid =
			ribbon.source.kind === "file"
				? ribbon.source.fileUid
				: BUILTIN_BRUSH_IDS.softCircle;
		const uid = this.textureManager.hasTexture(preferredUid)
			? preferredUid
			: BUILTIN_BRUSH_IDS.softCircle;
		const texture = this.textureManager.getTexture(uid);
		if (!texture) return null;
		let view = this.textureViewCache.get(uid);
		if (!view) {
			view = texture.createView();
			this.textureViewCache.set(uid, view);
		}
		return {
			texture,
			view,
			aspectRatio: this.textureManager.getTextureAspectRatio(uid),
		};
	}

	/** Batch PathMeta write: appends the stroke's gradient stops to the
	 *  batch's shared color-stop arena, then writes the entry itself. */
	private writePathMeta(
		input: StrokeDrawInput,
		textureAspectRatio: number,
	): void {
		const { batch } = this;
		const stopOffset = batch.colorStops.used / COLOR_STOP_FLOATS;
		if (input.strokeColor.type === "stroke-gradient") {
			const stops = input.strokeColor.gradient.stops;
			const offset = batch.colorStops.reserve(stops.length * COLOR_STOP_FLOATS);
			for (let i = 0; i < stops.length; i++) {
				writeColorStop(
					batch.colorStops.data,
					offset + i * COLOR_STOP_FLOATS,
					stops[i],
				);
			}
		}
		const metaOffset = batch.pathMetas.reserve(PATH_META_FLOATS);
		writeSinglePathMeta(
			batch.pathMetas.data,
			metaOffset,
			input,
			stopOffset,
			textureAspectRatio,
		);
	}

	private resetBatch(): void {
		this.batch.instances.reset();
		this.batch.pathMetas.reset();
		this.batch.colorStops.reset();
	}

	/** Lazy-init ribbon pipeline (bezier segment instancing) */
	private ensureRibbonPipeline(): RibbonPipeline {
		if (this.ribbonPipeline) return this.ribbonPipeline;

		// Static unit vertex buffer: [t, side] pairs forming triangle-list strips
		const vertexData = new Float32Array(RIBBON_VERTICES_PER_SEGMENT * 2);
		for (let i = 0; i < RIBBON_STEPS; i++) {
			const t0 = i / RIBBON_STEPS;
			const t1 = (i + 1) / RIBBON_STEPS;
			const off = i * 12; // 6 verts * 2 floats
			// Triangle 1: (t0,-1), (t1,-1), (t0,+1)
			vertexData[off] = t0;
			vertexData[off + 1] = -1;
			vertexData[off + 2] = t1;
			vertexData[off + 3] = -1;
			vertexData[off + 4] = t0;
			vertexData[off + 5] = 1;
			// Triangle 2: (t0,+1), (t1,-1), (t1,+1)
			vertexData[off + 6] = t0;
			vertexData[off + 7] = 1;
			vertexData[off + 8] = t1;
			vertexData[off + 9] = -1;
			vertexData[off + 10] = t1;
			vertexData[off + 11] = 1;
		}

		const unitVertexBuffer = this.device.createBuffer({
			label: "Ribbon Unit Vertex Buffer",
			size: vertexData.byteLength,
			usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
		});
		this.device.queue.writeBuffer(unitVertexBuffer, 0, vertexData);

		// Sampler with repeat U for seamless tiling. Brush textures carry mip
		// chains for the dab pipeline; pin this one to level 0 so ribbons keep
		// their full-resolution look.
		const sampler = this.device.createSampler({
			label: "Ribbon Repeat Sampler",
			magFilter: "linear",
			minFilter: "linear",
			lodMaxClamp: 0,
			addressModeU: "repeat",
			addressModeV: "clamp-to-edge",
		});

		const { module: shaderModule } = compileShaderModule(this.device, {
			label: "Ribbon Stroke Shader",
			code: RIBBON_STROKE_SHADER,
		});

		const bindGroupLayout = this.device.createBindGroupLayout({
			label: "Ribbon Bind Group Layout 0",
			entries: [
				{
					binding: 0,
					visibility: GPUShaderStage.VERTEX,
					buffer: { type: "uniform" },
				},
				{
					binding: 1,
					visibility: GPUShaderStage.VERTEX,
					buffer: { type: "read-only-storage" },
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

		const pipelineLayout = this.device.createPipelineLayout({
			label: "Ribbon Pipeline Layout",
			bindGroupLayouts: [
				bindGroupLayout,
				this.strokeMetaBindGroupLayout,
				this.transformsBindGroupLayout,
				this.maskBindGroupLayout,
			],
		});

		const blendState: GPUBlendState = {
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

		const pipeline = this.device.createRenderPipeline({
			label: "Ribbon Stroke Pipeline",
			layout: pipelineLayout,
			vertex: {
				module: shaderModule,
				entryPoint: "vs_main",
				buffers: [
					{
						arrayStride: 8, // 2 floats (t, side)
						stepMode: "vertex",
						attributes: [
							{
								shaderLocation: 0,
								offset: 0,
								format: "float32x2",
							},
						],
					},
				],
			},
			fragment: {
				module: shaderModule,
				entryPoint: "fs_main",
				targets: [{ format: this.canvasFormat, blend: blendState }],
			},
			primitive: { topology: "triangle-list", cullMode: "none" },
			multisample: { count: RENDER_SAMPLE_COUNT },
		});

		this.ribbonPipeline = {
			pipeline,
			bindGroupLayout,
			unitVertexBuffer,
			sampler,
		};
		return this.ribbonPipeline;
	}
}

function ribbonConfigOf(settings: BrushSettings): RibbonConfig | undefined {
	return settings.engine === "ribbon" ? settings.ribbon : undefined;
}

function sameBatchTarget(
	pending: PendingBatchTarget,
	pass: GPURenderPassEncoder,
	bindings: BrushDrawBindings,
	texture: ResolvedRibbonTexture,
): boolean {
	return (
		pending.pass === pass &&
		pending.bindings.uniformBuffer === bindings.uniformBuffer &&
		pending.bindings.transformsBindGroup === bindings.transformsBindGroup &&
		pending.bindings.maskBindGroup === bindings.maskBindGroup &&
		pending.texture.texture === texture.texture
	);
}

/** A grow-only Float32Array and how much of it the batch has filled. */
class FloatArena {
	public data = new Float32Array(0);
	public used = 0;
	private readonly minFloats: number;

	public constructor(minFloats: number) {
		this.minFloats = minFloats;
	}

	/** Claim `floats` more entries; returns the offset to write them at. */
	public reserve(floats: number): number {
		const offset = this.used;
		this.used += floats;
		if (this.data.length < this.used) {
			const next = new Float32Array(
				Math.max(this.used, this.data.length * 2, this.minFloats),
			);
			next.set(this.data);
			this.data = next;
		}
		return offset;
	}

	public view(): Float32Array {
		return this.data.subarray(0, this.used);
	}

	public reset(): void {
		this.used = 0;
	}
}

// ================================================================
// BrushSettings -> generator input adapters
//
// Express BrushSettings in the vocabulary RibbonGenerator consumes. The
// settings object stays the source of truth; these only reshape it.
// ================================================================

/** What the ribbon geometry reads, taken off the settings. The width's
 *  pressure response is a two-point line from -k to 0; the generator wants
 *  that k back. */
function ribbonStrokeInputOf(settings: BrushSettings): RibbonStrokeInput {
	const sizeCurve = settings.properties.size?.curves?.find(
		(curve) => curve.input === "pressure",
	);
	return {
		size: settings.properties.size?.base ?? 10,
		opacity: settings.strokeOpacity,
		flow: settings.properties.flow?.base ?? 1,
		sizeByPressure: sizeCurve ? -(sizeCurve.points[0][1] ?? 0) : 0,
		colorMode: settings.colorMode,
		taperStart: settings.taperStart,
		taperEnd: settings.taperEnd,
	};
}

/** Ribbon options plus the settings whose curves modulate width and
 *  opacity. Baked paths carry the size curves' evaluation in strokeWidths,
 *  which the ribbon applies as its side ratios; size then evaluates from the
 *  base. */
function ribbonOptionsWithCurves(
	settings: BrushSettings,
	ribbon: RibbonConfig,
	strokeWidthsBaked: boolean | undefined,
): RibbonOptions {
	return {
		uvMode: ribbon.uvMode,
		flipU: ribbon.flipU ?? false,
		flipV: ribbon.flipV ?? false,
		tileSpacing:
			ribbon.uvMode === "stretch" ? 0 : Math.max(ribbon.tileSpacing, 0),
		curved: strokeWidthsBaked ? neutralizeSizeCurves(settings) : settings,
	};
}
