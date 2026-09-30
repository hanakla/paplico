# Changelog

## [Unreleased]

## [0.3.0] - 2026-10-01

### Added

- `Paplico.wrapDocumentFile(papf)` wraps a stored papf into the same PDF-compatible file as `exportDocumentFile`. The preview pages are drawn from that papf's own document through a throwaway isolated target, so a stored revision never touches the editor's caches.
- `ExportContext.targetId` names the target that `PNGExporter`, `JPEGExporter` and `TIFFExporter` draw artboards through.
- `PaplicoCommands.flipElements(ids, flip)` mirrors a selection in the axes of its selection frame, so a lone rotated element turns over across its own axis. The ActionsPanel's flip buttons use it.
- `PaplicoCommands.updateElementTransforms(updates)` rewrites the transforms of several elements in one undo step so the fields act on each element as it is seen: a change of the rotation, scale or skew fields turns the element around the centre of its local bounds instead of its origin, and a change of `x` and `y` moves it by that much. The ActionsPanel's rotation and skew inputs and the transforms written by automation scripts go through it.
- `placementAnchorIds` option of `PaplicoCommands.pasteElements`. `placement` is resolved against these elements instead of the selection.
- `paplico.tool.shapeCycle` shortcut command, bound to M by default. Each press while the shape tool is active switches to the next shape type. Pressing it from any other tool starts the shape tool at the rectangle.
- A long press or a right click with the eyedropper lists every element painted at that point, front to back, in `toolSession` as `type: "eyedropper-candidates"`. Groups and compound paths are listed when they carry their own appearance. `Paplico.eyedropperPickCandidate` applies the chosen one. A lone candidate is listed too.
- A long press on a point's center handle in the stroke width edit tool deletes the point on release. It works for both the width and the erasure profile. A ring appears once the press is long enough.
- `PaplicoCommands.setElementVisibility(layerId, elementId, visible)` shows or hides an element by an absolute value. A lock does not hold it back.
- `PaplicoCommands.moveElements(elements, deltaX, deltaY)` moves elements by a world delta in one undo step. A locked element is skipped, while what a moved element carries along follows it. The select tool's drag and nudge go through it.
- `PaplicoCommands.writeElement(layerId, elementId, updates)` writes to an element without asking its lock, for an operation whose target was already checked. The tools' deformation commit goes through it.
- `TimelapsePlayer.skipBy(elapsedMs)` moves the playback clock forward the way `advanceBy` does without building the frame, for measuring how long a recording runs.
- `signal` option of `TimelapseExporter.exportMP4`. Aborting it calls the export off: the encoder and the unfinished file are released and the returned promise rejects with the signal's reason.
- The gradient tool can edit any gradient fill of an element that carries several. `ToolSettings.gradientTargetFillUid` names the fill appearance being edited, and `null` stands for the element's first gradient fill. `Paplico.gradientSetTargetFill(uid)` switches it, clears the stop selection and rebuilds the handles. `getGradientFills` and `getGradientTargetFill` in `@paplico/core/utils` list an element's gradient fills and resolve the one being edited.
- `PaplicoCommands.updateGradientTargetFill(fill)` writes a fill to the appearance the gradient tool edits and leaves the element's other fills as they are.
- A drag with the gradient tool that starts away from every handle redraws the selected element's gradient: a linear gradient runs from the press point to the release point, and a radial one becomes a circle centered on the press point that reaches the release point. The stops are kept. A click that does not move still picks or clears the selection, on release.
- `GradientEditUIHandle.screenOffset` places a handle a fixed number of screen pixels away from its world position.
- Dragging the bar of a linear or radial gradient moves the whole gradient by the drag distance. `GradientEditUILine.hitId` makes an overlay line hit-testable.

### Changed

- A locked element or layer can be shown and hidden. `PaplicoCommands.toggleElementVisibility` and `toggleLayerVisibility` no longer stop at a lock on the element, on a group around it or on its layer. A readonly room still blocks them.
- The selection frame of a lone rotated or skewed element tilts with the element. Its handles sit on the element's own box, the rotation handle stands above it along the element's up axis, the resize cursors follow the frame's axes, and a resize drag maps the box along those axes, with the aspect lock and the centre anchor working in them. Snapping applies to world-axis frames only. Any other selection keeps a world-axis frame around its elements.
- `PaplicoCommands.resizeElements(ids, frame, newBounds, flip)` takes the selection frame and maps its box onto `newBounds` in the frame's space. Each element takes that map in its own space: a rotated path keeps its rotation and bakes the map into its coordinates, a container hands it down to its content, an image, a 3D reference or a text scales its rect by the map's axis factors and folds the mirror, turn or shear that is left into its transform, and a mesh or repeat folds the map whole. A compound path or blend keeps its own transform instead of cancelling its chain.
- `SelectionUIData` carries the frame's corners as `quad`, drawn as a closed polyline, and no longer carries `rotation` and `rotationCenter`.
- `ElementTransform` is an affine matrix on the element's local origin: a local point lands at `L·p + (x, y)`. Every element used to turn and scale around a pivot of its own, the centre of its bounds for most kinds, and a group's children each around their own pivot. Containers now place their content by plain composition, mask content included, so editing an element's geometry no longer moves the point it turns around, and a group's rotation stays on the group. Rotation, resize and skew from the canvas fold their pivot into the translation. Migration `20260929` rewrites every stored transform so documents are drawn where they were; a rotated or scaled text is placed by its measured layout, which the migration context supplies.
- Timelapse playback and MP4 export reuse the filter results of elements that did not change since the previous frame. A recording with many filtered elements no longer slows down toward its end.
- `TimelapsePlayer` hands out `TimelapseFrame`, the replayed document together with the elements that changed since the frame before it. `onFrame`, `advanceBy` and `restart` pass it instead of a bare `Document`. `TimelapsePreviewSurface.render` and `renderToImageData` take it in place of the document.
- `TimelapsePreviewSurface.renderToImageData` also shows the frame on the preview canvas, fitted inside it, so an MP4 export shows the frame it is encoding. The canvas used to stay on the last playback frame for the whole export.
- Timelapse playback draws through the export render: the artboard fitted inside the preview on white, with nothing drawn beside it. Elements of a neighbouring artboard used to show in the preview's side bars. An artboard's own fill is no longer painted in playback, which matches the exported video. `TimelapsePreviewSurface.render` returns a promise for the frame.
- `paplico.tool.shapeRect` no longer has a default key. M is bound to `paplico.tool.shapeCycle` instead.
- An eyedropper click picks on release instead of on press, so it can be told apart from a long press.
- The gradient tool takes an element whose first fill is solid when a later fill is a gradient. It used to look at the first fill only. An element whose fills are solid or pattern only is no longer selected by it.
- `PaplicoCommands.deleteSelectedGradientStop` removes the stop from the fill the gradient tool edits instead of the element's first fill.
- The start and end handles of a linear gradient sit 12 screen pixels outside the end stops at any zoom. They used to sit 16 world units out, which drifted away from the stops as the view zoomed in.
- The center, radius and rotation handles of a radial gradient sit 12 screen pixels away from the stops at any zoom, and a drag on the center or a radius handle moves it by the drag distance. They used to sit 24 world units away, which drifted as the view zoomed in, and the first move snapped the center or the radius to the cursor.
- A radial gradient has no rotation handle any more. Dragging its end point sets the radius and the angle at once, and the ellipse keeps its shape while it grows or shrinks. The handle on the rotated Y axis still sets the other radius.
- A blur whose radius reaches 8 texels at the document's rasterization DPI is computed through the same blur pyramid the drop shadow uses, so its cost no longer grows with the radius. A radius of 72 on a 300 DPI document used to read about 300 texels per pixel and pass.
- Every long press in the tools takes 400ms. The mesh deform tool, the eyedropper and the pen's color pick used to wait 500ms, while the path edit tool waited 400ms.
- `GRADIENT_MAP_PRESET_STOPS` holds its stop colors as HSV. The colors themselves are unchanged. They used to be RGB.

### Fixed

- A locked element follows a change made to its container. Moving or aligning a blend used to leave a locked source behind, resizing a group, a compound path or a blend used to leave a locked child at its old size, and the free transform tool's warp used to leave a locked child of a group unwarped. A lock now stops only changes aimed at the element itself: it is checked once, on the operation's target, and not again on the content the operation reaches through it.
- The mesh deform tool works on a group that holds a locked child. It used to ignore every press.
- A text bound to a locked path can be moved. The path moves with it; the move used to do nothing.
- An element with a raster filter inside a group keeps its filtered bake across frames, the way a top-level element does. Its filter chain used to run again on every pan frame and on every frame of a pen stroke drawn anywhere in the document.
- A text keeps its measured layout bounds through a move or a transform edit. They used to fall back to the estimate, which shifted the selection frame, and a rotation typed into the ActionsPanel left the frame where the text no longer was.
- `ungroupElements` and `extractChildFromGroup` keep the children where they were drawn. The group's transform, and for an extracted child every ancestor's, moves into each child. The children used to lose the rotation, skew or offset of the group they left.
- Undoing the deletion of an element whose fields were changed in the same undo step now sends those fields to collaborators and the timelapse recording. They used to lose them, which left the restored element unreadable. yjs is upgraded to 13.6.33 for this.
- Timelapse playback leaves out an element it cannot read instead of stopping with an error.
- An MP4 export no longer rebuilds the document at every step while it measures the recording's length before the first frame. On a recording made before `20260929` each of those steps migrated the whole document, which kept the export from starting for a long time.
- Alt+drag duplicates with the select tool and the path edit tool land right in front of the frontmost source instead of on top of the layer. `duplicateElementsByIds` stacks its copies the same way.
- A drop shadow follows the alpha of its shadow color. The shadow's strength is the shadow opacity multiplied by that alpha. The alpha used to be ignored, so a half-transparent shadow color cast a full shadow.
- An element whose filter is applied to the backdrop now shows the backdrop in the shape its geometry filters produce. Geometry filters on its enclosing groups apply too.
- An element with a raster filter such as blur inside a group with geometry filters is drawn in the shape the group deforms, instead of at its undeformed position.
- Raster filters placed after a backdrop filter now reach past the element's shape. A drop shadow after frost glass is drawn, and a blur after it softens the pane's edge. They used to be cut off at the shape.
- A drop shadow on a group is drawn beneath the group, and the group's children are then drawn the way they are without it. Their blend modes composite against the document and the shadow. The group used to be baked into one texture, where a child's blend mode, and a blend mode set on one of its fills, fell back to normal. This applies to a group whose only raster filter is the drop shadow and that has normal blending, full opacity and no clip or mask of its own. Any other filtered group is still drawn from its bake.
- A hidden element inside a group that is drawn from a bake stays hidden. A raster filter, an opacity or a mask on the group used to draw it.
- Gradient buffers that a later draw replaces are released after the frame is submitted. An element drawn twice in one frame at different scales used to fail the submit with "used in submit while destroyed".
- Clicks, rectangle selection, eyedropper candidates and clip paths inside a rotated or scaled group now hit the children where they are drawn. They used to miss parts of a child and hit empty space beside it.
- The bounds of a rotated or scaled group now enclose its children where they are drawn. The selection box, snapping and hit candidates of such a group used to be shifted away from its content.
- A path with two gradient fills, or two gradient strokes, renders both. Each appearance now owns its gradient buffers. The second used to take over the first one's buffers within the same frame and destroy them, which failed the frame's submit with "used in submit while destroyed".
- Color adjustment reaches texts and the content of a mesh. `startAdjustColorSession` collects and adjusts the fill and stroke of a text's default style and of each run, and walks into a mesh's children. A selection mixing these with paths used to change the paths only.
- Dragging a gradient handle previews the change on the fill being edited only. Every fill of the element used to show the dragged gradient until the drag ended.

## [0.2.0] - 2026-09-27

### Added

- `fontLoaders` option of `Paplico.create`. Text fonts resolve through the `FontLoader`s it lists, and the host app can add its own by extending the abstract `FontLoader` class. No loader is registered by default.
- `paplico.fonts`, the `FontManager` each Paplico instance owns.
- `LocalFontBackend` and `FontData` types in `/typography`, and `DomLocalFontBackend` in `/infra`, for building a `LocalFontsLoader` on any platform.
- `Paplico.connectCollaboration(factory, { document })` attaches a collaboration transport. `factory` receives the Y.Doc to sync. `document: "fromRemote"` discards the local document so the room's state is adopted as-is. `document: "keepForRemote"` keeps it, merges it with the room and removes layers listed twice once the transport reports sync.
- `CollaborationBase` in `/collaboration`, the base class a collaboration transport extends. A host app can implement its own transport with it.
- `@paplico/core/export` entry. It holds one exporter class per output format, `PNGExporter`, `JPEGExporter`, `AvifHdrExporter`, `PSDExporter`, `TIFFExporter` and `SVGExporter`, and the `IExporter`, `ExportContext`, `ExportRenderer` and `ExportResult` types. Each class takes its settings in the constructor.
- `Paplico.exportArtboard(exporter, artboardId)` exports an artboard through any `IExporter`, so a host app can add its own output format.
- `Paplico.renderElementsToPNG(elementIds, document, options)` renders elements to a PNG sized to their filter-expanded bounds.
- `Paplico.activateCanvasTarget(targetId)` makes a canvas target the active one, and the `activeCanvasTargetChange` event reports the switch. Removing the active target emits it with `null`, which means the primary target serves as the active one.

### Changed

- `FontSource` is `{ loaderId, fontId }`. Documents saved earlier are migrated when opened.
- `Paplico.importDocument` throws `PaplicoError` with the code `DOCUMENT_OPEN_WHILE_CONNECTED` while a collaboration transport is attached. The transport would otherwise keep syncing the discarded Y.Doc, and edits would stop reaching the room without any error.
- With several canvas targets, only the active target draws tool overlays such as handles, the brush cursor, snap lines and selection outlines. A press on another target activates it before reaching the tool. Hovering no longer switches the active target, and hover moves and tool wheel input on inactive targets are ignored. Plain wheel pan and zoom still work on every target.

### Removed

- `getFontManager` and the `googleFontsApiKey` option of `Paplico.create`. Pass a `GoogleFontsLoader` in `fontLoaders` instead.
- `/infra/localfonts.tauri` and the `@tauri-apps/api` and `tauri-plugin-system-fonts-api` dependencies. A Tauri app implements `LocalFontBackend` itself.
- `Paplico.setCollaboration` and the `collaboration` option of `Paplico.create`. Use `connectCollaboration` instead.
- The `exporter`, `psdExporter`, `tiffExporter` and `svgExporter` properties of `Paplico`. Pass an exporter from `/export` to `exportArtboard` instead.

### Fixed

- Resizing a group no longer moves a rotated compound path or blend inside it away from the rest of the group.
- A stroke that ends within 100ms of pen-down keeps its pressure when the pen lifts off. It used to commit at a flat width, unlike its preview.
- With several canvas targets, a paste or a keyboard shortcut runs once instead of once per target.
- `clipPathId` is stored as a plain string by every Yjs reader and writer. Deleting a middle anchor with the path edit tool in a document with a clip group no longer leaves the original path behind.
- Inside an editing scope, hit tests answer only on the layer that holds the scope element. The current layer no longer jumps to the topmost visible layer, and deleting a middle anchor with the path edit tool no longer makes the whole path disappear.

## [0.1.0] - 2026-09-26

### Added

- First release of the Paplico drawing engine as a standalone package: document model, WebGPU renderer, drawing tools, filters, typography, papf I/O and collaboration transports.
- Entry points: `@paplico/core` (the `Paplico` facade, errors and shortcuts), `/schema`, `/document`, `/brush`, `/collaboration`, `/color`, `/io`, `/tools`, `/timelapse`, `/typography`, `/filters`, `/utils` and `/infra`.
- `/infra/localfonts.tauri` for the Tauri local font backend, kept out of `/infra` so browser bundles never load `@tauri-apps/*`.
- `/three-webgpu-compat`, the target for a bundler alias of `three` so three.js and `@pixiv/three-vrm` share one WebGPU build.
- `fallbackFontUrl` option of `Paplico.create` names where the built-in Noto Sans JP fallback font is served. The package fetches no app-specific URL on its own.
- `registerForHotReload(paplico)` marks the instance that development hot reloads re-attach to.
- `CollaborationConfig.relayHost` names the PartyKit host for the cloud and end-to-end encrypted transports. The package reads no environment variables, so the host application passes it in.
- `pngjs` is an optional peer dependency. It is loaded only for the PNG decode fallback when running on Node WebGPU.
