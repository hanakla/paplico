import type { StructuredView } from "webgpu-utils";
import { compileShaderModule } from "../../utils/wgpu-utils";
import {
	JUMP_FLOOD_JUMP_SHADER,
	JUMP_FLOOD_SEED_SHADER,
} from "./jumpFlood.wgsl";

/**
 * Shared jump-flood distance field over an alpha silhouette (outline ring,
 * drop-shadow spread, ...). Owns the seed / jump pipelines plus a ping-pong
 * rg32float texture pair; compute() returns the texture holding each pixel's
 * nearest-seed texel coordinate (sentinel x <= -1e5 when nothing is within
 * reach). The result stays valid until the next compute() or destroy(), so
 * each consumer owns its instance.
 */
export class JumpFloodDistanceField {
	private seedPipeline: GPURenderPipeline | null = null;
	private seedBindGroupLayout: GPUBindGroupLayout | null = null;
	private seedUniformView: StructuredView | null = null;
	private jumpPipeline: GPURenderPipeline | null = null;
	private jumpBindGroupLayout: GPUBindGroupLayout | null = null;
	private jumpUniformView: StructuredView | null = null;
	private textureA: GPUTexture | null = null;
	private textureB: GPUTexture | null = null;
	private size = { width: 0, height: 0 };
	private pendingDestroyTextures: GPUTexture[] = [];

	public initialize(device: GPUDevice): void {
		const seed = compileShaderModule(device, {
			label: "Jump Flood Seed Shader",
			code: JUMP_FLOOD_SEED_SHADER,
		});
		this.seedUniformView = seed.uniformViews.uniforms;
		this.seedBindGroupLayout = device.createBindGroupLayout({
			label: "Jump Flood Seed Bind Group Layout",
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
			],
		});
		this.seedPipeline = device.createRenderPipeline({
			label: "Jump Flood Seed Pipeline",
			layout: device.createPipelineLayout({
				bindGroupLayouts: [this.seedBindGroupLayout],
			}),
			vertex: { module: seed.module, entryPoint: "vertexMain" },
			fragment: {
				module: seed.module,
				entryPoint: "fragmentMain",
				targets: [{ format: "rg32float" }],
			},
			primitive: { topology: "triangle-list" },
		});

		const jump = compileShaderModule(device, {
			label: "Jump Flood Jump Shader",
			code: JUMP_FLOOD_JUMP_SHADER,
		});
		this.jumpUniformView = jump.uniformViews.uniforms;
		this.jumpBindGroupLayout = device.createBindGroupLayout({
			label: "Jump Flood Jump Bind Group Layout",
			entries: [
				{
					binding: 0,
					visibility: GPUShaderStage.FRAGMENT,
					buffer: { type: "uniform" },
				},
				{
					binding: 1,
					visibility: GPUShaderStage.FRAGMENT,
					texture: { sampleType: "unfilterable-float" },
				},
			],
		});
		this.jumpPipeline = device.createRenderPipeline({
			label: "Jump Flood Jump Pipeline",
			layout: device.createPipelineLayout({
				bindGroupLayouts: [this.jumpBindGroupLayout],
			}),
			vertex: { module: jump.module, entryPoint: "vertexMain" },
			fragment: {
				module: jump.module,
				entryPoint: "fragmentMain",
				targets: [{ format: "rg32float" }],
			},
			primitive: { topology: "triangle-list" },
		});
	}

	/** Deferred texture destroys — call once per frame after the previous
	 *  frame's submit (in-flight passes may still read the old pair). */
	public flushPendingDestroy(): void {
		for (const texture of this.pendingDestroyTextures) {
			texture.destroy();
		}
		this.pendingDestroyTextures.length = 0;
	}

	/**
	 * Encode seed + flood passes over `sourceTexture`'s alpha.
	 * @param maxDistance - Longest distance (texels) callers will read from
	 *   the field; drives the flood pass count.
	 * @param seedInside - true seeds covered pixels (distance to silhouette),
	 *   false seeds uncovered pixels (distance to background, for erosion).
	 */
	public compute(
		device: GPUDevice,
		commandEncoder: GPUCommandEncoder,
		sourceTexture: GPUTexture,
		width: number,
		height: number,
		maxDistance: number,
		seedInside: boolean,
	): GPUTexture | null {
		if (
			!this.seedPipeline ||
			!this.seedBindGroupLayout ||
			!this.seedUniformView ||
			!this.jumpPipeline ||
			!this.jumpBindGroupLayout ||
			!this.jumpUniformView
		) {
			console.warn("JumpFloodDistanceField not initialized");
			return null;
		}

		this.ensureTextures(device, width, height);
		if (!this.textureA || !this.textureB) return null;

		this.seedUniformView.set({ seedInside: seedInside ? 1 : 0 });
		const seedUniformBuffer = device.createBuffer({
			label: "Jump Flood Seed Uniform Buffer",
			size: this.seedUniformView.arrayBuffer.byteLength,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		});
		device.queue.writeBuffer(
			seedUniformBuffer,
			0,
			this.seedUniformView.arrayBuffer,
		);

		const seedBindGroup = device.createBindGroup({
			label: "Jump Flood Seed Bind Group",
			layout: this.seedBindGroupLayout,
			entries: [
				{ binding: 0, resource: { buffer: seedUniformBuffer } },
				{ binding: 1, resource: sourceTexture.createView() },
			],
		});
		const seedPass = commandEncoder.beginRenderPass({
			label: "Jump Flood Seed Pass",
			colorAttachments: [
				{
					view: this.textureA.createView(),
					loadOp: "clear",
					storeOp: "store",
					clearValue: { r: -1e6, g: -1e6, b: 0, a: 0 },
				},
			],
		});
		seedPass.setPipeline(this.seedPipeline);
		seedPass.setBindGroup(0, seedBindGroup);
		seedPass.draw(3, 1, 0, 0);
		seedPass.end();

		const passCount = Math.max(1, Math.ceil(Math.log2(maxDistance + 1)));
		let floodSource = this.textureA;
		let floodTarget = this.textureB;
		for (let i = 0; i < passCount; i++) {
			const step = Math.max(1, 2 ** (passCount - 1 - i));
			this.jumpUniformView.set({ step });
			const jumpUniformBuffer = device.createBuffer({
				label: "Jump Flood Jump Uniform Buffer",
				size: this.jumpUniformView.arrayBuffer.byteLength,
				usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
			});
			device.queue.writeBuffer(
				jumpUniformBuffer,
				0,
				this.jumpUniformView.arrayBuffer,
			);

			const jumpBindGroup = device.createBindGroup({
				label: "Jump Flood Jump Bind Group",
				layout: this.jumpBindGroupLayout,
				entries: [
					{ binding: 0, resource: { buffer: jumpUniformBuffer } },
					{ binding: 1, resource: floodSource.createView() },
				],
			});
			const jumpPass = commandEncoder.beginRenderPass({
				label: "Jump Flood Jump Pass",
				colorAttachments: [
					{
						view: floodTarget.createView(),
						loadOp: "clear",
						storeOp: "store",
						clearValue: { r: -1e6, g: -1e6, b: 0, a: 0 },
					},
				],
			});
			jumpPass.setPipeline(this.jumpPipeline);
			jumpPass.setBindGroup(0, jumpBindGroup);
			jumpPass.draw(3, 1, 0, 0);
			jumpPass.end();

			[floodSource, floodTarget] = [floodTarget, floodSource];
		}

		return floodSource;
	}

	public destroy(): void {
		this.flushPendingDestroy();
		this.textureA?.destroy();
		this.textureB?.destroy();
		this.textureA = null;
		this.textureB = null;
		this.size = { width: 0, height: 0 };
		this.seedPipeline = null;
		this.seedBindGroupLayout = null;
		this.seedUniformView = null;
		this.jumpPipeline = null;
		this.jumpBindGroupLayout = null;
		this.jumpUniformView = null;
	}

	private ensureTextures(
		device: GPUDevice,
		width: number,
		height: number,
	): void {
		if (
			this.textureA &&
			this.size.width === width &&
			this.size.height === height
		) {
			return;
		}
		if (this.textureA) this.pendingDestroyTextures.push(this.textureA);
		if (this.textureB) this.pendingDestroyTextures.push(this.textureB);

		const descriptor: GPUTextureDescriptor = {
			label: "Jump Flood Coord Texture",
			size: { width, height },
			format: "rg32float",
			usage:
				GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
		};
		this.textureA = device.createTexture(descriptor);
		this.textureB = device.createTexture(descriptor);
		this.size = { width, height };
	}
}
