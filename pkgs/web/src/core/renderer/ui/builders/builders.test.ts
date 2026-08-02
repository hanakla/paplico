import { describe, expect, it } from "vitest";
import { UI_THEME } from "../theme";
import { TEST_ARTBOARDS, UI_FIXTURE_DATA } from "../UILayer.visual.fixtures";
import { buildArtboardOverlay } from "./artboard";
import { buildBucketFillOverlay } from "./bucketFill";
import { buildEraserOverlay } from "./eraser";
import { buildGradientOverlay } from "./gradient";
import { buildHoverOverlay } from "./hover";
import { buildMarqueeOverlay } from "./marquee";
import { buildMeshDeformOverlay } from "./meshDeform";
import { buildPathEditOverlay } from "./pathEdit";
import { buildPatternEditOverlay } from "./patternEdit";
import { buildPerspectiveGuideOverlay } from "./perspectiveGuides";
import { buildSelectionOverlay } from "./selection";
import { buildSnapLineOverlay } from "./snapLine";
import { buildStrokeWidthEditOverlay } from "./strokeWidthEdit";
import { buildFontMissingOutlines } from "./text";
import { buildTextEditOverlay } from "./textEdit";
import { buildToolCursorOverlay } from "./toolCursor";

/**
 * Snapshot the primitive stream each builder emits for the shared VRT
 * fixture data. Guards the builder output (geometry, colors, painter's order)
 * against unintended changes without a GPU.
 */
describe("UI overlay builders", () => {
	it("should build selection primitives from the VRT fixture", () => {
		expect(
			buildSelectionOverlay(UI_FIXTURE_DATA.selection, UI_THEME),
		).toMatchSnapshot();
	});

	it("should build path-edit primitives from the VRT fixture", () => {
		expect(
			buildPathEditOverlay(UI_FIXTURE_DATA.pathEdit, UI_THEME),
		).toMatchSnapshot();
	});

	it("should draw a mesh cage's dashed bounds after its edge curves", () => {
		const prims = buildPathEditOverlay(
			{
				paths: [],
				meshCages: [
					{
						meshId: "mesh-1",
						bounds: {
							minX: 0,
							minY: 0,
							maxX: 100,
							maxY: 100,
							width: 100,
							height: 100,
						},
						edges: [
							{
								start: { x: 0, y: 0 },
								cp1: { x: 33, y: 0 },
								cp2: { x: 67, y: 0 },
								end: { x: 100, y: 0 },
							},
						],
						handles: [],
					},
				],
			},
			UI_THEME,
		);

		// The cage boundary coincides with the bounds on an undeformed cage, so
		// the dashes are only visible when they paint last.
		const edgeIndex = prims.findIndex((p) => p.kind === "bezierPath");
		const dashedIndex = prims.findIndex(
			(p) => p.kind === "rect" && p.stroke?.dash != null,
		);
		expect(edgeIndex).toBeGreaterThanOrEqual(0);
		expect(dashedIndex).toBeGreaterThan(edgeIndex);
	});

	it("should draw derived cage vertices as diamonds and explicit ones as squares", () => {
		const prims = buildPathEditOverlay(
			{
				paths: [],
				meshCages: [
					{
						meshId: "mesh-1",
						bounds: {
							minX: 0,
							minY: 0,
							maxX: 100,
							maxY: 100,
							width: 100,
							height: 100,
						},
						edges: [],
						handles: [
							{
								id: "meshv:mesh-1:0",
								handleType: "mesh-vertex",
								worldX: 0,
								worldY: 0,
								selected: false,
							},
							{
								id: "meshv:mesh-1:4",
								handleType: "mesh-vertex",
								worldX: 50,
								worldY: 0,
								isDerived: true,
								selected: false,
							},
						],
					},
				],
			},
			UI_THEME,
		);

		// Both handles sit on y = 0; the dashed bounds rect is centered elsewhere.
		const kindsAt = (cx: number) =>
			prims
				.filter(
					(p) =>
						!p.hitOnly && "cx" in p && p.cx === cx && "cy" in p && p.cy === 0,
				)
				.map((p) => p.kind);
		// The explicit vertex keeps the square; the derived one is a diamond of
		// the same size (fill + outline for each).
		expect(new Set(kindsAt(0))).toEqual(new Set(["rect"]));
		expect(new Set(kindsAt(50))).toEqual(new Set(["diamond"]));
	});

	it("should build tool-cursor primitives from the VRT fixture", () => {
		expect(
			buildToolCursorOverlay(UI_FIXTURE_DATA.toolCursor, UI_THEME),
		).toMatchSnapshot();
	});

	it("should build eraser primitives from the VRT fixture", () => {
		expect(
			buildEraserOverlay(UI_FIXTURE_DATA.eraserTool, UI_THEME),
		).toMatchSnapshot();
	});

	it("should build marquee primitives from the VRT fixture", () => {
		expect(
			buildMarqueeOverlay(UI_FIXTURE_DATA.marquee, UI_THEME),
		).toMatchSnapshot();
	});

	it("should build artboard outline primitives from the VRT fixture", () => {
		expect(
			buildArtboardOverlay(TEST_ARTBOARDS, undefined, UI_THEME),
		).toMatchSnapshot();
	});

	it("should build artboard selection primitives from the VRT fixture", () => {
		expect(
			buildArtboardOverlay(
				TEST_ARTBOARDS,
				UI_FIXTURE_DATA.artboardSelection,
				UI_THEME,
			),
		).toMatchSnapshot();
	});

	it("should build hover primitives from the VRT fixture", () => {
		expect(
			buildHoverOverlay(UI_FIXTURE_DATA.hover, UI_THEME),
		).toMatchSnapshot();
	});

	it("should build snap-line primitives from the VRT fixture", () => {
		expect(
			buildSnapLineOverlay(UI_FIXTURE_DATA.snapLine, UI_THEME),
		).toMatchSnapshot();
	});

	it("should build perspective ruler primitives (horizon + finite VP markers)", () => {
		expect(
			buildPerspectiveGuideOverlay(
				{
					elementId: "reference3d-el",
					axes: [
						{ axis: "x", kind: "finite", point: { x: -500, y: 40 } },
						{ axis: "y", kind: "infinite", direction: { x: 0, y: 1 } },
						{ axis: "z", kind: "finite", point: { x: 600, y: 40 } },
					],
					horizon: { point: { x: -500, y: 40 }, direction: { x: 1, y: 0 } },
				},
				UI_THEME,
			),
		).toMatchSnapshot();
	});

	it("should build gradient-edit primitives from the VRT fixture", () => {
		expect(
			buildGradientOverlay(UI_FIXTURE_DATA.gradientEdit, UI_THEME),
		).toMatchSnapshot();
	});

	it("should draw a gray outline stroke beneath an outlined gradient line", () => {
		expect(
			buildGradientOverlay(
				{
					handles: [],
					lines: [
						{
							x1: 0,
							y1: 0,
							x2: 100,
							y2: 0,
							color: [1, 1, 1, 1],
							width: 4,
							outlined: true,
						},
					],
					circles: [],
					ellipses: [],
				},
				UI_THEME,
			),
		).toMatchSnapshot();
	});

	it("should build mesh-deform primitives from the VRT fixture", () => {
		expect(
			buildMeshDeformOverlay(UI_FIXTURE_DATA.meshDeform, UI_THEME),
		).toMatchSnapshot();
	});

	it("should build pattern-edit primitives from the VRT fixture", () => {
		expect(
			buildPatternEditOverlay(UI_FIXTURE_DATA.patternEdit, UI_THEME),
		).toMatchSnapshot();
	});

	it("should build stroke-width-edit primitives from the VRT fixture", () => {
		expect(
			buildStrokeWidthEditOverlay(UI_FIXTURE_DATA.strokeWidthEdit, UI_THEME),
		).toMatchSnapshot();
	});

	it("should build text-edit primitives from the VRT fixture", () => {
		expect(
			buildTextEditOverlay(UI_FIXTURE_DATA.textEdit, UI_THEME),
		).toMatchSnapshot();
	});

	it("should build bucket-fill primitives from the VRT fixture", () => {
		expect(
			buildBucketFillOverlay(UI_FIXTURE_DATA.bucketFill, UI_THEME),
		).toMatchSnapshot();
	});
});

describe("buildFontMissingOutlines", () => {
	it("emits one stroke-only red rect per bounds", () => {
		const prims = buildFontMissingOutlines(
			[
				{ minX: 0, minY: 0, maxX: 10, maxY: 20 },
				{ minX: 5, minY: 5, maxX: 15, maxY: 15 },
			],
			UI_THEME,
		);
		expect(prims).toHaveLength(2);
		for (const p of prims) {
			expect(p.kind).toBe("rect");
			if (p.kind !== "rect") continue;
			// Stroke-only: red outline, no fill.
			expect(p.fill).toBeUndefined();
			expect(p.stroke?.color).toEqual(UI_THEME.colors.textOverflowBadge);
		}
		const first = prims[0];
		if (first.kind !== "rect") throw new Error("expected rect");
		expect(first.cx).toBe(5);
		expect(first.cy).toBe(10);
		expect(first.width).toBe(10);
		expect(first.height).toBe(20);
	});
});
