import type { Appearance, Filter } from "../../../schema";
import { lerp } from "../../../utils/math";
import type { FilterProcessorContext } from "../../canvas/pipeline/FilterRenderer";
import { SvgFilterHandlerBase } from "./SvgFilterHandlerBase";
import { SvgFullscreenPass } from "./SvgFullscreenPass";
import { SVG_TURBULENCE_SHADER } from "./svg-turbulence.wgsl";
import { svgRegionOriginTexel } from "./svgFilterInput";
import {
	buildTurbulenceLattice,
	packTurbulenceLattice,
	TURBULENCE_PERLIN_N,
} from "./turbulenceLattice";

/**
 * feTurbulence. Generates noise over the whole filter region, ignoring any
 * input. baseFrequency is in cycles per user-space px, where user space is
 * world px with its origin at the filter region's top-left corner.
 */
export interface SvgTurbulenceParams {
	type: "fractalNoise" | "turbulence";
	baseFrequencyX: number;
	baseFrequencyY: number;
	numOctaves: number;
	seed: number;
	stitchTiles: boolean;
}

export interface SvgTurbulenceFilter extends Appearance<SvgTurbulenceParams> {
	processor: "svg:turbulence";
}

/** Seeds whose lattice buffers stay resident (FIFO beyond it). */
const MAX_CACHED_SEEDS = 8;

interface StitchInfo {
	baseFrequency: [number, number];
	wrap: [number, number];
	size: [number, number];
}

export class SvgTurbulenceHandler extends SvgFilterHandlerBase<SvgTurbulenceParams> {
	private readonly pass = new SvgFullscreenPass();
	protected readonly passes = [this.pass];
	private latticeBuffers = new Map<number, GPUBuffer>();
	private pendingDestroy: GPUBuffer[] = [];

	public async initialize(
		device: GPUDevice,
		canvasFormat: GPUTextureFormat,
	): Promise<void> {
		this.pass.initialize(
			device,
			canvasFormat,
			"SVG Turbulence",
			SVG_TURBULENCE_SHADER,
			{ textures: 0, storage: true },
		);
	}

	public postProcess(context: FilterProcessorContext, filter: Filter): void {
		const {
			type,
			baseFrequencyX,
			baseFrequencyY,
			numOctaves,
			seed,
			stitchTiles,
		} = this.params(filter);
		const { dpiScale, textureSize } = context.sceneInfo;
		// The SVG exporter places the filter's user-space origin at the filter
		// region's top-left, so resvg evaluates the same noise coordinates.
		const contentOrigin = svgRegionOriginTexel(context);
		const regionSize = context.coordinateSpace?.worldSize ?? {
			width: textureSize.width / dpiScale,
			height: textureSize.height / dpiScale,
		};
		const stitch = stitchTiles
			? stitchFrequency(
					[baseFrequencyX, baseFrequencyY],
					[0, 0, regionSize.width, regionSize.height],
				)
			: {
					baseFrequency: [baseFrequencyX, baseFrequencyY],
					wrap: [0, 0],
					size: [0, 0],
				};
		this.pass.run(
			context,
			{
				baseFrequency: stitch.baseFrequency,
				contentOrigin: [contentOrigin.x, contentOrigin.y],
				stitchWrap: stitch.wrap,
				stitchSize: stitch.size,
				invDpiScale: 1 / dpiScale,
				numOctaves: Math.max(0, Math.trunc(numOctaves)),
				fractalNoise: type === "fractalNoise" ? 1 : 0,
				stitchTiles: stitchTiles ? 1 : 0,
			},
			[],
			context.targetTexture,
			this.latticeBuffer(context.device, seed),
		);
	}

	public onScaleFilter(filter: Filter, [sx, sy]: [number, number]): Filter {
		const { baseFrequencyX, baseFrequencyY } = this.params(filter);
		return this.withParams(filter, {
			baseFrequencyX: baseFrequencyX / sx,
			baseFrequencyY: baseFrequencyY / sy,
		});
	}

	public onInterpolate(a: unknown, b: unknown, t: number): unknown {
		const pa = a as SvgTurbulenceParams;
		const pb = b as SvgTurbulenceParams;
		return {
			...pa,
			baseFrequencyX: lerp(pa.baseFrequencyX, pb.baseFrequencyX, t),
			baseFrequencyY: lerp(pa.baseFrequencyY, pb.baseFrequencyY, t),
		};
	}

	public override flushPendingDestroy(): void {
		super.flushPendingDestroy();
		for (const buffer of this.pendingDestroy) buffer.destroy();
		this.pendingDestroy.length = 0;
	}

	public override destroy(): void {
		super.destroy();
		this.flushPendingDestroy();
		for (const buffer of this.latticeBuffers.values()) buffer.destroy();
		this.latticeBuffers.clear();
	}

	private latticeBuffer(device: GPUDevice, seed: number): GPUBuffer {
		// The spec truncates a fractional seed before it reaches the generator.
		const key = Math.trunc(seed);
		const existing = this.latticeBuffers.get(key);
		if (existing) return existing;
		if (this.latticeBuffers.size >= MAX_CACHED_SEEDS) {
			const [oldestKey, oldest] = this.latticeBuffers.entries().next().value!;
			// The evicted buffer may still be referenced by this frame's
			// encoder; it is destroyed after the frame like scratch textures.
			this.pendingDestroy.push(oldest);
			this.latticeBuffers.delete(oldestKey);
		}
		const packed = packTurbulenceLattice(buildTurbulenceLattice(key));
		const buffer = device.createBuffer({
			label: `SVG Turbulence Lattice (seed ${key})`,
			size: packed.byteLength,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
		});
		device.queue.writeBuffer(buffer, 0, packed);
		this.latticeBuffers.set(key, buffer);
		return buffer;
	}
}

/**
 * The reference code's stitching preamble: snaps each base frequency to a
 * whole number of cycles per tile so the tile borders are continuous, and
 * derives the first-octave lattice wrap thresholds.
 */
function stitchFrequency(
	[freqX, freqY]: [number, number],
	[tileX, tileY, tileW, tileH]: [number, number, number, number],
): StitchInfo {
	const fx = snapFrequency(freqX, tileW);
	const fy = snapFrequency(freqY, tileH);
	const width = Math.trunc(tileW * fx + 0.5);
	const height = Math.trunc(tileH * fy + 0.5);
	return {
		baseFrequency: [fx, fy],
		size: [width, height],
		wrap: [
			Math.trunc(tileX * fx + TURBULENCE_PERLIN_N + width),
			Math.trunc(tileY * fy + TURBULENCE_PERLIN_N + height),
		],
	};
}

function snapFrequency(frequency: number, tileLength: number): number {
	if (frequency === 0) return 0;
	const lo = Math.floor(tileLength * frequency) / tileLength;
	const hi = Math.ceil(tileLength * frequency) / tileLength;
	return frequency / lo < hi / frequency ? lo : hi;
}
