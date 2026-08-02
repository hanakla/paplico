import { describe, expect, it, vi } from "vitest";
import { createIdentityTransform } from "../document/factory";
import type { OverlayHit } from "../renderer/ui/hitTest";
import { OVERLAY_KEYS } from "../renderer/ui/overlayKeys";
import type { Path, TextElement, TextStyle } from "../schema";
import { createMockToolContext } from "../testUtils/mockToolContext";
import {
	ev,
	testCanvasHeight,
	testCanvasWidth,
	testViewport,
} from "../testUtils/pointerEvent";
import { closedRectSegments, lineSeg } from "../testUtils/segmentFactory";
import { brandWorldBBox } from "../utils/geometry/bounds";
import { toWorld } from "../utils/geometry/geometry";
import { createDefaultTextStyle, TextTool } from "./TextTool";

function createTextElement(text: string): TextElement {
	const style = createDefaultTextStyle();

	return {
		type: "text",
		id: "text-1",
		x: 0,
		y: 0,
		content: {
			paragraphs: [
				{
					runs: [{ text, style: { ...style } }],
					alignment: "left",
					lineHeight: 1.2,
					indent: 0,
					spacing: { before: 0, after: 0 },
				},
			],
		},
		defaultStyle: { ...style },
		layout: {
			writingMode: "horizontal-tb",
			boxWidth: "auto",
			boxHeight: "auto",
			overflow: "visible",
			wordWrap: false,
		},
		opacity: 1,
		blendMode: "normal",
		transform: createIdentityTransform(),
	};
}

function createTool(previewUpdate: (text: TextElement | null) => void) {
	const defaultStyle: TextStyle = createDefaultTextStyle();
	return new TextTool(
		createMockToolContext({
			textPreviewUpdate: previewUpdate,
		}),
		{ defaultStyle },
	);
}

describe("TextTool", () => {
	it("does not request preview updates when only moving cursor", () => {
		const previewUpdate = vi.fn();
		const tool = createTool(previewUpdate);
		tool.enterEditModeForElement(createTextElement("abc"));

		tool.moveCursor("right", false);

		expect(previewUpdate).not.toHaveBeenCalled();
	});

	it("requests preview update when text content changes", () => {
		const previewUpdate = vi.fn();
		const tool = createTool(previewUpdate);
		tool.enterEditModeForElement(createTextElement(""));

		tool.insertText("a");

		expect(previewUpdate).toHaveBeenCalledTimes(1);
	});

	it("uses text cursor while hovering editable text", () => {
		const previewUpdate = vi.fn();
		const text = createTextElement("abc");
		const tool = new TextTool(
			createMockToolContext({
				textPreviewUpdate: previewUpdate,
				findTextAtPoint: vi.fn(() => text),
			}),
			{ defaultStyle: createDefaultTextStyle() },
		);

		tool.onPointerMove(
			ev(400, 300),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);

		expect(tool.getCursor()).toBe("text");
	});

	it("uses crosshair cursor when not hovering text", () => {
		const previewUpdate = vi.fn();
		const tool = new TextTool(
			createMockToolContext({
				textPreviewUpdate: previewUpdate,
				findTextAtPoint: vi.fn(() => null),
			}),
			{ defaultStyle: createDefaultTextStyle() },
		);

		tool.onPointerMove(
			ev(400, 300),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);

		expect(tool.getCursor()).toBe("crosshair");
	});
});

// --- Path-bound creation / region drag / flow linking scenarios ---

const bbox = (minX: number, minY: number, maxX: number, maxY: number) =>
	brandWorldBBox({
		minX,
		minY,
		maxX,
		maxY,
		width: maxX - minX,
		height: maxY - minY,
	});

const pathElement = (id: string, segments: Path["segments"]): Path => ({
	type: "path",
	id,
	segments,
	opacity: 1,
	blendMode: "normal",
	transform: createIdentityTransform(),
});

/** World segment with absolute control points tracing a straight edge */
const absLine = (
	start: { x: number; y: number },
	end: { x: number; y: number },
) => ({
	start: toWorld(start.x, start.y),
	cp1: toWorld(start.x, start.y),
	cp2: toWorld(end.x, end.y),
	end: toWorld(end.x, end.y),
});

describe("TextTool path-bound creation", () => {
	it("should create text on path when clicking an open path outline", () => {
		const path = pathElement("axis", [
			lineSeg({ x: 100, y: 0 }, { start: { x: 0, y: 0 } }),
		]);
		const textCreateOnPath = vi.fn();
		const ctx = createMockToolContext({
			findPathAtPoint: vi.fn(() => path),
			getElementWorldSegments: vi.fn(() => [
				absLine({ x: 0, y: 0 }, { x: 100, y: 0 }),
			]),
			getBounds: vi.fn(() => bbox(0, -10, 100, 10)),
			textCreateOnPath,
		});
		const tool = new TextTool(ctx, { defaultStyle: createDefaultTextStyle() });

		// world(50, 0) = screen(450, 300): on the outline
		tool.onPointerDown(
			ev(450, 300),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);

		const call = textCreateOnPath.mock.calls[0];
		expect(call).toBeDefined();
		const [text, pathObjectId, mode, clickWorld] = call;
		expect(pathObjectId).toBe("axis");
		expect(mode).toBe("onPath");
		expect((text as TextElement).axisBinding?.mode).toBe("onPath");
		expect(clickWorld.x).toBeCloseTo(50);
		expect(clickWorld.y).toBeCloseTo(0);
	});

	it("should create area text when clicking a closed path outline", () => {
		const path = pathElement("shape", closedRectSegments(0, 0, 100, -100));
		const textCreateOnPath = vi.fn();
		const ctx = createMockToolContext({
			findPathAtPoint: vi.fn(() => path),
			getElementWorldSegments: vi.fn(() => [
				absLine({ x: 0, y: 0 }, { x: 100, y: 0 }),
				absLine({ x: 100, y: 0 }, { x: 100, y: -100 }),
				absLine({ x: 100, y: -100 }, { x: 0, y: -100 }),
				absLine({ x: 0, y: -100 }, { x: 0, y: 0 }),
			]),
			getBounds: vi.fn(() => bbox(0, -100, 100, 0)),
			textCreateOnPath,
		});
		const tool = new TextTool(ctx, { defaultStyle: createDefaultTextStyle() });

		// world(50, 0) = screen(450, 300): on the top edge
		tool.onPointerDown(
			ev(450, 300),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);

		const [text, pathObjectId, mode] = textCreateOnPath.mock.calls[0];
		expect(pathObjectId).toBe("shape");
		expect(mode).toBe("inShape");
		expect((text as TextElement).axisBinding?.mode).toBe("inShape");
	});

	it("should not bind when clicking the interior of a filled closed path", () => {
		const path = pathElement("shape", closedRectSegments(0, 0, 100, -100));
		const textCreateOnPath = vi.fn();
		const textCreate = vi.fn();
		const ctx = createMockToolContext({
			findPathAtPoint: vi.fn(() => path),
			getElementWorldSegments: vi.fn(() => [
				absLine({ x: 0, y: 0 }, { x: 100, y: 0 }),
				absLine({ x: 100, y: 0 }, { x: 100, y: -100 }),
				absLine({ x: 100, y: -100 }, { x: 0, y: -100 }),
				absLine({ x: 0, y: -100 }, { x: 0, y: 0 }),
			]),
			textCreateOnPath,
			textCreate,
		});
		const tool = new TextTool(ctx, { defaultStyle: createDefaultTextStyle() });

		// world(50, -50) = screen(450, 350): interior, 50px from every edge
		tool.onPointerDown(
			ev(450, 350),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		expect(textCreateOnPath).not.toHaveBeenCalled();
		expect(textCreate).not.toHaveBeenCalled();

		tool.onPointerUp(
			ev(450, 350),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		expect(textCreate).toHaveBeenCalledTimes(1);
		const created = textCreate.mock.calls[0][0] as TextElement;
		expect(created.axisBinding).toBeUndefined();
	});
});

describe("TextTool region drag", () => {
	it("should create a fixed-box wrapping region from a drag", () => {
		const textCreate = vi.fn();
		const ctx = createMockToolContext({ textCreate });
		const tool = new TextTool(ctx, { defaultStyle: createDefaultTextStyle() });

		tool.onPointerDown(
			ev(400, 300),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		expect(textCreate).not.toHaveBeenCalled();

		tool.onPointerMove(
			ev(500, 360),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		tool.onPointerUp(
			ev(500, 360),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);

		const created = textCreate.mock.calls[0][0] as TextElement;
		expect(created.layout.boxWidth).toBe(100);
		expect(created.layout.boxHeight).toBe(60);
		expect(created.layout.wordWrap).toBe(true);
		expect(created.layout.overflow).toBe("hidden");
		// Anchor at the top-left corner (world Y-up)
		expect(created.x).toBe(0);
		expect(created.y).toBe(0);
	});

	it("should create point text on a sub-threshold click, only at pointerup", () => {
		const textCreate = vi.fn();
		const ctx = createMockToolContext({ textCreate });
		const tool = new TextTool(ctx, { defaultStyle: createDefaultTextStyle() });

		tool.onPointerDown(
			ev(400, 300),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		tool.onPointerMove(
			ev(401, 301),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		expect(textCreate).not.toHaveBeenCalled();

		tool.onPointerUp(
			ev(401, 301),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		const created = textCreate.mock.calls[0][0] as TextElement;
		expect(created.layout.boxWidth).toBe("auto");
	});

	it("should show the region preview while dragging and clear it on release", () => {
		const uiSetOverlay = vi.fn();
		const ctx = createMockToolContext({ uiSetOverlay });
		const tool = new TextTool(ctx, { defaultStyle: createDefaultTextStyle() });

		tool.onPointerDown(
			ev(400, 300),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		tool.onPointerMove(
			ev(500, 360),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		const previewCalls = uiSetOverlay.mock.calls.filter(
			(c) => c[0] === OVERLAY_KEYS.textRegionPreview,
		);
		expect(previewCalls.at(-1)?.[1]).not.toBeNull();

		tool.onPointerUp(
			ev(500, 360),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		const afterUp = uiSetOverlay.mock.calls.filter(
			(c) => c[0] === OVERLAY_KEYS.textRegionPreview,
		);
		expect(afterUp.at(-1)?.[1]).toBeNull();
	});
});

describe("TextTool flow linking", () => {
	function regionText(id: string, x = 0, y = 0): TextElement {
		return {
			...createTextElement("hello"),
			id,
			x,
			y,
			layout: {
				writingMode: "horizontal-tb",
				boxWidth: 100,
				boxHeight: 50,
				overflow: "hidden",
				wordWrap: true,
			},
		};
	}

	function linkSetup(overrides: Record<string, unknown> = {}) {
		const a = regionText("A");
		const b = regionText("B", 200, 0);
		const boundsById: Record<string, ReturnType<typeof bbox>> = {
			A: bbox(0, -50, 100, 0),
			B: bbox(200, -50, 300, 0),
		};
		const textFlowLink = vi.fn();
		const ctx = createMockToolContext({
			getBounds: vi.fn((id: string) => boundsById[id] ?? null),
			findTextAtPoint: vi.fn(() => null),
			textFlowLink,
			...overrides,
		});
		const tool = new TextTool(ctx, { defaultStyle: createDefaultTextStyle() });
		// Editing region A publishes its ■ handle into the overlay store
		tool.enterEditModeForElement(a);
		return { tool, ctx, a, b, textFlowLink };
	}

	// Handle sits at A's corner world(100,-50) + screenOffset(5,-5) = screen(505, 355)
	const pressHandle = (tool: TextTool) =>
		tool.onPointerDown(
			ev(505, 355),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);

	const dragTo = (tool: TextTool, x: number, y: number) => {
		tool.onPointerMove(
			ev(x, y),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		tool.onPointerUp(ev(x, y), testViewport, testCanvasWidth, testCanvasHeight);
	};

	it("should link two regions by dragging from the ■ handle onto the target", () => {
		const { tool, ctx, b, textFlowLink } = linkSetup();
		pressHandle(tool);
		expect(textFlowLink).not.toHaveBeenCalled();

		vi.mocked(ctx.findTextAtPoint).mockReturnValue(b);
		dragTo(tool, 650, 325);

		const call = textFlowLink.mock.calls[0];
		expect(call[0]).toBe("A");
		expect(call[1]).toBe("B");
	});

	it("should reject self links", () => {
		const { tool, ctx, a, textFlowLink } = linkSetup();
		pressHandle(tool);
		vi.mocked(ctx.findTextAtPoint).mockReturnValue(a);
		dragTo(tool, 450, 325);
		expect(textFlowLink).not.toHaveBeenCalled();
	});

	it("should reject a second inflow into the target", () => {
		const { tool, ctx, b, textFlowLink } = linkSetup({
			textFindFlowSource: vi.fn((id: string) =>
				id === "B" ? regionText("C") : null,
			),
		});
		pressHandle(tool);
		vi.mocked(ctx.findTextAtPoint).mockReturnValue(b);
		dragTo(tool, 650, 325);
		expect(textFlowLink).not.toHaveBeenCalled();
	});

	it("should cancel linking with Escape", () => {
		const { tool, ctx, b, textFlowLink } = linkSetup();
		pressHandle(tool);

		const handled = tool.onKeyDown(
			new KeyboardEvent("keydown", {
				code: "Escape",
				key: "Escape",
				cancelable: true,
			}),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		expect(handled).toBe(true);

		vi.mocked(ctx.findTextAtPoint).mockReturnValue(b);
		dragTo(tool, 650, 325);
		expect(textFlowLink).not.toHaveBeenCalled();
	});

	it("should clear flow overlays on cancel", () => {
		const uiSetOverlay = vi.fn();
		const ctx = createMockToolContext({ uiSetOverlay });
		const tool = new TextTool(ctx, { defaultStyle: createDefaultTextStyle() });

		tool.onCancel();

		const handleCalls = uiSetOverlay.mock.calls.filter(
			(c) => c[0] === OVERLAY_KEYS.textFlowHandles,
		);
		expect(handleCalls.at(-1)?.[1]).toBeNull();
	});
});

describe("TextTool empty region persistence", () => {
	const emptyRegion = (): TextElement => ({
		...createTextElement(""),
		id: "region-empty",
		layout: {
			writingMode: "horizontal-tb",
			boxWidth: 100,
			boxHeight: 50,
			overflow: "hidden",
			wordWrap: true,
		},
	});

	it("should keep an empty fixed-box region on exit", () => {
		const textDelete = vi.fn();
		const textComplete = vi.fn();
		const ctx = createMockToolContext({ textDelete, textComplete });
		const tool = new TextTool(ctx, { defaultStyle: createDefaultTextStyle() });

		tool.enterEditModeForElement(emptyRegion());
		tool.onCancel();

		expect(textDelete).not.toHaveBeenCalled();
		expect(textComplete).toHaveBeenCalledTimes(1);
	});

	it("should delete a click-created text left empty when clicking away", () => {
		const textCreate = vi.fn();
		const textDelete = vi.fn();
		const textComplete = vi.fn();
		const ctx = createMockToolContext({
			textCreate,
			textDelete,
			textComplete,
			findTextAtPoint: vi.fn(() => null),
		});
		const tool = new TextTool(ctx, { defaultStyle: createDefaultTextStyle() });

		// Blank click creates a text and enters editing
		tool.onPointerDown(
			ev(400, 300),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		tool.onPointerUp(
			ev(400, 300),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		expect(textCreate).toHaveBeenCalledTimes(1);
		const created = textCreate.mock.calls[0][0] as TextElement;

		// Clicking away with nothing typed commits and deletes the empty text
		tool.onPointerDown(
			ev(600, 300),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);

		expect(textDelete).toHaveBeenCalledWith(created.id);
		expect(textComplete).not.toHaveBeenCalled();
	});

	it("should commit a click-created text with content when clicking away", () => {
		const textCreate = vi.fn();
		const textDelete = vi.fn();
		const textComplete = vi.fn();
		const ctx = createMockToolContext({
			textCreate,
			textDelete,
			textComplete,
			findTextAtPoint: vi.fn(() => null),
		});
		const tool = new TextTool(ctx, { defaultStyle: createDefaultTextStyle() });

		tool.onPointerDown(
			ev(400, 300),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		tool.onPointerUp(
			ev(400, 300),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		tool.insertText("hi");

		tool.onPointerDown(
			ev(600, 300),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);

		expect(textComplete).toHaveBeenCalledTimes(1);
		expect(textDelete).not.toHaveBeenCalled();
	});

	it("should still delete an empty point text on exit", () => {
		const textDelete = vi.fn();
		const ctx = createMockToolContext({ textDelete });
		const tool = new TextTool(ctx, { defaultStyle: createDefaultTextStyle() });

		tool.enterEditModeForElement(createTextElement(""));
		tool.onCancel();

		expect(textDelete).toHaveBeenCalledTimes(1);
	});
});

describe("TextTool flow link visual feedback", () => {
	function regionText(id: string, x = 0, y = 0): TextElement {
		return {
			...createTextElement("hello"),
			id,
			x,
			y,
			layout: {
				writingMode: "horizontal-tb",
				boxWidth: 100,
				boxHeight: 50,
				overflow: "hidden",
				wordWrap: true,
			},
		};
	}

	it("should show translucent candidate bboxes while linking", () => {
		const a = regionText("A");
		const b = regionText("B", 200, 0);
		const c = regionText("C", 400, 0);
		const boundsById: Record<string, ReturnType<typeof brandWorldBBox>> = {
			A: bbox(0, -50, 100, 0),
			B: bbox(200, -50, 300, 0),
			C: bbox(400, -50, 500, 0),
		};
		const ctx = createMockToolContext({
			getBounds: vi.fn((id: string) => boundsById[id] ?? null),
			findTextAtPoint: vi.fn(() => null),
			listTextElements: vi.fn(() => [a, b, c]),
		});
		const tool = new TextTool(ctx, { defaultStyle: createDefaultTextStyle() });
		tool.enterEditModeForElement(a);

		// Click A's ■ handle: corner (100,-50) + screenOffset(5,-5) = (505,355)
		tool.onPointerDown(
			ev(505, 355),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);

		const previewCall = vi
			.mocked(ctx.uiSetOverlay)
			.mock.calls.filter((call) => call[0] === OVERLAY_KEYS.textFlowLinkPreview)
			.at(-1);
		expect(previewCall?.[1]).not.toBeNull();
		const rects = previewCall?.[1]?.primitives.filter((p) => p.kind === "rect");
		// B and C are candidates (source A excluded)
		expect(rects).toHaveLength(2);
	});

	it("should draw dashed connectors while hovering a chained region", () => {
		const a = regionText("A");
		const b = regionText("B", 200, 0);
		const boundsById: Record<string, ReturnType<typeof brandWorldBBox>> = {
			A: bbox(0, -50, 100, 0),
			B: bbox(200, -50, 300, 0),
		};
		const ctx = createMockToolContext({
			getBounds: vi.fn((id: string) => boundsById[id] ?? null),
			findTextAtPoint: vi.fn(() => a),
			textChainMembers: vi.fn(() => [a, b]),
		});
		const tool = new TextTool(ctx, { defaultStyle: createDefaultTextStyle() });

		tool.onPointerMove(
			ev(450, 325),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);

		const chainCall = vi
			.mocked(ctx.uiSetOverlay)
			.mock.calls.filter((call) => call[0] === OVERLAY_KEYS.textFlowChain)
			.at(-1);
		expect(chainCall?.[1]).not.toBeNull();
		const lines = chainCall?.[1]?.primitives.filter((p) => p.kind === "line");
		expect(lines?.length).toBeGreaterThan(1);
	});

	it("should clear the chain connectors when nothing is hovered or edited", () => {
		const ctx = createMockToolContext({
			findTextAtPoint: vi.fn(() => null),
			textChainMembers: vi.fn(() => []),
		});
		const tool = new TextTool(ctx, { defaultStyle: createDefaultTextStyle() });

		tool.onPointerMove(
			ev(400, 300),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);

		const chainCall = vi
			.mocked(ctx.uiSetOverlay)
			.mock.calls.filter((call) => call[0] === OVERLAY_KEYS.textFlowChain)
			.at(-1);
		expect(chainCall?.[1] ?? null).toBeNull();
	});
});

describe("TextTool.commitEditing", () => {
	it("should end the edit session so the next blank click creates a new text", () => {
		const textComplete = vi.fn();
		const textCreate = vi.fn();
		const ctx = createMockToolContext({ textComplete, textCreate });
		const tool = new TextTool(ctx, { defaultStyle: createDefaultTextStyle() });

		tool.enterEditModeForElement(createTextElement("abc"));
		tool.commitEditing();
		expect(textComplete).toHaveBeenCalledTimes(1);

		// A blank click after committing must create a new text, not be
		// swallowed by a stale edit session
		tool.onPointerDown(
			ev(400, 300),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		tool.onPointerUp(
			ev(400, 300),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		expect(textCreate).toHaveBeenCalledTimes(1);
	});

	it("should be a no-op when not editing", () => {
		const textComplete = vi.fn();
		const textDelete = vi.fn();
		const ctx = createMockToolContext({ textComplete, textDelete });
		const tool = new TextTool(ctx, { defaultStyle: createDefaultTextStyle() });

		tool.commitEditing();

		expect(textComplete).not.toHaveBeenCalled();
		expect(textDelete).not.toHaveBeenCalled();
	});
});

describe("TextTool cursor update sequencing", () => {
	it("should ignore stale cursor position resolutions", async () => {
		const updateTextCursor = vi.fn();
		const resolvers: Array<
			(v: { x: number; y: number; height: number }) => void
		> = [];
		const getCursorWorldPosition = vi.fn(
			() =>
				new Promise<{ x: number; y: number; height: number }>((resolve) => {
					resolvers.push(resolve);
				}),
		);
		const ctx = createMockToolContext({
			updateTextCursor,
			getCursorWorldPosition,
		});
		const tool = new TextTool(ctx, { defaultStyle: createDefaultTextStyle() });
		tool.enterEditModeForElement(createTextElement(""));

		tool.insertText("a");
		tool.insertText("b");
		expect(resolvers.length).toBeGreaterThanOrEqual(2);

		// Newest lookup resolves first…
		resolvers.at(-1)?.({ x: 99, y: 0, height: 10 });
		await new Promise((r) => setTimeout(r, 0));
		// …then a stale one arrives late and must NOT overwrite the caret
		resolvers[0]?.({ x: 11, y: 0, height: 10 });
		await new Promise((r) => setTimeout(r, 0));

		const last = updateTextCursor.mock.calls.at(-1);
		expect(last?.[1]).toBe(99);
	});
});

describe("TextTool IME composition caret", () => {
	it("should advance the caret by the composing text before commit", async () => {
		const updateTextCursor = vi.fn();
		const ctx = createMockToolContext({ updateTextCursor });
		const tool = new TextTool(ctx, { defaultStyle: createDefaultTextStyle() });
		tool.enterEditModeForElement(createTextElement("ab"));
		tool.moveToDocumentEnd(false); // caret after "ab" (index 2)

		tool.startComposition();
		tool.updateComposition("かん");
		await new Promise((r) => setTimeout(r, 0));

		// Caret sits after the composing chars: 2 (anchor) + 2 (composition)
		const last = updateTextCursor.mock.calls.at(-1);
		expect(last?.[0]).toBe(4);

		// Committing keeps the caret after the inserted text
		tool.endComposition("感");
		await new Promise((r) => setTimeout(r, 0));
		const afterCommit = updateTextCursor.mock.calls.at(-1);
		expect(afterCommit?.[0]).toBe(3);
	});

	it("should return the caret to the anchor when composition is cleared", async () => {
		const updateTextCursor = vi.fn();
		const ctx = createMockToolContext({ updateTextCursor });
		const tool = new TextTool(ctx, { defaultStyle: createDefaultTextStyle() });
		tool.enterEditModeForElement(createTextElement("ab"));
		tool.moveToDocumentEnd(false);

		tool.startComposition();
		tool.updateComposition("かん");
		tool.updateComposition("");
		await new Promise((r) => setTimeout(r, 0));

		const last = updateTextCursor.mock.calls.at(-1);
		expect(last?.[0]).toBe(2);
	});
});

describe("TextTool caret-pending style via IME", () => {
	it("should insert IME-confirmed text with the caret-staged style", () => {
		const previewUpdate = vi.fn();
		const tool = createTool(previewUpdate);
		const element = createTextElement("abc");
		tool.enterEditModeForElement(element);

		// Caret only: stage a size, then type through the IME
		tool.changeSelectionFontSize(30);
		tool.startComposition();
		tool.updateComposition("\u304b");
		tool.endComposition("\u304b");

		const runs = element.content.paragraphs[0].runs;
		const inserted = runs.find((r) => r.text.includes("\u304b"));
		expect(inserted?.style.fontSize).toBe(30);
	});
});

describe("TextTool caret-pending style", () => {
	it("should stage a style with no selection and apply it to the next typed text", () => {
		const ctx = createMockToolContext();
		const tool = new TextTool(ctx, { defaultStyle: createDefaultTextStyle() });
		const element = createTextElement("ab");
		tool.enterEditModeForElement(element);
		tool.moveToDocumentEnd(false);

		// No selection: the style is staged, not applied to existing runs
		tool.applyStyleToSelection({ fontSize: 40 });
		expect(element.content.paragraphs[0].runs[0].style.fontSize).not.toBe(40);

		tool.insertText("X");
		const runs = element.content.paragraphs[0].runs;
		const styledRun = runs.find((r) => r.text === "X");
		expect(styledRun?.style.fontSize).toBe(40);
		// Existing text keeps its style
		expect(runs.find((r) => r.text === "ab")?.style.fontSize).not.toBe(40);
	});

	it("should drop the staged style when the caret moves", () => {
		const ctx = createMockToolContext();
		const tool = new TextTool(ctx, { defaultStyle: createDefaultTextStyle() });
		const element = createTextElement("ab");
		tool.enterEditModeForElement(element);
		tool.moveToDocumentEnd(false);

		tool.applyStyleToSelection({ fontSize: 40 });
		tool.moveCursor("left", false);
		tool.insertText("X");

		const runs = element.content.paragraphs[0].runs;
		expect(runs.every((r) => r.style.fontSize !== 40)).toBe(true);
	});
});

describe("TextTool char override tracking through edits", () => {
	const setupEditing = (text: string) => {
		const tool = createTool(vi.fn());
		const element = createTextElement(text);
		tool.enterEditModeForElement(element);
		tool.moveToDocumentEnd(false);
		return { tool, element };
	};
	const caretTo = (tool: TextTool, fromEnd: number) => {
		for (let i = 0; i < fromEnd; i++) tool.moveCursor("left", false);
	};
	const overridesOf = (element: TextElement) =>
		element.content.paragraphs[0].runs[0].charOverrides;

	it("should keep an override attached to its character across forward delete", () => {
		const { tool, element } = setupEditing("abc");
		element.content.paragraphs[0].runs[0].charOverrides = [
			{ charIndex: 2, rotation: 30 },
		];

		caretTo(tool, 2); // caret before "b"
		tool.deleteText("forward"); // delete "b"

		expect(element.content.paragraphs[0].runs[0].text).toBe("ac");
		expect(overridesOf(element)).toEqual([{ charIndex: 1, rotation: 30 }]);
	});

	it("should drop the deleted character's own override on backspace", () => {
		const { tool, element } = setupEditing("abc");
		element.content.paragraphs[0].runs[0].charOverrides = [
			{ charIndex: 1, rotation: 30 },
			{ charIndex: 2, kerningAdjust: 0.5 },
		];

		caretTo(tool, 1); // caret before "c"
		tool.deleteText("backward"); // delete "b"

		expect(element.content.paragraphs[0].runs[0].text).toBe("ac");
		expect(overridesOf(element)).toEqual([
			{ charIndex: 1, kerningAdjust: 0.5 },
		]);
	});

	it("should shift overrides right on insertion before them", () => {
		const { tool, element } = setupEditing("abc");
		element.content.paragraphs[0].runs[0].charOverrides = [
			{ charIndex: 2, rotation: 30 },
		];

		caretTo(tool, 2); // caret before "b"
		tool.insertText("XY");

		expect(element.content.paragraphs[0].runs[0].text).toBe("aXYbc");
		expect(overridesOf(element)).toEqual([{ charIndex: 4, rotation: 30 }]);
	});

	it("should remove covered overrides and shift the rest on selection delete", () => {
		const { tool, element } = setupEditing("abcd");
		element.content.paragraphs[0].runs[0].charOverrides = [
			{ charIndex: 1, rotation: 30 },
			{ charIndex: 3, kerningAdjust: 0.5 },
		];

		caretTo(tool, 3); // caret before "b"
		tool.moveCursor("right", true);
		tool.moveCursor("right", true); // select "bc"
		tool.deleteText("backward");

		expect(element.content.paragraphs[0].runs[0].text).toBe("ad");
		expect(overridesOf(element)).toEqual([
			{ charIndex: 1, kerningAdjust: 0.5 },
		]);
	});
});

describe("TextTool rich clipboard", () => {
	class FakeClipboardItem {
		public types: string[];
		public constructor(private data: Record<string, Blob | Promise<Blob>>) {
			this.types = Object.keys(data);
		}
		public async getType(type: string): Promise<Blob> {
			return await this.data[type];
		}
		public static supports(): boolean {
			return true;
		}
	}

	const clipboardWrite = vi.fn(
		async (_items: FakeClipboardItem[]): Promise<void> => {},
	);
	const clipboardRead = vi.fn(async (): Promise<unknown[]> => []);

	beforeEach(() => {
		clipboardWrite.mockClear();
		clipboardRead.mockClear();
		vi.stubGlobal("ClipboardItem", FakeClipboardItem);
		vi.stubGlobal("navigator", {
			clipboard: {
				write: clipboardWrite,
				read: clipboardRead,
				readText: vi.fn(async () => ""),
				writeText: vi.fn(async () => {}),
			},
		});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("should copy the selection as plain text, styled HTML and a rich payload", async () => {
		const tool = createTool(vi.fn());
		const element = createTextElement("abcd");
		element.content.paragraphs[0].runs[0].charOverrides = [
			{ charIndex: 2, rotation: 30 },
		];
		tool.enterEditModeForElement(element);
		tool.moveToDocumentEnd(false);
		for (let i = 0; i < 3; i++) tool.moveCursor("left", false);
		tool.moveCursor("right", true);
		tool.moveCursor("right", true); // select "bc"

		await tool.copyToClipboard();

		expect(clipboardWrite).toHaveBeenCalledTimes(1);
		const item = clipboardWrite.mock.calls[0]?.[0]?.[0];
		if (!item) throw new Error("clipboard write received no items");
		const payload = JSON.parse(
			await (await item.getType("web application/x-paplico-text")).text(),
		);
		expect(payload.paragraphs).toHaveLength(1);
		expect(payload.paragraphs[0].runs[0].text).toBe("bc");
		// The override on "c" (content index 2) reindexes to the slice (1)
		expect(payload.paragraphs[0].runs[0].charOverrides).toEqual([
			{ charIndex: 1, rotation: 30 },
		]);
		const html = await (await item.getType("text/html")).text();
		expect(html).toContain("font-size: 24px");
		expect(html).toContain("bc");
		const plain = await (await item.getType("text/plain")).text();
		expect(plain).toBe("bc");
	});

	it("should restore styles and overrides when pasting the rich payload", async () => {
		const payload = {
			paragraphs: [
				{
					runs: [
						{
							text: "XY",
							style: { ...createDefaultTextStyle(), fontSize: 48 },
							charOverrides: [{ charIndex: 1, rotation: 15 }],
						},
					],
				},
			],
		};
		clipboardRead.mockResolvedValue([
			new FakeClipboardItem({
				"web application/x-paplico-text": new Blob([JSON.stringify(payload)], {
					type: "web application/x-paplico-text",
				}),
			}),
		]);

		const tool = createTool(vi.fn());
		const element = createTextElement("ab");
		tool.enterEditModeForElement(element);
		tool.moveToDocumentEnd(false);

		await tool.pasteFromClipboard();

		const runs = element.content.paragraphs[0].runs;
		const pasted = runs.find((r) => r.text === "XY");
		expect(pasted?.style.fontSize).toBe(48);
		expect(pasted?.charOverrides).toEqual([{ charIndex: 1, rotation: 15 }]);
		// Existing run untouched
		expect(runs.find((r) => r.text === "ab")).toBeDefined();
	});
});

describe("TextTool drag selection from the entry press", () => {
	it("should extend a character selection when the press that starts editing continues into a drag", async () => {
		const element = createTextElement("abcdef");
		const selectionRangeChange = vi.fn();
		const context = createMockToolContext({
			textPreviewUpdate: vi.fn(),
			findTextAtPoint: vi.fn(() => element),
			// 10px-advance fixture metrics: world X / 10 = char index
			hitTestCharacter: vi.fn(async (_el: TextElement, worldX: number) =>
				Math.max(0, Math.min(6, Math.round(worldX / 10))),
			),
			selectionRangeChange,
		});
		const tool = new TextTool(context, {
			defaultStyle: createDefaultTextStyle(),
		});

		// screen(400,300) = world(0,0) → char 0; keep the pointer down and drag
		tool.onPointerDown(
			ev(400, 300),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		tool.onPointerMove(
			ev(430, 300),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);

		await vi.waitFor(() => {
			expect(selectionRangeChange).toHaveBeenCalled();
		});
		const [, startIndex, endIndex] = selectionRangeChange.mock.calls.at(-1)!;
		expect(startIndex).toBe(0);
		expect(endIndex).toBe(3);
	});

	it("should extend the selection from the caret on Shift+click", async () => {
		const element = createTextElement("abcdef");
		const selectionRangeChange = vi.fn();
		const context = createMockToolContext({
			textPreviewUpdate: vi.fn(),
			findTextAtPoint: vi.fn(() => element),
			hitTestCharacter: vi.fn(async (_el: TextElement, worldX: number) =>
				Math.max(0, Math.min(6, Math.round(worldX / 10))),
			),
			selectionRangeChange,
		});
		const tool = new TextTool(context, {
			defaultStyle: createDefaultTextStyle(),
		});

		const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

		// Click to place the caret at char 1 (world x=10)
		tool.onPointerDown(
			ev(410, 300),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		await settle();
		tool.onPointerUp(
			ev(410, 300),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		selectionRangeChange.mockClear();

		// Shift+click at char 4 (world x=40) extends the selection 1 → 4
		tool.onPointerDown(
			ev(440, 300, { shiftKey: true }),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		await vi.waitFor(() => {
			expect(selectionRangeChange).toHaveBeenCalled();
		});
		const [, startIndex, endIndex] = selectionRangeChange.mock.calls.at(-1)!;
		expect(startIndex).toBe(1);
		expect(endIndex).toBe(4);
	});
});

describe("TextTool char touch mode", () => {
	const setupSession = (text = "abc") => {
		const element = createTextElement(text);
		const quadFor = (i: number) => ({
			charIndex: i,
			pivot: { x: i * 10 + 5, y: 0 },
			width: 10,
			height: 10,
			rotation: 0,
			localBounds: { minX: -5, minY: -2, maxX: 5, maxY: 8 },
			corners: [
				{ x: i * 10, y: -2 },
				{ x: i * 10 + 10, y: -2 },
				{ x: i * 10 + 10, y: 8 },
				{ x: i * 10, y: 8 },
			] as [
				{ x: number; y: number },
				{ x: number; y: number },
				{ x: number; y: number },
				{ x: number; y: number },
			],
		});
		const textCharTouchCommit = vi.fn();
		const uiHitTest = vi.fn((): OverlayHit | null => null);
		const textCreate = vi.fn();
		const ctx = createMockToolContext({
			textPreviewUpdate: vi.fn(),
			findTextAtPoint: vi.fn(() => element),
			getElement: vi.fn(() => element),
			hitTestTextGlyph: vi.fn(async (_el: TextElement, worldX: number) => {
				const i = Math.floor(worldX / 10);
				return i >= 0 && i < element.content.paragraphs[0].runs[0].text.length
					? i
					: null;
			}),
			getTextGlyphQuads: vi.fn(async (_el: TextElement, indices: number[]) => ({
				quads: indices.map(quadFor),
				elementTransform: { rotation: 0, scaleX: 1, scaleY: 1 },
			})),
			textCharTouchCommit,
			uiHitTest,
			textCreate,
		});
		const tool = new TextTool(ctx, {
			defaultStyle: createDefaultTextStyle(),
		});
		tool.setCharTouchMode(true);
		return { tool, element, ctx, textCharTouchCommit, uiHitTest, textCreate };
	};

	const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

	it("should pick a char on click and toggle with shift", async () => {
		const { tool, ctx } = setupSession();

		// world(5,0) = screen(405,300) → char 0
		tool.onPointerDown(
			ev(405, 300),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		await flush();
		tool.onPointerUp(
			ev(405, 300),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);

		// Overlay carries one selected quad
		const setOverlay = ctx.uiSetOverlay as ReturnType<typeof vi.fn>;
		const charTouchCalls = setOverlay.mock.calls.filter(
			(c) => c[0] === "text/char-touch" && c[1] != null,
		);
		expect(charTouchCalls.length).toBeGreaterThan(0);
	});

	it("should move all selected chars by the same delta and commit once on release", async () => {
		const { tool, element, uiHitTest, textCharTouchCommit } = setupSession();

		// Select char 1 by clicking world(15, 0)
		tool.onPointerDown(
			ev(415, 300),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		await flush();
		tool.onPointerUp(
			ev(415, 300),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		await flush();

		// Second press lands on the char quad via the overlay hit
		uiHitTest.mockReturnValue({
			overlayKey: OVERLAY_KEYS.textCharTouch,
			hitId: "char-touch:char:1",
		});
		tool.onPointerDown(
			ev(415, 300),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		tool.onPointerMove(
			ev(420, 290),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		expect(textCharTouchCommit).not.toHaveBeenCalled();
		tool.onPointerUp(
			ev(420, 290),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);

		expect(textCharTouchCommit).toHaveBeenCalledTimes(1);
		const committed = textCharTouchCommit.mock.calls[0][0] as TextElement;
		const overrides =
			committed.content.paragraphs[0].runs[0].charOverrides ?? [];
		const ov = overrides.find((o) => o.charIndex === 1);
		// screen +5,-10 → world +5,+10 (Y-up). Horizontal text: the inline
		// move writes kerning (em, fontSize 24), the cross move baseline shift
		expect(ov?.kerningAdjust).toBeCloseTo(5 / 24);
		expect(ov?.baselineShift).toBeCloseTo(10);
		// The original element is untouched until commit lands
		expect(
			element.content.paragraphs[0].runs[0].charOverrides ?? [],
		).toHaveLength(0);
	});

	it("should swap move axes in vertical writing but not for tate-chu-yoko chars", async () => {
		const { tool, element, uiHitTest, textCharTouchCommit } = setupSession();
		element.layout.writingMode = "vertical-rl";
		element.content.paragraphs[0].runs[0].style.tateChuYoko = true;

		tool.onPointerDown(
			ev(415, 300),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		await flush();
		tool.onPointerUp(
			ev(415, 300),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		await flush();

		uiHitTest.mockReturnValue({
			overlayKey: OVERLAY_KEYS.textCharTouch,
			hitId: "char-touch:char:1",
		});
		tool.onPointerDown(
			ev(415, 300),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		// screen +5,-10 → world +5,+10. Tate-chu-yoko composes horizontally:
		// X stays the inline axis (kerning), Y the cross axis (baseline shift)
		tool.onPointerMove(
			ev(420, 290),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		tool.onPointerUp(
			ev(420, 290),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);

		const committed = textCharTouchCommit.mock.calls[0][0] as TextElement;
		const ov = (
			committed.content.paragraphs[0].runs[0].charOverrides ?? []
		).find((o) => o.charIndex === 1);
		expect(ov?.kerningAdjust).toBeCloseTo(5 / 24);
		expect(ov?.baselineShift).toBeCloseTo(10);
	});

	it("should lock the move to the dominant axis while Shift is held", async () => {
		const { tool, uiHitTest, textCharTouchCommit } = setupSession();

		tool.onPointerDown(
			ev(415, 300),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		await flush();
		tool.onPointerUp(
			ev(415, 300),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		await flush();

		uiHitTest.mockReturnValue({
			overlayKey: OVERLAY_KEYS.textCharTouch,
			hitId: "char-touch:char:1",
		});
		tool.onPointerDown(
			ev(415, 300),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		// screen +3,-10 → world +3,+10; Shift keeps only the dominant Y axis
		tool.onPointerMove(
			ev(418, 290, { shiftKey: true }),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		tool.onPointerUp(
			ev(418, 290),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);

		const committed = textCharTouchCommit.mock.calls[0][0] as TextElement;
		const ov = (
			committed.content.paragraphs[0].runs[0].charOverrides ?? []
		).find((o) => o.charIndex === 1);
		expect(ov?.kerningAdjust ?? 0).toBeCloseTo(0);
		expect(ov?.baselineShift).toBeCloseTo(10);
	});

	it("should apply the same rotation delta to every selected char", async () => {
		const { tool, uiHitTest, textCharTouchCommit } = setupSession();

		// Select chars 0 and 1 (shift toggle via glyph picks)
		tool.onPointerDown(
			ev(405, 300),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		await flush();
		tool.onPointerDown(
			ev(415, 300, { shiftKey: true }),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		await flush();

		uiHitTest.mockReturnValue({
			overlayKey: OVERLAY_KEYS.textCharTouch,
			hitId: "char-touch:rotate",
		});
		// Combined bounds of quads 0..1: x 0..20, y -2..8 → center (10, 3)
		// Start pointing right of center, drag to above center = +90°
		tool.onPointerDown(
			ev(420, 297),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		tool.onPointerMove(
			ev(410, 287),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		tool.onPointerUp(
			ev(410, 287),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);

		const committed = textCharTouchCommit.mock.calls[0][0] as TextElement;
		const overrides =
			committed.content.paragraphs[0].runs[0].charOverrides ?? [];
		expect(overrides.find((o) => o.charIndex === 0)?.rotation).toBeCloseTo(90);
		expect(overrides.find((o) => o.charIndex === 1)?.rotation).toBeCloseTo(90);
	});

	it("should scale selected chars uniformly from the corner handle", async () => {
		const { tool, uiHitTest, textCharTouchCommit } = setupSession();

		tool.onPointerDown(
			ev(405, 300),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		await flush();

		uiHitTest.mockReturnValue({
			overlayKey: OVERLAY_KEYS.textCharTouch,
			hitId: "char-touch:scale:se",
		});
		// Quad 0 bounds: x 0..10, y -2..8 → center (5, 3). Distance 5 → 10 = ×2
		tool.onPointerDown(
			ev(410, 297),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		tool.onPointerMove(
			ev(415, 297),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		tool.onPointerUp(
			ev(415, 297),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);

		const committed = textCharTouchCommit.mock.calls[0][0] as TextElement;
		const ov = (
			committed.content.paragraphs[0].runs[0].charOverrides ?? []
		).find((o) => o.charIndex === 0);
		expect(ov?.sizeMultiplier).toBeCloseTo(2);
	});

	it("should apply absolute panel values to the selection and report them back", async () => {
		const { tool } = setupSession();

		tool.onPointerDown(
			ev(405, 300),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		await flush();

		// Fixture run font size is 24 → 48px = ×2 multiplier
		tool.setCharTouchValues({
			fontSize: 48,
			kerningAdjust: 0.1,
			rotation: 30,
			lineHeight: 2,
		});

		const selection = tool.getCharTouchSelection();
		expect(selection?.count).toBe(1);
		expect(selection?.fontSize).toBeCloseTo(48);
		expect(selection?.kerningAdjust).toBeCloseTo(0.1);
		expect(selection?.rotation).toBe(30);
		expect(selection?.lineHeight).toBe(2);
	});

	it("should remove selected chars' overrides when resetting styles", async () => {
		const { tool, textCharTouchCommit } = setupSession();

		tool.onPointerDown(
			ev(405, 300),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		await flush();

		tool.setCharTouchValues({ kerningAdjust: 0.1, rotation: 30 });
		tool.resetCharTouchValues();

		const committed = textCharTouchCommit.mock.calls.at(-1)?.[0] as TextElement;
		const overrides =
			committed.content.paragraphs[0].runs[0].charOverrides ?? [];
		expect(overrides.some((o) => o.charIndex === 0)).toBe(false);
		expect(tool.getCharTouchSelection()?.rotation).toBe(0);
		expect(tool.getCharTouchSelection()?.kerningAdjust).toBe(0);
	});

	it("should resync the session from the store on refreshUI (undo/redo)", async () => {
		const { tool, ctx, element } = setupSession();

		tool.onPointerDown(
			ev(405, 300),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		await flush();

		const getQuads = ctx.getTextGlyphQuads as ReturnType<typeof vi.fn>;
		const callsBefore = getQuads.mock.calls.length;

		// Simulate an undo replacing the stored element
		const reverted = { ...element, id: element.id };
		(ctx.getElement as ReturnType<typeof vi.fn>).mockReturnValue(reverted);
		tool.refreshUI();
		await flush();

		expect(getQuads.mock.calls.length).toBeGreaterThan(callsBefore);
		expect(getQuads.mock.calls.at(-1)?.[0]).toBe(reverted);
	});

	it("should clear selection then leave the mode on Escape", async () => {
		const { tool, ctx } = setupSession();
		tool.onPointerDown(
			ev(405, 300),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		await flush();

		const esc = new KeyboardEvent("keydown", { code: "Escape" });
		expect(
			tool.onKeyDown(esc, testViewport, testCanvasWidth, testCanvasHeight),
		).toBe(true);
		// Second Escape leaves the mode and reports back
		tool.onKeyDown(esc, testViewport, testCanvasWidth, testCanvasHeight);
		expect(ctx.textCharTouchModeChange).toHaveBeenCalledWith(false);
	});

	it("should not create text on blank clicks while in the mode", async () => {
		const { tool, ctx, textCreate } = setupSession();
		(ctx.findTextAtPoint as ReturnType<typeof vi.fn>).mockReturnValue(null);

		tool.onPointerDown(
			ev(700, 500),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		await flush();
		tool.onPointerUp(
			ev(700, 500),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);

		expect(textCreate).not.toHaveBeenCalled();
	});
});

describe("TextTool line spacing", () => {
	it("should survive run merges that shift the caret's run index", () => {
		const previewUpdate = vi.fn();
		const tool = createTool(previewUpdate);
		const element = createTextElement("ab");
		const [para] = element.content.paragraphs;
		const style = para.runs[0].style;
		// Three same-style runs collapse into one on mergeAdjacentRuns,
		// stranding any cursor position that still points at run 2
		para.runs = [
			{ text: "ab", style: { ...style } },
			{ text: "cd", style: { ...style } },
			{ text: "ef", style: { ...style } },
		];
		tool.enterEditModeForElement(element);
		tool.moveToDocumentEnd(false);
		tool.selectAll();

		tool.setLineSpacing(2);

		expect(element.content.paragraphs[0].runs[0].style.lineHeight).toBe(2);
	});

	it("should adjust the runs of the selected characters", () => {
		const previewUpdate = vi.fn();
		const tool = createTool(previewUpdate);
		const element = createTextElement("abc");
		tool.enterEditModeForElement(element);
		tool.selectAll();

		tool.adjustLineSpacing(0.1);

		// Base is 1.5 (unset run/default style)
		expect(element.content.paragraphs[0].runs[0].style.lineHeight).toBeCloseTo(
			1.6,
		);
	});

	it("should set an absolute leading on the selected characters", () => {
		const previewUpdate = vi.fn();
		const tool = createTool(previewUpdate);
		const element = createTextElement("abc");
		tool.enterEditModeForElement(element);
		tool.selectAll();

		tool.setLineSpacing(2);

		expect(element.content.paragraphs[0].runs[0].style.lineHeight).toBe(2);
	});

	it("should adjust only the caret paragraph when line geometry is unavailable", async () => {
		const previewUpdate = vi.fn();
		const tool = createTool(previewUpdate);
		const element = createTextElement("abc");
		const [para] = element.content.paragraphs;
		element.content.paragraphs.push({
			runs: [{ text: "def", style: { ...para.runs[0].style } }],
			alignment: "left",
			lineHeight: 1.2,
			indent: 0,
			spacing: { before: 0, after: 0 },
		});
		tool.enterEditModeForElement(element);
		tool.moveToDocumentEnd(false);

		tool.adjustLineSpacing(0.1);

		await vi.waitFor(() => {
			expect(
				element.content.paragraphs[1].runs[0].style.lineHeight,
			).toBeCloseTo(1.6);
		});
		expect(element.content.paragraphs[0].runs[0].style.lineHeight).toBe(
			undefined,
		);
	});

	it("should adjust only the caret's visual line when line geometry is available", async () => {
		const previewUpdate = vi.fn();
		const context = createMockToolContext({
			textPreviewUpdate: previewUpdate,
			getLineStartEnd: vi.fn(
				async (_el: TextElement, _i: number, which: "start" | "end") =>
					which === "start" ? 0 : 2,
			),
		});
		const tool = new TextTool(context, {
			defaultStyle: createDefaultTextStyle(),
		});
		const element = createTextElement("abc");
		tool.enterEditModeForElement(element);

		tool.adjustLineSpacing(0.1);

		// Chars [0, 2) get the new leading; the rest of the run stays untouched
		await vi.waitFor(() => {
			expect(element.content.paragraphs[0].runs).toHaveLength(2);
		});
		const [adjusted, rest] = element.content.paragraphs[0].runs;
		expect(adjusted.text).toBe("ab");
		expect(adjusted.style.lineHeight).toBeCloseTo(1.6);
		expect(rest.text).toBe("c");
		expect(rest.style.lineHeight).toBe(undefined);
	});
});
