/**
 * Factory functions for creating WebGPU render pipelines.
 *
 * Extracts the repetitive pipeline descriptor construction from
 * RenderOrchestrator.initPipelinesAndSharedSystems into reusable helpers.
 */

import { RENDER_SAMPLE_COUNT } from "./canvas/CanvasLayerTypes";

const DEFAULT_MULTISAMPLE_COUNT = RENDER_SAMPLE_COUNT;

interface GeometryPipelineOpts {
	device: GPUDevice;
	label: string;
	shaderModule: GPUShaderModule;
	/** Single vertex buffer layout. Use vertexBufferLayouts for multiple buffers (e.g. instanced rendering). */
	vertexBufferLayout?: GPUVertexBufferLayout;
	/** Multiple vertex buffer layouts. Takes precedence over vertexBufferLayout when provided. */
	vertexBufferLayouts?: GPUVertexBufferLayout[];
	pipelineLayout: GPUPipelineLayout;
	topology: GPUPrimitiveTopology;
	targetFormat: GPUTextureFormat;
	blend?: GPUBlendState;
	multisampleCount?: number;
	vertexEntryPoint?: string;
	fragmentEntryPoint?: string;
}

/** Create a render pipeline with vertex buffers (stroke/fill/gradient/UI families). */
export function createGeometryPipeline(
	opts: GeometryPipelineOpts,
): GPURenderPipeline {
	const multisampleCount = opts.multisampleCount ?? DEFAULT_MULTISAMPLE_COUNT;
	const buffers =
		opts.vertexBufferLayouts ??
		(opts.vertexBufferLayout ? [opts.vertexBufferLayout] : []);

	return opts.device.createRenderPipeline({
		label: opts.label,
		layout: opts.pipelineLayout,
		vertex: {
			module: opts.shaderModule,
			entryPoint: opts.vertexEntryPoint ?? "vs_main",
			buffers,
		},
		fragment: {
			module: opts.shaderModule,
			entryPoint: opts.fragmentEntryPoint ?? "fs_main",
			targets: [
				{
					format: opts.targetFormat,
					blend: opts.blend,
				},
			],
		},
		primitive: { topology: opts.topology },
		multisample: { count: multisampleCount },
	});
}

interface FullscreenPipelineOpts {
	device: GPUDevice;
	label: string;
	shaderModule: GPUShaderModule;
	pipelineLayout: GPUPipelineLayout;
	targetFormat: GPUTextureFormat;
	fragmentEntryPoint?: string;
	blend?: GPUBlendState;
	multisampleCount?: number;
}

/** Create a render pipeline without vertex buffers (blit/composite families). */
export function createFullscreenPipeline(
	opts: FullscreenPipelineOpts,
): GPURenderPipeline {
	const multisampleCount = opts.multisampleCount ?? DEFAULT_MULTISAMPLE_COUNT;

	return opts.device.createRenderPipeline({
		label: opts.label,
		layout: opts.pipelineLayout,
		vertex: {
			module: opts.shaderModule,
			entryPoint: "vertexMain",
		},
		fragment: {
			module: opts.shaderModule,
			entryPoint: opts.fragmentEntryPoint ?? "fragmentMain",
			targets: [
				{
					format: opts.targetFormat,
					blend: opts.blend,
				},
			],
		},
		primitive: { topology: "triangle-list" },
		multisample: { count: multisampleCount },
	});
}
