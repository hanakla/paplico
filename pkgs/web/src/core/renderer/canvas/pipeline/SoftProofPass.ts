import { createFullscreenPipeline } from "../../PipelineFactory";
import { SOFT_PROOF_BLIT_SHADER } from "../../shaders/softProofBlit.wgsl";

/** Lazily created GPU objects shared across apply() calls. */
interface SoftProofGpuResources {
	pipeline: GPURenderPipeline;
	bindGroupLayout: GPUBindGroupLayout;
	sampler: GPUSampler;
	uniformBuffer: GPUBuffer;
}

/**
 * Final-display soft proof pass.
 *
 * Holds a 3D LUT texture (RGB→CMYK→RGB roundtrip baked on CPU) and applies
 * it to the rendered frame as a fullscreen blit. Self-contained: owns its
 * pipeline, sampler, uniform buffer, and LUT texture. The pipeline is built
 * lazily on first apply() so targets that never proof pay no GPU cost.
 */
export class SoftProofPass {
	private device: GPUDevice;
	private targetFormat: GPUTextureFormat;

	private resources: SoftProofGpuResources | null = null;

	private lutTexture: GPUTexture | null = null;
	private lutSize = 0;

	private bindGroup: GPUBindGroup | null = null;
	private bindGroupSourceView: GPUTextureView | null = null;

	public constructor(device: GPUDevice, targetFormat: GPUTextureFormat) {
		this.device = device;
		this.targetFormat = targetFormat;
	}

	/** Whether a LUT is currently uploaded and apply() would have an effect. */
	public hasLut(): boolean {
		return this.lutTexture !== null;
	}

	/**
	 * Upload an RGBA size^3 LUT. Reuses the existing texture when the size
	 * matches; otherwise destroys and recreates it.
	 */
	public setLut(data: Uint8Array, size: number): void {
		if (this.lutTexture && this.lutSize !== size) {
			this.lutTexture.destroy();
			this.lutTexture = null;
		}
		if (!this.lutTexture) {
			this.lutTexture = this.device.createTexture({
				label: "Soft Proof 3D LUT",
				size: { width: size, height: size, depthOrArrayLayers: size },
				dimension: "3d",
				format: "rgba8unorm",
				usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
			});
		}
		this.lutSize = size;
		this.device.queue.writeTexture(
			{ texture: this.lutTexture },
			data,
			{ bytesPerRow: size * 4, rowsPerImage: size },
			{ width: size, height: size, depthOrArrayLayers: size },
		);
		this.invalidateBindGroup();
	}

	public clearLut(): void {
		this.lutTexture?.destroy();
		this.lutTexture = null;
		this.lutSize = 0;
		this.invalidateBindGroup();
	}

	/**
	 * Apply the LUT to sourceView, writing the result to targetView as a
	 * fullscreen blit. No-op when no LUT is set.
	 */
	public apply(
		encoder: GPUCommandEncoder,
		sourceView: GPUTextureView,
		targetView: GPUTextureView,
	): void {
		if (!this.lutTexture) return;

		const resources = this.ensureResources();

		this.device.queue.writeBuffer(
			resources.uniformBuffer,
			0,
			new Float32Array([this.lutSize]),
		);

		if (!this.bindGroup || this.bindGroupSourceView !== sourceView) {
			this.bindGroupSourceView = sourceView;
			this.bindGroup = this.device.createBindGroup({
				label: "Soft Proof Bind Group",
				layout: resources.bindGroupLayout,
				entries: [
					{ binding: 0, resource: { buffer: resources.uniformBuffer } },
					{ binding: 1, resource: resources.sampler },
					{ binding: 2, resource: this.lutTexture.createView() },
					{ binding: 3, resource: sourceView },
				],
			});
		}

		const pass = encoder.beginRenderPass({
			label: "Soft Proof Post-Process",
			colorAttachments: [
				{
					view: targetView,
					loadOp: "clear",
					storeOp: "store",
				},
			],
		});
		pass.setPipeline(resources.pipeline);
		pass.setBindGroup(0, this.bindGroup);
		pass.draw(6);
		pass.end();
	}

	public destroy(): void {
		this.lutTexture?.destroy();
		this.lutTexture = null;
		this.lutSize = 0;
		this.resources?.uniformBuffer.destroy();
		this.resources = null;
		this.invalidateBindGroup();
	}

	private invalidateBindGroup(): void {
		this.bindGroup = null;
		this.bindGroupSourceView = null;
	}

	private ensureResources(): SoftProofGpuResources {
		if (this.resources) return this.resources;

		const bindGroupLayout = this.device.createBindGroupLayout({
			label: "Soft Proof Bind Group Layout",
			entries: [
				{
					binding: 0,
					visibility: GPUShaderStage.FRAGMENT,
					buffer: { type: "uniform" },
				},
				{
					binding: 1,
					visibility: GPUShaderStage.FRAGMENT,
					sampler: {},
				},
				{
					binding: 2,
					visibility: GPUShaderStage.FRAGMENT,
					texture: { sampleType: "float", viewDimension: "3d" },
				},
				{
					binding: 3,
					visibility: GPUShaderStage.FRAGMENT,
					texture: { sampleType: "float" },
				},
			],
		});

		// Filtering sampler shared by the LUT (trilinear interpolation) and the
		// source (1:1 blit, so linear == nearest). Clamp on all axes — W matters
		// for the 3D LUT edges.
		const sampler = this.device.createSampler({
			label: "Soft Proof Sampler",
			magFilter: "linear",
			minFilter: "linear",
			addressModeU: "clamp-to-edge",
			addressModeV: "clamp-to-edge",
			addressModeW: "clamp-to-edge",
		});

		const uniformBuffer = this.device.createBuffer({
			label: "Soft Proof Uniform Buffer",
			size: 16, // Minimum uniform buffer alignment
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		});

		const pipeline = createFullscreenPipeline({
			device: this.device,
			label: "Soft Proof Blit Pipeline",
			shaderModule: this.device.createShaderModule({
				label: "Soft Proof Blit Shader",
				code: SOFT_PROOF_BLIT_SHADER,
			}),
			pipelineLayout: this.device.createPipelineLayout({
				bindGroupLayouts: [bindGroupLayout],
			}),
			targetFormat: this.targetFormat,
			// Renders directly to the (non-multisampled) canvas texture.
			multisampleCount: 1,
		});

		this.resources = { pipeline, bindGroupLayout, sampler, uniformBuffer };
		return this.resources;
	}
}
