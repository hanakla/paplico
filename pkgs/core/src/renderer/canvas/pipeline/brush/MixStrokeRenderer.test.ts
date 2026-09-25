import { describe, expect, it } from "vitest";
import { createDefaultTransform } from "../../../../document/factory";
import type { Filter, Group, Path } from "../../../../schema";
import { resolveMixingStroke } from "./MixStrokeRenderer";

/**
 * Which strokes the mix pass owns (design §10, §13-7). Everything else must
 * stay on its existing route. Picking up the layer below belongs to the mix
 * pass alone, which is why a wet brush that mixes lands here.
 */
describe("resolveMixingStroke", () => {
	it("should claim a dab stroke with mixing enabled", () => {
		const element = strokePath(mixingBrushSettings());

		expect(resolveMixingStroke(element)?.settings.mixing?.enabled).toBe(true);
	});

	it("should claim a wet stroke that mixes", () => {
		// The wet layer never touches colour, so a wet brush that picks up the
		// layer below does so through mixing.
		const element = strokePath({
			...mixingBrushSettings(),
			paintMode: "wash",
			wet: {
				enabled: true,
				bleedRadius: 0.5,
				pigmentLoad: 0.85,
				grainScale: 1,
			},
		});

		expect(resolveMixingStroke(element)?.settings.wet?.enabled).toBe(true);
	});

	it("should ignore a stroke whose mixing is disabled", () => {
		const element = strokePath(mixingBrushSettings({ enabled: false }));

		expect(resolveMixingStroke(element)).toBeNull();
	});

	it("should ignore a disabled stroke appearance", () => {
		const element = strokePath(mixingBrushSettings());
		element.filters = [{ ...element.filters![0], enabled: false }];

		expect(resolveMixingStroke(element)).toBeNull();
	});

	it("should ignore non-path elements", () => {
		const group: Group = {
			id: "group-1",
			type: "group",
			childIds: [],
			opacity: 1,
			blendMode: "normal",
			transform: createDefaultTransform(),
			filters: strokePath(mixingBrushSettings()).filters,
		};

		expect(resolveMixingStroke(group)).toBeNull();
	});
});

function mixingBrushSettings(overrides: { enabled?: boolean } = {}) {
	return {
		version: 2,
		engine: "dab",
		strokeOpacity: 1,
		paintMode: "buildup",
		properties: { size: { base: 20 }, spacing: { base: 0.2 } },
		tip: { kind: "procedural", hardness: 1, angleMode: "fixed" },
		mixing: {
			enabled: overrides.enabled ?? true,
			mode: "dulling",
			sampleRadius: 1,
			sampleTrail: 1,
			blendStyle: 0,
		},
		randomSeed: 1,
	};
}

function strokePath(brushSettings: unknown): Path {
	return {
		id: "stroke-1",
		type: "path",
		opacity: 1,
		blendMode: "normal",
		transform: createDefaultTransform(),
		segments: [],
		filters: [
			{
				uid: "stroke-appearance",
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
