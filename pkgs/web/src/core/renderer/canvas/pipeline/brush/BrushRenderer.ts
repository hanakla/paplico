/**
 * BrushRenderer - the brush engine's GPU routes for one canvas. Owns the
 * DabRenderer, RibbonRenderer and WetStrokeRenderer, the frame buffer pools
 * the dab and ribbon routes draw from, and the group(1) layout both pipelines
 * share. It dispatches an immediate stroke to the route its engine names and
 * drives the frame lifecycle of everything it owns. Geometric strokes never
 * arrive here: they are tessellated and drawn by PathElementRenderer.
 */

import type {
	BrushSettings,
	CubicBezierSegment,
	Path,
	StrokeColor,
} from "../../../../schema";
import type { StampCache } from "../../caches/StampCache";
import type { TexturePool } from "../TexturePool";
import type { UniformScope } from "../UniformScope";
import { BrushFrameBuffers } from "./BrushFrameBuffers";
import type { BrushTextureManager } from "./BrushTextureManager";
import { DabRenderer, type DabRendererOptions } from "./DabRenderer";
import { RibbonRenderer } from "./RibbonRenderer";
import { WetStrokeRenderer } from "./WetStrokeRenderer";

/**
 * One stroke appearance to draw. The caller picks the appearance and its
 * brush route; the renderers read only these fields, and from `path` only
 * its geometry.
 */
export interface StrokeDrawInput {
	/** Geometry owner: strokeWidths / pathStart / pathEnd, and the bounds a
	 *  "within" gradient spans. */
	path: Path;
	segments: CubicBezierSegment[];
	strokeColor: StrokeColor;
	/** Stored brush settings, with the renderer default filled in when the
	 *  appearance carries none. */
	settings: BrushSettings;
	alphaMultiplier: number;
	transformIndex: number;
}

/** Where a brush draw lands: the viewport uniform of the pass being encoded
 *  plus the transforms and mask bind groups in effect for the element. */
export interface BrushDrawBindings {
	uniformBuffer: GPUBuffer;
	transformsBindGroup: GPUBindGroup | undefined;
	maskBindGroup: GPUBindGroup;
}

interface BrushRendererDeps {
	device: GPUDevice;
	canvasFormat: GPUTextureFormat;
	/** Device-wide brush texture store; the renderer reads it and never
	 *  destroys it. */
	textures: BrushTextureManager;
	transformsBindGroupLayout: GPUBindGroupLayout;
	maskBindGroupLayout: GPUBindGroupLayout;
	/** Resolved per use: the cache manager swaps its active document scope
	 *  between frames. */
	getStampCache: () => StampCache;
	texturePool: TexturePool;
	uniformScope: UniformScope;
	/** Hand a frame texture back once this frame's commands are submitted. */
	deferDestroy: (texture: GPUTexture) => void;
	options?: DabRendererOptions;
}

export class BrushRenderer {
	public readonly textures: BrushTextureManager;
	public readonly dabs: DabRenderer;
	public readonly ribbons: RibbonRenderer;
	public readonly wet: WetStrokeRenderer;
	private readonly buffers: BrushFrameBuffers;

	public constructor(deps: BrushRendererDeps) {
		const {
			device,
			canvasFormat,
			textures,
			transformsBindGroupLayout,
			maskBindGroupLayout,
		} = deps;
		this.textures = textures;
		this.buffers = new BrushFrameBuffers(device);
		const strokeMetaBindGroupLayout = createStrokeMetaBindGroupLayout(device);
		this.dabs = new DabRenderer({
			device,
			canvasFormat,
			textureManager: textures,
			buffers: this.buffers,
			strokeMetaBindGroupLayout,
			transformsBindGroupLayout,
			maskBindGroupLayout,
			getStampCache: deps.getStampCache,
			options: deps.options,
		});
		this.ribbons = new RibbonRenderer({
			device,
			canvasFormat,
			textureManager: textures,
			buffers: this.buffers,
			strokeMetaBindGroupLayout,
			transformsBindGroupLayout,
			maskBindGroupLayout,
		});
		this.wet = new WetStrokeRenderer({
			device,
			canvasFormat,
			texturePool: deps.texturePool,
			uniformScope: deps.uniformScope,
			dabs: this.dabs,
			deferDestroy: deps.deferDestroy,
		});
	}

	/** Rewind the frame pools and let the dab route free what last frame's
	 *  submitted draws no longer need. Call at the start of each frame. */
	public beginFrame(): void {
		this.buffers.beginFrame();
		this.dabs.beginFrame();
	}

	/** Retire the GPU resources this frame's wet simulations referenced.
	 *  Call after every pass of the frame is encoded, before the submit. */
	public endFrame(): void {
		this.wet.releaseFrame();
	}

	/** Draw one stroke immediately, on the route its engine names. */
	public render(
		pass: GPURenderPassEncoder,
		input: StrokeDrawInput,
		bindings: BrushDrawBindings,
	): void {
		if (input.segments.length === 0) return;
		if (input.settings.engine === "ribbon") {
			this.ribbons.render(pass, input, bindings);
			return;
		}
		this.dabs.render(pass, input, bindings);
	}

	public destroy(): void {
		this.wet.destroy();
		this.dabs.destroy();
		this.ribbons.destroy();
		this.buffers.destroy();
	}
}

/** Bind group layout 1 of every brush pipeline: PathMetas + ColorStops. */
function createStrokeMetaBindGroupLayout(
	device: GPUDevice,
): GPUBindGroupLayout {
	return device.createBindGroupLayout({
		label: "Stroke Bind Group Layout 1",
		entries: [
			{
				binding: 0,
				visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
				buffer: { type: "read-only-storage" },
			},
			{
				binding: 1,
				visibility: GPUShaderStage.FRAGMENT,
				buffer: { type: "read-only-storage" },
			},
		],
	});
}
