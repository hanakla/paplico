import type { Appearance, Filter } from "../../../schema";
import type { FilterProcessorContext } from "../../canvas/pipeline/FilterRenderer";
import { SvgFilterHandlerBase } from "./SvgFilterHandlerBase";
import { SvgFullscreenPass } from "./SvgFullscreenPass";
import { SVG_COMPONENT_TRANSFER_SHADER } from "./svg-component-transfer.wgsl";
import { resolveSvgInput, type SvgFilterInputParams } from "./svgFilterInput";

/** One feFuncX element. Empty table / discrete values act as identity. */
export type SvgTransferFunction =
	| { type: "identity" }
	| { type: "table" | "discrete"; tableValues: number[] }
	| { type: "linear"; slope: number; intercept: number }
	| { type: "gamma"; amplitude: number; exponent: number; offset: number };

/** feComponentTransfer. */
export interface SvgComponentTransferParams extends SvgFilterInputParams {
	r: SvgTransferFunction;
	g: SvgTransferFunction;
	b: SvgTransferFunction;
	a: SvgTransferFunction;
}

export interface SvgComponentTransferFilter
	extends Appearance<SvgComponentTransferParams> {
	processor: "svg:component-transfer";
}

/** Must match the TYPE_* constants in the shader. */
const TRANSFER_TYPE_INDEX: Record<SvgTransferFunction["type"], number> = {
	identity: 0,
	table: 1,
	discrete: 2,
	linear: 3,
	gamma: 4,
};

export class SvgComponentTransferHandler extends SvgFilterHandlerBase<SvgComponentTransferParams> {
	private readonly pass = new SvgFullscreenPass();
	protected readonly passes = [this.pass];

	public async initialize(
		device: GPUDevice,
		canvasFormat: GPUTextureFormat,
	): Promise<void> {
		this.pass.initialize(
			device,
			canvasFormat,
			"SVG Component Transfer",
			SVG_COMPONENT_TRANSFER_SHADER,
			{ textures: 1, storage: true },
		);
	}

	public postProcess(context: FilterProcessorContext, filter: Filter): void {
		const { r, g, b, a, in: input } = this.params(filter);
		const source = resolveSvgInput(context, input);
		const tables: number[] = [];
		const channels = [r, g, b, a].map((fn) => channelUniform(fn, tables));
		this.pass.run(
			context,
			{ channels, inputMode: source.mode },
			[source.texture],
			context.targetTexture,
			tableBuffer(context.device, tables),
		);
	}
}

/** Uniform block of one channel; table values are appended to `tables`. */
function channelUniform(
	fn: SvgTransferFunction,
	tables: number[],
): Record<string, unknown> {
	const uniform = {
		kind: TRANSFER_TYPE_INDEX[fn.type],
		offset: tables.length,
		count: 0,
		coeffs: [0, 0, 0, 0],
	};
	switch (fn.type) {
		case "table":
		case "discrete":
			tables.push(...fn.tableValues);
			uniform.count = fn.tableValues.length;
			break;
		case "linear":
			uniform.coeffs = [fn.slope, fn.intercept, 0, 0];
			break;
		case "gamma":
			uniform.coeffs = [fn.amplitude, fn.exponent, fn.offset, 0];
			break;
	}
	return uniform;
}

/** A storage buffer never binds empty, so an unused table still holds one value. */
function tableBuffer(device: GPUDevice, tables: number[]): GPUBuffer {
	const data = new Float32Array(tables.length === 0 ? [0] : tables);
	const buffer = device.createBuffer({
		label: "SVG Component Transfer Tables",
		size: data.byteLength,
		usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
	});
	device.queue.writeBuffer(buffer, 0, data);
	return buffer;
}
