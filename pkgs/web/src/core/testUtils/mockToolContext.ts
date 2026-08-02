import { type Mock, vi } from "vitest";
import type { PaplicoCommands } from "../PaplicoCommands";
import { hitTestOverlays } from "../renderer/ui/hitTest";
import type { OverlayKey } from "../renderer/ui/overlayKeys";
import type { UIOverlay } from "../renderer/ui/primitives";
import { ToolContext, type ToolContextOptions } from "../tools/ToolContext";
import {
	testCanvasHeight,
	testCanvasWidth,
	testViewport,
} from "./pointerEvent";

/** ToolContext with all function properties typed as vitest Mock instances */
export type MockToolContext = {
	[K in keyof ToolContextOptions]: ToolContextOptions[K] extends (
		...args: infer A
	) => infer R
		? Mock<(...args: A) => R>
		: ToolContextOptions[K];
} & ToolContext & { mockCommands: MockCommands };

export type MockCommands = {
	deleteElements: Mock;
	addPaths: Mock;
	addPathsToGroup: Mock;
	updateElement: Mock;
	addEraseMask: Mock;
	updateRepeatGrid: Mock;
	updateRepeatRadial: Mock;
};

export function createMockToolContext(
	overrides: Partial<ToolContextOptions> = {},
): MockToolContext {
	const mockCommands: MockCommands = {
		deleteElements: vi.fn(),
		addPaths: vi.fn(),
		addPathsToGroup: vi.fn(),
		updateElement: vi.fn(),
		addEraseMask: vi.fn(),
		updateRepeatGrid: vi.fn(),
		updateRepeatRadial: vi.fn(),
	};

	// Working generic-overlay store: uiSetOverlay records into it and uiHitTest
	// runs the real hit test against it (testViewport / 800×600 coordinates),
	// so tools that hit-test their own overlays behave as in production.
	const overlays: Record<string, UIOverlay> = {};

	const base: ToolContextOptions = {
		textToolController: null,
		reference3dController: null,

		strokeComplete: vi.fn(),
		previewUpdate: vi.fn(),
		textPreviewUpdate: vi.fn(),

		eraseElement: vi.fn(),
		addEraseMask: vi.fn(),
		updateElement: vi.fn(),
		addPaths: vi.fn(),
		transact: vi.fn((fn: (commands: PaplicoCommands) => void) => {
			const proxy = new Proxy(mockCommands, {
				get(target, prop) {
					if (prop in target) return target[prop as keyof MockCommands];
					throw new Error(`MockCommands: "${String(prop)}" is not mocked`);
				},
			}) as unknown as PaplicoCommands;
			fn(proxy);
		}),
		getCurrentLayer: vi.fn(() => null),
		getLayers: vi.fn(() => []),
		getObjects: vi.fn(() => ({})),

		elementSelect: vi.fn(),
		elementToggleSelect: vi.fn(),
		elementMove: vi.fn(),
		elementsMove: vi.fn(),
		elementResize: vi.fn(),
		elementsResize: vi.fn(),
		elementRotate: vi.fn(),
		elementsRotate: vi.fn(),
		uiUpdateSelectionUI: vi.fn(),
		selectionSelectMultiple: vi.fn(),
		selectionClear: vi.fn(),
		uiRefreshSelectionUI: vi.fn(),
		getSelectedElementIds: vi.fn(() => []),
		setKeyObject: vi.fn(),
		getKeyObjectId: vi.fn(() => null),
		findElementAtPoint: vi.fn(() => null),
		findElementsInRect: vi.fn(() => []),
		enterEditingScope: vi.fn(),
		exitEditingScopeOneLevel: vi.fn(),
		getEditingScopeId: vi.fn(() => null),
		isElementEditable: vi.fn(() => true),
		isElementLocked: vi.fn(() => false),
		isCurrentLayerLocked: vi.fn(() => false),
		isReadonly: vi.fn(() => false),
		getElement: vi.fn(() => null),
		getBounds: vi.fn(() => null),
		getElementWorldSegments: vi.fn(() => null),
		getAncestorTransform: vi.fn(() => null),
		updateSelectedElementFilter: vi.fn(),
		addElementToLayer: vi.fn(),
		addObjectToDocument: vi.fn(),
		duplicateElementsByIds: vi.fn(() => []),
		textEdit: vi.fn(),
		reference3dEdit: vi.fn(),
		reference3dExitEdit: vi.fn(),
		reference3dCreate: vi.fn(() => null),
		reference3dGetDef: vi.fn(() => null),
		reference3dAddNode: vi.fn(),
		reference3dCommitNode: vi.fn(),
		reference3dPreviewCamera: vi.fn(),
		reference3dPreviewNodes: vi.fn(),
		reference3dRaycastNode: vi.fn(() => null),
		reference3dSetGuideSource: vi.fn(),
		getPerspectiveGuides: vi.fn(() => null),
		reference3dGetFigureRig: vi.fn(() => null),
		snapElements: vi.fn(
			(
				_movingElementIds,
				_originalBounds,
				proposedDeltaX: number,
				proposedDeltaY: number,
			) => ({
				deltaX: proposedDeltaX,
				deltaY: proposedDeltaY,
				snapLines: [],
			}),
		),

		pathSelect: vi.fn(),
		pathUpdate: vi.fn(),
		batchPathUpdate: vi.fn(),
		previewSegments: vi.fn(),
		findPathAtPoint: vi.fn(() => null),
		replacePathWithPaths: vi.fn(),
		getPathById: vi.fn(() => null),
		getAllEditablePaths: vi.fn(() => []),

		artboardCreate: vi.fn(),
		artboardSelect: vi.fn(),
		artboardUpdate: vi.fn(),
		getArtboards: vi.fn(() => []),
		getSelectedArtboardId: vi.fn(() => null),
		findArtboardAtPoint: vi.fn(() => null),
		snapArtboard: vi.fn((_id, _bounds, dx: number, dy: number) => ({
			deltaX: dx,
			deltaY: dy,
			snapLines: [],
		})),
		snapArtboardToElements: vi.fn((_bounds, _zoom) => ({
			deltaX: 0,
			deltaY: 0,
			snapLines: [],
		})),
		findElementsOnArtboard: vi.fn(() => []),
		artboardMoveCommit: vi.fn(),

		pathDraftCreate: vi.fn(),
		pathDraftUpdate: vi.fn(),
		pathDraftDelete: vi.fn(),
		pathComplete: vi.fn(),

		shapeComplete: vi.fn(),

		textCreate: vi.fn(),
		textComplete: vi.fn(),
		textDelete: vi.fn(),
		editStart: vi.fn(),
		editEnd: vi.fn(),
		findTextAtPoint: vi.fn(() => null),
		updateTextCursor: vi.fn(),
		selectionStyleChange: vi.fn(),
		selectionRangeChange: vi.fn(),
		getCursorWorldPosition: vi.fn(async () => ({
			x: 0,
			y: 0,
			height: 0,
		})),
		hitTestCharacter: vi.fn(async () => null),
		getLineNavigationTarget: vi.fn(async () => null),
		getLineStartEnd: vi.fn(async () => null),
		persistTextEdit: vi.fn(),
		textCreateOnPath: vi.fn(),
		textFlowLink: vi.fn(),
		textFlowUnlink: vi.fn(),
		textFindFlowSource: vi.fn(() => null),
		listTextElements: vi.fn(() => []),
		textChainMembers: vi.fn(() => []),
		hitTestTextGlyph: vi.fn(async () => null),
		getTextGlyphQuads: vi.fn(async () => ({
			quads: [],
			elementTransform: { rotation: 0, scaleX: 1, scaleY: 1 },
		})),
		textCharTouchCommit: vi.fn(),
		textCharTouchModeChange: vi.fn(),

		getSelectedElement: vi.fn(() => null),
		getSelectedElementBounds: vi.fn(() => null),
		updateFill: vi.fn(),
		setGradientSelectedStopId: vi.fn(),
		setGradientSelectedStopIndex: vi.fn(),
		deleteSelectedGradientStop: vi.fn(() => false),
		getActiveStrokeAppearance: vi.fn(() => null),
		getActiveFillAppearance: vi.fn(() => null),
		requestRender: vi.fn(),

		uiSetOverlay: vi.fn((key: OverlayKey, overlay: UIOverlay | null) => {
			if (overlay) overlays[key] = overlay;
			else delete overlays[key];
		}),
		uiHitTest: vi.fn((point: { x: number; y: number }) =>
			hitTestOverlays(
				overlays,
				point,
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			),
		),
		uiSetToolSession: vi.fn(),
		previewDeformation: vi.fn(),
		clearDeformationPreview: vi.fn(),
		applyDeformation: vi.fn(),
		restoreOriginal: vi.fn(),
		perspectiveWarpCompute: vi.fn(() => []),
		outlineTextElements: vi.fn(async () => []),
		complete: vi.fn(),
		getCurrentLayerId: vi.fn(() => null),
		getViewport: vi.fn(() => null),

		renderViewportToImageData: vi.fn(async () => null),
		renderWorldRegionToImageData: vi.fn(async () => null),
		getDocumentContentBounds: vi.fn(() => null),
		getMaxRasterDimension: vi.fn(() => 2048),
		setBucketFillLeaks: vi.fn(),
		setBucketFillComputing: vi.fn(),
		panToWorldPoint: vi.fn(),

		hintTransformOnlyChange: vi.fn((fn: () => void) => fn()),

		pickPixelColor: vi.fn(async () => null),
		emitColorPick: vi.fn(),

		pathEditGetSelectionMode: vi.fn(() => "lasso" as const),
		pathEditGetCutMode: vi.fn(() => false),
		pathEditSetCutMode: vi.fn(),
		stashPathEditUndoSelection: vi.fn(),
		selectGetSelectionMode: vi.fn(() => "lasso" as const),
		pathEditUpdateSelectedAnchors: vi.fn(),
	};

	const ctx = new ToolContext({
		...base,
		...overrides,
	}) as MockToolContext;
	ctx.mockCommands = mockCommands;
	return ctx;
}
