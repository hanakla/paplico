import { getTestDevice } from "../../testUtils/shaderTestHarness";
import { compileShaderModule } from "../../utils/wgpu-utils";
import {
	buildBrushDabShader,
	DAB_TIP_MODES,
	WET_SEED_TARGETS,
} from "./brushDab.wgsl";

describe("brushDab shader single source", () => {
	it("should contain exactly one gradient sampling switch per variant", () => {
		for (const tipMode of DAB_TIP_MODES) {
			const code = buildBrushDabShader({ tipMode });
			const occurrences = code.split("fn sampleGradientStops").length - 1;
			expect(occurrences).toBe(1);
		}
	});

	it.each(
		DAB_TIP_MODES.map((mode) => [mode] as const),
	)("should build a valid render pipeline for the %s tip variant", async (tipMode) => {
		const device = await getTestDevice();
		const { module } = compileShaderModule(device, {
			label: `brushDab-${tipMode}`,
			code: buildBrushDabShader({ tipMode }),
		});
		const pipeline = await device.createRenderPipelineAsync({
			layout: "auto",
			vertex: { module, entryPoint: "vs_main" },
			fragment: {
				module,
				entryPoint: "fs_main",
				targets: [{ format: "rgba8unorm" }],
			},
			primitive: { topology: "triangle-list" },
		});
		expect(pipeline).toBeTruthy();
	});

	it("should build a valid pipeline for the wet-seed variant", async () => {
		const device = await getTestDevice();
		const code = buildBrushDabShader({ tipMode: "procedural", wetSeed: true });
		// The wet route seeds its fields from each dab, not from one uniform
		// per stroke as v1 did.
		expect(code).toContain("dab.wetness");
		expect(code).toContain("dab.directionality");
		// Five coefficients across three narrow targets, so each can blend by
		// coverage while the fields keep accumulating.
		expect(WET_SEED_TARGETS).toHaveLength(6);
		const { module } = compileShaderModule(device, {
			label: "brushDab-wet",
			code,
		});
		const pipeline = await device.createRenderPipelineAsync({
			layout: "auto",
			vertex: { module, entryPoint: "vs_main" },
			fragment: {
				module,
				entryPoint: "fs_wet",
				targets: [...WET_SEED_TARGETS],
			},
			primitive: { topology: "triangle-list" },
		});
		expect(pipeline).toBeTruthy();
	});

	it("should build a valid pipeline for the mixed-colors variant", async () => {
		const device = await getTestDevice();
		const code = buildBrushDabShader({
			tipMode: "procedural",
			mixedColors: true,
		});
		expect(code).toContain("var<storage, read> mixedColors: array<vec4<f32>>");
		const { module } = compileShaderModule(device, {
			label: "brushDab-mixed",
			code,
		});
		const pipeline = await device.createRenderPipelineAsync({
			layout: "auto",
			vertex: { module, entryPoint: "vs_main" },
			fragment: {
				module,
				entryPoint: "fs_main",
				targets: [{ format: "rgba8unorm" }],
			},
			primitive: { topology: "triangle-list" },
		});
		expect(pipeline).toBeTruthy();
	});
});
