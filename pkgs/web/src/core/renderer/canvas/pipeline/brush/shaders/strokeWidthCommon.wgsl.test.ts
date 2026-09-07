import { describe, expect, it } from "vitest";
import {
	getTestDevice,
	setupComputeShaderTest,
} from "../../../../../testUtils/shaderTestHarness";
import { buildBrushDabShader, DAB_TIP_MODES } from "./brushDab.wgsl";
import { RIBBON_STROKE_SHADER } from "./ribbonStroke.wgsl";
import { STROKE_WIDTH_COMMON_WGSL } from "./strokeWidthCommon.wgsl";

describe("strokeWidthCoverage", () => {
	it("should keep only the signed interval and hide exhausted widths", async () => {
		const setup = await setupComputeShaderTest(COVERAGE_TEST_SHADER);
		const input = setup.createStorageBuffer(
			new Float32Array([
				-0.75, -0.5, 1, 0, 0, -0.5, 1, 0, 0, -1, 1, 0, -1.5, -2, 1, 0, 0, 1, 1,
				0,
			]),
		);
		const output = setup.createStorageBuffer(new Float32Array(5));

		await setup.dispatch(
			[
				{ binding: 0, resource: { buffer: input } },
				{ binding: 1, resource: { buffer: output } },
			],
			[5, 1, 1],
		);

		const values = await setup.readBuffer(output);
		expect(values[0]).toBeCloseTo(1, 5);
		expect(values[1]).toBeCloseTo(0, 5);
		expect(values[2]).toBeCloseTo(0, 5);
		expect(values[3]).toBeCloseTo(0, 5);
		expect(values[4]).toBeCloseTo(1, 5);

		input.destroy();
		output.destroy();
	});

	it("should preserve unchanged edges and normalize tip, stamp, and across coordinates", async () => {
		const setup = await setupComputeShaderTest(GEOMETRY_TEST_SHADER);
		const output = setup.createStorageBuffer(new Float32Array(7));

		await setup.dispatch(
			[{ binding: 0, resource: { buffer: output } }],
			[1, 1, 1],
		);

		const values = await setup.readBuffer(output);
		expect(values[0]).toBeCloseTo(1, 5);
		expect(values[1]).toBeCloseTo(-1, 5);
		expect(values[2]).toBeCloseTo(-1, 5);
		expect(values[3]).toBeCloseTo(0, 5);
		expect(values[4]).toBeCloseTo(1, 5);
		expect(values[5]).toBeCloseTo(0.5, 5);
		expect(values[6]).toBeCloseTo(0.5, 5);

		output.destroy();
	});
});

describe("brush stroke shaders", () => {
	it.each([
		...DAB_TIP_MODES.flatMap((tipMode) => [
			[`dab (${tipMode})`, buildBrushDabShader({ tipMode })],
			[
				`dab (${tipMode}, mixed colors)`,
				buildBrushDabShader({ tipMode, mixedColors: true }),
			],
			[
				`dab (${tipMode}, wet seed)`,
				buildBrushDabShader({ tipMode, wetSeed: true }),
			],
		]),
		["ribbon", RIBBON_STROKE_SHADER],
	])("should compile the %s shader", async (_name, code) => {
		const device = await getTestDevice();
		const module = device.createShaderModule({ code });
		const info = await module.getCompilationInfo();

		expect(info.messages.filter(({ type }) => type === "error")).toEqual([]);
	});
});

const COVERAGE_TEST_SHADER = /* wgsl */ `
${STROKE_WIDTH_COMMON_WGSL}

@group(0) @binding(0) var<storage, read> input: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> output: array<f32>;

@compute @workgroup_size(1)
fn main(@builtin(global_invocation_id) id: vec3u) {
	let value = input[id.x];
	output[id.x] = strokeWidthCoverage(value.x, value.y, value.z);
}
`;

const GEOMETRY_TEST_SHADER = /* wgsl */ `
${STROKE_WIDTH_COMMON_WGSL}

@group(0) @binding(0) var<storage, read_write> output: array<f32>;

@compute @workgroup_size(1)
fn main() {
	output[0] = strokeWidthCoverage(-0.99, -0.5, 1.0);
	output[1] = strokeWidthPosition(-1.0, -1.0, 1.0);
	output[2] = strokeWidthPosition(1.0, -1.0, 1.0);
	output[3] = strokeWidthAcrossUV(-1.0);
	output[4] = strokeWidthAcrossUV(1.0);
	output[5] = normalizedStampNormalDistance(
		vec2f(0.0, 2.5),
		vec2f(0.0, 1.0),
		vec2f(10.0, 5.0),
		0.0,
	);
	output[6] = normalizedStampNormalDistance(
		vec2f(2.5, 0.0),
		vec2f(1.0, 0.0),
		vec2f(10.0, 5.0),
		1.57079632679,
	);
}
`;
