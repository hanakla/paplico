import type { StructuredView } from "webgpu-utils";
import type { Appearance, Filter } from "../../../schema";
import { compileShaderModule } from "../../../utils/wgpu-utils";
import type {
	FilterHandler,
	FilterProcessorContext,
} from "../../canvas/pipeline/FilterRenderer";
import {
	HK_HUSKY_BLEED_SHADER,
	HK_HUSKY_BLUR_SHADER,
	HK_HUSKY_MELT_SHADER,
} from "./hk-husky.wgsl";

export interface HKHuskyParams {
	angle: number;
	horizontalEnabled: boolean;
	verticalEnabled: boolean;
	blurIntensity: number;
	bleedIntensity: number;
	/** White breath veil dissolving boundaries (0-1). Absent in older documents. */
	breathiness?: number;
	/** Boundary melt-out into connected wisps (0-1). Absent in older documents. */
	melt?: number;
	maxOffset: number;
	randomSeed: number;
}
export interface HKHuskyFilter extends Appearance<HKHuskyParams> {
	processor: "hk:husky";
}

/** Retire a cached chain intermediate unused for this many frames. */
const STAGE_TEXTURE_IDLE_FRAMES = 120;
/** Bound on cached chain intermediates during continuous size churn. */
const MAX_STAGE_TEXTURES = 8;

export class HKHuskyHandler implements FilterHandler {
	private meltPipeline: GPURenderPipeline | null = null;
	private blurPipeline: GPURenderPipeline | null = null;
	private bleedPipeline: GPURenderPipeline | null = null;
	private stageBindGroupLayout: GPUBindGroupLayout | null = null;
	private bleedBindGroupLayout: GPUBindGroupLayout | null = null;
	private uniformView: StructuredView | null = null;
	private canvasFormat: GPUTextureFormat = "rgba8unorm";
	private pendingDestroy: GPUTexture[] = [];
	/** Chain intermediates reused across frames, keyed by size + stage label.
	 * A visible husky filter runs every frame; per-call createTexture churned
	 * tens of MB of allocations per second. Idle entries retire after
	 * STAGE_TEXTURE_IDLE_FRAMES; the map is capped, never evicting entries
	 * used in the current frame. */
	private stageTextures = new Map<
		string,
		{ texture: GPUTexture; lastUsedFrame: number }
	>();
	private frameIndex = 0;

	public async initialize(
		device: GPUDevice,
		canvasFormat: GPUTextureFormat,
	): Promise<void> {
		this.canvasFormat = canvasFormat;

		const stageEntries: GPUBindGroupLayoutEntry[] = [
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
		];
		this.stageBindGroupLayout = device.createBindGroupLayout({
			label: "HK Husky Stage Bind Group Layout",
			entries: stageEntries,
		});
		this.bleedBindGroupLayout = device.createBindGroupLayout({
			label: "HK Husky Bleed Bind Group Layout",
			entries: [
				...stageEntries,
				{
					binding: 3,
					visibility: GPUShaderStage.FRAGMENT,
					texture: { sampleType: "float" },
				},
			],
		});

		const buildPipeline = (
			label: string,
			code: string,
			layout: GPUBindGroupLayout,
		) => {
			const { module, uniformViews } = compileShaderModule(device, {
				label,
				code,
			});
			// All stages share the same Uniforms struct; keep one view.
			this.uniformView ??= uniformViews.uniforms;
			return device.createRenderPipeline({
				label: `${label} Pipeline`,
				layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
				vertex: { module, entryPoint: "vertexMain" },
				fragment: {
					module,
					entryPoint: "fragmentMain",
					targets: [{ format: this.canvasFormat }],
				},
				primitive: { topology: "triangle-list" },
			});
		};

		this.meltPipeline = buildPipeline(
			"HK Husky Melt Shader",
			HK_HUSKY_MELT_SHADER,
			this.stageBindGroupLayout,
		);
		this.blurPipeline = buildPipeline(
			"HK Husky Blur Shader",
			HK_HUSKY_BLUR_SHADER,
			this.stageBindGroupLayout,
		);
		this.bleedPipeline = buildPipeline(
			"HK Husky Bleed Shader",
			HK_HUSKY_BLEED_SHADER,
			this.bleedBindGroupLayout,
		);
	}

	/** Deferred intermediate-texture destroys — called once per frame by
	 *  FilterRenderer after the previous frame's submit. */
	public flushPendingDestroy(): void {
		for (const tex of this.pendingDestroy) tex.destroy();
		this.pendingDestroy.length = 0;
		this.frameIndex++;
		for (const [key, entry] of this.stageTextures) {
			if (this.frameIndex - entry.lastUsedFrame > STAGE_TEXTURE_IDLE_FRAMES) {
				this.pendingDestroy.push(entry.texture);
				this.stageTextures.delete(key);
			}
		}
	}

	private acquireStageTexture(
		device: GPUDevice,
		label: string,
		width: number,
		height: number,
	): GPUTexture {
		const key = `${width}x${height}:${label}`;
		let entry = this.stageTextures.get(key);
		if (!entry) {
			if (this.stageTextures.size >= MAX_STAGE_TEXTURES) {
				let lruKey: string | undefined;
				let lruFrame = Infinity;
				for (const [k, e] of this.stageTextures) {
					if (e.lastUsedFrame === this.frameIndex) continue;
					if (e.lastUsedFrame < lruFrame) {
						lruFrame = e.lastUsedFrame;
						lruKey = k;
					}
				}
				if (lruKey) {
					const lru = this.stageTextures.get(lruKey)!;
					this.pendingDestroy.push(lru.texture);
					this.stageTextures.delete(lruKey);
				}
			}
			entry = {
				texture: device.createTexture({
					label,
					size: { width, height },
					format: this.canvasFormat,
					usage:
						GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
				}),
				lastUsedFrame: this.frameIndex,
			};
			this.stageTextures.set(key, entry);
		}
		entry.lastUsedFrame = this.frameIndex;
		return entry.texture;
	}

	public postProcess(context: FilterProcessorContext, filter: Filter): void {
		const f = filter as HKHuskyFilter;
		const {
			device,
			sourceTexture,
			targetTexture,
			commandEncoder,
			sceneInfo: { textureSize, dpiScale },
		} = context;

		if (
			!this.meltPipeline ||
			!this.blurPipeline ||
			!this.bleedPipeline ||
			!this.stageBindGroupLayout ||
			!this.bleedBindGroupLayout ||
			!this.uniformView
		) {
			console.warn("HKHuskyHandler not initialized");
			return;
		}

		const params = f.paramData.params;

		this.uniformView.set({
			resolution: [textureSize.width, textureSize.height],
			dpiScale: dpiScale,
			angle: params.angle,
			horizontalEnabled: params.horizontalEnabled ? 1.0 : 0.0,
			verticalEnabled: params.verticalEnabled ? 1.0 : 0.0,
			blurIntensity: params.blurIntensity,
			bleedIntensity: params.bleedIntensity,
			breathiness: params.breathiness ?? 0,
			melt: params.melt ?? 0,
			maxOffset: params.maxOffset,
			randomSeed: params.randomSeed,
		});

		const uniformBuffer = device.createBuffer({
			label: "HK Husky Uniform Buffer",
			size: this.uniformView.arrayBuffer.byteLength,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		});
		device.queue.writeBuffer(uniformBuffer, 0, this.uniformView.arrayBuffer);

		const sampler = device.createSampler({
			magFilter: "linear",
			minFilter: "linear",
			addressModeU: "clamp-to-edge",
			addressModeV: "clamp-to-edge",
		});

		const acquireStageTexture = (label: string) =>
			this.acquireStageTexture(
				device,
				label,
				textureSize.width,
				textureSize.height,
			);

		const runStage = (
			label: string,
			pipeline: GPURenderPipeline,
			input: GPUTexture,
			output: GPUTexture,
			withSourceAlpha: boolean,
		) => {
			const entries: GPUBindGroupEntry[] = [
				{ binding: 0, resource: { buffer: uniformBuffer } },
				{ binding: 1, resource: input.createView() },
				{ binding: 2, resource: sampler },
			];
			if (withSourceAlpha) {
				entries.push({ binding: 3, resource: sourceTexture.createView() });
			}
			const bindGroup = device.createBindGroup({
				label: `${label} Bind Group`,
				layout: withSourceAlpha
					? this.bleedBindGroupLayout!
					: this.stageBindGroupLayout!,
				entries,
			});
			const pass = commandEncoder.beginRenderPass({
				label: `${label} Pass`,
				colorAttachments: [
					{
						view: output.createView(),
						loadOp: "clear",
						storeOp: "store",
						clearValue: { r: 0, g: 0, b: 0, a: 0 },
					},
				],
			});
			pass.setPipeline(pipeline);
			pass.setBindGroup(0, bindGroup);
			pass.draw(3, 1, 0, 0);
			pass.end();
		};

		// Chain: melt → blur/thin → bleed+veil, each stage reading the
		// previous stage's texture. Zero-strength stages are skipped; the
		// bleed+veil stage always runs so the chain ends in targetTexture.
		let chain = sourceTexture;
		if ((params.melt ?? 0) > 0) {
			const meltTexture = acquireStageTexture("HK Husky Melt Texture");
			runStage("HK Husky Melt", this.meltPipeline, chain, meltTexture, false);
			chain = meltTexture;
		}
		if (params.blurIntensity > 0) {
			const blurTexture = acquireStageTexture("HK Husky Blur Texture");
			runStage("HK Husky Blur", this.blurPipeline, chain, blurTexture, false);
			chain = blurTexture;
		}
		runStage("HK Husky Bleed", this.bleedPipeline, chain, targetTexture, true);
	}

	public getExpansionMargin(filter: Filter): number {
		const f = filter as HKHuskyFilter;
		// Melt wisps reach up to 40px beyond the flat bounds at melt = 1.
		return f.paramData.params.maxOffset + (f.paramData.params.melt ?? 0) * 40;
	}

	public onScaleFilter(
		params: Filter,
		[scaleX, scaleY]: [number, number],
	): Filter {
		const f = params as HKHuskyFilter;
		const uniformScale = Math.sqrt(scaleX * scaleY);
		return {
			...f,
			paramData: {
				...f.paramData,
				params: {
					...f.paramData.params,
					maxOffset: f.paramData.params.maxOffset * uniformScale,
				},
			},
		};
	}

	public onInterpolate(paramsA: unknown, paramsB: unknown, t: number): unknown {
		const a = paramsA as HKHuskyFilter["paramData"]["params"];
		const b = paramsB as HKHuskyFilter["paramData"]["params"];
		return {
			angle: a.angle + (b.angle - a.angle) * t,
			horizontalEnabled: t < 0.5 ? a.horizontalEnabled : b.horizontalEnabled,
			verticalEnabled: t < 0.5 ? a.verticalEnabled : b.verticalEnabled,
			blurIntensity: a.blurIntensity + (b.blurIntensity - a.blurIntensity) * t,
			bleedIntensity:
				a.bleedIntensity + (b.bleedIntensity - a.bleedIntensity) * t,
			breathiness:
				(a.breathiness ?? 0) +
				((b.breathiness ?? 0) - (a.breathiness ?? 0)) * t,
			melt: (a.melt ?? 0) + ((b.melt ?? 0) - (a.melt ?? 0)) * t,
			maxOffset: a.maxOffset + (b.maxOffset - a.maxOffset) * t,
			randomSeed: a.randomSeed + (b.randomSeed - a.randomSeed) * t,
		};
	}

	public destroy(): void {
		for (const entry of this.stageTextures.values()) {
			entry.texture.destroy();
		}
		this.stageTextures.clear();
		this.flushPendingDestroy();
		this.meltPipeline = null;
		this.blurPipeline = null;
		this.bleedPipeline = null;
		this.stageBindGroupLayout = null;
		this.bleedBindGroupLayout = null;
		this.uniformView = null;
	}
}
