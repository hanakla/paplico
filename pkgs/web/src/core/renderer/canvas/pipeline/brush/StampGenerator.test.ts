import { describe, expect, it } from "vitest";
import type {
	CubicBezierSegment,
	ScatterBrushSettings,
} from "../../../../schema";
import {
	cullStampBufferToViewport,
	generateStampsDirect,
} from "./StampGenerator";

const FLOATS_PER_STAMP = 16;

describe("cullStampBufferToViewport", () => {
	it("should preserve full stamp rows when copying visible stamps", () => {
		const data = new Float32Array(FLOATS_PER_STAMP * 3);
		for (let i = 0; i < data.length; i++) {
			data[i] = i + 1;
		}
		data[0] = 0;
		data[1] = 0;
		data[FLOATS_PER_STAMP] = 100;
		data[FLOATS_PER_STAMP + 1] = 100;
		data[FLOATS_PER_STAMP * 2] = 5;
		data[FLOATS_PER_STAMP * 2 + 1] = 5;

		const culled = cullStampBufferToViewport(
			{ data, count: 3 },
			{ minX: -1, minY: -1, maxX: 10, maxY: 10, width: 11, height: 11 },
			0,
		);

		expect(culled.count).toBe(2);
		expect(Array.from(culled.data.slice(0, FLOATS_PER_STAMP))).toEqual(
			Array.from(data.slice(0, FLOATS_PER_STAMP)),
		);
		expect(
			Array.from(culled.data.slice(FLOATS_PER_STAMP, FLOATS_PER_STAMP * 2)),
		).toEqual(
			Array.from(data.slice(FLOATS_PER_STAMP * 2, FLOATS_PER_STAMP * 3)),
		);
	});
});

describe("generateStampsDirect — pathStart/pathEnd", () => {
	it("pathStart=0: first stamp size reflects startPressure (low = ramp-in present)", () => {
		const buf = generateStampsDirect(
			[rampInSegment()],
			pressureSensitiveSettings(),
			0,
			0,
			1,
		);
		expect(buf.count).toBeGreaterThan(0);

		// size = brushSize * (1 - 1 + 1 * pressure) = 10 * 0.1 = 1
		const firstSize = stampSize(buf.data, 0);
		expect(firstSize).toBeCloseTo(1, 0);
	});

	it("pathStart>0: first stamp size uses endPressure (higher = ramp-in suppressed)", () => {
		const buf = generateStampsDirect(
			[rampInSegment()],
			pressureSensitiveSettings(),
			0,
			0.5,
			1,
		);
		expect(buf.count).toBeGreaterThan(0);

		// size = brushSize * endPressure = 10 * 0.8 = 8
		const firstSize = stampSize(buf.data, 0);
		expect(firstSize).toBeCloseTo(8, 0);
	});

	it("pathEnd=1: last stamp size reflects endPressure (low = ramp-out present)", () => {
		const buf = generateStampsDirect(
			[rampOutSegment()],
			pressureSensitiveSettings(),
			0,
			0,
			1,
		);
		expect(buf.count).toBeGreaterThan(1);

		// Last stamp pressure should approach endPressure=0.1
		const lastSize = stampSize(buf.data, buf.count - 1);
		expect(lastSize).toBeLessThan(5); // significantly lower than startPressure-based size (8)
	});

	it("pathEnd<1: last stamp size stays high (ramp-out suppressed)", () => {
		const buf = generateStampsDirect(
			[rampOutSegment()],
			pressureSensitiveSettings(),
			0,
			0,
			0.5,
		);
		expect(buf.count).toBeGreaterThan(1);

		// endPressure is overridden with startPressure=0.8, so all stamps
		// have pressure ≈ 0.8 → size ≈ 8
		const lastSize = stampSize(buf.data, buf.count - 1);
		expect(lastSize).toBeGreaterThan(5);
	});

	it("default pathStart/pathEnd (omitted): behaves same as 0 and 1", () => {
		const settings = pressureSensitiveSettings();
		const segments = [rampInSegment()];

		const withDefaults = generateStampsDirect(segments, settings);
		const withExplicit = generateStampsDirect(segments, settings, 0, 0, 1);

		expect(withDefaults.count).toBe(withExplicit.count);
		expect(stampSize(withDefaults.data, 0)).toBe(
			stampSize(withExplicit.data, 0),
		);
	});
});

describe("generateStampsDirect — rotation", () => {
	it("should apply stampAngle to the first fixed-rotation stamp", () => {
		const buf = generateStampsDirect([rampInSegment()], {
			...baseSettings(),
			stampAngle: 45,
			stampRotation: "none",
		});

		expect(buf.count).toBeGreaterThan(0);
		expect(stampRotation(buf.data, 0)).toBeCloseTo(Math.PI / 4, 5);
	});

	it("should apply stampAngle to the first tangent-rotation stamp", () => {
		const buf = generateStampsDirect([rampInSegment()], {
			...baseSettings(),
			stampAngle: 45,
			stampRotation: "tangent",
		});

		expect(buf.count).toBeGreaterThan(0);
		expect(stampRotation(buf.data, 0)).toBeCloseTo(-Math.PI / 4, 5);
	});
});

describe("generateStampsDirect — signed stroke widths", () => {
	it("should preserve negative side widths and their interpolation", () => {
		const buf = generateStampsDirect(
			[rampInSegment()],
			baseSettings(),
			0,
			0,
			1,
			[
				{ t: 0, side1: -0.5, side2: 1 },
				{ t: 1, side1: -1.5, side2: 1 },
			],
		);

		expect(buf.count).toBeGreaterThan(2);
		expect(stampSide1(buf.data, 0)).toBeCloseTo(-0.5, 5);
		expect(stampSide2(buf.data, 0)).toBeCloseTo(1, 5);

		let middleStamp = 0;
		let middleDistance = Number.POSITIVE_INFINITY;
		for (let i = 0; i < buf.count; i++) {
			const distance = Math.abs(stampPathT(buf.data, i) - 0.5);
			if (distance < middleDistance) {
				middleDistance = distance;
				middleStamp = i;
			}
		}
		expect(stampSide1(buf.data, middleStamp)).toBeCloseTo(
			-0.5 - stampPathT(buf.data, middleStamp),
			5,
		);
		expect(stampSide2(buf.data, middleStamp)).toBeCloseTo(1, 5);
	});
});

/** Straight segment with explicit pressure ramp (low start → high end). */
function rampInSegment(): CubicBezierSegment {
	return {
		start: { x: 0, y: 0 },
		cp1: { x: 33, y: 0 },
		cp2: { x: -33, y: 0 },
		end: { x: 100, y: 0 },
		isMoved: true,
		startPressure: 0.1,
		endPressure: 0.8,
		startTiltX: 0,
		startTiltY: 0,
		endTiltX: 0,
		endTiltY: 0,
		startDeltaTime: 0,
		endDeltaTime: 0,
	};
}

/** Straight segment with explicit pressure ramp-out (high start → low end). */
function rampOutSegment(): CubicBezierSegment {
	return {
		start: { x: 0, y: 0 },
		cp1: { x: 33, y: 0 },
		cp2: { x: -33, y: 0 },
		end: { x: 100, y: 0 },
		isMoved: true,
		startPressure: 0.8,
		endPressure: 0.1,
		startTiltX: 0,
		startTiltY: 0,
		endTiltX: 0,
		endTiltY: 0,
		startDeltaTime: 0,
		endDeltaTime: 0,
	};
}

/**
 * Brush settings with sizeByPressure=1 so stamp size directly reflects
 * the pressure value: size = brushSize * pressure.
 */
function pressureSensitiveSettings(): ScatterBrushSettings {
	return {
		type: "scatter",
		source: { kind: "file", fileUid: "builtin-brush-soft-circle" },
		size: 10,
		sizeByPressure: 1,
		opacity: 1,
		opacityByPressure: 0,
		spacing: 0.2,
		flow: 1,
		stampRotation: "none",
		randomSeed: 0,
		rotationByTilt: 0,
		aspectRatioByTilt: 0,
		sizeBySpeed: 0,
		pooling: 0,
		poolingSizeRatio: 0.5,
	};
}

describe("generateStampsDirect — tilt", () => {
	it("with rotationByTilt=0: tilt data does not affect rotation", () => {
		const noTilt = generateStampsDirect([straightSegment()], {
			...baseSettings(),
			rotationByTilt: 0,
		});
		const withTilt = generateStampsDirect([tiltedSegment()], {
			...baseSettings(),
			rotationByTilt: 0,
		});

		for (let i = 0; i < Math.min(noTilt.count, withTilt.count); i++) {
			expect(stampRotation(withTilt.data, i)).toBeCloseTo(
				stampRotation(noTilt.data, i),
				5,
			);
		}
	});

	it("with rotationByTilt=1: tilted stamps have different rotation than untilted", () => {
		const noTilt = generateStampsDirect([straightSegment()], {
			...baseSettings(),
			rotationByTilt: 1,
		});
		const withTilt = generateStampsDirect([tiltedSegment()], {
			...baseSettings(),
			rotationByTilt: 1,
		});

		// At least some stamps should differ in rotation
		let hasDifference = false;
		for (let i = 0; i < Math.min(noTilt.count, withTilt.count); i++) {
			if (
				Math.abs(
					stampRotation(withTilt.data, i) - stampRotation(noTilt.data, i),
				) > 0.01
			) {
				hasDifference = true;
				break;
			}
		}
		expect(hasDifference).toBe(true);
	});

	it("with aspectRatioByTilt=1: tilted stamps have sizeY < sizeX (elliptical)", () => {
		const withTilt = generateStampsDirect([tiltedSegment()], {
			...baseSettings(),
			aspectRatioByTilt: 1,
		});

		// Compare sizeX (off+2) vs sizeY (off+7) for a non-first stamp
		const idx = 1;
		if (withTilt.count > idx) {
			const sizeX = stampSize(withTilt.data, idx);
			const sizeY = stampSizeY(withTilt.data, idx);
			expect(sizeY).toBeLessThan(sizeX);
			expect(sizeY).toBeGreaterThan(0);
		}
	});

	it("with aspectRatioByTilt=0: sizeY equals sizeX (circular)", () => {
		const withTilt = generateStampsDirect([tiltedSegment()], {
			...baseSettings(),
			aspectRatioByTilt: 0,
		});

		for (let i = 0; i < withTilt.count; i++) {
			expect(stampSizeY(withTilt.data, i)).toBeCloseTo(
				stampSize(withTilt.data, i),
				5,
			);
		}
	});
});

describe("generateStampsDirect — pooling", () => {
	it("with pooling=0: slow and fast strokes produce same stamp count", () => {
		const fast = generateStampsDirect([fastSegment()], {
			...baseSettings(),
			pooling: 0,
		});
		const slow = generateStampsDirect([slowSegment()], {
			...baseSettings(),
			pooling: 0,
		});

		expect(fast.count).toBe(slow.count);
	});

	it("with pooling=1: slow stroke produces more stamps than fast stroke", () => {
		const fast = generateStampsDirect([fastSegment()], {
			...baseSettings(),
			pooling: 1,
		});
		const slow = generateStampsDirect([slowSegment()], {
			...baseSettings(),
			pooling: 1,
		});

		expect(slow.count).toBeGreaterThan(fast.count);
	});

	it("with pooling=1, poolingSizeRatio=1: slow stamps are larger", () => {
		const fast = generateStampsDirect([fastSegment()], {
			...baseSettings(),
			pooling: 1,
			poolingSizeRatio: 1,
		});
		const slow = generateStampsDirect([slowSegment()], {
			...baseSettings(),
			pooling: 1,
			poolingSizeRatio: 1,
		});

		// Compare average stamp size (skip first stamp)
		const avgFast = avgStampSize(fast);
		const avgSlow = avgStampSize(slow);
		expect(avgSlow).toBeGreaterThan(avgFast);
	});

	it("with pooling=1, poolingSizeRatio=0: slow stamps have higher opacity", () => {
		// Use opacity < 1 so pooling boost is not clamped
		const settings = {
			...baseSettings(),
			pooling: 1,
			poolingSizeRatio: 0,
			opacity: 0.5,
		};
		const fast = generateStampsDirect([fastSegment()], settings);
		const slow = generateStampsDirect([slowSegment()], settings);

		const avgFast = avgStampOpacity(fast);
		const avgSlow = avgStampOpacity(slow);
		expect(avgSlow).toBeGreaterThan(avgFast);
	});
});

describe("generateStampsDirect — sizeBySpeed", () => {
	it("with sizeBySpeed=0: fast and slow strokes have same average size", () => {
		const fast = generateStampsDirect([fastSegment()], {
			...baseSettings(),
			sizeBySpeed: 0,
		});
		const slow = generateStampsDirect([slowSegment()], {
			...baseSettings(),
			sizeBySpeed: 0,
		});

		expect(avgStampSize(fast)).toBeCloseTo(avgStampSize(slow), 3);
	});

	it("with sizeBySpeed=1: fast stroke stamps are smaller than slow stroke", () => {
		const fast = generateStampsDirect([fastSegment()], {
			...baseSettings(),
			sizeBySpeed: 1,
		});
		const slow = generateStampsDirect([slowSegment()], {
			...baseSettings(),
			sizeBySpeed: 1,
		});

		expect(avgStampSize(fast)).toBeLessThan(avgStampSize(slow));
	});
});

describe("generateStampsDirect — wet motion metadata", () => {
	it("writes flow in path progression direction", () => {
		const buf = generateStampsDirect([slowSegment()], baseSettings());

		expect(buf.count).toBeGreaterThan(1);
		expect(stampFlowX(buf.data, 1)).toBeGreaterThan(0.99);
		expect(Math.abs(stampFlowY(buf.data, 1))).toBeLessThan(0.01);
	});

	it("writes slower speed metadata for slower timed strokes", () => {
		const fast = generateStampsDirect([fastSegment()], baseSettings());
		const slow = generateStampsDirect([slowSegment()], baseSettings());

		expect(avgStampMotionSpeed(slow)).toBeLessThan(avgStampMotionSpeed(fast));
	});

	it("marks acceleration when stroke speed changes", () => {
		const steady = generateStampsDirect([slowSegment()], baseSettings());
		const changing = generateStampsDirect(
			fastThenSlowSegments(),
			baseSettings(),
		);

		expect(maxStampMotionAccel(changing)).toBeGreaterThan(
			maxStampMotionAccel(steady),
		);
	});
});

describe("generateStampsDirect — backward compatibility", () => {
	it("default tilt/pooling values produce identical output to omitted values", () => {
		const segments = [rampInSegment()];

		const withDefaults = generateStampsDirect(segments, {
			...pressureSensitiveSettings(),
			rotationByTilt: 0,
			aspectRatioByTilt: 0,
			sizeBySpeed: 0,
			pooling: 0,
			poolingSizeRatio: 0.5,
		});
		const withoutNewFields = generateStampsDirect(
			segments,
			pressureSensitiveSettings(),
		);

		expect(withDefaults.count).toBe(withoutNewFields.count);
		for (let i = 0; i < withDefaults.count; i++) {
			expect(stampSize(withDefaults.data, i)).toBeCloseTo(
				stampSize(withoutNewFields.data, i),
				5,
			);
			expect(stampOpacity(withDefaults.data, i)).toBeCloseTo(
				stampOpacity(withoutNewFields.data, i),
				5,
			);
			expect(stampRotation(withDefaults.data, i)).toBeCloseTo(
				stampRotation(withoutNewFields.data, i),
				5,
			);
		}
	});
});

describe("generateStampsDirect — taper", () => {
	it("with taperStart: first stamp is smaller than a mid-stroke stamp at constant pressure", () => {
		const buf = generateStampsDirect([straightSegment()], {
			...baseSettings(),
			taperStart: 30,
		});

		expect(buf.count).toBeGreaterThan(2);
		const mid = Math.floor(buf.count / 2);
		expect(stampSize(buf.data, 0)).toBeLessThan(stampSize(buf.data, mid));
	});

	it("with taperStart and pathStart=0.5: entry taper is suppressed (sizes unchanged)", () => {
		const baseline = generateStampsDirect(
			[straightSegment()],
			baseSettings(),
			0,
			0.5,
			1,
		);
		const suppressed = generateStampsDirect(
			[straightSegment()],
			{ ...baseSettings(), taperStart: 30 },
			0,
			0.5,
			1,
		);

		expect(suppressed.count).toBe(baseline.count);
		for (let i = 0; i < suppressed.count; i++) {
			expect(stampSize(suppressed.data, i)).toBe(stampSize(baseline.data, i));
		}
	});

	it("with taper 0/undefined: buffer is identical to baseline", () => {
		const baseline = generateStampsDirect([straightSegment()], baseSettings());
		const withZero = generateStampsDirect([straightSegment()], {
			...baseSettings(),
			taperStart: 0,
			taperEnd: 0,
		});

		expect(withZero.count).toBe(baseline.count);
		expect(
			Array.from(withZero.data.subarray(0, withZero.count * FLOATS_PER_STAMP)),
		).toEqual(
			Array.from(baseline.data.subarray(0, baseline.count * FLOATS_PER_STAMP)),
		);
	});
});

describe("generateStampsDirect — speed taper (ramp-in/out)", () => {
	it("starts thin while accelerating from rest and reaches full width at cruise", () => {
		// 4 × 100px at 1 px/ms — well above the reference velocity for size 10
		const buf = generateStampsDirect(
			timedStraightSegments([100, 100, 100, 100]),
			{ ...baseSettings(), sizeBySpeed: 1 },
		);

		const head = avgSizeInPathRange(buf, 0, 0.1);
		const cruise = avgSizeInPathRange(buf, 0.4, 0.6);
		expect(head).toBeLessThan(cruise * 0.7);
	});

	it("keeps a thin head when the stroke starts with a touch-down dwell", () => {
		// Real pen input dwells right after touch-down: 5px over the first
		// 80ms, then a fast 1 px/ms gesture. The head must not blob.
		const dwell: CubicBezierSegment = {
			start: { x: -5, y: 0 },
			cp1: { x: 1.7, y: 0 },
			cp2: { x: -1.7, y: 0 },
			end: { x: 0, y: 0 },
			isMoved: true,
			startPressure: 0.5,
			endPressure: 0.5,
			startTiltX: 0,
			startTiltY: 0,
			endTiltX: 0,
			endTiltY: 0,
			startDeltaTime: 0,
			endDeltaTime: 80,
		};
		const cruise = timedStraightSegments([100, 100, 100]).map((segment) => ({
			...segment,
			isMoved: false,
			startDeltaTime: segment.startDeltaTime + 80,
			endDeltaTime: segment.endDeltaTime + 80,
		}));
		const buf = generateStampsDirect([dwell, ...cruise], {
			...baseSettings(),
			sizeBySpeed: 1,
		});

		// Assert on the dwell region itself (first ~6px) — that is where the
		// blob used to form.
		const head = avgSizeInPathRange(buf, 0, 0.02);
		const late = avgSizeInPathRange(buf, 0.6, 0.9);
		expect(head).toBeLessThan(late * 0.7);
	});

	it("thins again while decelerating into the stroke end", () => {
		// Cruise at 1 px/ms, then brake hard over the last 10px (0.1 px/ms)
		const buf = generateStampsDirect(
			timedStraightSegments([100, 100, 100, 100], { tailPx: 10, tailMs: 100 }),
			{ ...baseSettings(), sizeBySpeed: 1 },
		);

		// Compare against late cruise (ramp-in fully decayed); the braking dip
		// is sharp, so assert on the thinnest stamp in the tail window.
		const cruise = avgSizeInPathRange(buf, 0.6, 0.9);
		const tailMin = minSizeInPathRange(buf, 0.97, 1);
		expect(tailMin).toBeLessThan(cruise * 0.6);
	});

	it("settles at the steady-state width after the ramp-in at constant sub-reference speed", () => {
		// 4 × 100px at 0.2 px/ms with influence 0.5:
		// size = 10 * (1 - 0.5 * (0.2 / 0.6) * 0.7) ≈ 8.83
		const buf = generateStampsDirect(
			timedStraightSegments([500, 500, 500, 500]),
			{ ...baseSettings(), sizeBySpeed: 0.5 },
		);

		expect(avgSizeInPathRange(buf, 0.5, 1)).toBeCloseTo(8.83, 0);
	});

	it("keeps untimed strokes at full width regardless of sizeBySpeed", () => {
		const neutral = generateStampsDirect([straightSegment()], {
			...baseSettings(),
			sizeBySpeed: 0,
		});
		const speedy = generateStampsDirect([straightSegment()], {
			...baseSettings(),
			sizeBySpeed: 1,
		});

		expect(speedy.count).toBe(neutral.count);
		for (let i = 0; i < speedy.count; i++) {
			expect(stampSize(speedy.data, i)).toBe(stampSize(neutral.data, i));
			expect(stampMotionSpeed(speedy.data, i)).toBe(0.5);
		}
	});

	it("suppresses the ramp-in taper on mid-stroke fragments (pathStart > 0)", () => {
		const segments = timedStraightSegments([100, 100, 100, 100]);
		const settings = { ...baseSettings(), sizeBySpeed: 1 };
		const fullStroke = generateStampsDirect(segments, settings, 0, 0, 1);
		const fragment = generateStampsDirect(segments, settings, 0, 0.5, 1);

		expect(stampSize(fragment.data, 0)).toBeGreaterThan(
			stampSize(fullStroke.data, 0),
		);
	});

	it("produces finite sizes when segment timestamps regress", () => {
		const regressed = timedStraightSegments([100, 100]);
		regressed[1].startDeltaTime = 100;
		regressed[1].endDeltaTime = 50;
		const buf = generateStampsDirect(regressed, {
			...baseSettings(),
			sizeBySpeed: 1,
			pooling: 1,
		});

		expect(buf.count).toBeGreaterThan(0);
		for (let i = 0; i < buf.count; i++) {
			expect(Number.isFinite(stampSize(buf.data, i))).toBe(true);
			expect(stampSize(buf.data, i)).toBeGreaterThan(0);
		}
	});
});

describe("generateStampsDirect — pooling arm gate", () => {
	it("keeps the stroke head free of pooling", () => {
		// 100px over 1000ms: slow enough that pooling engages once armed
		const buf = generateStampsDirect(timedStraightSegments([1000]), {
			...baseSettings(),
			pooling: 1,
			poolingSizeRatio: 1,
		});

		// Head stamp carries no pooling boost; later stamps do
		expect(stampSize(buf.data, 0)).toBeCloseTo(10, 5);
		const early = avgSizeInPathRange(buf, 0, 0.05);
		const late = avgSizeInPathRange(buf, 0.5, 1);
		expect(early).toBeLessThan(late);
	});
});

/** Straight horizontal segment with no tilt */
function straightSegment(): CubicBezierSegment {
	return {
		start: { x: 0, y: 0 },
		cp1: { x: 33, y: 0 },
		cp2: { x: -33, y: 0 },
		end: { x: 100, y: 0 },
		isMoved: true,
		startPressure: 0.5,
		endPressure: 0.5,
		startTiltX: 0,
		startTiltY: 0,
		endTiltX: 0,
		endTiltY: 0,
		startDeltaTime: 0,
		endDeltaTime: 0,
	};
}

/** Straight horizontal segment with significant tilt */
function tiltedSegment(): CubicBezierSegment {
	return {
		start: { x: 0, y: 0 },
		cp1: { x: 33, y: 0 },
		cp2: { x: -33, y: 0 },
		end: { x: 100, y: 0 },
		isMoved: true,
		startPressure: 0.5,
		endPressure: 0.5,
		startTiltX: 45,
		startTiltY: 30,
		endTiltX: 45,
		endTiltY: 30,
		startDeltaTime: 0,
		endDeltaTime: 0,
	};
}

/** Fast stroke: short time for the distance */
function fastSegment(): CubicBezierSegment {
	return {
		start: { x: 0, y: 0 },
		cp1: { x: 33, y: 0 },
		cp2: { x: -33, y: 0 },
		end: { x: 100, y: 0 },
		isMoved: true,
		startPressure: 0.5,
		endPressure: 0.5,
		startTiltX: 0,
		startTiltY: 0,
		endTiltX: 0,
		endTiltY: 0,
		startDeltaTime: 0,
		endDeltaTime: 10,
	};
}

/** Slow stroke: long time for the same distance */
function slowSegment(): CubicBezierSegment {
	return {
		start: { x: 0, y: 0 },
		cp1: { x: 33, y: 0 },
		cp2: { x: -33, y: 0 },
		end: { x: 100, y: 0 },
		isMoved: true,
		startPressure: 0.5,
		endPressure: 0.5,
		startTiltX: 0,
		startTiltY: 0,
		endTiltX: 0,
		endTiltY: 0,
		startDeltaTime: 0,
		endDeltaTime: 5000,
	};
}

function fastThenSlowSegments(): CubicBezierSegment[] {
	return [
		fastSegment(),
		{
			cp1: { x: 33, y: 0 },
			cp2: { x: -33, y: 0 },
			end: { x: 200, y: 0 },
			isMoved: false,
			startPressure: 0.5,
			endPressure: 0.5,
			startTiltX: 0,
			startTiltY: 0,
			endTiltX: 0,
			endTiltY: 0,
			startDeltaTime: 10,
			endDeltaTime: 5010,
		},
	];
}

/**
 * Straight multi-segment stroke: 100px per segment with the given per-segment
 * durations (ms), plus an optional short braking segment at the end.
 */
function timedStraightSegments(
	durations: number[],
	tail?: { tailPx: number; tailMs: number },
): CubicBezierSegment[] {
	const segments: CubicBezierSegment[] = [];
	let time = 0;
	for (let i = 0; i < durations.length; i++) {
		const startDeltaTime = time;
		time += durations[i];
		segments.push({
			...(i === 0 ? { start: { x: 0, y: 0 } } : {}),
			cp1: { x: 33, y: 0 },
			cp2: { x: -33, y: 0 },
			end: { x: (i + 1) * 100, y: 0 },
			isMoved: i === 0,
			startPressure: 0.5,
			endPressure: 0.5,
			startTiltX: 0,
			startTiltY: 0,
			endTiltX: 0,
			endTiltY: 0,
			startDeltaTime,
			endDeltaTime: time,
		});
	}
	if (tail) {
		const cruiseEnd = durations.length * 100;
		segments.push({
			cp1: { x: tail.tailPx / 3, y: 0 },
			cp2: { x: -tail.tailPx / 3, y: 0 },
			end: { x: cruiseEnd + tail.tailPx, y: 0 },
			isMoved: false,
			startPressure: 0.5,
			endPressure: 0.5,
			startTiltX: 0,
			startTiltY: 0,
			endTiltX: 0,
			endTiltY: 0,
			startDeltaTime: time,
			endDeltaTime: time + tail.tailMs,
		});
	}
	return segments;
}

function baseSettings(): ScatterBrushSettings {
	return {
		type: "scatter",
		source: { kind: "file", fileUid: "builtin-brush-soft-circle" },
		size: 10,
		sizeByPressure: 0,
		opacity: 1,
		opacityByPressure: 0,
		spacing: 0.2,
		flow: 1,
		stampRotation: "none",
		randomSeed: 0,
		rotationByTilt: 0,
		aspectRatioByTilt: 0,
		sizeBySpeed: 0,
		pooling: 0,
		poolingSizeRatio: 0.5,
	};
}

function avgStampSize(buf: { data: Float32Array; count: number }): number {
	let sum = 0;
	const start = Math.min(1, buf.count - 1);
	for (let i = start; i < buf.count; i++) sum += stampSize(buf.data, i);
	return sum / (buf.count - start);
}

/** Average stamp size over stamps whose pathT falls in [min, max]. */
function avgSizeInPathRange(
	buf: { data: Float32Array; count: number },
	min: number,
	max: number,
): number {
	let sum = 0;
	let n = 0;
	for (let i = 0; i < buf.count; i++) {
		const t = stampPathT(buf.data, i);
		if (t >= min && t <= max) {
			sum += stampSize(buf.data, i);
			n++;
		}
	}
	return n > 0 ? sum / n : Number.NaN;
}

/** Smallest stamp size over stamps whose pathT falls in [min, max]. */
function minSizeInPathRange(
	buf: { data: Float32Array; count: number },
	min: number,
	max: number,
): number {
	let smallest = Number.POSITIVE_INFINITY;
	for (let i = 0; i < buf.count; i++) {
		const t = stampPathT(buf.data, i);
		if (t >= min && t <= max) {
			smallest = Math.min(smallest, stampSize(buf.data, i));
		}
	}
	return smallest;
}

function avgStampOpacity(buf: { data: Float32Array; count: number }): number {
	let sum = 0;
	const start = Math.min(1, buf.count - 1);
	for (let i = start; i < buf.count; i++) sum += stampOpacity(buf.data, i);
	return sum / (buf.count - start);
}

function avgStampMotionSpeed(buf: {
	data: Float32Array;
	count: number;
}): number {
	let sum = 0;
	const start = Math.min(1, buf.count - 1);
	for (let i = start; i < buf.count; i++) sum += stampMotionSpeed(buf.data, i);
	return sum / (buf.count - start);
}

function maxStampMotionAccel(buf: {
	data: Float32Array;
	count: number;
}): number {
	let max = 0;
	for (let i = 0; i < buf.count; i++) {
		max = Math.max(max, stampMotionAccel(buf.data, i));
	}
	return max;
}

/** Extract stamp size (index 2) from Float32Array at stamp index. */
function stampSize(data: Float32Array, stampIndex: number): number {
	return data[stampIndex * FLOATS_PER_STAMP + 2];
}

/** Extract stamp opacity (index 3) from Float32Array at stamp index. */
function stampOpacity(data: Float32Array, stampIndex: number): number {
	return data[stampIndex * FLOATS_PER_STAMP + 3];
}

/** Extract stamp sizeY (index 7) from Float32Array at stamp index. */
function stampSizeY(data: Float32Array, stampIndex: number): number {
	return data[stampIndex * FLOATS_PER_STAMP + 7];
}

/** Extract stamp rotation (index 4) from Float32Array at stamp index. */
function stampRotation(data: Float32Array, stampIndex: number): number {
	return data[stampIndex * FLOATS_PER_STAMP + 4];
}

function stampPathT(data: Float32Array, stampIndex: number): number {
	return data[stampIndex * FLOATS_PER_STAMP + 5];
}

function stampSide1(data: Float32Array, stampIndex: number): number {
	return data[stampIndex * FLOATS_PER_STAMP + 8];
}

function stampSide2(data: Float32Array, stampIndex: number): number {
	return data[stampIndex * FLOATS_PER_STAMP + 9];
}

function stampFlowX(data: Float32Array, stampIndex: number): number {
	return data[stampIndex * FLOATS_PER_STAMP + 12];
}

function stampFlowY(data: Float32Array, stampIndex: number): number {
	return data[stampIndex * FLOATS_PER_STAMP + 13];
}

function stampMotionSpeed(data: Float32Array, stampIndex: number): number {
	return data[stampIndex * FLOATS_PER_STAMP + 14];
}

function stampMotionAccel(data: Float32Array, stampIndex: number): number {
	return data[stampIndex * FLOATS_PER_STAMP + 15];
}
