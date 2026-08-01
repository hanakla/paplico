import type { StructuredView } from "webgpu-utils";
import type { Appearance, Filter } from "../../../schema";
import { compileShaderModule } from "../../../utils/wgpu-utils";
import type {
	FilterHandler,
	FilterProcessorContext,
	FilterRenderRequirements,
} from "../../canvas/pipeline/FilterRenderer";
import { FrameUniformPool } from "../../canvas/pipeline/FrameUniformPool";
import {
	HK_PIXEL_SORT_SHADER,
	PIXEL_SORT_CHUNK_SIZE,
} from "./hk-pixel-sort.wgsl";

export interface HKPixelSortParams {
	/** Sort line angle in degrees (0 = horizontal, 90 = vertical) */
	angle: number;
	/** Fraction of the bitonic stage schedule to run (0-1, 1 = full sort) */
	strength: number;
	ascending: boolean;
	thresholdMin: number;
	thresholdMax: number;
	/** Sort the captured backdrop instead of the element raster */
	applyToBackdrop: boolean;
}
export interface HKPixelSortFilter extends Appearance<HKPixelSortParams> {
	processor: "hk:pixel-sort";
}

/**
 * Bitonic pixel sort based on ruccho/BitonicPixelSorter (MIT):
 * https://github.com/ruccho/BitonicPixelSorter
 *
 * A compute pass sorts in-threshold spans per line in workgroup memory into
 * an intermediate rgba8unorm storage texture (the target may be a
 * non-storage format like bgra8unorm), then a blit pass copies it into the
 * target texture. Lines run at an arbitrary angle as shear-decomposed
 * digital lines, and a strength param truncates the sort schedule for
 * partial sorting. In backdrop mode the source is the captured backdrop
 * region and the pipeline masks the result to the element shape afterwards.
 */
export class HKPixelSortHandler implements FilterHandler {
	private computePipeline: GPUComputePipeline | null = null;
	private blitPipeline: GPURenderPipeline | null = null;
	private computeBindGroupLayout: GPUBindGroupLayout | null = null;
	private blitBindGroupLayout: GPUBindGroupLayout | null = null;
	private uniformView: StructuredView | null = null;
	// Per-frame pools indexed per postProcess call, reset by startFrame.
	// Entries persist across frames to avoid per-frame GPU allocations; the
	// handler instance is shared across elements/canvases, so replaced and
	// unused textures go through releaseFrame for deferred destruction.
	private sortTexturePool: { texture: GPUTexture; view: GPUTextureView }[] = [];
	private sortTexturePoolIndex = 0;
	private uniformPool: FrameUniformPool | null = null;
	private pendingRelease: GPUTexture[] = [];

	public async initialize(
		device: GPUDevice,
		canvasFormat: GPUTextureFormat,
	): Promise<void> {
		const { module, uniformViews } = compileShaderModule(device, {
			label: "HK PixelSort Filter Shader",
			code: HK_PIXEL_SORT_SHADER,
		});

		this.uniformView = uniformViews.uniforms;
		this.uniformPool = new FrameUniformPool(
			device,
			"HK PixelSort Uniform Buffer",
		);

		this.computeBindGroupLayout = device.createBindGroupLayout({
			label: "HK PixelSort Compute Bind Group Layout",
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
					storageTexture: { access: "write-only", format: "rgba8unorm" },
				},
			],
		});

		this.computePipeline = device.createComputePipeline({
			label: "HK PixelSort Compute Pipeline",
			layout: device.createPipelineLayout({
				bindGroupLayouts: [this.computeBindGroupLayout],
			}),
			compute: { module, entryPoint: "sortPass" },
		});

		this.blitBindGroupLayout = device.createBindGroupLayout({
			label: "HK PixelSort Blit Bind Group Layout",
			entries: [
				{
					binding: 3,
					visibility: GPUShaderStage.FRAGMENT,
					texture: { sampleType: "float" },
				},
			],
		});

		this.blitPipeline = device.createRenderPipeline({
			label: "HK PixelSort Blit Pipeline",
			layout: device.createPipelineLayout({
				bindGroupLayouts: [this.blitBindGroupLayout],
			}),
			vertex: { module, entryPoint: "vertexMain" },
			fragment: {
				module,
				entryPoint: "blitMain",
				targets: [{ format: canvasFormat }],
			},
			primitive: { topology: "triangle-list" },
		});
	}

	public getRenderConfigure(filter: Filter): FilterRenderRequirements {
		const f = filter as HKPixelSortFilter;
		return {
			needsBackdrop: f.paramData.params.applyToBackdrop ?? false,
			needsSourceTexture: true,
		};
	}

	public postProcess(context: FilterProcessorContext, filter: Filter): void {
		const f = filter as HKPixelSortFilter;
		const { device, sourceTexture, targetTexture, commandEncoder } = context;

		if (
			!this.computePipeline ||
			!this.blitPipeline ||
			!this.computeBindGroupLayout ||
			!this.blitBindGroupLayout ||
			!this.uniformView ||
			!this.uniformPool
		) {
			console.warn("HKPixelSortHandler not initialized");
			return;
		}

		const params = f.paramData.params;
		// Documents from the old horizontal/vertical model carry direction
		// instead of angle
		const legacyVertical =
			(params as { direction?: string }).direction === "vertical";
		const angle = params.angle ?? (legacyVertical ? 90 : 0);
		// Full-circle angle: theta picks the line direction (mod 180deg), and
		// the order flips whenever the +major-axis traversal points opposite
		// to the requested angle, so dark->bright follows the angle over the
		// whole -180..180 range (angle and angle+180 flow in opposite ways)
		const phi = (((angle % 360) + 360) % 360) * (Math.PI / 180);
		const theta = phi % Math.PI;
		const xMajor = theta <= Math.PI / 4 || theta >= Math.PI * 0.75;
		const slope = xMajor ? Math.tan(theta) : 1 / Math.tan(theta);
		const flip = phi >= Math.PI !== (xMajor && theta > Math.PI / 2);
		const ascending = (params.ascending ?? true) !== flip;

		const majorSize = xMajor ? sourceTexture.width : sourceTexture.height;
		const minorSize = xMajor ? sourceTexture.height : sourceTexture.width;
		const shearEnd = Math.floor((majorSize - 1) * slope + 0.5);
		// One slack line on both ends absorbs f32-vs-f64 disagreement with the
		// shader's per-texel shear; slack lines have no in-rect texel and
		// early-out in the shader
		const cMin = -Math.max(shearEnd, 0) - 1;
		const lines = minorSize + Math.abs(shearEnd) + 3;
		const chunks = Math.ceil(majorSize / PIXEL_SORT_CHUNK_SIZE);

		this.uniformView.set({
			thresholdMin: params.thresholdMin ?? 0,
			thresholdMax: params.thresholdMax ?? 1,
			ordering: ascending ? 1 : 0,
			xMajor: xMajor ? 1 : 0,
			slope,
			cMin,
			strength: params.strength ?? 1,
		});

		const uniformBuffer = this.uniformPool.write(this.uniformView.arrayBuffer);

		const sortTarget = this.acquireSortTexture(
			device,
			sourceTexture.width,
			sourceTexture.height,
		);

		const computeBindGroup = device.createBindGroup({
			label: "HK PixelSort Compute Bind Group",
			layout: this.computeBindGroupLayout,
			entries: [
				{ binding: 0, resource: { buffer: uniformBuffer } },
				{ binding: 1, resource: sourceTexture.createView() },
				{ binding: 2, resource: sortTarget.view },
			],
		});

		const computePass = commandEncoder.beginComputePass({
			label: "HK PixelSort Sort Pass",
		});
		computePass.setPipeline(this.computePipeline);
		computePass.setBindGroup(0, computeBindGroup);
		computePass.dispatchWorkgroups(lines, chunks);
		computePass.end();

		const blitBindGroup = device.createBindGroup({
			label: "HK PixelSort Blit Bind Group",
			layout: this.blitBindGroupLayout,
			entries: [{ binding: 3, resource: sortTarget.view }],
		});

		const pass = commandEncoder.beginRenderPass({
			label: "HK PixelSort Blit Pass",
			colorAttachments: [
				{
					view: targetTexture.createView(),
					loadOp: "clear",
					storeOp: "store",
					clearValue: { r: 0, g: 0, b: 0, a: 0 },
				},
			],
		});
		pass.setPipeline(this.blitPipeline);
		pass.setBindGroup(0, blitBindGroup);
		pass.draw(3, 1, 0, 0);
		pass.end();
	}

	public startFrame(): void {
		this.sortTexturePoolIndex = 0;
		this.uniformPool?.beginFrame();
	}

	public releaseFrame(release: (texture: GPUTexture) => void): void {
		for (const texture of this.pendingRelease) {
			release(texture);
		}
		this.pendingRelease = [];
		// Pool entries this frame didn't reach: the working set shrank
		for (const entry of this.sortTexturePool.splice(
			this.sortTexturePoolIndex,
		)) {
			release(entry.texture);
		}
	}

	public getExpansionMargin(_filter: Filter): number {
		return 0;
	}

	public onScaleFilter(params: Filter, _scale: [number, number]): Filter {
		return params;
	}

	public onInterpolate(paramsA: unknown, paramsB: unknown, t: number): unknown {
		const a = paramsA as HKPixelSortFilter["paramData"]["params"];
		const b = paramsB as HKPixelSortFilter["paramData"]["params"];
		return {
			angle: a.angle + (b.angle - a.angle) * t,
			strength: a.strength + (b.strength - a.strength) * t,
			ascending: t < 0.5 ? a.ascending : b.ascending,
			thresholdMin: a.thresholdMin + (b.thresholdMin - a.thresholdMin) * t,
			thresholdMax: a.thresholdMax + (b.thresholdMax - a.thresholdMax) * t,
			applyToBackdrop: t < 0.5 ? a.applyToBackdrop : b.applyToBackdrop,
		};
	}

	public destroy(): void {
		for (const entry of this.sortTexturePool) {
			entry.texture.destroy();
		}
		this.sortTexturePool = [];
		this.sortTexturePoolIndex = 0;
		for (const texture of this.pendingRelease) {
			texture.destroy();
		}
		this.pendingRelease = [];
		this.uniformPool?.destroy();
		this.uniformPool = null;
		this.computePipeline = null;
		this.blitPipeline = null;
		this.computeBindGroupLayout = null;
		this.blitBindGroupLayout = null;
		this.uniformView = null;
	}

	private acquireSortTexture(
		device: GPUDevice,
		width: number,
		height: number,
	): { texture: GPUTexture; view: GPUTextureView } {
		const slot = this.sortTexturePool[this.sortTexturePoolIndex];
		if (
			slot &&
			slot.texture.width === width &&
			slot.texture.height === height
		) {
			this.sortTexturePoolIndex++;
			return slot;
		}
		if (slot) {
			this.pendingRelease.push(slot.texture);
		}
		const texture = device.createTexture({
			label: "HK PixelSort Sort Texture",
			size: { width, height },
			format: "rgba8unorm",
			usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
		});
		const entry = { texture, view: texture.createView() };
		this.sortTexturePool[this.sortTexturePoolIndex] = entry;
		this.sortTexturePoolIndex++;
		return entry;
	}
}
