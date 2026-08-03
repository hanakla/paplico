import {
	getSizeAndAlignmentOfUnsizedArrayElement,
	makeShaderDataDefinitions,
	makeStructuredView,
	type ShaderDataDefinitions,
	type StructuredView,
} from "webgpu-utils";

export type { ShaderDataDefinitions, StructuredView };

interface CompiledShaderModule {
	module: GPUShaderModule;
	info: Promise<GPUCompilationInfo>;
	definitions: ShaderDataDefinitions;
	uniformViews: Record</* uniform variable name */ string, StructuredView>;
	storageViews: Record</* storage variable name */ string, StructuredView>;
}

/** Compile shader module and check compilation info */
export function compileShaderModule(
	device: GPUDevice,
	{ code, label, compilationHints }: GPUShaderModuleDescriptor,
): CompiledShaderModule {
	const module = device.createShaderModule({
		code,
		label,
		compilationHints,
	});

	const defs = makeShaderDataDefinitions(code);
	const uniformViews = Object.keys(defs.uniforms).reduce<
		Record<string, StructuredView>
	>((acc, name) => {
		acc[name] = makeStructuredView(defs.uniforms[name]);
		return acc;
	}, {});

	const storageViews = Object.keys(defs.storages).reduce<
		Record<string, StructuredView>
	>((acc, name) => {
		const def = defs.storages[name];
		// Unsized arrays need an explicit ArrayBuffer since their size is runtime-determined
		const elemInfo = getSizeAndAlignmentOfUnsizedArrayElement(def);
		if (elemInfo.size > 0) {
			// Default to 16 elements for unsized arrays (callers can create their own views for other sizes)
			const buf = new ArrayBuffer(elemInfo.size * 16);
			acc[name] = makeStructuredView(def, buf);
		} else {
			acc[name] = makeStructuredView(def);
		}
		return acc;
	}, {});

	const info = module.getCompilationInfo();

	info.then((info) => {
		if (info.messages.length === 0) return;
		info.messages.forEach((msg) => {
			const type = (
				{
					error: "error",
					warning: "warn",
					info: "info",
				} as const
			)[msg.type];

			console[type](msg);
		});
	});

	return { module, definitions: defs, uniformViews, storageViews, info };
}

/** Full mip chain length for a texture of the given size. */
export function mipLevelCountFor(width: number, height: number): number {
	return Math.floor(Math.log2(Math.max(width, height))) + 1;
}

const MIP_BLIT_SHADER = /* wgsl */ `
@group(0) @binding(0) var srcTexture: texture_2d<f32>;
@group(0) @binding(1) var srcSampler: sampler;

struct VertexOutput {
	@builtin(position) position: vec4<f32>,
	@location(0) uv: vec2<f32>,
}

@vertex
fn vs_main(@builtin(vertex_index) index: u32) -> VertexOutput {
	// Fullscreen triangle.
	let pos = array<vec2<f32>, 3>(
		vec2<f32>(-1.0, -1.0),
		vec2<f32>(3.0, -1.0),
		vec2<f32>(-1.0, 3.0),
	);
	var out: VertexOutput;
	out.position = vec4<f32>(pos[index], 0.0, 1.0);
	out.uv = pos[index] * vec2<f32>(0.5, -0.5) + vec2<f32>(0.5, 0.5);
	return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
	// The source view is restricted to a single mip level, so a linear
	// sample at the destination texel center is an exact 2x2 box filter.
	return textureSampleLevel(srcTexture, srcSampler, in.uv, 0.0);
}
`;

const mipBlitPipelines = new WeakMap<
	GPUDevice,
	Map<GPUTextureFormat, GPURenderPipeline>
>();
const mipBlitSamplers = new WeakMap<GPUDevice, GPUSampler>();

/**
 * Fill mip levels 1..N of `texture` by box-filtering each level from the
 * previous one, for every array layer. Level 0 must already contain the
 * image; the texture needs TEXTURE_BINDING | RENDER_ATTACHMENT usage and a
 * color-renderable format.
 */
export function generateMipmaps(device: GPUDevice, texture: GPUTexture): void {
	if (texture.mipLevelCount < 2) return;

	let formats = mipBlitPipelines.get(device);
	if (!formats) {
		formats = new Map();
		mipBlitPipelines.set(device, formats);
	}
	let pipeline = formats.get(texture.format);
	if (!pipeline) {
		const { module } = compileShaderModule(device, {
			label: "Mipmap Blit Shader",
			code: MIP_BLIT_SHADER,
		});
		pipeline = device.createRenderPipeline({
			label: `Mipmap Blit Pipeline (${texture.format})`,
			layout: "auto",
			vertex: { module, entryPoint: "vs_main" },
			fragment: {
				module,
				entryPoint: "fs_main",
				targets: [{ format: texture.format }],
			},
			primitive: { topology: "triangle-list" },
		});
		formats.set(texture.format, pipeline);
	}

	let sampler = mipBlitSamplers.get(device);
	if (!sampler) {
		sampler = device.createSampler({
			label: "Mipmap Blit Sampler",
			minFilter: "linear",
			magFilter: "linear",
		});
		mipBlitSamplers.set(device, sampler);
	}

	const encoder = device.createCommandEncoder({ label: "Generate Mipmaps" });
	for (let layer = 0; layer < texture.depthOrArrayLayers; layer++) {
		for (let level = 1; level < texture.mipLevelCount; level++) {
			const srcView = texture.createView({
				dimension: "2d",
				baseMipLevel: level - 1,
				mipLevelCount: 1,
				baseArrayLayer: layer,
				arrayLayerCount: 1,
			});
			const dstView = texture.createView({
				dimension: "2d",
				baseMipLevel: level,
				mipLevelCount: 1,
				baseArrayLayer: layer,
				arrayLayerCount: 1,
			});
			const pass = encoder.beginRenderPass({
				colorAttachments: [
					{ view: dstView, loadOp: "clear", storeOp: "store" },
				],
			});
			pass.setPipeline(pipeline);
			pass.setBindGroup(
				0,
				device.createBindGroup({
					layout: pipeline.getBindGroupLayout(0),
					entries: [
						{ binding: 0, resource: srcView },
						{ binding: 1, resource: sampler },
					],
				}),
			);
			pass.draw(3);
			pass.end();
		}
	}
	device.queue.submit([encoder.finish()]);
}
