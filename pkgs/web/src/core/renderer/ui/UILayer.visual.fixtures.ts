import type { Artboard, BoundingBox } from "../../schema";
import {
	toWorld,
	type WorldBezierSegment,
} from "../../utils/geometry/geometry";
import type { UIOverlayState } from "../types";
import { buildArtboardOverlay } from "./builders/artboard";
import { buildBucketFillOverlay } from "./builders/bucketFill";
import { buildEraserOverlay } from "./builders/eraser";
import { buildGradientOverlay } from "./builders/gradient";
import { buildHoverOverlay } from "./builders/hover";
import { buildMarqueeOverlay } from "./builders/marquee";
import { buildMeshDeformOverlay } from "./builders/meshDeform";
import { buildPathEditOverlay } from "./builders/pathEdit";
import { buildPatternEditOverlay } from "./builders/patternEdit";
import { buildSelectionOverlay } from "./builders/selection";
import { buildSnapLineOverlay } from "./builders/snapLine";
import { buildStrokeWidthEditOverlay } from "./builders/strokeWidthEdit";
import { buildTextEditOverlay } from "./builders/textEdit";
import { buildToolCursorOverlay } from "./builders/toolCursor";
import type { OverlayKey } from "./overlayKeys";
import type { UIPrimitive } from "./primitives";
import { OVERLAY_Z, UI_THEME } from "./theme";
import type {
	ArtboardSelectionUIData,
	BucketFillUIData,
	ControlPointHandle,
	EraserToolUIData,
	GradientEditUIData,
	HoverUIData,
	MarqueeSelectionUIData,
	MeshDeformUIData,
	PathEditUIData,
	PatternEditUIData,
	SelectionUIData,
	SnapLineUIData,
	StrokeWidthEditUIData,
	TextEditUIData,
	ToolCursorUIData,
} from "./types";

/**
 * Deterministic UIOverlayState fixtures for UILayer visual regression tests.
 * One fixture per overlay builder (fed through the generic `overlays` channel
 * at its historical base z) plus the raw generic-channel fixture. All
 * coordinates are world-space and kept within x∈[-180,180], y∈[-130,130] so
 * every overlay is visible on an 800×600 canvas at both zoom 1 and zoom 2
 * (viewport centered at origin).
 */
export interface UIOverlayFixture {
	/** Baseline file name suffix (ui-overlay-<name>-zoom<z>.png) */
	name: string;
	state: UIOverlayState;
	artboards?: Artboard[];
}

export const TEST_ARTBOARDS: Artboard[] = [
	{
		id: "artboard-1",
		name: "Artboard 1",
		x: -60,
		y: 10,
		width: 200,
		height: 150,
	},
	{
		id: "artboard-2",
		name: "Artboard 2",
		x: 120,
		y: -60,
		width: 100,
		height: 80,
	},
];

/** Typed overlay source data per fixture (also consumed by builders.test.ts). */
export const UI_FIXTURE_DATA: {
	selection: SelectionUIData;
	pathEdit: PathEditUIData;
	toolCursor: ToolCursorUIData;
	eraserTool: EraserToolUIData;
	marquee: MarqueeSelectionUIData;
	artboardSelection: ArtboardSelectionUIData;
	hover: HoverUIData;
	snapLine: SnapLineUIData;
	gradientEdit: GradientEditUIData;
	meshDeform: MeshDeformUIData;
	patternEdit: PatternEditUIData;
	strokeWidthEdit: StrokeWidthEditUIData;
	textEdit: TextEditUIData;
	bucketFill: BucketFillUIData;
} = {
	selection: {
		bounds: bbox(-120, -70, 120, 70),
		rotation: 0,
		rotationCenter: { x: 0, y: 0 },
		handles: boundsHandles(bbox(-120, -70, 120, 70)),
		rotationHandle: { x: 0, y: 94 },
		pathSegments: [
			[
				wseg([-100, 0], [-100, 55], [100, 55], [100, 0]),
				wseg(null, [100, -55], [-100, -55], [-100, 0]),
			],
		],
	},
	pathEdit: {
		paths: [
			{
				pathId: "path-1",
				controlPoints: [
					cp("anchor", 0, "start", -140, -40, true),
					cp("control", 0, "cp1", -100, 60, false),
					cp("control", 0, "cp2", -20, 60, false),
					cp("anchor", 0, "end", 20, -20, false),
					cp("control", 1, "cp1", 60, -70, false),
					cp("control", 1, "cp2", 120, -40, false),
					cp("anchor", 1, "end", 140, 40, false),
					cp("corner-radius", 0, "corner-radius", -60, -90, false),
					cp(
						"corner-superellipse-k",
						1,
						"corner-superellipse-k",
						0,
						-110,
						true,
					),
				],
				segments: [
					{
						start: { x: -140, y: -40 },
						cp1: { x: -100, y: 60 },
						cp2: { x: -20, y: 60 },
						end: { x: 20, y: -20 },
					},
					{
						cp1: { x: 60, y: -70 },
						cp2: { x: 120, y: -40 },
						end: { x: 140, y: 40 },
					},
				],
			},
		],
		additionalOutlines: [[wseg([-160, 90], [-120, 120], [-40, 120], [0, 90])]],
		longPressRing: { worldX: -140, worldY: 100 },
		lassoPath: [
			{ x: 60, y: 60 },
			{ x: 150, y: 70 },
			{ x: 160, y: 120 },
			{ x: 80, y: 110 },
		],
	},
	toolCursor: {
		worldX: 0,
		worldY: -60,
		radius: 32,
		color: [0.2, 0.2, 0.2, 0.9],
		pickedColor: [0.85, 0.3, 0.2, 1],
	},
	eraserTool: {
		worldX: -40,
		worldY: 20,
		radius: 48,
		color: [1, 1, 1, 0.9],
	},
	marquee: { startX: -130, startY: -90, endX: 70, endY: 50 },
	artboardSelection: {
		bounds: bbox(-160, -65, 40, 85),
		handles: boundsHandles(bbox(-160, -65, 40, 85)),
	},
	hover: {
		pathSegments: [
			[wseg([-120, -20], [-60, 80], [40, -90], [120, 30])],
			[wseg([-100, -90], [-60, -50], [20, -120], [80, -70])],
		],
	},
	snapLine: {
		lines: [
			{ axis: "vertical", position: -80, extentMin: -240, extentMax: 240 },
			{
				axis: "horizontal",
				position: 40,
				extentMin: -320,
				extentMax: 320,
			},
		],
	},
	gradientEdit: {
		handles: [
			{
				id: "g-start",
				worldX: -140,
				worldY: -60,
				handleType: "linear-start",
				color: [0.1, 0.4, 0.9, 1],
				selected: false,
			},
			{
				id: "g-stop-1",
				worldX: -60,
				worldY: -20,
				handleType: "linear-stop",
				color: [0.5, 0.2, 0.8, 1],
				selected: true,
			},
			{
				id: "g-stop-2",
				worldX: 20,
				worldY: 20,
				handleType: "linear-stop",
				color: [0.9, 0.6, 0.1, 1],
				selected: false,
			},
			{
				id: "g-end",
				worldX: 100,
				worldY: 60,
				handleType: "linear-end",
				color: [0.9, 0.1, 0.2, 1],
				selected: false,
			},
			{
				id: "m-v1",
				worldX: -120,
				worldY: 90,
				handleType: "mesh-vertex",
				color: [0.2, 0.8, 0.4, 1],
				selected: true,
			},
			{
				id: "m-v2",
				worldX: -40,
				worldY: 110,
				handleType: "mesh-vertex",
				color: [1, 1, 1, 1],
				selected: false,
				isDerived: true,
			},
			{
				id: "m-cp1",
				worldX: -80,
				worldY: 70,
				handleType: "mesh-cp",
				color: [1, 1, 1, 1],
				selected: false,
			},
			{
				id: "f-cp",
				worldX: 140,
				worldY: -90,
				handleType: "free-cp",
				color: [1, 1, 1, 1],
				selected: false,
			},
		],
		lines: [{ x1: -140, y1: -60, x2: 100, y2: 60, color: [1, 1, 1, 0.9] }],
		circles: [{ cx: 60, cy: -70, radius: 40, color: [1, 1, 1, 0.8] }],
		ellipses: [
			{
				centerX: -40,
				centerY: -95,
				radiusX: 60,
				radiusY: 25,
				rotation: 0.4,
				color: [1, 1, 1, 0.8],
			},
		],
		bezierEdges: [
			{
				start: { x: -120, y: 90 },
				cp1: { x: -100, y: 105 },
				cp2: { x: -60, y: 108 },
				end: { x: -40, y: 110 },
				boundary: true,
				highlighted: false,
			},
			{
				start: { x: -120, y: 90 },
				cp1: { x: -130, y: 60 },
				cp2: { x: -110, y: 40 },
				end: { x: -90, y: 30 },
				boundary: false,
				highlighted: true,
			},
		],
	},
	meshDeform: {
		originalBounds: bbox(-120, -80, 80, 60),
		edges: [
			// Horizontal edges (3×3 deformed grid)
			{ x1: -120, y1: -80, x2: -20, y2: -85 },
			{ x1: -20, y1: -85, x2: 80, y2: -80 },
			{ x1: -125, y1: -10, x2: -10, y2: 0 },
			{ x1: -10, y1: 0, x2: 85, y2: -10 },
			{ x1: -120, y1: 60, x2: -20, y2: 72 },
			{ x1: -20, y1: 72, x2: 80, y2: 60 },
			// Vertical edges
			{ x1: -120, y1: -80, x2: -125, y2: -10 },
			{ x1: -20, y1: -85, x2: -10, y2: 0 },
			{ x1: 80, y1: -80, x2: 85, y2: -10 },
			{ x1: -125, y1: -10, x2: -120, y2: 60 },
			{ x1: -10, y1: 0, x2: -20, y2: 72 },
			{ x1: 85, y1: -10, x2: 80, y2: 60 },
			// Diagonals
			{ x1: -120, y1: -80, x2: -10, y2: 0 },
			{ x1: -10, y1: 0, x2: 80, y2: -80 },
			{ x1: -125, y1: -10, x2: -20, y2: 72 },
			{ x1: -10, y1: 0, x2: 80, y2: 60 },
		],
		handles: [
			{
				id: "h-1",
				originalX: -120,
				originalY: -80,
				currentX: -120,
				currentY: -80,
				selected: false,
			},
			{
				id: "h-2",
				originalX: -20,
				originalY: -80,
				currentX: -20,
				currentY: -85,
				selected: true,
			},
			{
				id: "h-3",
				originalX: 80,
				originalY: 60,
				currentX: 80,
				currentY: 60,
				selected: false,
			},
			{
				id: "h-4",
				originalX: -10,
				originalY: -5,
				currentX: -10,
				currentY: 0,
				selected: false,
			},
		],
		lassoPath: [
			{ x: 100, y: 80 },
			{ x: 160, y: 90 },
			{ x: 170, y: 125 },
			{ x: 110, y: 115 },
		],
		longPressRing: { worldX: 140, worldY: -60 },
	},
	patternEdit: {
		centerX: -10,
		centerY: 5,
		tileWidth: 180,
		tileHeight: 140,
	},
	strokeWidthEdit: {
		pathSegments: [
			{
				start: { x: -140, y: 0 },
				cp1: { x: -70, y: 80 },
				cp2: { x: 30, y: -80 },
				end: { x: 130, y: 10 },
			},
		],
		handles: [
			{
				pointIndex: -1,
				side: "side1",
				worldX: -140,
				worldY: 20,
				selected: false,
			},
			{
				pointIndex: -1,
				side: "side2",
				worldX: -140,
				worldY: -20,
				selected: false,
			},
			{
				pointIndex: -2,
				side: "side1",
				worldX: 130,
				worldY: 30,
				selected: true,
			},
			{
				pointIndex: -2,
				side: "side2",
				worldX: 130,
				worldY: -10,
				selected: false,
			},
		],
		centerHandles: [
			{
				pointIndex: -1,
				worldX: -140,
				worldY: 0,
				selected: false,
				fixed: true,
			},
			{
				pointIndex: -2,
				worldX: 130,
				worldY: 10,
				selected: false,
				fixed: true,
			},
		],
		crossLines: [
			{ x1: -140, y1: 20, x2: -140, y2: -20 },
			{ x1: 130, y1: 30, x2: 130, y2: -10 },
		],
		// Interleaved: even index = side1, odd index = side2
		envelopeLines: [
			{ x1: -140, y1: 20, x2: -70, y2: 45 },
			{ x1: -140, y1: -20, x2: -70, y2: 5 },
			{ x1: -70, y1: 45, x2: 30, y2: -35 },
			{ x1: -70, y1: 5, x2: 30, y2: -75 },
			{ x1: 30, y1: -35, x2: 130, y2: 30 },
			{ x1: 30, y1: -75, x2: 130, y2: -10 },
		],
	},
	textEdit: {
		// Blink state fixed to visible for determinism
		cursor: {
			x: -80,
			y: -20,
			height: 44,
			visible: true,
			writingMode: "horizontal-tb",
			rotation: 0,
		},
		selectionRects: [
			{ x: -80, y: -20, width: 120, height: 44, rotation: 0 },
			{ x: -80, y: -70, width: 90, height: 40, rotation: 0.25 },
		],
		compositionUnderline: { x: 60, y: 40, width: 80, rotation: 0 },
	},
	bucketFill: {
		cutPaths: [
			[
				{ x: -140, y: -60 },
				{ x: -70, y: -10 },
				{ x: -10, y: -50 },
			],
			[
				{ x: 20, y: 70 },
				{ x: 90, y: 40 },
				{ x: 150, y: 75 },
			],
		],
		activeCutPath: [
			{ x: -60, y: 80 },
			{ x: 10, y: 110 },
			{ x: 80, y: 95 },
		],
		gapBarrierSegments: [{ x1: -120, y1: 60, x2: -60, y2: 60 }],
	},
};

export const UI_OVERLAY_FIXTURES: UIOverlayFixture[] = [
	{
		name: "selection",
		state: overlayState(
			"selection",
			OVERLAY_Z.selection,
			buildSelectionOverlay(UI_FIXTURE_DATA.selection, UI_THEME),
		),
	},
	{
		name: "path-edit",
		state: overlayState(
			"path-edit",
			OVERLAY_Z.pathEdit,
			buildPathEditOverlay(UI_FIXTURE_DATA.pathEdit, UI_THEME),
		),
	},
	{
		name: "tool-cursor",
		state: overlayState(
			"tool-cursor",
			OVERLAY_Z.toolCursor,
			buildToolCursorOverlay(UI_FIXTURE_DATA.toolCursor, UI_THEME),
		),
	},
	{
		name: "eraser-tool",
		state: overlayState(
			"eraser-tool",
			OVERLAY_Z.eraser,
			buildEraserOverlay(UI_FIXTURE_DATA.eraserTool, UI_THEME),
		),
	},
	{
		name: "marquee",
		state: overlayState(
			"marquee",
			OVERLAY_Z.marquee,
			buildMarqueeOverlay(UI_FIXTURE_DATA.marquee, UI_THEME),
		),
	},
	{
		name: "artboard-edit-mode",
		state: { isArtboardEditMode: true },
		artboards: TEST_ARTBOARDS,
	},
	{
		name: "artboard-selection",
		state: {
			isArtboardEditMode: true,
			...overlayState(
				"artboard-selection",
				OVERLAY_Z.artboard,
				buildArtboardOverlay([], UI_FIXTURE_DATA.artboardSelection, UI_THEME),
			),
		},
		artboards: TEST_ARTBOARDS,
	},
	{
		name: "hover",
		state: overlayState(
			"hover",
			OVERLAY_Z.hover,
			buildHoverOverlay(UI_FIXTURE_DATA.hover, UI_THEME),
		),
	},
	{
		name: "snap-line",
		state: overlayState(
			"snap-line",
			OVERLAY_Z.snapLine,
			buildSnapLineOverlay(UI_FIXTURE_DATA.snapLine, UI_THEME),
		),
	},
	{
		name: "gradient-edit",
		state: overlayState(
			"gradient-edit",
			OVERLAY_Z.gradient,
			buildGradientOverlay(UI_FIXTURE_DATA.gradientEdit, UI_THEME),
		),
	},
	{
		name: "mesh-deform",
		state: overlayState(
			"mesh-deform",
			OVERLAY_Z.meshDeform,
			buildMeshDeformOverlay(UI_FIXTURE_DATA.meshDeform, UI_THEME),
		),
	},
	{
		name: "pattern-edit",
		state: overlayState(
			"pattern-edit",
			OVERLAY_Z.patternEdit,
			buildPatternEditOverlay(UI_FIXTURE_DATA.patternEdit, UI_THEME),
		),
	},
	{
		name: "stroke-width-edit",
		state: overlayState(
			"stroke-width-edit",
			OVERLAY_Z.strokeWidthEdit,
			buildStrokeWidthEditOverlay(UI_FIXTURE_DATA.strokeWidthEdit, UI_THEME),
		),
	},
	{
		name: "text-edit",
		state: overlayState(
			"text-edit",
			OVERLAY_Z.textEdit,
			buildTextEditOverlay(UI_FIXTURE_DATA.textEdit, UI_THEME),
		),
	},
	{
		name: "bucket-fill",
		state: overlayState(
			"bucket-fill",
			OVERLAY_Z.bucketFill,
			buildBucketFillOverlay(UI_FIXTURE_DATA.bucketFill, UI_THEME),
		),
	},
	{
		name: "generic-overlay",
		state: {
			overlays: {
				// Synthetic test-only key; production keys come from OVERLAY_KEYS.
				["generic-tool" as OverlayKey]: {
					primitives: [
						{
							kind: "circle",
							cx: -100,
							cy: 40,
							radius: 36,
							fill: { color: [0.2, 0.5, 1, 0.2] },
							stroke: { color: [0.2, 0.5, 1, 1], width: 2 },
							hitId: "circle-1",
						},
						{
							kind: "arrow",
							x1: -40,
							y1: -70,
							x2: 90,
							y2: -20,
							color: [0.9, 0.3, 0.2, 1],
							width: 3,
							headLength: 18,
							headWidth: 14,
						},
						{
							kind: "arc",
							cx: 60,
							cy: 60,
							radiusX: 44,
							startAngle: Math.PI / 6,
							endAngle: (Math.PI * 4) / 3,
							stroke: { color: [0.1, 0.7, 0.4, 1], width: 2.5 },
						},
						{
							kind: "polyline",
							points: [
								{ x: -150, y: -90 },
								{ x: -90, y: -40 },
								{ x: -30, y: -100 },
								{ x: 30, y: -60 },
							],
							stroke: { color: [0.8, 0.6, 0.1, 1], width: 2 },
							hitId: "polyline-1",
						},
						// hitOnly: hit-testable but must never appear in the image.
						// Bright magenta over the canvas center makes an accidental
						// render an unmistakable VRT failure.
						{
							kind: "rect",
							cx: 0,
							cy: 0,
							width: 240,
							height: 160,
							fill: { color: [1, 0, 1, 1] },
							stroke: { color: [1, 0, 1, 1], width: 6 },
							hitOnly: true,
							hitId: "hit-only-rect",
						},
					],
				},
			},
		},
	},
];

/** Wrap pre-built primitives as a single-entry generic overlays channel. */
function overlayState(
	key: string,
	zIndex: number,
	primitives: UIPrimitive[],
): UIOverlayState {
	return { overlays: { [key]: { zIndex, primitives } } };
}

function bbox(
	minX: number,
	minY: number,
	maxX: number,
	maxY: number,
): BoundingBox {
	return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

/** Build the 8 resize handles for a bounding box ("n" = maxY, Y-axis up). */
function boundsHandles(b: BoundingBox): SelectionUIData["handles"] {
	const cx = (b.minX + b.maxX) / 2;
	const cy = (b.minY + b.maxY) / 2;
	return [
		{ x: b.minX, y: b.maxY, position: "nw" },
		{ x: cx, y: b.maxY, position: "n" },
		{ x: b.maxX, y: b.maxY, position: "ne" },
		{ x: b.maxX, y: cy, position: "e" },
		{ x: b.maxX, y: b.minY, position: "se" },
		{ x: cx, y: b.minY, position: "s" },
		{ x: b.minX, y: b.minY, position: "sw" },
		{ x: b.minX, y: cy, position: "w" },
	];
}

/** Build a WorldBezierSegment from raw [x, y] tuples. */
function wseg(
	start: [number, number] | null,
	cp1: [number, number],
	cp2: [number, number],
	end: [number, number],
): WorldBezierSegment {
	return {
		...(start ? { start: toWorld(start[0], start[1]) } : {}),
		cp1: toWorld(cp1[0], cp1[1]),
		cp2: toWorld(cp2[0], cp2[1]),
		end: toWorld(end[0], end[1]),
	};
}

/** Build a ControlPointHandle (screen coords derived for zoom 1, unused by UILayer). */
function cp(
	type: ControlPointHandle["type"],
	segmentIndex: number,
	pointType: ControlPointHandle["pointType"],
	worldX: number,
	worldY: number,
	selected: boolean,
): ControlPointHandle {
	return {
		type,
		pathId: "path-1",
		segmentIndex,
		pointType,
		worldX,
		worldY,
		screenX: 400 + worldX,
		screenY: 300 - worldY,
		selected,
	};
}
