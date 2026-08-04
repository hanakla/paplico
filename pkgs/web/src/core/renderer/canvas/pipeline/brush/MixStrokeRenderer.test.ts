import { describe, expect, it } from "vitest";
import { normalizeBrushSettingsV2 } from "../../../../brush/migrate";
import { createDefaultTransform } from "../../../../document/factory";
import type { Filter, Group, Path } from "../../../../schema";
import { resolveMixingStroke } from "./MixStrokeRenderer";

/**
 * Which strokes the mix pass owns (design §10, §13-7). Everything else must
 * stay on its existing route. Picking up the layer below belongs to the mix
 * pass alone now, which is why a converted v1 wet brush lands here.
 */
describe("resolveMixingStroke", () => {
	it("should claim a dab-v2 stroke with mixing enabled", () => {
		const element = strokePath(mixingBrushSettings());

		expect(resolveMixingStroke(element)?.settings.mixing?.enabled).toBe(true);
	});

	it("should claim a converted v1 wet stroke that picked up colour", () => {
		// v1's pickup migrates into mixing, so a wet brush that picked up the
		// layer below now mixes — the wet layer no longer touches colour.
		const element = strokePath(
			normalizeBrushSettingsV2({
				type: "scatter",
				size: 20,
				opacity: 1,
				wetInk: { enabled: true, wetness: 0.7, pickupUnderlyingColor: true },
			}),
		);

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
	return normalizeBrushSettingsV2({
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
	});
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
