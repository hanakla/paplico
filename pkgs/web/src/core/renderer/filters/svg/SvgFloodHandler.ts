import {
	type Appearance,
	type Color,
	colorToRawRGBA,
	type Filter,
	toRGBColor,
} from "../../../schema";
import { lerpOptionalRGBColor } from "../../../utils/color";
import { lerp } from "../../../utils/math";
import type { FilterProcessorContext } from "../../canvas/pipeline/FilterRenderer";
import { SvgFilterHandlerBase } from "./SvgFilterHandlerBase";
import { SvgFullscreenPass } from "./SvgFullscreenPass";
import { SVG_FLOOD_SHADER } from "./svg-flood.wgsl";

/** feFlood: fills the whole filter region, ignoring any input. */
export interface SvgFloodParams {
	color: Color;
	opacity: number;
}

export interface SvgFloodFilter extends Appearance<SvgFloodParams> {
	processor: "svg:flood";
}

export class SvgFloodHandler extends SvgFilterHandlerBase<SvgFloodParams> {
	private readonly pass = new SvgFullscreenPass();
	protected readonly passes = [this.pass];

	public async initialize(
		device: GPUDevice,
		canvasFormat: GPUTextureFormat,
	): Promise<void> {
		this.pass.initialize(device, canvasFormat, "SVG Flood", SVG_FLOOD_SHADER, {
			textures: 0,
		});
	}

	public postProcess(context: FilterProcessorContext, filter: Filter): void {
		this.pass.run(
			context,
			{ color: svgFloodColor(this.params(filter)) },
			[],
			context.targetTexture,
		);
	}

	public onInterpolate(a: unknown, b: unknown, t: number): unknown {
		return lerpSvgFlood(a as SvgFloodParams, b as SvgFloodParams, t);
	}

	public onAdjustColor(
		params: unknown,
		adjustColor: (color: Color) => Color,
	): unknown {
		return adjustSvgFloodColor(params as SvgFloodParams, adjustColor);
	}
}

/** Premultiplied RGBA of a flood: the color at flood-opacity. */
export function svgFloodColor({
	color,
	opacity,
}: SvgFloodParams): [number, number, number, number] {
	const raw = colorToRawRGBA(color);
	const a = raw.a * opacity;
	return [raw.r * a, raw.g * a, raw.b * a, a];
}

export function lerpSvgFlood<P extends SvgFloodParams>(
	a: P,
	b: P,
	t: number,
): P {
	return {
		...a,
		color: lerpOptionalRGBColor(
			toRGBColor(colorToRawRGBA(a.color)),
			toRGBColor(colorToRawRGBA(b.color)),
			t,
		),
		opacity: lerp(a.opacity, b.opacity, t),
	};
}

export function adjustSvgFloodColor<P extends SvgFloodParams>(
	params: P,
	adjustColor: (color: Color) => Color,
): P {
	return { ...params, color: adjustColor(params.color) };
}
