import { getTestDevice } from "../../testUtils/shaderTestHarness";
import { compileShaderModule } from "../../utils/wgpu-utils";
import { buildBrushDabShader, DAB_TIP_MODES } from "./brushDab.wgsl";

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
});
