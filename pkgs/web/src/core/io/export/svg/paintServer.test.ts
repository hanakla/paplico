import { describe, expect, it } from "vitest";
import type {
	BoundingBox,
	ColorStop,
	LinearGradient,
	RadialGradient,
	RGBColor,
} from "../../../schema";
import { colorToSvgPaint, gradientToSvgPaint } from "./paintServer";
import { createCoordMapper } from "./pathData";
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

const bounds = (
	minX: number,
	minY: number,
	width: number,
	height: number,
): BoundingBox => ({
	minX,
	minY,
	maxX: minX + width,
	maxY: minY + height,
	width,
	height,
});

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
	it("should register a unit-space linearGradient with a bbox gradientTransform", () => {
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
			bounds(0, 0, 100, 50),
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
		gradientToSvgPaint(gradient, bounds(0, 0, 100, 100), mapper, builder);
		// Center world (50, 50) → svg (450, 250); radius 50 with Y flip.
		expect(builder.serialize()).toContain(
			`<radialGradient id="grad0" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="1" gradientTransform="matrix(50 0 0 -50 450 250)">`,
		);
	});

	it("should insert a mixed intermediate stop for non-0.5 midpoints", () => {
		const builder = new SvgDocumentBuilder({ width: 800, height: 600 });
		const gradient: LinearGradient = {
			type: "linear",
			x1: 0,
			y1: 0,
			x2: 1,
			y2: 0,
			stops: [stop(0, rgb(0, 0, 0), 0.25), stop(1, rgb(1, 1, 1))],
		};
		gradientToSvgPaint(gradient, bounds(0, 0, 100, 100), mapper, builder);
		expect(builder.serialize()).toContain(
			`<stop offset="0.25" stop-color="#808080"/>`,
		);
	});

	it("should emit stop-opacity only for translucent stops", () => {
		const builder = new SvgDocumentBuilder({ width: 800, height: 600 });
		const gradient: LinearGradient = {
			type: "linear",
			x1: 0,
			y1: 0,
			x2: 1,
			y2: 0,
			stops: [stop(0, rgb(0, 0, 0, 0.5)), stop(1, rgb(1, 1, 1))],
		};
		gradientToSvgPaint(gradient, bounds(0, 0, 100, 100), mapper, builder);
		expect(builder.serialize()).toContain(
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
			gradientToSvgPaint(base, bounds(0, 0, 10, 10), mapper, builder),
		).toEqual({ paint: "none", opacity: 1 });
		expect(
			gradientToSvgPaint(
				{ ...base, stops: [stop(0, rgb(1, 0, 0))] },
				bounds(0, 0, 10, 10),
				mapper,
				builder,
			),
		).toEqual({ paint: "#ff0000", opacity: 1 });
	});

	it("should fall back to the first stop color for degenerate bounds", () => {
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
			gradientToSvgPaint(gradient, bounds(0, 0, 0, 10), mapper, builder),
		).toEqual({ paint: "#00ff00", opacity: 1 });
	});
});
