import type { StructuredView } from "webgpu-utils";
import { compileShaderModule } from "../../../utils/wgpu-utils";
import type { FilterProcessorContext } from "../../canvas/pipeline/FilterRenderer";

/**
 * One fullscreen render pass with a `uniforms` block, N input textures and an
 * optional read-only storage buffer — the whole GPU boilerplate an SVG filter
 * primitive needs. Handlers own one instance per shader and drive it from
 * postProcess.
 */
export class SvgFullscreenPass {
	private pipeline: GPURenderPipeline | null = null;
	private bindGroupLayout: GPUBindGroupLayout | null = null;
	private uniformView: StructuredView | null = null;
	private label = "";

	public initialize(
		device: GPUDevice,
		canvasFormat: GPUTextureFormat,
		label: string,
		code: string,
		{ textures, storage = false }: { textures: number; storage?: boolean },
	): void {
		this.label = label;
		const { module, uniformViews } = compileShaderModule(device, {
			label: `${label} Shader`,
			code,
		});
		this.uniformView = uniformViews.uniforms;

		const entries: GPUBindGroupLayoutEntry[] = [
			{
				binding: 0,
				visibility: GPUShaderStage.FRAGMENT,
				buffer: { type: "uniform" },
			},
		];
		for (let i = 0; i < textures; i++) {
			entries.push({
				binding: 1 + i,
				visibility: GPUShaderStage.FRAGMENT,
				texture: { sampleType: "float" },
			});
		}
		if (storage) {
			entries.push({
				binding: 1 + textures,
				visibility: GPUShaderStage.FRAGMENT,
				buffer: { type: "read-only-storage" },
			});
		}
		this.bindGroupLayout = device.createBindGroupLayout({
			label: `${label} Bind Group Layout`,
			entries,
		});
		this.pipeline = device.createRenderPipeline({
			label: `${label} Pipeline`,
			layout: device.createPipelineLayout({
				bindGroupLayouts: [this.bindGroupLayout],
			}),
			vertex: { module, entryPoint: "vertexMain" },
			fragment: {
				module,
				entryPoint: "fragmentMain",
				targets: [{ format: canvasFormat }],
			},
			primitive: { topology: "triangle-list" },
		});
	}

	public run(
		context: Pick<
			FilterProcessorContext,
			"device" | "commandEncoder" | "profiler" | "timingLabel"
		>,
		uniforms: Record<string, unknown>,
		textures: GPUTexture[],
		target: GPUTexture,
		storage?: GPUBuffer,
	): void {
		if (!this.pipeline || !this.bindGroupLayout || !this.uniformView) {
			throw new Error(`${this.label} not initialized`);
		}
		const { device, commandEncoder } = context;

		this.uniformView.set(uniforms);
		const uniformBuffer = device.createBuffer({
			label: `${this.label} Uniforms`,
			size: this.uniformView.arrayBuffer.byteLength,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		});
		device.queue.writeBuffer(uniformBuffer, 0, this.uniformView.arrayBuffer);

		const entries: GPUBindGroupEntry[] = [
			{ binding: 0, resource: { buffer: uniformBuffer } },
			...textures.map((texture, i) => ({
				binding: 1 + i,
				resource: texture.createView(),
			})),
		];
		if (storage) {
			entries.push({
				binding: 1 + textures.length,
				resource: { buffer: storage },
			});
		}
		const bindGroup = device.createBindGroup({
			label: `${this.label} Bind Group`,
			layout: this.bindGroupLayout,
			entries,
		});

		const pass = commandEncoder.beginRenderPass({
			label: `${this.label} Pass`,
			timestampWrites: context.profiler?.timestampWrites(
				context.timingLabel ?? this.label,
			),
			colorAttachments: [
				{
					view: target.createView(),
					loadOp: "clear",
					storeOp: "store",
					clearValue: { r: 0, g: 0, b: 0, a: 0 },
				},
			],
		});
		pass.setPipeline(this.pipeline);
		pass.setBindGroup(0, bindGroup);
		pass.draw(3, 1, 0, 0);
		pass.end();
	}

	public destroy(): void {
		this.pipeline = null;
		this.bindGroupLayout = null;
		this.uniformView = null;
	}
}
