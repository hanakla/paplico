# Changelog

## [Unreleased]

### Added

- `PaplicoCommands.flipElements(ids, flip)` mirrors a selection in the axes of its selection frame, so a lone rotated element turns over across its own axis. The ActionsPanel's flip buttons use it.
- `PaplicoCommands.updateElementTransforms(updates)` rewrites the transforms of several elements in one undo step so the fields act on each element as it is seen: a change of the rotation, scale or skew fields turns the element around the centre of its local bounds instead of its origin, and a change of `x` and `y` moves it by that much. The ActionsPanel's rotation and skew inputs and the transforms written by automation scripts go through it.
- `placementAnchorIds` option of `PaplicoCommands.pasteElements`. `placement` is resolved against these elements instead of the selection.
- `paplico.tool.shapeCycle` shortcut command, bound to M by default. Each press while the shape tool is active switches to the next shape type. Pressing it from any other tool starts the shape tool at the rectangle.
- A long press or a right click with the eyedropper lists every element painted at that point, front to back, in `toolSession` as `type: "eyedropper-candidates"`. Groups and compound paths are listed when they carry their own appearance. `Paplico.eyedropperPickCandidate` applies the chosen one. A lone candidate is listed too.
- A long press on a point's center handle in the stroke width edit tool deletes the point on release. It works for both the width and the erasure profile. A ring appears once the press is long enough.

### Changed

- The selection frame of a lone rotated or skewed element tilts with the element. Its handles sit on the element's own box, the rotation handle stands above it along the element's up axis, the resize cursors follow the frame's axes, and a resize drag maps the box along those axes, with the aspect lock and the centre anchor working in them. Snapping applies to world-axis frames only. Any other selection keeps a world-axis frame around its elements.
- `PaplicoCommands.resizeElements(ids, frame, newBounds, flip)` takes the selection frame and maps its box onto `newBounds` in the frame's space. Each element takes that map in its own space: a rotated path keeps its rotation and bakes the map into its coordinates, a container hands it down to its content, an image, a 3D reference or a text scales its rect by the map's axis factors and folds the mirror, turn or shear that is left into its transform, and a mesh or repeat folds the map whole. A compound path or blend keeps its own transform instead of cancelling its chain.
- `SelectionUIData` carries the frame's corners as `quad`, drawn as a closed polyline, and no longer carries `rotation` and `rotationCenter`.
- `ElementTransform` is an affine matrix on the element's local origin: a local point lands at `L·p + (x, y)`. Every element used to turn and scale around a pivot of its own, the centre of its bounds for most kinds, and a group's children each around their own pivot. Containers now place their content by plain composition, mask content included, so editing an element's geometry no longer moves the point it turns around, and a group's rotation stays on the group. Rotation, resize and skew from the canvas fold their pivot into the translation. Migration `20260929` rewrites every stored transform so documents are drawn where they were; a rotated or scaled text is placed by its measured layout, which the migration context supplies.
- Timelapse playback and MP4 export reuse the filter results of elements that did not change since the previous frame. A recording with many filtered elements no longer slows down toward its end.
- `TimelapsePlayer` hands out `TimelapseFrame`, the replayed document together with the elements that changed since the frame before it. `onFrame`, `advanceBy` and `restart` pass it instead of a bare `Document`. `TimelapsePreviewSurface.render` and `renderToImageData` take it in place of the document.
- `paplico.tool.shapeRect` no longer has a default key. M is bound to `paplico.tool.shapeCycle` instead.
- An eyedropper click picks on release instead of on press, so it can be told apart from a long press.
- A blur whose radius reaches 8 texels at the document's rasterization DPI is computed through the same blur pyramid the drop shadow uses, so its cost no longer grows with the radius. A radius of 72 on a 300 DPI document used to read about 300 texels per pixel and pass.
- Every long press in the tools takes 400ms. The mesh deform tool, the eyedropper and the pen's color pick used to wait 500ms, while the path edit tool waited 400ms.

### Fixed

- An element with a raster filter inside a group keeps its filtered bake across frames, the way a top-level element does. Its filter chain used to run again on every pan frame and on every frame of a pen stroke drawn anywhere in the document.
- A text keeps its measured layout bounds through a move or a transform edit. They used to fall back to the estimate, which shifted the selection frame, and a rotation typed into the ActionsPanel left the frame where the text no longer was.
- `ungroupElements` and `extractChildFromGroup` keep the children where they were drawn. The group's transform, and for an extracted child every ancestor's, moves into each child. The children used to lose the rotation, skew or offset of the group they left.
- Undoing the deletion of an element whose fields were changed in the same undo step now sends those fields to collaborators and the timelapse recording. They used to lose them, which left the restored element unreadable. yjs is upgraded to 13.6.33 for this.
- Timelapse playback leaves out an element it cannot read instead of stopping with an error.
- Alt+drag duplicates with the select tool and the path edit tool land right in front of the frontmost source instead of on top of the layer. `duplicateElementsByIds` stacks its copies the same way.
- An element whose filter is applied to the backdrop now shows the backdrop in the shape its geometry filters produce. Geometry filters on its enclosing groups apply too.
- An element with a raster filter such as blur inside a group with geometry filters is drawn in the shape the group deforms, instead of at its undeformed position.
- Raster filters placed after a backdrop filter now reach past the element's shape. A drop shadow after frost glass is drawn, and a blur after it softens the pane's edge. They used to be cut off at the shape.
- Clicks, rectangle selection, eyedropper candidates and clip paths inside a rotated or scaled group now hit the children where they are drawn. They used to miss parts of a child and hit empty space beside it.
- The bounds of a rotated or scaled group now enclose its children where they are drawn. The selection box, snapping and hit candidates of such a group used to be shifted away from its content.
- A path with two gradient fills, or two gradient strokes, renders both. Each appearance now owns its gradient buffers. The second used to take over the first one's buffers within the same frame and destroy them, which failed the frame's submit with "used in submit while destroyed".

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
