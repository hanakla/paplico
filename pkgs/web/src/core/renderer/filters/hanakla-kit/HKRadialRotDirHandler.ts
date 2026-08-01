/**
 * Ported from AviUtl script "RadRotDirBlur_S" by sigma-axis
 * Original: https://github.com/sigma-axis/aviutl_script_RadRotDirBlur_S
 * License: MIT - https://github.com/sigma-axis/aviutl_script_RadRotDirBlur_S/blob/main/LICENSE
 */

import type { StructuredView } from "webgpu-utils";
import type { Appearance, Filter } from "../../../schema";
import { compileShaderModule } from "../../../utils/wgpu-utils";
import type {
	FilterHandler,
	FilterProcessorContext,
} from "../../canvas/pipeline/FilterRenderer";
import { HK_RADIAL_ROT_DIR_SHADER } from "./hk-radial-rot-dir.wgsl";

export interface HKRadialRotDirParams {
	radialRate: number;
	rotateAngle: number;
	strength: number;
	relativePos: number;
	directionX: number;
	directionY: number;
	centerX: number;
	centerY: number;
	quality: number;
}
export interface HKRadialRotDirFilter extends Appearance<HKRadialRotDirParams> {
	processor: "hk:radial-rot-dir";
}

export class HKRadialRotDirHandler implements FilterHandler {
	private pipeline: GPURenderPipeline | null = null;
	private bindGroupLayout: GPUBindGroupLayout | null = null;
	private uniformView: StructuredView | null = null;
	private canvasFormat: GPUTextureFormat = "rgba8unorm";

	public async initialize(
		device: GPUDevice,
		canvasFormat: GPUTextureFormat,
	): Promise<void> {
		this.canvasFormat = canvasFormat;
		const { module, uniformViews } = compileShaderModule(device, {
			label: "HK Radial Rot Dir Filter Shader",
			code: HK_RADIAL_ROT_DIR_SHADER,
		});

		this.uniformView = uniformViews.uniforms;

		this.bindGroupLayout = device.createBindGroupLayout({
			label: "HK Radial Rot Dir Bind Group Layout",
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
				{
					binding: 2,
					visibility: GPUShaderStage.FRAGMENT,
					sampler: { type: "filtering" },
				},
			],
		});

		this.pipeline = device.createRenderPipeline({
			label: "HK Radial Rot Dir Filter Pipeline",
			layout: device.createPipelineLayout({
				bindGroupLayouts: [this.bindGroupLayout],
			}),
			vertex: { module, entryPoint: "vertexMain" },
			fragment: {
				module,
				entryPoint: "fragmentMain",
				targets: [{ format: this.canvasFormat }],
			},
			primitive: { topology: "triangle-list" },
		});
	}

	public postProcess(context: FilterProcessorContext, filter: Filter): void {
		const f = filter as HKRadialRotDirFilter;
		const {
			device,
			sourceTexture,
			targetTexture,
			commandEncoder,
			sceneInfo: { textureSize, dpiScale },
		} = context;

		if (!this.pipeline || !this.bindGroupLayout || !this.uniformView) {
			console.warn("HKRadialRotDirHandler not initialized");
			return;
		}

		const params = f.paramData.params;

		// Stored 0-1 rate maps onto a dpiScale ratio where 1 means no radial blur,
		// so invert it: 0% = none, 100% = strongest
		let radialRate = Math.max(1 - params.radialRate, 0.01);
		let rotateRad = (params.rotateAngle * Math.PI) / 180;
		const amount = params.strength / 100;
		const relPos = Math.max(-1, Math.min(1, params.relativePos / 100));
		const quality = Math.max(2, Math.min(4096, params.quality));
		// Direction is a unit vector; strength provides its length in px
		const directionX = params.directionX * params.strength * dpiScale;
		const directionY = params.directionY * params.strength * dpiScale;
		// Stored center is normalized 0-1 over the FULL element rect, but the
		// bake may be viewport-clamped to a sub-rect. Expand it in world px on
		// the element rect and map it into bake UV — reading it as a UV of the
		// bake itself snapped the pivot to the clamped rect's centre on every
		// zoom or pan.
		const worldSize = context.sourceWorldSize ?? {
			width: textureSize.width / dpiScale,
			height: textureSize.height / dpiScale,
		};
		const contentOffset = context.sourceContentOffset ?? { x: 0, y: 0 };
		const elementWorldSize = context.coordinateSpace?.worldSize ?? worldSize;
		const worldOrigin = context.coordinateSpace?.sourceOffset ?? { x: 0, y: 0 };
		const centerU =
			((params.centerX * elementWorldSize.width - worldOrigin.x) * dpiScale +
				contentOffset.x) /
			textureSize.width;
		const centerV =
			((params.centerY * elementWorldSize.height - worldOrigin.y) * dpiScale +
				contentOffset.y) /
			textureSize.height;

		if (
			amount === 0 ||
			(radialRate === 1 &&
				rotateRad === 0 &&
				directionX === 0 &&
				directionY === 0)
		) {
			commandEncoder.copyTextureToTexture(
				{ texture: sourceTexture },
				{ texture: targetTexture },
				{ width: textureSize.width, height: textureSize.height },
			);
			return;
		}

		radialRate = radialRate ** amount;
		rotateRad = rotateRad * amount;

		const relPos1 = (relPos - 1) / 2;
		const relPos2 = (relPos + 1) / 2;
		const scale1 = radialRate ** relPos1;
		const scale2 = radialRate ** relPos2;
		const rotate1 = rotateRad * relPos1;
		const rotate2 = rotateRad * relPos2;
		const moveX1 = directionX * relPos1;
		const moveX2 = directionX * relPos2;
		const moveY1 = directionY * relPos1;
		const moveY2 = directionY * relPos2;

		const outputWidth = textureSize.width;
		const outputHeight = textureSize.height;

		const scale = scale2 / scale1;
		const rotate = rotate2 - rotate1;
		const moveX = moveX2 - moveX1;
		const moveY = moveY2 - moveY1;
		const count = quality - 1;

		const scaleRotPerStep = scale ** (-1 / count);
		const rotatePerStep = -rotate / count;
		const c = scaleRotPerStep * Math.cos(rotatePerStep);
		const s = scaleRotPerStep * Math.sin(rotatePerStep);

		const iniC = Math.cos(-rotate1) / scale1;
		const iniS = Math.sin(-rotate1) / scale1;

		this.uniformView.set({
			resolution: [outputWidth, outputHeight],
			dpiScale,
			count,
			scaleRotMat: [
				c,
				(s * outputWidth) / outputHeight,
				(-s * outputHeight) / outputWidth,
				c,
			],
			delta: [-moveX / count / outputWidth, -moveY / count / outputHeight],
			iniScaleRotMat: [
				iniC,
				(iniS * outputWidth) / outputHeight,
				(-iniS * outputHeight) / outputWidth,
				iniC,
			],
			iniDelta: [-moveX1 / outputWidth, -moveY1 / outputHeight],
			center: [centerU, centerV],
		});

		const uniformBuffer = device.createBuffer({
			label: "HK Radial Rot Dir Uniform Buffer",
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

		const bindGroup = device.createBindGroup({
			label: "HK Radial Rot Dir Bind Group",
			layout: this.bindGroupLayout,
			entries: [
				{ binding: 0, resource: { buffer: uniformBuffer } },
				{ binding: 1, resource: sourceTexture.createView() },
				{ binding: 2, resource: sampler },
			],
		});

		const pass = commandEncoder.beginRenderPass({
			label: "HK Radial Rot Dir Filter Pass",
			colorAttachments: [
				{
					view: targetTexture.createView(),
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

	public getExpansionMargin(
		filter: Filter,
		bounds?: { width: number; height: number },
	): number {
		const params = (filter as HKRadialRotDirFilter).paramData.params;
		const strength = params.strength ?? 0;
		const amount = strength / 100;
		if (amount === 0) return 0;

		// The blur spans two transform states at relPos1/relPos2 around the
		// pivot; content lands at most at the larger of the two.
		const relPos = Math.max(-1, Math.min(1, params.relativePos / 100));
		const relSpan = Math.max((1 - relPos) / 2, (1 + relPos) / 2);

		const moveMargin =
			Math.hypot(params.directionX, params.directionY) * strength * relSpan;

		// Zoom/rotation displacement scales with the content radius
		if (!bounds) return moveMargin + strength;

		const centerOffX = (params.centerX - 0.5) * bounds.width;
		const centerOffY = (params.centerY - 0.5) * bounds.height;
		const radius =
			Math.hypot(bounds.width / 2, bounds.height / 2) +
			Math.hypot(centerOffX, centerOffY);

		const ratio = Math.max(1 - params.radialRate, 0.01);
		const magnification = (1 / ratio) ** (amount * relSpan);
		const zoomMargin = radius * (magnification - 1);

		const rotateRad =
			Math.abs((params.rotateAngle * Math.PI) / 180) * amount * relSpan;
		// Chord length, capped at the diameter for large angles
		const rotateMargin = radius * Math.min(2 * Math.sin(rotateRad / 2), 2);

		return zoomMargin + rotateMargin + moveMargin;
	}

	public onScaleFilter(
		params: Filter,
		[scaleX, scaleY]: [number, number],
	): Filter {
		const f = params as HKRadialRotDirFilter;
		const uniformScale = Math.sqrt(scaleX * scaleY);
		return {
			...f,
			paramData: {
				...f.paramData,
				params: {
					...f.paramData.params,
					strength: f.paramData.params.strength * uniformScale,
				},
			},
		};
	}

	public onInterpolate(paramsA: unknown, paramsB: unknown, t: number): unknown {
		const a = paramsA as HKRadialRotDirFilter["paramData"]["params"];
		const b = paramsB as HKRadialRotDirFilter["paramData"]["params"];
		return {
			radialRate: a.radialRate + (b.radialRate - a.radialRate) * t,
			rotateAngle: a.rotateAngle + (b.rotateAngle - a.rotateAngle) * t,
			strength: a.strength + (b.strength - a.strength) * t,
			relativePos: a.relativePos + (b.relativePos - a.relativePos) * t,
			directionX: a.directionX + (b.directionX - a.directionX) * t,
			directionY: a.directionY + (b.directionY - a.directionY) * t,
			centerX: a.centerX + (b.centerX - a.centerX) * t,
			centerY: a.centerY + (b.centerY - a.centerY) * t,
			quality: Math.round(a.quality + (b.quality - a.quality) * t),
		};
	}

	public destroy(): void {
		this.pipeline = null;
		this.bindGroupLayout = null;
		this.uniformView = null;
	}
}
