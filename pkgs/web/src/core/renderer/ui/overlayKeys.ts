/**
 * Central registry of generic overlay channel keys.
 *
 * Keys follow the "<producer>/<role>" convention. Every overlay written
 * through `uiSetOverlay`/`setOverlayEntry` MUST use an entry from this
 * registry — add new keys here so typos and convention violations fail
 * to compile.
 */
export const OVERLAY_KEYS = {
	// Tool-owned overlays
	selectSnapLines: "select/snap-lines",
	selectMarquee: "select/marquee",
	selectExtrudeGizmo: "select/extrude-gizmo",
	artboardSnapLines: "artboard/snap-lines",
	shapeSnapLines: "shape/snap-lines",
	pathHover: "path/hover",
	pathHandles: "path/handles",
	pathSnapLines: "path/snap-lines",
	pathEditMarquee: "path-edit/marquee",
	pathEditHandles: "path-edit/handles",
	textHover: "text/hover",
	textRegionPreview: "text/region-preview",
	textFlowHandles: "text/flow-handles",
	textFlowLinkPreview: "text/flow-link-preview",
	textFlowChain: "text/flow-chain",
	textCharTouch: "text/char-touch",
	textCharTouchMarquee: "text/char-touch-marquee",
	bucketFillPreview: "bucket-fill/preview",
	meshDeformHandles: "mesh-deform/handles",
	freeTransformHandles: "free-transform/handles",
	skewHandles: "skew/handles",
	strokeWidthHandles: "stroke-width/handles",
	gradientHandles: "gradient/handles",
	reference3dGizmo: "reference3d/gizmo",
	reference3dPose: "reference3d/pose",
	reference3dCameraUi: "reference3d/camera-ui",
	reference3dEditBounds: "reference3d/edit-bounds",
	reference3dCreatePreview: "reference3d/create-preview",
	penPerspective: "pen/perspective",
	// Engine-owned (sink/adapter) overlays
	sysCursor: "sys/cursor",
	sysEraser: "sys/eraser",
	sysSelection: "sys/selection",
	sysArtboardSelection: "sys/artboard-selection",
	sysTextEdit: "sys/text-edit",
	sysTextOverflow: "sys/text-overflow",
	sysFontMissing: "sys/font-missing",
	sysPerspectiveGuides: "sys/perspective-guides",
	patternEditTile: "pattern-edit/tile",
	repeatHandles: "repeat/handles",
} as const;

/** Union of all registered overlay keys. */
export type OverlayKey = (typeof OVERLAY_KEYS)[keyof typeof OVERLAY_KEYS];
