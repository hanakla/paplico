/**
 * Tool settings store
 * Manages current tool color and other settings
 */

import { proxy } from "valtio";
import {
	createDefaultColor,
	createStrokeBrushSettings,
} from "../document/factory";
import {
	type FillAppearance,
	generateUid,
	type StrokeAppearance,
	type TextStyle,
} from "../schema";
import {
	DEFAULT_PRESSURE_CURVE,
	type PressureCurvePoint,
} from "../utils/pressureCurve";
import type { EraserMode } from "./EraserTool";
import { createDefaultTextStyle } from "./TextTool";

export type ToolType =
	| "pen"
	| "eraser"
	| "select"
	| "path-edit"
	| "path"
	| "artboard"
	| "shape"
	| "text"
	| "gradient"
	| "mesh-deform"
	| "skew"
	| "free-transform"
	| "bucket-fill"
	| "stroke-width-edit"
	| "eyedropper"
	| "reference3d";

export type ShapeType = "rectangle" | "ellipse" | "line" | "star" | "spiral";

export type SmoothingMethod = "smooth" | "pulled-string" | "inertia";

/** Upper bound for `ToolSettings.touchDrawOffsetScale` */
export const MAX_TOUCH_DRAW_OFFSET_SCALE = 3;

/** Published by BucketFillTool when the last fill leaked. */
export interface BucketFillLeakState {
	/** Number of leak markers currently shown. */
	count: number;
	/** True when nothing enclosed the clicked point at all (blank area). */
	noBarriers: boolean;
	/** True when the fill stayed bounded but flooded an artboard background
	 *  through a gap (the leaky preview is kept on screen). */
	spill: boolean;
	/** True when sealing the found leaks yields a closed, paintable region. */
	canSealFill: boolean;
}

export interface ToolSettings {
	currentTool: ToolType;
	/** Stroke appearance (strokeColor + brushSettings). null means no stroke. */
	strokeAppearance: StrokeAppearance | null;
	/** Fill appearance (null means no fill) */
	fillAppearance: FillAppearance | null;
	/** Shape type for shape tool */
	shapeType: ShapeType;
	/** Currently selected FreeGradientStop ID in GradientTool */
	gradientSelectedStopId: string | null;
	/** Currently selected Linear/RadialGradient stop index in GradientTool */
	gradientSelectedStopIndex: number | null;
	/** Eraser width in world units (independent from brush size) */
	eraserSize: number;
	/** Eraser mode: slice (path cutting), mask (non-destructive), width-adjust (per-side width) */
	eraserMode: EraserMode;
	/** Erase across all unlocked layers instead of only the current layer */
	eraserPierceAllLayers: boolean;
	/** Stroke stabilization strength (0 = none, 1 = strong smoothing) */
	stabilization: number;
	/** Smoothing method for stroke stabilization */
	smoothingMethod: SmoothingMethod;
	/** Opacity given to newly drawn path objects (0..1) */
	opacity: number;
	/** Guide brush mode for pen tool */
	guideBrushEnabled: boolean;
	/** Pixel radius for bucket fill gap closing (0 = disabled) */
	bucketFillGapClosing: number;
	/** Color tolerance for bucket fill (0 = exact match, higher = more lenient) */
	bucketFillTolerance: number;
	/** Unbounded-fill leak state (null = last fill was bounded / no fill yet) */
	bucketFillLeaks: BucketFillLeakState | null;
	/** Eyedropper copy target flags */
	eyedropperCopyTargets: {
		stroke: boolean;
		fill: boolean;
		filters: boolean;
		appearance: boolean;
		fontStyle: boolean;
	};
	/** Default text style for new TextElements (synced from last selected TextElement) */
	textDefaultStyle: TextStyle;
	/** Default text alignment for new TextElements */
	textDefaultAlignment: "left" | "center" | "right" | "justify";
	/** Default writing mode for new TextElements */
	textDefaultWritingMode: "horizontal-tb" | "vertical-rl" | "vertical-lr";
	/** Touch-type mode in the text tool: pick chars and move/rotate/scale them */
	textCharTouchMode: boolean;
	/** Selection mode for PathEdit tool: lasso or rectangle marquee */
	pathEditSelectionMode: "lasso" | "rectangle";
	/** PathEdit tool: the next click cuts the path instead of selecting */
	pathEditCutMode: boolean;
	/** Selection mode for Select tool: lasso or rectangle marquee */
	selectSelectionMode: "lasso" | "rectangle";
	/** Selected anchor points in PathEdit tool (for ActionsPanel button enable/disable) */
	pathEditSelectedAnchors: Array<{
		pathId: string;
		segmentIndex: number;
		pointType: "start" | "end";
		isEndpoint: boolean;
	}>;
	/** Whether to auto-select the stroke after drawing (pen tool) */
	selectStrokeAfterDraw: boolean;
	/** Control points mapping raw pen pressure to effective pressure */
	pressureCurvePoints: PressureCurvePoint[];
	/**
	 * How far finger input is lifted above the contact point while drawing,
	 * as a multiplier on the reported contact width (0 = draw at the contact
	 * point). Applies to touch input on the pen and eraser tools only.
	 */
	touchDrawOffsetScale: number;
	/**
	 * Snap pen strokes to perspective-ruler directions. Default on — it only
	 * takes effect while a perspective guide source is set, so leaving it
	 * enabled is harmless otherwise.
	 */
	perspectiveSnap: boolean;
}

export function createToolSettings(): ToolSettings {
	return proxy<ToolSettings>({
		currentTool: "pen",
		strokeAppearance: {
			uid: generateUid("app"),
			processor: "stroke",
			opacity: 1,
			blendMode: "normal",
			paramData: {
				version: "1",
				params: {
					strokeColor: { type: "solid", color: createDefaultColor() },
					brushSettings: createStrokeBrushSettings(2),
				},
			},
		},
		fillAppearance: null,
		eraserSize: 10,
		eraserMode: "slice",
		eraserPierceAllLayers: false,
		stabilization: 0.5,
		smoothingMethod: "smooth",
		opacity: 1,
		shapeType: "rectangle",
		gradientSelectedStopId: null,
		gradientSelectedStopIndex: null,
		guideBrushEnabled: false,
		bucketFillGapClosing: 3,
		bucketFillTolerance: 30,
		bucketFillLeaks: null,
		eyedropperCopyTargets: {
			stroke: true,
			fill: true,
			filters: true,
			appearance: true,
			fontStyle: true,
		},
		textDefaultStyle: createDefaultTextStyle(),
		textDefaultAlignment: "left",
		textDefaultWritingMode: "horizontal-tb",
		textCharTouchMode: false,
		pathEditSelectionMode: "rectangle",
		pathEditCutMode: false,
		selectSelectionMode: "rectangle",
		pathEditSelectedAnchors: [],
		selectStrokeAfterDraw: true,
		pressureCurvePoints: [...DEFAULT_PRESSURE_CURVE],
		touchDrawOffsetScale: 1,
		perspectiveSnap: true,
	});
}
