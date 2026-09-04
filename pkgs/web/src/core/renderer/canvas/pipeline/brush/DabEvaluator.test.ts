import type { BrushSettings, CubicBezierSegment } from "../../../../schema";
import { evaluateDabs } from "./DabEvaluator";
import { DAB_INSTANCE_FLOATS, readDabField } from "./DabInstanceLayout";

/** Straight line from (0,0) to (100,0): collinear controls, arc length 100. */
function lineSegment(
	overrides: Partial<CubicBezierSegment> = {},
): CubicBezierSegment {
	return {
		start: { x: 0, y: 0 },
		cp1: { x: 33, y: 0 },
		cp2: { x: -33, y: 0 },
		end: { x: 100, y: 0 },
		startPressure: 0.5,
		endPressure: 0.5,
		startTiltX: 0,
		startTiltY: 0,
		endTiltX: 0,
		endTiltY: 0,
		startDeltaTime: 0,
		endDeltaTime: 100,
		isMoved: true,
		...overrides,
	};
}

function dabSettings(overrides: Record<string, unknown> = {}): BrushSettings {
	return {
		version: 2,
		engine: "dab",
		strokeOpacity: 1,
		paintMode: "buildup",
		properties: {
			size: { base: 10 },
			spacing: { base: 0.2 },
			flow: { base: 1 },
		},
		tip: { kind: "procedural", hardness: 1, angleMode: "fixed" },
		randomSeed: 1,
		...overrides,
	};
}

describe("evaluateDabs", () => {
	describe("spacing integration (Krita min-of-distance-and-time)", () => {
		it("should place dabs at fixed distance intervals when time dabs are off", () => {
			const result = evaluateDabs([lineSegment()], dabSettings());
			// size 10 * spacing 0.2 = one dab every 2 world units over 100 units.
			expect(result.count).toBe(51);
			expect(readDabField(result.data, 0, "positionX")).toBeCloseTo(0, 5);
			expect(readDabField(result.data, 1, "positionX")).toBeCloseTo(2, 1);
			expect(
				readDabField(result.data, result.count - 1, "positionX"),
			).toBeCloseTo(100, 1);
		});

		it("should emit time-based dabs when the timed interval fires first", () => {
			// 10_000 ms over 100 units: distance threshold (2 units = 200 ms)
			// loses against the 10 ms timed interval (dabsPerSecond 100).
			const settings = dabSettings({
				properties: {
					size: { base: 10 },
					spacing: { base: 0.2 },
					flow: { base: 1 },
					dabsPerSecond: { base: 100 },
				},
			});
			const result = evaluateDabs(
				[lineSegment({ endDeltaTime: 10_000 })],
				settings,
			);
			expect(result.count).toBeGreaterThanOrEqual(999);
			expect(result.count).toBeLessThanOrEqual(1003);
		});

		it("should keep distance dabs when they fire faster than the timed interval", () => {
			// 100 ms over 100 units: distance threshold (2 units = 2 ms) wins
			// against the 10 ms interval, so the count matches distance-only.
			const settings = dabSettings({
				properties: {
					size: { base: 10 },
					spacing: { base: 0.2 },
					flow: { base: 1 },
					dabsPerSecond: { base: 100 },
				},
			});
			const result = evaluateDabs([lineSegment()], settings);
			expect(result.count).toBe(51);
		});
	});

	describe("airbrush hold", () => {
		it("should keep spraying dabs while the pointer stays still", () => {
			// An airbrush held in place still lays down paint: the timed
			// interval has to fire even though no distance accumulates.
			const settings = dabSettings({
				properties: {
					size: { base: 10 },
					spacing: { base: 0.2 },
					flow: { base: 1 },
					dabsPerSecond: { base: 50 },
				},
			});
			const held = lineSegment({
				cp1: { x: 0, y: 0 },
				cp2: { x: 0, y: 0 },
				end: { x: 0, y: 0 },
				startDeltaTime: 0,
				endDeltaTime: 200,
			});

			const result = evaluateDabs([held], settings);

			// 200 ms at 50 dabs/s: about ten, all on the same spot.
			expect(result.count).toBeGreaterThanOrEqual(8);
			for (let i = 0; i < result.count; i++) {
				expect(readDabField(result.data, i, "positionX")).toBeCloseTo(0, 4);
			}
		});
	});

	describe("curve matrix evaluation", () => {
		it("should apply the two-point pressure-size curve to emitted dabs", () => {
			const k = 0.5;
			const settings = dabSettings({
				properties: {
					size: {
						base: 10,
						curves: [
							{
								input: "pressure",
								points: [
									[0, -k],
									[1, 0],
								],
							},
						],
					},
					spacing: { base: 0.2 },
					flow: { base: 1 },
				},
			});
			const result = evaluateDabs(
				[lineSegment({ startPressure: 0, endPressure: 1 })],
				settings,
			);
			// First dab at pressure 0 -> size 5; last dab at pressure 1 -> size 10.
			expect(readDabField(result.data, 0, "sizeX")).toBeCloseTo(
				10 * (1 - k),
				4,
			);
			expect(readDabField(result.data, result.count - 1, "sizeX")).toBeCloseTo(
				10,
				4,
			);
		});
	});

	describe("mixing per-dab params", () => {
		it("should evaluate mixing rates per dab when mixing is enabled", () => {
			const settings = dabSettings({
				mixing: {
					enabled: true,
					mode: "dulling",
					sampleRadius: 1,
					sampleTrail: 1,
					blendStyle: 0,
				},
				properties: {
					size: { base: 10 },
					spacing: { base: 0.2 },
					flow: { base: 1 },
					colorRate: {
						base: 0.5,
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
					alphaRate: { base: 0.7 },
					smudgeLength: { base: 0.3 },
				},
			});
			const result = evaluateDabs(
				[lineSegment({ startPressure: 0, endPressure: 1 })],
				settings,
			);
			expect(result.count).toBeGreaterThan(1);
			expect(result.mixParams.length).toBeGreaterThanOrEqual(result.count * 4);
			// colorRate is scale-domain: pressure 0 halves the base, pressure 1
			// leaves it unchanged.
			expect(result.mixParams[0]).toBeCloseTo(0.25, 4);
			expect(result.mixParams[(result.count - 1) * 4]).toBeCloseTo(0.5, 4);
			expect(result.mixParams[1]).toBeCloseTo(0.7, 4);
			expect(result.mixParams[2]).toBeCloseTo(0.3, 4);
		});

		it("should not allocate mix params when mixing is disabled", () => {
			const result = evaluateDabs([lineSegment()], dabSettings());
			expect(result.mixParams.length).toBe(0);
		});
	});

	describe("color dynamics", () => {
		it("should pack per-dab hue/saturation/value shifts", () => {
			const settings = dabSettings({
				properties: {
					size: { base: 10 },
					spacing: { base: 0.2 },
					flow: { base: 1 },
					hueShift: {
						base: 0,
						curves: [
							{
								input: "pressure",
								points: [
									[0, 0],
									[1, 0.25],
								],
							},
						],
					},
					satShift: { base: -0.5 },
					valShift: { base: 0.5 },
				},
			});
			const result = evaluateDabs(
				[lineSegment({ startPressure: 0, endPressure: 1 })],
				settings,
			);

			// 16-bit signed quantization: within one step of the exact value.
			const eps = 2 / 32767;
			const first = readDabColorShift(result.data, 0);
			const last = readDabColorShift(result.data, result.count - 1);
			expect(first.hue).toBeCloseTo(0, 3);
			expect(last.hue).toBeCloseTo(0.25, 3);
			for (const shift of [first, last]) {
				expect(Math.abs(shift.saturation - -0.5)).toBeLessThan(eps);
				expect(Math.abs(shift.value - 0.5)).toBeLessThan(eps);
			}
		});

		it("should pack zero shifts when no color properties are set", () => {
			const result = evaluateDabs([lineSegment()], dabSettings());
			const shift = readDabColorShift(result.data, 0);

			expect(shift.hue).toBe(0);
			expect(shift.saturation).toBe(0);
			expect(shift.value).toBe(0);
		});
	});

	describe("wet field coefficients", () => {
		it("should pack the five field coefficients when wet is enabled", () => {
			const settings = dabSettings({
				wet: {
					enabled: true,
					bleedRadius: 0.5,
					pigmentLoad: 0.85,
					grainScale: 1,
				},
				properties: {
					size: { base: 10 },
					spacing: { base: 0.2 },
					flow: { base: 1 },
					absorption: { base: 0.5 },
					granulation: { base: 0.25 },
					bleedSoftness: { base: 1 },
					edgeDarkening: { base: 0 },
					edgeRoughness: { base: 0.75 },
				},
			});
			const coefficients = readWetCoefficients(
				evaluateDabs([lineSegment()], settings).data,
				0,
			);

			// 6-bit quantization: one step is 1/63.
			const eps = 1 / 63;
			expect(Math.abs(coefficients[0] - 0.5)).toBeLessThanOrEqual(eps);
			expect(Math.abs(coefficients[1] - 0.25)).toBeLessThanOrEqual(eps);
			expect(coefficients[2]).toBe(1);
			expect(coefficients[3]).toBe(0);
			expect(Math.abs(coefficients[4] - 0.75)).toBeLessThanOrEqual(eps);
		});

		it("should pack nothing when wet is disabled", () => {
			const result = evaluateDabs([lineSegment()], dabSettings());

			expect(readDabField(result.data, 0, "packedWetCoefficients")).toBe(0);
		});
	});

	describe("determinism", () => {
		it("should produce byte-identical buffers for identical inputs", () => {
			const settings = dabSettings({
				properties: {
					size: { base: 10 },
					spacing: { base: 0.2 },
					flow: { base: 1 },
					angle: {
						base: 0,
						curves: [
							{
								input: "randomPerDab",
								points: [
									[0, -Math.PI],
									[1, Math.PI],
								],
							},
						],
					},
				},
			});
			const a = evaluateDabs([lineSegment()], settings);
			const b = evaluateDabs([lineSegment()], settings);
			expect(a.count).toBe(b.count);
			expect(
				Buffer.from(a.data.buffer, 0, a.count * 4).equals(
					Buffer.from(b.data.buffer, 0, b.count * 4),
				),
			).toBe(true);
		});
	});

	describe("opaque_linearize", () => {
		it("should compensate buildup dab alpha for the expected overlap", () => {
			const settings = dabSettings({
				properties: {
					size: { base: 10 },
					spacing: { base: 0.2 },
					flow: { base: 0.5 },
				},
			});
			const result = evaluateDabs([lineSegment()], settings);
			const dabsPerPixel = 1 + 0.9 * (1 / 0.2 - 1);
			const expected = 1 - (1 - 0.5) ** (1 / dabsPerPixel);
			expect(readDabField(result.data, 0, "alpha")).toBeCloseTo(expected, 5);
		});

		it("should write plain flow as alpha in wash mode", () => {
			const settings = dabSettings({
				paintMode: "wash",
				properties: {
					size: { base: 10 },
					spacing: { base: 0.2 },
					flow: { base: 0.5 },
				},
			});
			const result = evaluateDabs([lineSegment()], settings);
			expect(readDabField(result.data, 0, "alpha")).toBeCloseTo(0.5, 5);
		});
	});

	describe("collaboration fragments", () => {
		it("should suppress the ramp-in for mid-stroke fragments", () => {
			const settings = dabSettings({
				properties: {
					size: {
						base: 10,
						curves: [
							{
								input: "pressure",
								points: [
									[0, -1],
									[1, 0],
								],
							},
						],
					},
					spacing: { base: 0.2 },
					flow: { base: 1 },
				},
			});
			const segment = lineSegment({ startPressure: 0.2, endPressure: 0.9 });

			const head = evaluateDabs([segment], settings, {
				pathStart: 0,
				pathEnd: 1,
			});
			const midFragment = evaluateDabs([segment], settings, {
				pathStart: 0.5,
				pathEnd: 1,
			});

			// Fresh stroke starts at startPressure (0.2 -> size 2); a mid-stroke
			// fragment seeds from endPressure (0.9 -> size 9).
			expect(readDabField(head.data, 0, "sizeX")).toBeCloseTo(2, 4);
			expect(readDabField(midFragment.data, 0, "sizeX")).toBeCloseTo(9, 4);
		});
	});

	describe("wet gate", () => {
		it("should write wet seed fields only while wet is enabled", () => {
			const wetOn = dabSettings({
				paintMode: "wash",
				wet: {
					enabled: true,
					bleedRadius: 0.5,
					pigmentLoad: 0.85,
					grainScale: 1,
				},
				properties: {
					size: { base: 10 },
					spacing: { base: 0.2 },
					flow: { base: 1 },
					wetness: { base: 0.7 },
					directionality: { base: 0.4 },
					grainAmount: { base: 0.2 },
				},
			});
			const wetOff = dabSettings({
				properties: {
					size: { base: 10 },
					spacing: { base: 0.2 },
					flow: { base: 1 },
					wetness: { base: 0.7 },
					directionality: { base: 0.4 },
					grainAmount: { base: 0.2 },
				},
			});

			const on = evaluateDabs([lineSegment()], wetOn);
			const off = evaluateDabs([lineSegment()], wetOff);

			expect(readDabField(on.data, 0, "wetness")).toBeCloseTo(0.7, 5);
			expect(readDabField(on.data, 0, "directionality")).toBeCloseTo(0.4, 5);
			expect(readDabField(on.data, 0, "grainAmount")).toBeCloseTo(0.2, 5);
			expect(readDabField(off.data, 0, "wetness")).toBe(0);
			expect(readDabField(off.data, 0, "directionality")).toBe(0);
			expect(readDabField(off.data, 0, "grainAmount")).toBe(0);
		});
	});
});

describe("evaluateDabs — incremental resume", () => {
	/** Curved, pressure/timing-varying 3-segment stroke. */
	function chunkSegments(): CubicBezierSegment[] {
		return [
			{
				start: { x: 0, y: 0 },
				cp1: { x: 20, y: 15 },
				cp2: { x: -20, y: 10 },
				end: { x: 80, y: 30 },
				startPressure: 0.3,
				endPressure: 0.6,
				startTiltX: 10,
				startTiltY: 0,
				endTiltX: 20,
				endTiltY: 5,
				startDeltaTime: 0,
				endDeltaTime: 90,
				isMoved: true,
			},
			{
				cp1: { x: 25, y: -5 },
				cp2: { x: -15, y: 20 },
				end: { x: 150, y: -10 },
				startPressure: 0.6,
				endPressure: 0.9,
				startTiltX: 20,
				startTiltY: 5,
				endTiltX: 5,
				endTiltY: 15,
				startDeltaTime: 90,
				endDeltaTime: 210,
				isMoved: false,
			},
			{
				cp1: { x: 10, y: 25 },
				cp2: { x: -30, y: 0 },
				end: { x: 220, y: 60 },
				startPressure: 0.9,
				endPressure: 0.4,
				startTiltX: 5,
				startTiltY: 15,
				endTiltX: 0,
				endTiltY: 0,
				startDeltaTime: 210,
				endDeltaTime: 380,
				isMoved: false,
			},
		] as CubicBezierSegment[];
	}

	function dynamicSettings(): BrushSettings {
		return {
			version: 2,
			engine: "dab",
			strokeOpacity: 1,
			paintMode: "buildup",
			properties: {
				size: {
					base: 10,
					curves: [
						{
							input: "pressure",
							points: [
								[0, -0.5],
								[1, 0],
							],
						},
						{
							input: "speedFine",
							points: [
								[0, 0],
								[1, -0.4],
							],
						},
					],
				},
				spacing: { base: 0.2 },
				flow: {
					base: 0.8,
					curves: [
						{
							input: "strokeT",
							points: [
								[0, 0.2],
								[1, -0.3],
							],
						},
					],
				},
				scatterOffset: { base: 0.3 },
				angle: {
					base: 0,
					curves: [
						{
							input: "randomPerDab",
							points: [
								[0, -3],
								[1, 3],
							],
						},
					],
				},
			},
			tip: { kind: "procedural", hardness: 0.8, angleMode: "fixed" },
			randomSeed: 7,
		};
	}

	function assertChunkedMatchesFull(
		settings: BrushSettings,
		options: { variantCount?: number } = {},
	): void {
		const segments = chunkSegments();
		const full = evaluateDabs(segments, settings, options);
		expect(full.count).toBeGreaterThan(10);

		const chunk1 = evaluateDabs([segments[0]], settings, {
			...options,
			totalLength: full.totalLength,
		});
		const chunk2 = evaluateDabs([segments[1], segments[2]], settings, {
			...options,
			totalLength: full.totalLength,
			resume: chunk1.state,
		});

		expect(chunk1.count + chunk2.count).toBe(full.count);
		const merged = new Float32Array(full.count * DAB_INSTANCE_FLOATS);
		merged.set(chunk1.data.subarray(0, chunk1.count * DAB_INSTANCE_FLOATS), 0);
		merged.set(
			chunk2.data.subarray(0, chunk2.count * DAB_INSTANCE_FLOATS),
			chunk1.count * DAB_INSTANCE_FLOATS,
		);
		expect(Array.from(merged)).toEqual(
			Array.from(full.data.subarray(0, full.count * DAB_INSTANCE_FLOATS)),
		);
	}

	it("should produce bit-identical dabs when evaluated in two chunks", () => {
		assertChunkedMatchesFull(dynamicSettings());
	});

	it("should keep random tip selection and jitter deterministic across the boundary", () => {
		assertChunkedMatchesFull(dynamicSettings(), { variantCount: 3 });
	});

	it("should keep timed dabs deterministic across the boundary", () => {
		const settings = {
			...dynamicSettings(),
			properties: {
				...dynamicSettings().properties,
				dabsPerSecond: { base: 120 },
			},
		};
		assertChunkedMatchesFull(settings);
	});

	it("should report the full arc length on the returned buffer", () => {
		const full = evaluateDabs(chunkSegments(), dynamicSettings());
		expect(full.totalLength).toBeGreaterThan(200);
	});
});

/** Unpack the per-dab color shift written by the evaluator. */
function readDabColorShift(
	data: Float32Array,
	dabIndex: number,
): { hue: number; saturation: number; value: number } {
	const unpack = (packed: number): [number, number] => {
		const bits = new Uint32Array(new Float32Array([packed]).buffer)[0];
		const dec = (half: number) =>
			Math.max((half > 32767 ? half - 65536 : half) / 32767, -1);
		return [dec(bits & 0xffff), dec(bits >>> 16)];
	};
	const [hue, saturation] = unpack(
		readDabField(data, dabIndex, "packedColorShift0"),
	);
	const [value] = unpack(readDabField(data, dabIndex, "packedColorShift1"));
	return { hue, saturation, value };
}

/** Unpack the five 6-bit wet field coefficients from a dab. */
function readWetCoefficients(data: Float32Array, dabIndex: number): number[] {
	const packed = readDabField(data, dabIndex, "packedWetCoefficients");
	const bits = new Uint32Array(new Float32Array([packed]).buffer)[0];
	return [0, 1, 2, 3, 4].map((i) => ((bits >>> (i * 6)) & 0x3f) / 63);
}
