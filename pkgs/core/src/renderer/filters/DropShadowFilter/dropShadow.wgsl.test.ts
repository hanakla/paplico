import { describe, expect, it } from "vitest";
import {
	DROP_SHADOW_SHADER,
	DROP_SHADOW_SPREAD_SHADER,
} from "./dropShadow.wgsl";

describe("drop shadow shader edge sampling", () => {
	it("should treat offset and Gaussian blur samples outside the texture as transparent", () => {
		expect(DROP_SHADOW_SHADER).toContain(
			"return select(0.0, alpha, isInside);",
		);
		expect(DROP_SHADOW_SHADER).toContain("sampleInputAlpha(baseUV)");
		expect(DROP_SHADOW_SHADER).toContain("sampleInputAlpha(sampleUV)");
	});

	it("should treat spread lookups outside the texture as transparent", () => {
		expect(DROP_SHADOW_SPREAD_SHADER).toContain(
			"all(samplePos >= vec2f(0.0)) && all(samplePos < vec2f(dims))",
		);
		expect(DROP_SHADOW_SPREAD_SHADER).toContain(
			"if (!isInside) {\n\t\t\treturn vec4f(0.0);",
		);
	});
});
