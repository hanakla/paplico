export type RGBA = [number, number, number, number];

/**
 * Base z-order for each overlay category. Mirrors the historical UILayer
 * render call order. Primitives sort by (base z + primitive zIndex, insertion
 * order) before lowering to GPU instances.
 */
export const OVERLAY_Z = {
	artboard: 0,
	selection: 10,
	pathEdit: 20,
	toolCursor: 30,
	eraser: 40,
	marquee: 50,
	hover: 60,
	/** Perspective ruler guides (horizon, vanishing points, pen radial lines). */
	perspectiveGuide: 65,
	snapLine: 70,
	gradient: 80,
	meshDeform: 90,
	patternEdit: 100,
	strokeWidthEdit: 110,
	textEdit: 120,
	/** Text flow handles (■) and link preview */
	textFlow: 122,
	/** Touch-type char quads and transform handles */
	textCharTouch: 123,
	/** Touch-type drag-to-select marquee rectangle */
	textCharTouchMarquee: 124,
	/** Text overflow badge (red …) */
	textOverflow: 125,
	bucketFill: 130,
	/** Default base z for generic `UIOverlayState.overlays` entries. */
	default: 140,
} as const;

/**
 * Centralized theme for the GPU overlay UI (UILayer and tool overlays).
 * All sizes are screen pixels; usage sites divide by zoom for world units.
 */
export const UI_THEME = {
	// --- Stroke Width (screen pixels) ---
	strokeWidth: {
		/** Default stroke width for UI outlines */
		default: 1.5,
		/** Stroke width for selection/hover bezier path outlines */
		path: 2.0,
		/** Stroke width for white mesh vertex outlines */
		meshVertexOutline: 2.5,
		/** Stroke width for the linear-gradient axis line */
		gradientAxis: 4,
	},
	// --- Handle sizes (screen pixels) ---
	handleSize: {
		/** Selection bounding-box handle edge length */
		selection: 8,
		/** Artboard resize handle edge length */
		artboard: 8,
		/** Path-edit control point handle size */
		pathEdit: 10,
		/** Gradient handle base size */
		gradient: 10,
		/** Mesh deform handle radius */
		meshDeformRadius: 5,
		/** Stroke-width-edit handle radius */
		strokeWidthEditRadius: 4,
		/** Ring outset around a selected handle */
		selectionRingOffset: 2,
	},
	/** Unified hit-test tolerance in screen pixels (for future hit-test consolidation) */
	hitTolerancePx: 8,
	// --- Dash patterns (screen pixels) ---
	dash: {
		/** Selection bounding box of container-like elements (mesh warp) */
		selectionBounds: { length: 4, gap: 3 },
	},
	colors: {
		// --- Shared ---
		white: rgba(1, 1, 1, 1),
		// --- Marquee ---
		marqueeFill: rgba(0.2, 0.5, 1.0, 0.15),
		marqueeOutline: rgba(0.2, 0.5, 1.0, 0.8),
		// --- Hover ---
		hover: rgba(0.2, 0.6, 1.0, 0.6),
		// --- Snap Line ---
		snapLine: rgba(1.0, 0.2, 0.5, 0.9),
		// --- Artboard ---
		artboardOutline: rgba(0.4, 0.4, 0.4, 0.8),
		artboardSelected: rgba(0.2, 0.6, 1.0, 1.0),
		// --- Selection ---
		selectionPath: rgba(0.2, 0.5, 1.0, 1.0),
		selectionBounds: rgba(0, 0.5, 1, 1),
		/** Key object (alignment reference) outline — orange to stand apart from
		 *  the blue selection outlines. */
		selectionKeyPath: rgba(1.0, 0.5, 0.0, 1.0),
		/** Touch-type selected-char quad face (whole face is draggable) */
		charTouchQuadFill: rgba(0, 0.5, 1, 0.12),
		// --- Path Edit ---
		pathHandleLine: rgba(0.6, 0.6, 0.6, 0.8),
		pathSuperellipseFillSelected: rgba(1.0, 0.6, 0.0, 1.0),
		pathSuperellipseFill: rgba(1.0, 1.0, 1.0, 1.0),
		pathSuperellipseOutlineSelected: rgba(0.8, 0.4, 0.0, 1.0),
		pathSuperellipseOutline: rgba(0.8, 0.5, 0.0, 1.0),
		pathCornerRadiusFillSelected: rgba(0.2, 0.8, 0.4, 1.0),
		pathCornerRadiusFill: rgba(1.0, 1.0, 1.0, 1.0),
		pathCornerRadiusOutlineSelected: rgba(0.1, 0.6, 0.2, 1.0),
		pathCornerRadiusOutline: rgba(0.2, 0.7, 0.3, 1.0),
		pathControlFillSelected: rgba(1.0, 0.5, 0.2, 1.0),
		pathControlFill: rgba(1.0, 1.0, 1.0, 1.0),
		pathControlOutlineSelected: rgba(1.0, 0.3, 0.0, 1.0),
		pathControlOutline: rgba(0.4, 0.7, 1.0, 1.0),
		pathAnchorFillSelected: rgba(1.0, 0.5, 0.2, 1.0),
		pathAnchorFill: rgba(1.0, 1.0, 1.0, 1.0),
		pathAnchorOutlineSelected: rgba(1.0, 0.3, 0.0, 1.0),
		pathAnchorOutline: rgba(0.2, 0.4, 1.0, 1.0),
		pathLongPressRing: rgba(1.0, 0.3, 0.3, 0.8),
		// --- Gradient (UILayer) ---
		gradientSelectionRing: rgba(0.23, 0.51, 0.96, 1),
		gradientOutlineStart: rgba(0.23, 0.51, 0.96, 1),
		gradientOutlineEnd: rgba(0.94, 0.27, 0.27, 1),
		gradientOutlineDefault: rgba(1, 1, 1, 1),
		// --- Gradient (GradientTool) ---
		gradientLine: rgba(0.39, 0.39, 1, 0.6),
		gradientStopConnection: rgba(0.59, 0.59, 0.59, 0.5),
		gradientLinearStartHandle: rgba(1, 1, 1, 1),
		gradientLinearEndHandle: rgba(1, 1, 1, 1),
		gradientRadialCenterHandle: rgba(1, 1, 1, 1),
		gradientRadialXHandle: rgba(1, 0.5, 0.5, 1),
		gradientRadialYHandle: rgba(0.5, 1, 0.5, 1),
		gradientRadialRotationHandle: rgba(0.5, 0.5, 1, 1),
		gradientFreeCp: rgba(0.23, 0.51, 0.96, 1),
		// --- Mesh Deform ---
		meshBounds: rgba(0.5, 0.5, 0.5, 0.3),
		meshEdge: rgba(0.4, 0.7, 1.0, 0.4),
		meshHandleRing: rgba(1.0, 0.5, 0.0, 1.0),
		meshHandleFillSelected: rgba(1.0, 0.8, 0.3, 1.0),
		meshHandleFill: rgba(1.0, 1.0, 1.0, 1.0),
		meshHandleOutline: rgba(0.2, 0.5, 1.0, 1.0),
		meshLasso: rgba(0.2, 0.8, 1.0, 0.7),
		meshLongPressRing: rgba(1.0, 0.3, 0.3, 0.8),
		// --- PathEdit Lasso ---
		pathEditLassoStroke: rgba(0.2, 0.5, 1.0, 0.8),
		pathEditLassoFill: rgba(0.2, 0.5, 1.0, 0.12),
		// --- Eraser ---
		eraserPreview: rgba(1, 0.3, 0.3, 0.8),
		eraserCursor: rgba(1, 1, 1, 0.6),
		eraserCursorOutline: rgba(0, 0, 0, 0.4),
		// --- Tool cursor (picked color preview) ---
		colorPickerPreviewShadow: rgba(0.5, 0.5, 0.5, 0.4),
		colorPickerPreviewOutline: rgba(1, 1, 1, 0.9),
		// --- Stroke Width Edit ---
		strokeWidthEnvelopeSide1: rgba(0.2, 0.8, 0.3, 0.5),
		strokeWidthEnvelopeSide2: rgba(0.3, 0.5, 1.0, 0.5),
		strokeWidthHandleSide1: rgba(0.2, 0.8, 0.3, 1.0),
		strokeWidthHandleSide2: rgba(0.3, 0.5, 1.0, 1.0),
		strokeWidthSelectionRing: rgba(1.0, 0.6, 0.0, 1.0),
		// --- Text Edit ---
		textSelection: rgba(0.25, 0.46, 0.93, 0.3),
		textCompositionUnderline: rgba(0.92, 0.69, 0.15, 1),
		// --- Text flow / overflow ---
		textOverflowBadge: rgba(0.85, 0.15, 0.15, 0.9),
		textFlowCandidate: rgba(0, 0.5, 1, 0.3),
		textFlowChain: rgba(0, 0.5, 1, 0.75),
		// --- Bucket Fill ---
		bucketFillCutPath: rgba(1.0, 0.6, 0.0, 0.9),
		bucketFillLeakMarker: rgba(1.0, 0.2, 0.2, 0.95),
		// --- Reference3D gizmo ---
		reference3dAxisX: rgba(0.92, 0.26, 0.31, 1.0),
		reference3dAxisY: rgba(0.35, 0.8, 0.36, 1.0),
		reference3dAxisZ: rgba(0.27, 0.52, 0.95, 1.0),
		reference3dPlaneFill: rgba(1.0, 1.0, 1.0, 0.9),
		reference3dPlaneOutline: rgba(0.35, 0.35, 0.35, 1.0),
		reference3dBoneFill: rgba(1.0, 1.0, 1.0, 0.95),
		reference3dBoneOutline: rgba(0.85, 0.35, 0.65, 1.0),
		reference3dHandleHover: rgba(1.0, 0.85, 0.2, 1.0),
		// --- Perspective ruler ---
		perspectiveHorizon: rgba(0.2, 0.7, 0.9, 0.7),
		perspectiveVp: rgba(0.2, 0.7, 0.9, 1.0),
		perspectiveRadial: rgba(0.2, 0.7, 0.9, 0.35),
	},
} as const;

export type UITheme = typeof UI_THEME;

function rgba(r: number, g: number, b: number, a: number): RGBA {
	return Object.freeze([r, g, b, a]) as RGBA;
}
