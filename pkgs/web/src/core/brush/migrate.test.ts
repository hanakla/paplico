import {
	BUILTIN_BRUSH_IDS,
	DEFAULT_CALLIGRAPHY_SPACING,
	type WetInkSettings,
} from "../schema";
import { evaluateBrushProperty } from "./curves";
import {
	mergeBrushSettingsV2PreservingCurves,
	normalizeBrushSettingsV2,
} from "./migrate";
import { toLegacyBrushSettings } from "./toLegacy";

describe("normalizeBrushSettingsV2", () => {
	describe("v1 stroke conversion", () => {
		const v1 = {
			type: "stroke",
			size: 12,
			sizeByPressure: 0.4,
			opacity: 0.9,
			opacityByPressure: 0.2,
			randomSeed: 3,
			stroking: { lineCap: "butt", lineJoin: "miter", miterLimit: 2 },
		};

		it("should map to the geometric engine and keep stroking", () => {
			const v2 = normalizeBrushSettingsV2(v1);
			expect(v2.version).toBe(2);
			expect(v2.engine).toBe("geometric");
			expect(v2.stroking?.lineCap).toBe("butt");
			expect(v2.stroking?.lineJoin).toBe("miter");
			expect(v2.stroking?.miterLimit).toBe(2);
			expect(v2.paintMode).toBe("buildup");
			expect(v2.strokeOpacity).toBe(1);
			expect(v2.randomSeed).toBe(3);
		});

		it("should reproduce the v1 pressure-size response exactly", () => {
			const v2 = normalizeBrushSettingsV2(v1);
			for (const p of [0, 0.3, 0.7, 1]) {
				expect(
					evaluateBrushProperty("size", v2.properties.size, { pressure: p }),
				).toBeCloseTo(12 * (1 - 0.4 + 0.4 * p), 10);
			}
		});

		it("should fold opacity into flow and reproduce the pressure-opacity response", () => {
			const v2 = normalizeBrushSettingsV2(v1);
			for (const p of [0, 0.5, 1]) {
				expect(
					evaluateBrushProperty("flow", v2.properties.flow, { pressure: p }),
				).toBeCloseTo(0.9 * (1 - 0.2 + 0.2 * p), 10);
			}
		});
	});

	describe("v1 scatter conversion", () => {
		const source = { kind: "file", fileUid: "tex-1" };
		const baseScatter = {
			type: "scatter",
			size: 20,
			sizeByPressure: 0.5,
			opacity: 0.8,
			opacityByPressure: 0.3,
			randomSeed: 7,
			source,
			spacing: 0.12,
			flow: 0.6,
			stampRotation: "none",
			rotationByTilt: 0,
			aspectRatioByTilt: 0,
			sizeBySpeed: 0,
			pooling: 0,
			poolingSizeRatio: 0.5,
		};

		it("should map to the dab engine with an image tip", () => {
			const v2 = normalizeBrushSettingsV2(baseScatter);
			expect(v2.engine).toBe("dab");
			expect(v2.tip?.kind).toBe("image");
			if (v2.tip?.kind !== "image") throw new Error("unreachable");
			expect(v2.tip.sources[0]).toEqual(source);
		});

		it("should fold opacity x flow into flow.base and keep strokeOpacity at 1", () => {
			const v2 = normalizeBrushSettingsV2(baseScatter);
			expect(v2.properties.flow?.base).toBeCloseTo(0.8 * 0.6, 10);
			expect(v2.strokeOpacity).toBe(1);
			expect(v2.paintMode).toBe("buildup");
		});

		it("should keep spacing as the spacing base", () => {
			const v2 = normalizeBrushSettingsV2(baseScatter);
			expect(v2.properties.spacing?.base).toBeCloseTo(0.12, 10);
		});

		it("should map tangent stamp rotation to the tip angle mode", () => {
			const v2 = normalizeBrushSettingsV2({
				...baseScatter,
				stampRotation: "tangent",
			});
			expect(v2.tip?.angleMode).toBe("tangent");
		});

		it("should map random stamp rotation to a full-turn randomPerDab angle curve", () => {
			const v2 = normalizeBrushSettingsV2({
				...baseScatter,
				stampRotation: "random",
			});
			expect(
				evaluateBrushProperty("angle", v2.properties.angle, {
					randomPerDab: 0,
				}),
			).toBeCloseTo(-Math.PI, 10);
			expect(
				evaluateBrushProperty("angle", v2.properties.angle, {
					randomPerDab: 1,
				}),
			).toBeCloseTo(Math.PI, 10);
		});

		it("should convert stampAngle degrees to the angle base in radians", () => {
			const v2 = normalizeBrushSettingsV2({ ...baseScatter, stampAngle: 30 });
			expect(v2.properties.angle?.base).toBeCloseTo(Math.PI / 6, 10);
		});

		it("should reproduce aspectRatioByTilt exactly via a tiltMagnitude curve", () => {
			const k = 0.6;
			const v2 = normalizeBrushSettingsV2({
				...baseScatter,
				aspectRatioByTilt: k,
			});
			for (const m of [0, 0.5, 1]) {
				expect(
					evaluateBrushProperty("ratio", v2.properties.ratio, {
						tiltMagnitude: m,
					}),
				).toBeCloseTo(1 - 0.7 * k * m, 10);
			}
		});

		it("should map rotationByTilt to a tiltAzimuth angle curve", () => {
			const k = 0.5;
			const v2 = normalizeBrushSettingsV2({
				...baseScatter,
				rotationByTilt: k,
			});
			expect(
				evaluateBrushProperty("angle", v2.properties.angle, {
					tiltAzimuth: 0,
				}),
			).toBeCloseTo(-Math.PI * k, 10);
			expect(
				evaluateBrushProperty("angle", v2.properties.angle, {
					tiltAzimuth: 1,
				}),
			).toBeCloseTo(Math.PI * k, 10);
		});

		it("should translate the pooling formulas into speedFine curves", () => {
			const p = 0.8;
			const r = 0.25;
			const v2 = normalizeBrushSettingsV2({
				...baseScatter,
				pooling: p,
				poolingSizeRatio: r,
			});
			expect(
				evaluateBrushProperty("spacing", v2.properties.spacing, {
					speedFine: 0,
				}),
			).toBeCloseTo(0.12 * (1 - 0.6 * p), 10);
			expect(
				evaluateBrushProperty("spacing", v2.properties.spacing, {
					speedFine: 1,
				}),
			).toBeCloseTo(0.12, 10);
			expect(
				evaluateBrushProperty("size", v2.properties.size, {
					speedFine: 0,
					pressure: 1,
				}),
			).toBeCloseTo(20 * (1 + 0.3 * p * r), 10);
			expect(
				evaluateBrushProperty("flow", v2.properties.flow, {
					speedFine: 0,
					pressure: 1,
				}),
			).toBeCloseTo(0.8 * 0.6 * (1 + 0.5 * p * (1 - r)), 10);
		});

		it("should map scatter offset and size variation", () => {
			const v = 0.4;
			const v2 = normalizeBrushSettingsV2({
				...baseScatter,
				scatterOffset: 0.3,
				scatterSizeVariation: v,
			});
			expect(v2.properties.scatterOffset?.base).toBeCloseTo(0.3, 10);
			expect(
				evaluateBrushProperty("size", v2.properties.size, {
					randomPerDab: 0,
					pressure: 1,
				}),
			).toBeCloseTo(20 * (1 - v), 10);
			expect(
				evaluateBrushProperty("size", v2.properties.size, {
					randomPerDab: 1,
					pressure: 1,
				}),
			).toBeCloseTo(20 * (1 + v), 10);
		});

		it("should carry scatter variants and start/end sources into the tip", () => {
			const v2 = normalizeBrushSettingsV2({
				...baseScatter,
				scatterSources: [{ kind: "file", fileUid: "tex-2" }],
				startSource: { kind: "file", fileUid: "tex-s" },
				endSource: { kind: "file", fileUid: "tex-e" },
			});
			if (v2.tip?.kind !== "image") throw new Error("unreachable");
			expect(v2.tip.sources).toEqual([
				{ kind: "file", fileUid: "tex-1" },
				{ kind: "file", fileUid: "tex-2" },
			]);
			expect(v2.tip.startSource).toEqual({ kind: "file", fileUid: "tex-s" });
			expect(v2.tip.endSource).toEqual({ kind: "file", fileUid: "tex-e" });
		});

		it("should preserve wetInk verbatim as wetV1 and not synthesize v2 wet/mixing", () => {
			const wetInk: WetInkSettings = {
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
			const v2 = normalizeBrushSettingsV2({ ...baseScatter, wetInk });
			// wetV1 is the v1-normalized value: v1's own asWetInk() fills its
			// optional defaults (diffusion/pickupDecay/pickupBlendMode) on read.
			expect(v2.wetV1).toEqual({
				...wetInk,
				diffusion: 0.35,
				pickupDecay: 1,
				pickupBlendMode: 0,
			});
			expect(v2.wet).toBeUndefined();
			expect(v2.mixing).toBeUndefined();
		});
	});

	describe("v1 calligraphy conversion", () => {
		const calligraphy = {
			type: "calligraphy",
			size: 14,
			sizeByPressure: 0,
			opacity: 1,
			opacityByPressure: 0,
			randomSeed: 0,
			nibAngle: 45,
			roundness: 0.25,
			angleMode: "fixed",
			flow: 1,
			sizeBySpeed: 0,
			pooling: 0,
			poolingSizeRatio: 0.5,
		};

		it("should map to a procedural hard tip", () => {
			const v2 = normalizeBrushSettingsV2(calligraphy);
			expect(v2.engine).toBe("dab");
			expect(v2.tip?.kind).toBe("procedural");
			if (v2.tip?.kind !== "procedural") throw new Error("unreachable");
			expect(v2.tip.hardness).toBe(1);
			expect(v2.tip.angleMode).toBe("fixed");
		});

		it("should map roundness and nibAngle to ratio and angle bases", () => {
			const v2 = normalizeBrushSettingsV2(calligraphy);
			expect(v2.properties.ratio?.base).toBeCloseTo(0.25, 10);
			expect(v2.properties.angle?.base).toBeCloseTo(Math.PI / 4, 10);
		});

		it("should map the tilt angle mode to a fixed mode with a tiltAzimuth curve", () => {
			const v2 = normalizeBrushSettingsV2({
				...calligraphy,
				angleMode: "tilt",
			});
			if (v2.tip?.kind !== "procedural") throw new Error("unreachable");
			expect(v2.tip.angleMode).toBe("fixed");
			expect(
				evaluateBrushProperty("angle", v2.properties.angle, { tiltAzimuth: 1 }),
			).toBeCloseTo(Math.PI / 4 + Math.PI, 10);
		});

		it("should fill the default calligraphy spacing", () => {
			const v2 = normalizeBrushSettingsV2(calligraphy);
			expect(v2.properties.spacing?.base).toBeCloseTo(
				DEFAULT_CALLIGRAPHY_SPACING,
				10,
			);
		});
	});

	describe("v1 ribbon conversions", () => {
		it("should map art brushes to a stretch ribbon", () => {
			const v2 = normalizeBrushSettingsV2({
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
			});
			expect(v2.engine).toBe("ribbon");
			expect(v2.ribbon?.uvMode).toBe("stretch");
			expect(v2.ribbon?.flipU).toBe(true);
			expect(v2.ribbon?.flipV).toBe(false);
		});

		it("should map pattern brushes to a repeat ribbon with tiling", () => {
			const v2 = normalizeBrushSettingsV2({
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
			});
			expect(v2.engine).toBe("ribbon");
			expect(v2.ribbon?.uvMode).toBe("repeat");
			expect(v2.ribbon?.tileScale).toBeCloseTo(1.5, 10);
			expect(v2.ribbon?.tileSpacing).toBeCloseTo(0.2, 10);
			expect(v2.ribbon?.uvOffset).toBeCloseTo(0.1, 10);
		});
	});

	describe("legacy flat conversion", () => {
		it("should convert the legacy flat shape through the v1 pipeline", () => {
			const v2 = normalizeBrushSettingsV2({
				size: 8,
				textureFileUid: BUILTIN_BRUSH_IDS.softCircle,
			});
			expect(v2.version).toBe(2);
			expect(v2.engine).toBe("dab");
			expect(v2.properties.size?.base).toBe(8);
		});
	});

	describe("idempotency", () => {
		const samples: unknown[] = [
			{
				type: "stroke",
				size: 12,
				sizeByPressure: 0.4,
				opacity: 0.9,
				opacityByPressure: 0.2,
				randomSeed: 3,
			},
			{
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
				stampAngle: 15,
				rotationByTilt: 0.5,
				aspectRatioByTilt: 0.6,
				sizeBySpeed: 0.4,
				pooling: 0.8,
				poolingSizeRatio: 0.25,
				scatterOffset: 0.3,
				scatterSizeVariation: 0.4,
				wetInk: {
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
				},
			},
			{
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
			},
			{ size: 8, textureFileUid: BUILTIN_BRUSH_IDS.softCircle },
		];

		it("should be idempotent for every conversion sample", () => {
			for (const raw of samples) {
				const once = normalizeBrushSettingsV2(raw);
				const twice = normalizeBrushSettingsV2(once);
				expect(twice).toEqual(once);
			}
		});
	});

	describe("malformed input tolerance", () => {
		it("should clamp out-of-range values and fill defaults", () => {
			const v2 = normalizeBrushSettingsV2({
				type: "scatter",
				size: 20,
				opacity: 99,
				spacing: "abc",
				source: { kind: "file", fileUid: "tex-1" },
				flow: -5,
			});
			expect(v2.properties.flow?.base).toBeGreaterThanOrEqual(0);
			expect(v2.properties.flow?.base).toBeLessThanOrEqual(1);
			expect(Number.isFinite(v2.properties.spacing?.base ?? NaN)).toBe(true);
		});

		it("should sanitize a v2 value with broken numbers", () => {
			const v2 = normalizeBrushSettingsV2({
				version: 2,
				engine: "dab",
				strokeOpacity: 42,
				paintMode: "buildup",
				properties: {
					size: { base: Number.NaN },
					wetness: { base: 99 },
				},
				tip: { kind: "procedural", hardness: 1, angleMode: "fixed" },
				mixing: {
					enabled: true,
					mode: "dulling",
					sampleRadius: 1,
					sampleTrail: 99,
					blendStyle: 0,
				},
				randomSeed: 0,
			});
			expect(v2.strokeOpacity).toBeLessThanOrEqual(1);
			expect(Number.isFinite(v2.properties.size?.base ?? NaN)).toBe(true);
			expect(v2.properties.wetness?.base).toBeLessThanOrEqual(1.5);
			expect(v2.mixing?.sampleTrail).toBeLessThanOrEqual(2);
		});
	});

	describe("v2 invariants", () => {
		it("should force wash paint mode when wet is enabled", () => {
			const v2 = normalizeBrushSettingsV2({
				version: 2,
				engine: "dab",
				strokeOpacity: 1,
				paintMode: "buildup",
				properties: {},
				tip: { kind: "procedural", hardness: 1, angleMode: "fixed" },
				wet: {
					enabled: true,
					bleedRadius: 0.5,
					pigmentLoad: 0.85,
					grainScale: 1,
				},
				randomSeed: 0,
			});
			expect(v2.paintMode).toBe("wash");
		});

		it("should fill wet config defaults", () => {
			const v2 = normalizeBrushSettingsV2({
				version: 2,
				engine: "dab",
				strokeOpacity: 1,
				paintMode: "wash",
				properties: {},
				tip: { kind: "procedural", hardness: 1, angleMode: "fixed" },
				wet: { enabled: true },
				randomSeed: 0,
			});
			expect(v2.wet?.bleedRadius).toBeCloseTo(0.5, 10);
			expect(v2.wet?.pigmentLoad).toBeCloseTo(0.85, 10);
			expect(v2.wet?.grainScale).toBeCloseTo(1, 10);
		});

		it("should default mixing.enabled to false instead of inferring from presence", () => {
			const v2 = normalizeBrushSettingsV2({
				version: 2,
				engine: "dab",
				strokeOpacity: 1,
				paintMode: "buildup",
				properties: {},
				tip: { kind: "procedural", hardness: 1, angleMode: "fixed" },
				mixing: {
					mode: "dulling",
					sampleRadius: 1,
					sampleTrail: 1,
					blendStyle: 0,
				},
				randomSeed: 0,
			});
			expect(v2.mixing?.enabled).toBe(false);
		});
	});
});

describe("mergeBrushSettingsV2PreservingCurves", () => {
	function v2WithCustomState(): ReturnType<typeof normalizeBrushSettingsV2> {
		return normalizeBrushSettingsV2({
			version: 2,
			engine: "dab",
			strokeOpacity: 1,
			paintMode: "buildup",
			properties: {
				size: { base: 20 },
				flow: {
					base: 0.5,
					// A curve-editor curve the flat slider layer cannot express.
					curves: [
						{
							input: "strokeT",
							points: [
								[0, 0.4],
								[0.5, -0.2],
								[1, 0.4],
							],
						},
					],
				},
			},
			tip: { kind: "procedural", hardness: 1, angleMode: "fixed" },
			grain: {
				source: { kind: "file", fileUid: "paper-1" },
				scale: 2,
				mode: "multiply",
				randomOffsetPerStroke: true,
			},
			inputDynamics: { speedRef: 1.5 },
			randomSeed: 3,
		});
	}

	it("should keep unmanaged curves and configs across an unrelated flat patch", () => {
		const previous = v2WithCustomState();
		// The flat layer rebuilds from the legacy view + patch: size changed.
		const rebuilt = normalizeBrushSettingsV2({
			...toLegacyBrushSettings(previous),
			size: 42,
		});

		const merged = mergeBrushSettingsV2PreservingCurves(previous, rebuilt);

		expect(merged.properties.size?.base).toBe(42);
		const strokeTCurve = merged.properties.flow?.curves?.find(
			(c) => c.input === "strokeT",
		);
		expect(strokeTCurve).toBeDefined();
		expect(strokeTCurve?.points.length).toBe(3);
		expect(merged.grain?.source).toEqual({ kind: "file", fileUid: "paper-1" });
		expect(merged.inputDynamics?.speedRef).toBe(1.5);
	});

	it("should let flat-managed curves be replaced by the patch", () => {
		const previous = normalizeBrushSettingsV2({
			version: 2,
			engine: "dab",
			strokeOpacity: 1,
			paintMode: "buildup",
			properties: {
				size: {
					base: 20,
					curves: [
						{
							input: "pressure",
							points: [
								[0, -0.5],
								[1, 0],
							],
						},
					],
				},
			},
			tip: { kind: "procedural", hardness: 1, angleMode: "fixed" },
			randomSeed: 0,
		});
		const rebuilt = normalizeBrushSettingsV2({
			...toLegacyBrushSettings(previous),
			sizeByPressure: 0.9,
		});

		const merged = mergeBrushSettingsV2PreservingCurves(previous, rebuilt);
		const pressureCurves = merged.properties.size?.curves?.filter(
			(c) => c.input === "pressure",
		);
		expect(pressureCurves?.length).toBe(1);
		expect(pressureCurves?.[0].points[0][1]).toBeCloseTo(-0.9, 10);
	});
});
