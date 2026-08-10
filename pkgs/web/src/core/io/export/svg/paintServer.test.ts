import { describe, expect, it } from "vitest";
import type {
	ColorStop,
	LinearGradient,
	RadialGradient,
	RGBColor,
} from "../../../schema";
import {
	oklabToRgb,
	rgbToOklab,
} from "../../../utils/geometry/blendInterpolation";
import { colorToSvgPaint, gradientToSvgPaint } from "./paintServer";
import { boundsUnitAffine, createCoordMapper } from "./pathData";
import { SvgDocumentBuilder } from "./svgBuilder";

const rgb = (r: number, g: number, b: number, a = 1): RGBColor => ({
	type: "rgb",
	r,
	g,
	b,
	a,
});

const stop = (offset: number, color: RGBColor, midpoint = 0.5): ColorStop => ({
	offset,
	color,
	midpoint,
});

/** unit space → world map spanning a w×h rect anchored at (minX, minY). */
const unitAffine = (
	minX: number,
	minY: number,
	width: number,
	height: number,
) => boundsUnitAffine({ minX, minY, width, height });

const mapper = createCoordMapper({
	id: "ab",
	name: "Artboard",
	x: 0,
	y: 0,
	width: 800,
	height: 600,
});

describe("colorToSvgPaint", () => {
	it("should convert RGB to hex with separate opacity", () => {
		expect(colorToSvgPaint(rgb(1, 0, 0.5, 0.25))).toEqual({
			paint: "#ff0080",
			opacity: 0.25,
		});
	});

	it("should convert HSV colors through RGB", () => {
		expect(colorToSvgPaint({ type: "hsv", h: 0, s: 1, v: 1, a: 1 })).toEqual({
			paint: "#ff0000",
			opacity: 1,
		});
	});
});

describe("gradientToSvgPaint", () => {
	it("should register a unit-space linearGradient with the unit→world gradientTransform", () => {
		const builder = new SvgDocumentBuilder({ width: 800, height: 600 });
		const gradient: LinearGradient = {
			type: "linear",
			x1: 0,
			y1: 0,
			x2: 1,
			y2: 1,
			stops: [stop(0, rgb(0, 0, 0)), stop(1, rgb(1, 1, 1))],
		};
		const paint = gradientToSvgPaint(
			gradient,
			unitAffine(0, 0, 100, 50),
			mapper,
			builder,
		);
		expect(paint).toEqual({ paint: "url(#grad0)", opacity: 1 });
		const svg = builder.serialize();
		// Unit coords stay raw; the bbox map diag(100, 50) + Y flip lands in the
		// gradientTransform (bbox origin world (0, 0) → svg (400, 300)).
		expect(svg).toContain(
			`<linearGradient id="grad0" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="1" y2="1" gradientTransform="matrix(100 0 0 -50 400 300)">`,
		);
		expect(svg).toContain(`<stop offset="0" stop-color="#000000"/>`);
		expect(svg).toContain(`<stop offset="1" stop-color="#ffffff"/>`);
	});

	it("should register a unit-circle radialGradient with a gradientTransform", () => {
		const builder = new SvgDocumentBuilder({ width: 800, height: 600 });
		const gradient: RadialGradient = {
			type: "radial",
			cx: 0.5,
			cy: 0.5,
			radiusX: 0.5,
			radiusY: 0.5,
			rotation: 0,
			stops: [stop(0, rgb(1, 0, 0)), stop(1, rgb(0, 0, 1))],
		};
		gradientToSvgPaint(gradient, unitAffine(0, 0, 100, 100), mapper, builder);
		// Center world (50, 50) → svg (450, 250); radius 50 with Y flip.
		expect(builder.serialize()).toContain(
			`<radialGradient id="grad0" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="1" gradientTransform="matrix(50 0 0 -50 450 250)">`,
		);
	});

	it("should sample intermediate stops reproducing the OKLab + midpoint ramp", () => {
		const builder = new SvgDocumentBuilder({ width: 800, height: 600 });
		const gradient: LinearGradient = {
			type: "linear",
			x1: 0,
			y1: 0,
			x2: 1,
			y2: 0,
			stops: [stop(0, rgb(0, 0, 0), 0.25), stop(1, rgb(1, 1, 1))],
		};
		gradientToSvgPaint(gradient, unitAffine(0, 0, 100, 100), mapper, builder);

		// midpoint 0.25 puts the ramp's 50% point at offset 0.25; the color
		// there is the OKLab midpoint of black/white, not the sRGB average.
		const labBlack = rgbToOklab(rgb(0, 0, 0));
		const labWhite = rgbToOklab(rgb(1, 1, 1));
		const mid = oklabToRgb({
			L: (labBlack.L + labWhite.L) / 2,
			a: (labBlack.a + labWhite.a) / 2,
			b: (labBlack.b + labWhite.b) / 2,
			alpha: 1,
		});
		const channel = (v: number) =>
			Math.round(Math.min(1, Math.max(0, v)) * 255)
				.toString(16)
				.padStart(2, "0");
		const midHex = `#${channel(mid.r)}${channel(mid.g)}${channel(mid.b)}`;
		expect(midHex).not.toBe("#808080");
		expect(builder.serialize()).toContain(
			`<stop offset="0.25" stop-color="${midHex}"/>`,
		);
	});

	it("should not insert stops for same-color unbiased pairs and keep stop-opacity", () => {
		const builder = new SvgDocumentBuilder({ width: 800, height: 600 });
		const gradient: LinearGradient = {
			type: "linear",
			x1: 0,
			y1: 0,
			x2: 1,
			y2: 0,
			stops: [stop(0, rgb(0, 0, 0, 0.5)), stop(1, rgb(0, 0, 0))],
		};
		gradientToSvgPaint(gradient, unitAffine(0, 0, 100, 100), mapper, builder);
		const svg = builder.serialize();
		// Alpha interpolates linearly on both sides — no intermediate stops.
		expect(svg.match(/<stop /g)).toHaveLength(2);
		expect(svg).toContain(
			`<stop offset="0" stop-color="#000000" stop-opacity="0.5"/>`,
		);
	});

	it("should fall back to none for zero stops and solid for one stop", () => {
		const builder = new SvgDocumentBuilder({ width: 800, height: 600 });
		const base: LinearGradient = {
			type: "linear",
			x1: 0,
			y1: 0,
			x2: 1,
			y2: 0,
			stops: [],
		};
		expect(
			gradientToSvgPaint(base, unitAffine(0, 0, 10, 10), mapper, builder),
		).toEqual({ paint: "none", opacity: 1 });
		expect(
			gradientToSvgPaint(
				{ ...base, stops: [stop(0, rgb(1, 0, 0))] },
				unitAffine(0, 0, 10, 10),
				mapper,
				builder,
			),
		).toEqual({ paint: "#ff0000", opacity: 1 });
	});

	it("should fall back to the first stop color for a degenerate unit map", () => {
		const builder = new SvgDocumentBuilder({ width: 800, height: 600 });
		const gradient: LinearGradient = {
			type: "linear",
			x1: 0,
			y1: 0,
			x2: 1,
			y2: 0,
			stops: [stop(0, rgb(0, 1, 0)), stop(1, rgb(1, 1, 1))],
		};
		expect(
			gradientToSvgPaint(gradient, unitAffine(0, 0, 0, 10), mapper, builder),
		).toEqual({ paint: "#00ff00", opacity: 1 });
	});
});
