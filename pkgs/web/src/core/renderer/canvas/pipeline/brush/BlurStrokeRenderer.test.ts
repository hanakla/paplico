import { describe, expect, it } from "vitest";
import { createDefaultTransform } from "../../../../document/factory";
import type { BrushSettings, Filter, Path } from "../../../../schema";
import { resolveBackdropBlurStroke } from "./BlurStrokeRenderer";
import { resolveMixingStroke } from "./MixStrokeRenderer";

/**
 * Which strokes the blur route owns. A blur stroke shows the backdrop
 * through its coverage instead of painting, so it takes the place of
 * mixing and of the wet layer rather than combining with them.
 */
describe("resolveBackdropBlurStroke", () => {
	it("should claim a dab stroke with the backdrop blur enabled", () => {
		const element = strokePath(blurBrushSettings());

		expect(
			resolveBackdropBlurStroke(element)?.settings.backdropBlur?.radius,
		).toBe(0.5);
	});

	it("should ignore a stroke whose backdrop blur is disabled", () => {
		const element = strokePath(blurBrushSettings({ enabled: false }));

		expect(resolveBackdropBlurStroke(element)).toBeNull();
	});

	it("should ignore a ribbon stroke", () => {
		const element = strokePath({
			...blurBrushSettings(),
			engine: "ribbon",
			tip: undefined,
		});

		expect(resolveBackdropBlurStroke(element)).toBeNull();
	});

	it("should take a stroke away from the mixing route when both are on", () => {
		const element = strokePath({
			...blurBrushSettings(),
			mixing: {
				enabled: true,
				mode: "dulling",
				sampleRadius: 1,
				sampleTrail: 1,
				blendStyle: 0,
			},
		});

		expect(resolveBackdropBlurStroke(element)).not.toBeNull();
		expect(resolveMixingStroke(element)).toBeNull();
	});

	it("should ignore a disabled stroke appearance", () => {
		const element = strokePath(blurBrushSettings());
		element.filters = [{ ...element.filters![0], enabled: false }];

		expect(resolveBackdropBlurStroke(element)).toBeNull();
	});
});

function blurBrushSettings(
	overrides: { enabled?: boolean } = {},
): BrushSettings {
	return {
		version: 2,
		engine: "dab",
		strokeOpacity: 1,
		paintMode: "wash",
		properties: { size: { base: 20 }, spacing: { base: 0.2 } },
		tip: { kind: "procedural", hardness: 1, angleMode: "fixed" },
		backdropBlur: { enabled: overrides.enabled ?? true, radius: 0.5 },
		randomSeed: 1,
	};
}

function strokePath(brushSettings: BrushSettings): Path {
	return {
		id: "path-1",
		type: "path",
		opacity: 1,
		blendMode: "normal",
		transform: createDefaultTransform(),
		segments: [],
		filters: [
			{
				uid: "stroke-1",
				processor: "stroke",
				opacity: 1,
				blendMode: "normal",
				paramData: {
					version: "1",
					params: {
						strokeColor: {
							type: "solid",
							color: { type: "rgb", r: 0, g: 0, b: 0, a: 1 },
						},
						brushSettings,
					},
				},
			} as unknown as Filter,
		],
	};
}
