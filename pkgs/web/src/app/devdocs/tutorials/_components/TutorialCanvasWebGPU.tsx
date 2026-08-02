"use client";

import { useEffect, useRef } from "react";

type Props = {
	width?: number;
	height?: number;
	worldUnit?: number;
	vertices: Float32Array | null;
	fillColor?: [number, number, number, number];
	clearColor?: [number, number, number, number];
};

const SHADER_CODE = /* wgsl */ `
struct Uniforms {
	resolution: vec2f,
	worldUnit: f32,
	_pad: f32,
};
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var<uniform> color: vec4f;

@vertex
fn vs(@location(0) pos: vec2f) -> @builtin(position) vec4f {
	let world = pos * u.worldUnit;
	let ndc = vec2f(world.x * 2.0 / u.resolution.x, -world.y * 2.0 / u.resolution.y);
	return vec4f(ndc, 0.0, 1.0);
}

@fragment
fn fs() -> @location(0) vec4f {
	return color;
}
`;

export function TutorialCanvasWebGPU({
	width = 600,
	height = 400,
	worldUnit = 1,
	vertices,
	fillColor = [0.23, 0.52, 1.0, 0.85],
	clearColor = [0, 0, 0, 0],
}: Props) {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const stateRef = useRef<{
		device: GPUDevice;
		context: GPUCanvasContext;
		pipeline: GPURenderPipeline;
		uniformBuffer: GPUBuffer;
		colorBuffer: GPUBuffer;
		bindGroupLayout: GPUBindGroupLayout;
		format: GPUTextureFormat;
		dpr: number;
	} | null>(null);

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		const dpr = window.devicePixelRatio || 1;
		canvas.width = width * dpr;
		canvas.height = height * dpr;
		canvas.style.width = `${width}px`;
		canvas.style.height = `${height}px`;

		let cancelled = false;
		(async () => {
			if (!navigator.gpu) {
				const ctx = canvas.getContext("2d");
				if (!ctx) return;
				ctx.fillStyle = "rgb(127 127 127 / 0.6)";
				ctx.font = "14px ui-sans-serif, system-ui, sans-serif";
				ctx.textAlign = "center";
				ctx.fillText(
					"このブラウザは WebGPU に対応していないよ",
					canvas.width / 2,
					canvas.height / 2,
				);
				return;
			}
			const adapter = await navigator.gpu.requestAdapter();
			if (!adapter || cancelled) return;
			const device = await adapter.requestDevice();
			if (cancelled) {
				device.destroy();
				return;
			}
			const context = canvas.getContext("webgpu");
			if (!context) return;
			const format = navigator.gpu.getPreferredCanvasFormat();
			context.configure({ device, format, alphaMode: "premultiplied" });

			const shaderModule = device.createShaderModule({ code: SHADER_CODE });
			const bindGroupLayout = device.createBindGroupLayout({
				entries: [
					{
						binding: 0,
						visibility: GPUShaderStage.VERTEX,
						buffer: { type: "uniform" },
					},
					{
						binding: 1,
						visibility: GPUShaderStage.FRAGMENT,
						buffer: { type: "uniform" },
					},
				],
			});
			const pipeline = device.createRenderPipeline({
				layout: device.createPipelineLayout({
					bindGroupLayouts: [bindGroupLayout],
				}),
				vertex: {
					module: shaderModule,
					entryPoint: "vs",
					buffers: [
						{
							arrayStride: 8,
							attributes: [
								{ shaderLocation: 0, offset: 0, format: "float32x2" },
							],
						},
					],
				},
				fragment: {
					module: shaderModule,
					entryPoint: "fs",
					targets: [
						{
							format,
							blend: {
								color: {
									srcFactor: "src-alpha",
									dstFactor: "one-minus-src-alpha",
								},
								alpha: {
									srcFactor: "one",
									dstFactor: "one-minus-src-alpha",
								},
							},
						},
					],
				},
				primitive: { topology: "triangle-list" },
			});

			const uniformBuffer = device.createBuffer({
				size: 16,
				usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
			});
			const colorBuffer = device.createBuffer({
				size: 16,
				usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
			});

			stateRef.current = {
				device,
				context,
				pipeline,
				uniformBuffer,
				colorBuffer,
				bindGroupLayout,
				format,
				dpr,
			};
		})();

		return () => {
			cancelled = true;
			const s = stateRef.current;
			stateRef.current = null;
			s?.device.destroy();
		};
	}, [width, height]);

	useEffect(() => {
		const s = stateRef.current;
		if (!s) return;
		const {
			device,
			context,
			pipeline,
			uniformBuffer,
			colorBuffer,
			bindGroupLayout,
			dpr,
		} = s;

		device.queue.writeBuffer(
			uniformBuffer,
			0,
			new Float32Array([width, height, worldUnit, 0]),
		);
		device.queue.writeBuffer(colorBuffer, 0, new Float32Array(fillColor));

		const bindGroup = device.createBindGroup({
			layout: bindGroupLayout,
			entries: [
				{ binding: 0, resource: { buffer: uniformBuffer } },
				{ binding: 1, resource: { buffer: colorBuffer } },
			],
		});

		let vertexBuffer: GPUBuffer | null = null;
		let vertexCount = 0;
		if (vertices && vertices.length >= 6) {
			vertexBuffer = device.createBuffer({
				size: vertices.byteLength,
				usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
			});
			device.queue.writeBuffer(vertexBuffer, 0, vertices);
			vertexCount = vertices.length / 2;
		}

		const encoder = device.createCommandEncoder();
		const pass = encoder.beginRenderPass({
			colorAttachments: [
				{
					view: context.getCurrentTexture().createView(),
					clearValue: {
						r: clearColor[0],
						g: clearColor[1],
						b: clearColor[2],
						a: clearColor[3],
					},
					loadOp: "clear",
					storeOp: "store",
				},
			],
		});
		if (vertexBuffer && vertexCount >= 3) {
			pass.setPipeline(pipeline);
			pass.setBindGroup(0, bindGroup);
			pass.setVertexBuffer(0, vertexBuffer);
			pass.draw(vertexCount);
		}
		pass.end();
		device.queue.submit([encoder.finish()]);
		vertexBuffer?.destroy();

		// dpr は再描画時の参考用 (現状は使わない)
		void dpr;
	}, [vertices, width, height, worldUnit, fillColor, clearColor]);

	return (
		<canvas
			ref={canvasRef}
			className="block rounded-lg border border-border bg-background"
		/>
	);
}
