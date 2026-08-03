import type { ScatterBrushSettings } from "../schema";
import { normalizeBrushSettingsV2 } from "./migrate";
import { toLegacyBrushSettings } from "./toLegacy";

/**
 * The down-converter feeds the legacy render paths (ribbon/geometric/wet)
 * and the flat UI adapter during the v2 transition. For migration-generated
 * settings (2-point linear curves) it must invert normalizeBrushSettingsV2
 * back to semantically equal v1 values.
 */
describe("toLegacyBrushSettings", () => {
	it("should invert a converted v1 scatter back to equivalent v1 fields", () => {
		const v1: Record<string, unknown> = {
			type: "scatter",
			size: 20,
			sizeByPressure: 0.5,
			opacity: 0.8,
			opacityByPressure: 0.3,
			randomSeed: 7,
			source: { kind: "file", fileUid: "tex-1" },
			spacing: 0.12,
			flow: 0.6,
			stampRotation: "random",
			stampAngle: 30,
			rotationByTilt: 0.5,
			aspectRatioByTilt: 0.6,
			sizeBySpeed: 0.4,
			pooling: 0.8,
			poolingSizeRatio: 0.25,
			scatterOffset: 0.3,
			scatterSizeVariation: 0.4,
		};
		const legacy = toLegacyBrushSettings(
			normalizeBrushSettingsV2(v1),
		) as ScatterBrushSettings;

		expect(legacy.type).toBe("scatter");
		expect(legacy.size).toBeCloseTo(20, 10);
		expect(legacy.sizeByPressure).toBeCloseTo(0.5, 10);
		// v2 folds opacity*flow into flow.base; the legacy view exposes it as
		// flow with opacity=1 (same rendered result).
		expect(legacy.opacity * legacy.flow).toBeCloseTo(0.8 * 0.6, 10);
		expect(legacy.opacityByPressure).toBeCloseTo(0.3, 10);
		expect(legacy.spacing).toBeCloseTo(0.12, 10);
		expect(legacy.stampRotation).toBe("random");
		expect(legacy.stampAngle).toBeCloseTo(30, 6);
		expect(legacy.rotationByTilt).toBeCloseTo(0.5, 10);
		expect(legacy.aspectRatioByTilt).toBeCloseTo(0.6, 10);
		expect(legacy.sizeBySpeed).toBeCloseTo(0.4, 10);
		expect(legacy.pooling).toBeCloseTo(0.8, 10);
		expect(legacy.poolingSizeRatio).toBeCloseTo(0.25, 10);
		expect(legacy.scatterOffset).toBeCloseTo(0.3, 10);
		expect(legacy.scatterSizeVariation).toBeCloseTo(0.4, 10);
		expect(legacy.source).toEqual({ kind: "file", fileUid: "tex-1" });
		expect(legacy.randomSeed).toBe(7);
	});

	it("should surface wetV1 as the legacy wetInk verbatim", () => {
		const wetInk = {
			enabled: true,
			bleedWidth: 0.5,
			edgeDarkening: 0.4,
			edgeRoughness: 0.3,
			paperGrain: 0.2,
			paperScale: 1,
			directionality: 0.4,
			speedInfluence: 0.5,
			accelInfluence: 0.3,
			wetness: 0.7,
			pigmentLoad: 0.85,
			absorption: 0.35,
			granulation: 0.25,
			pickupUnderlyingColor: true,
			pickupStrength: 0.35,
		};
		const legacy = toLegacyBrushSettings(
			normalizeBrushSettingsV2({
				type: "scatter",
				size: 10,
				source: { kind: "file", fileUid: "t" },
				spacing: 0.1,
				flow: 1,
				opacity: 1,
				sizeByPressure: 0,
				opacityByPressure: 0,
				randomSeed: 0,
				stampRotation: "none",
				rotationByTilt: 0,
				aspectRatioByTilt: 0,
				sizeBySpeed: 0,
				pooling: 0,
				poolingSizeRatio: 0.5,
				wetInk,
			}),
		) as ScatterBrushSettings;

		expect(legacy.wetInk?.enabled).toBe(true);
		expect(legacy.wetInk?.bleedWidth).toBeCloseTo(0.5, 10);
		expect(legacy.wetInk?.pickupStrength).toBeCloseTo(0.35, 10);
	});

	it("should invert stroke and calligraphy conversions", () => {
		const stroke = toLegacyBrushSettings(
			normalizeBrushSettingsV2({
				type: "stroke",
				size: 12,
				sizeByPressure: 0.4,
				opacity: 0.9,
				opacityByPressure: 0.2,
				randomSeed: 3,
				stroking: { lineCap: "butt", lineJoin: "miter", miterLimit: 2 },
			}),
		);
		expect(stroke.type).toBe("stroke");
		expect(stroke.size).toBeCloseTo(12, 10);
		if (stroke.type !== "stroke") throw new Error("unreachable");
		expect(stroke.stroking?.lineCap).toBe("butt");

		const calligraphy = toLegacyBrushSettings(
			normalizeBrushSettingsV2({
				type: "calligraphy",
				size: 14,
				sizeByPressure: 0,
				opacity: 1,
				opacityByPressure: 0,
				randomSeed: 0,
				nibAngle: 45,
				roundness: 0.25,
				angleMode: "tilt",
				flow: 1,
				sizeBySpeed: 0,
				pooling: 0,
				poolingSizeRatio: 0.5,
			}),
		);
		expect(calligraphy.type).toBe("calligraphy");
		if (calligraphy.type !== "calligraphy") throw new Error("unreachable");
		expect(calligraphy.nibAngle).toBeCloseTo(45, 6);
		expect(calligraphy.roundness).toBeCloseTo(0.25, 10);
		expect(calligraphy.angleMode).toBe("tilt");
	});

	it("should invert art and pattern ribbon conversions", () => {
		const art = toLegacyBrushSettings(
			normalizeBrushSettingsV2({
				type: "art",
				size: 10,
				sizeByPressure: 0,
				opacity: 1,
				opacityByPressure: 0,
				randomSeed: 0,
				source: { kind: "file", fileUid: "art-1" },
				flow: 1,
				flip: true,
				flipAcross: false,
			}),
		);
		expect(art.type).toBe("art");
		if (art.type !== "art") throw new Error("unreachable");
		expect(art.flip).toBe(true);
		expect(art.source).toEqual({ kind: "file", fileUid: "art-1" });

		const pattern = toLegacyBrushSettings(
			normalizeBrushSettingsV2({
				type: "pattern",
				size: 10,
				sizeByPressure: 0,
				opacity: 1,
				opacityByPressure: 0,
				randomSeed: 0,
				source: { kind: "file", fileUid: "pat-1" },
				flow: 1,
				tileScale: 1.5,
				tileSpacing: 0.2,
				uvOffset: 0.1,
			}),
		);
		expect(pattern.type).toBe("pattern");
		if (pattern.type !== "pattern") throw new Error("unreachable");
		expect(pattern.tileScale).toBeCloseTo(1.5, 10);
		expect(pattern.tileSpacing).toBeCloseTo(0.2, 10);
		expect(pattern.uvOffset).toBeCloseTo(0.1, 10);
	});

	it("should round-trip v1 -> v2 -> v1 -> v2 to a fixed point", () => {
		const v1: Record<string, unknown> = {
			type: "scatter",
			size: 20,
			sizeByPressure: 0.5,
			opacity: 0.8,
			opacityByPressure: 0.3,
			randomSeed: 7,
			source: { kind: "file", fileUid: "tex-1" },
			spacing: 0.12,
			flow: 0.6,
			stampRotation: "tangent",
			rotationByTilt: 0.5,
			aspectRatioByTilt: 0.6,
			sizeBySpeed: 0.4,
			pooling: 0.8,
			poolingSizeRatio: 0.25,
		};
		const v2a = normalizeBrushSettingsV2(v1);
		const v2b = normalizeBrushSettingsV2(toLegacyBrushSettings(v2a));
		expect(v2b).toEqual(v2a);
	});
});
