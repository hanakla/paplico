# Tool System Reference

## Why tools are isolated from renderer and collaboration

Tools only interact with the engine through `ToolContext` (injected callbacks). They never import renderer classes or YjsProvider directly. This exists because:

1. **Testability** — Tools can be tested with mock callbacks. No GPU, no Yjs, no network needed
2. **Safety** — A tool bug cannot corrupt the renderer state or break collaboration sync
3. **Independence** — Adding or modifying a tool has zero impact on rendering or collaboration code

## Tool interface

`Tool` (defined in `tools/Tool.ts`) requires:
- `name` — Tool identifier
- `onPointerDown`, `onPointerMove`, `onPointerUp` — Pointer event handlers. Receive `PointerEventData` + `Viewport` + canvas dimensions
- `onCancel` — Cleanup when operation is cancelled (e.g., Escape key)
- `getCursor` — CSS cursor string for this tool

Optional:
- `onDoubleClick` — Double-click behavior (e.g., finish path, enter text edit mode)
- `onKeyDown` — Keyboard input during tool use. Return true to prevent default
- `refreshUI` — External trigger to refresh overlay state from current data
- `dispose` — Cleanup when tool is deactivated

## PointerEventData

Contains screen coordinates (`x`, `y`), `pressure` (0-1, for pen input), `tiltX`/`tiltY`, `pointerType` (mouse/pen/touch), `button`, and modifier keys (shift/ctrl/alt/meta).

Tools must convert screen coordinates to world coordinates using `screenToWorld` from `utils/coordinates.ts`. The viewport and canvas dimensions are passed alongside the event for this purpose.

## ToolContext

Injected via constructor. Provides callbacks that bridge the tool to the engine:
- `previewUpdate(path)` — Show in-progress element (rendered but not persisted)
- `strokeComplete(path)` — Commit finished element to document (→ YjsProvider)
- `previewUpdate(null)` — Clear preview

The exact callback set varies by tool type. PenTool has simple stroke callbacks. SelectTool has move/resize/rotate callbacks. PathEditTool has point manipulation callbacks.

**When creating a new tool:** Check similar tools' ToolContext/Options types to understand what callbacks are available. Define your own options type if needed.

## Tool lifecycle

1. Tool constructed with ToolContext + options (when user selects from toolbar)
2. `onPointerDown` — Initialize state (anchor point, accumulator)
3. `onPointerMove` (repeated) — Update preview, accumulate points
4. `onPointerUp` — Finalize, commit via ToolContext callbacks, clear transient state
5. `onCancel` — Discard everything, clear transient state (alternative to step 4)
6. `dispose` — Called when switching to a different tool

## Existing tools

| Tool | Purpose | Complexity |
|------|---------|-----------|
| PenTool | Freehand brush stroke drawing | Simple — accumulate points, commit path |
| PathTool | Bezier path creation (click to add anchor points) | Medium — manages point array, handle mirroring |
| PathEditTool | Edit existing path points and handles | Complex — hit testing on points/handles/segments, handle mirroring |
| ShapeTool | Rectangle, ellipse, polygon | Simple — compute geometry from drag |
| TextTool | Text creation and editing | Complex — caret management, text selection, inline editing |
| SelectTool | Selection, move, resize, rotate | Complex — multi-selection, resize handles, rotation |
| EraserTool | Erase elements by clicking/dragging over them | Simple — hit test and delete |
| GradientTool | Edit gradient fill stops and direction | Medium — interactive stop editing, gradient preview |
| MeshDeformTool | Mesh-based element deformation | Medium — grid handle manipulation |
| ArtboardTool | Create and manage artboards | Medium — drag to create, move with elements |
| BucketFillTool | Fill enclosed area | Complex — rasterize viewport, flood fill, trace boundary |

## Testing tools

Use `testUtils/pointerEvent.ts`:
- `ev(x, y, overrides?)` — Create mock `PointerEventData`
- `testViewport` — `{ x: 0, y: 0, zoom: 1, rotation: 0 }`
- `testCanvasWidth` = 800, `testCanvasHeight` = 600

At default viewport: screen(400, 300) → world(0, 0).

Testing approach:
- Test through public API only (`onPointerDown` → `onPointerMove` → `onPointerUp`)
- Assert on callback arguments via `mock.calls[n][0]`, not `toHaveBeenCalledWith` (brittle)
- Recreate tool with `new` in `beforeEach` to prevent state leaks
- Define `createMockCallbacks()` locally per test file (callback types differ across tools)
