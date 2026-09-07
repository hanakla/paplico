/**
 * WetStrokeRenderer - runs the wet layer for one stroke. DabRenderer seeds
 * the simulation fields from the stroke's dabs tile by tile, then
 * WetLayerPass diffuses and composites the settled result.
 *
 * Two entrances share that simulation. renderAppearance is the per-appearance
 * isolation route of a plain wet stroke and returns the isolated surface;
 * renderMixed composites a mixing stroke's picked-up pigment onto the texture
 * MixStrokeRenderer owns.
 */

import { readStoredBrushSize } from "../../../../brush/access";
import { BRUSH_PROPERTY_REGISTRY } from "../../../../brush/properties";
import type {
	BoundingBox,
	BrushPropertyId,
	BrushSettings,
	ElementTransform,
} from "../../../../schema";
import {
	calculatePathBounds,
	expandBounds,
	type WorldBBox,
} from "../../../../utils/geometry/bounds";
import { applyTransformToBounds } from "../../../../utils/geometry/geometry";
import { FULL_BLIT_UV_RECT } from "../../CanvasLayerTypes";
import {
	createFrameTextureRef,
	createRenderSurface,
	type RasterizedRenderSurface,
} from "../RenderSurface";
import { resolveSimulationDomain } from "../rasterizationDomain";
import type { TexturePool } from "../TexturePool";
import type { UniformScope } from "../UniformScope";
import type { StrokeDrawInput } from "./BrushRenderer";
import type { DabRenderer, MixedDabSource } from "./DabRenderer";
import { WET_SEED_TARGETS } from "./shaders/brushDab.wgsl";
import { WetLayerPass } from "./WetLayerPass";

interface WetStrokeRendererDeps {
	device: GPUDevice;
	canvasFormat: GPUTextureFormat;
	texturePool: TexturePool;
	uniformScope: UniformScope;
	dabs: DabRenderer;
	/** Hand a frame texture back once this frame's commands are submitted. */
	deferDestroy: (texture: GPUTexture) => void;
}

/** Bind groups in effect for the stroke's element. The viewport uniform is
 *  the simulation tile's own, acquired per tile. */
interface WetStrokeBindings {
	transformsBindGroup: GPUBindGroup | undefined;
	maskBindGroup: GPUBindGroup;
}

/** Where the settled wash composites and how its pixels map to the world. */
interface WetTarget {
	view: GPUTextureView;
	resolution: { width: number; height: number };
	worldOrigin: { x: number; y: number };
	worldPerPixel: number;
}

export class WetStrokeRenderer {
	private readonly deps: WetStrokeRendererDeps;
	private readonly wetLayerPass: WetLayerPass;

	public constructor(deps: WetStrokeRendererDeps) {
		this.deps = deps;
		this.wetLayerPass = new WetLayerPass(deps.device, deps.canvasFormat);
	}

	/**
	 * Render one wet appearance into an isolated texture spanning `bounds` at
	 * `scale` pixels per world unit. It stands in for the normal offscreen
	 * element render inside the wash isolation, so the surface it returns is
	 * shaped like that one and the accumulator blit applies opacity exactly as
	 * it does for any other appearance.
	 */
	public renderAppearance(
		encoder: GPUCommandEncoder,
		input: StrokeDrawInput,
		composedTransform: ElementTransform,
		bounds: WorldBBox,
		scale: number,
		bindings: WetStrokeBindings,
	): RasterizedRenderSurface | null {
		if (input.segments.length === 0) return null;
		const { settings, path } = input;
		const wet = settings.wet!;
		const brushSize = brushSizeOf(settings);

		const width = Math.max(1, Math.ceil(bounds.width * scale));
		const height = Math.max(1, Math.ceil(bounds.height * scale));
		const result = this.deps.texturePool.acquireExact(
			width,
			height,
			this.deps.canvasFormat,
			1,
			GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
			"Wet Appearance",
		);
		encoder
			.beginRenderPass({
				label: "Wet Appearance Clear",
				colorAttachments: [
					{
						view: result.createView(),
						clearValue: { r: 0, g: 0, b: 0, a: 0 },
						loadOp: "clear",
						storeOp: "store",
					},
				],
			})
			.end();

		const effectBounds = applyTransformToBounds(
			expandBounds(
				calculatePathBounds({ ...path, segments: input.segments, filters: [] }),
				brushSize * (0.5 + wet.bleedRadius),
			),
			composedTransform,
		);
		this.simulate(encoder, input, effectBounds, undefined, bindings, {
			view: result.createView(),
			resolution: { width, height },
			worldOrigin: { x: bounds.minX, y: bounds.maxY },
			worldPerPixel: 1 / scale,
		});

		return {
			...createRenderSurface(
				createFrameTextureRef(result, this.deps.deferDestroy),
				{ kind: "world-aabb", bounds, uvRect: FULL_BLIT_UV_RECT },
				{
					role: "color",
					alphaMode: "premultiplied",
					opacityState: "intrinsic",
				},
			),
			effectiveZoom: scale,
		};
	}

	/**
	 * Spread a mixing stroke's picked-up pigment through the wet simulation
	 * onto `target`, a texture centred on `bounds` and drawn at
	 * `effectiveZoom` pixels per world unit. That zoom sits below the
	 * document's scale once the texture is capped.
	 */
	public renderMixed(
		encoder: GPUCommandEncoder,
		input: StrokeDrawInput,
		mixed: MixedDabSource,
		target: { view: GPUTextureView; width: number; height: number },
		bounds: BoundingBox,
		effectiveZoom: number,
		bindings: WetStrokeBindings,
	): void {
		if (input.segments.length === 0) return;
		const { settings } = input;
		const wet = settings.wet!;
		const brushSize = brushSizeOf(settings);
		this.simulate(
			encoder,
			input,
			expandBounds(bounds, brushSize * wet.bleedRadius),
			mixed,
			bindings,
			{
				view: target.view,
				resolution: { width: target.width, height: target.height },
				// The draw viewport is centred on the bounds, so the texture's
				// top-left corner is half a texture away from that centre —
				// which is not the bounds' corner once the texture is capped.
				worldOrigin: {
					x:
						(bounds.minX + bounds.maxX) / 2 -
						target.width / (2 * effectiveZoom),
					y:
						(bounds.minY + bounds.maxY) / 2 +
						target.height / (2 * effectiveZoom),
				},
				worldPerPixel: 1 / effectiveZoom,
			},
		);
	}

	/** Free what this frame's simulation dispatches referenced. Called one
	 *  frame late by the owner, after the encoder has been submitted. */
	public releaseFrame(): void {
		this.wetLayerPass.releaseFrame();
	}

	public destroy(): void {
		this.wetLayerPass.destroy();
	}

	/**
	 * The simulation both entrances share: tile the domain, seed each tile
	 * from the stroke's dabs in the tile's own space, run the wet layer and
	 * composite it onto the target.
	 */
	private simulate(
		encoder: GPUCommandEncoder,
		input: StrokeDrawInput,
		effectBounds: BoundingBox,
		mixed: MixedDabSource | undefined,
		bindings: WetStrokeBindings,
		target: WetTarget,
	): void {
		const { settings } = input;
		const wet = settings.wet!;
		const brushSize = brushSizeOf(settings);
		const domain = resolveSimulationDomain(
			effectBounds,
			brushSize,
			this.deps.device.limits.maxTextureDimension2D,
		);
		const base = (id: BrushPropertyId): number =>
			settings.properties[id]?.base ?? BRUSH_PROPERTY_REGISTRY[id].base;
		// Coefficient targets clear to the stroke's own bases so texels no dab
		// covers still carry sane coefficients; the fields clear to nothing.
		const clearValues = [
			{ r: 0, g: 0, b: 0, a: 0 },
			{ r: 0, g: 0, b: 0, a: 0 },
			{ r: 0, g: 0, b: 0, a: 0 },
			{ r: base("absorption"), g: base("granulation"), b: 0, a: 0 },
			{ r: base("bleedSoftness"), g: base("edgeDarkening"), b: 0, a: 0 },
			{ r: base("edgeRoughness"), g: 0, b: 0, a: 0 },
		];
		const brushRadiusPx = Math.max(brushSize * 0.5, 1) / domain.worldPerPixel;

		for (const tile of domain.tiles) {
			const tileW = tile.textureSize.width;
			const tileH = tile.textureSize.height;
			if (tileW <= 0 || tileH <= 0) continue;

			const seeds = WET_SEED_TARGETS.map((seedTarget, index) =>
				this.deps.texturePool.acquireExact(
					tileW,
					tileH,
					seedTarget.format,
					1,
					GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
					`Wet Seed ${index}`,
				),
			);
			const seedPass = encoder.beginRenderPass({
				label: "Wet Layer Seed Pass",
				colorAttachments: seeds.map((texture, index) => ({
					view: texture.createView(),
					clearValue: clearValues[index],
					loadOp: "clear" as const,
					storeOp: "store" as const,
				})),
			});
			// Dabs draw in the domain's own space: one texel per domain pixel.
			const uniform = this.deps.uniformScope.acquire(
				{
					x: tile.worldOrigin.x + (tileW * domain.worldPerPixel) / 2,
					y: tile.worldOrigin.y - (tileH * domain.worldPerPixel) / 2,
					zoom: 1 / domain.worldPerPixel,
					rotation: 0,
				},
				tileW,
				tileH,
			);
			this.deps.dabs.renderWetSeeds(
				seedPass,
				input,
				{ uniformBuffer: uniform.buffer, ...bindings },
				mixed,
			);
			seedPass.end();

			this.wetLayerPass.apply(encoder, {
				seeds: {
					pigment: seeds[0],
					fluidVelocity: seeds[1],
					moisture: seeds[2],
					absorptionGranulation: seeds[3],
					softnessEdgeDarkening: seeds[4],
					edgeRoughness: seeds[5],
				},
				domain: { width: tileW, height: tileH },
				domainWorldOrigin: tile.worldOrigin,
				domainWorldPerPixel: domain.worldPerPixel,
				target: target.view,
				targetResolution: target.resolution,
				targetWorldOrigin: target.worldOrigin,
				targetWorldPerPixel: target.worldPerPixel,
				brushRadiusPx,
				bleedRadius: wet.bleedRadius,
				pigmentLoad: wet.pigmentLoad,
				grainScale: wet.grainScale,
				randomSeed: settings.randomSeed,
				paperGrain: base("grainAmount"),
				scatter: (wet.scatter ?? 0) * brushRadiusPx,
			});

			for (const texture of seeds) this.deps.deferDestroy(texture);
		}
	}
}

function brushSizeOf(settings: BrushSettings): number {
	return Math.max(readStoredBrushSize(settings) ?? 10, 1);
}
