# Changelog

## [Unreleased]

### Changed

- **Extrude / Revolve filters**
  - Their multisampled scratch textures come from the canvas's texture pool instead of a pool of their own that could hold up to 384 MB each.
- **Elements**
  - Drawing, adding, deleting, grouping and ungrouping elements no longer get slower as the document grows. This also covers their undo, redo and edits from collaborators.
- **Images**
  - Opening split view or the timelapse player no longer waits for every embedded image to load again.
- **Text**
  - Typing in split view no longer lays out the text once per canvas.

### Fixed

- **Brushes**
  - Fix a brush whose image tip or grain comes from a def stamping a round tip or applying no grain instead of the def's artwork.
- **Layers**
  - Fix an element moved to another layer still being picked from its old layer.
- **Rendering**
  - Fix GPU memory staying allocated after switching documents, deleting elements, or leaving the canvas idle.
- **Export**
  - Fix an artboard export leaving gigabytes of GPU memory allocated until the next edit.
- **Viewport**
  - Fix the canvas not redrawing, or redrawing only from a stretched stale frame, after `CanvasTarget.setViewport` is called directly.
- **Filters**
  - Fix a filter's effect stopping at an element's old edge after the element's shape changed, until the layer was hidden and shown again.
  - Fix GPU memory growing by gigabytes and textures being reallocated on every edit when a document with a high rasterization DPI has a filter applied to the backdrop.
- **Patterns**
  - Fix an export, timelapse playback or a stored revision's preview pages drawing a pattern's old tile after the tile was edited.
- **Gradients**
  - Fix every free and mesh gradient on the canvas being generated again after the timelapse player closes.

## [0.5.0] - 2026-10-03

### Added

- **Path edit tool**
  - Shift+drag locks anchors, path faces, whole elements and control points to 45° steps from the press point.
  - Selected anchors get a padded frame whose handles scale and rotate those anchors with their control points, as the Select tool's frame does.
- **API**
  - `calculateResizedBounds` takes an `aspectDriver` option that picks the axis whose size sets the other under `constrainAspect`.
- **E2EE collaboration**
  - `E2EECollaboration` emits `messageRejected` with the error when a message from a peer cannot be applied.
- **Clipboard**
  - `Paplico` emits `clipboardWriteFailed` with the error when a copy or cut cannot write to the system clipboard.

### Changed

- **Clipboard**
  - A cut whose clipboard write fails keeps the selected elements instead of deleting them.
- **Select tool / Path edit tool / Gradient tool**
  - The outline traced along a selected shape is 1px wide instead of 2px.
- **Outline**
  - `outlineElements` turns a compound path with no vector stroke into one path of its combined shape instead of leaving it unchanged. `canOutlineStrokes` accepts every compound path.

### Fixed

- **Select tool / Path edit tool**
  - Fix an Alt+drag copy starting 10 units away from its original and lagging behind the pointer.
- **Compound paths**
  - Fix a self-crossing source with a handle only on one side of a vertex making the whole compound path disappear.
- **Select tool**
  - Fix a resize dropping the Shift aspect lock and the Alt centre anchor when an edge snaps.
- **Object masks**
  - Fix a Repeat object inside an object mask hiding the mask's owner.
- **Cloud collaboration**
  - Fix `PartyKitCollaboration` never sending `roomToken` to the relay.
- **E2EE collaboration**
  - Fix one message that fails to apply stopping `E2EECollaboration` from processing every message after it.
- **Flip**
  - Fix `flipElements` on a single rotated element mirroring it across its own tilted axis instead of the screen's.
- **Filters**
  - Fix the color correction filter coloring the transparent area around its element and skewing the color of semi-transparent pixels.
  - Fix the gradient map, posterization and color replacement filters skewing the color of semi-transparent pixels.
- **Backdrop filters**
  - Fix the elements above a backdrop-filter element in the same group not being drawn.

## [0.4.0] - 2026-10-01

### Added

- **SVG export**
  - `SVGExporter` takes a `disableIncompatibleFilters` option that exports the artboard as if every filter SVG cannot hold were turned off. The document itself is not modified.

### Changed

- **SVG export**
  - `SVGExporter` exports a path or compound path as vectors even when a fill or stroke has its own blend mode or sub-filters. A sub-filter with no SVG equivalent still rasterizes the element.
  - `ExportRenderer` now includes `dropDocumentCaches`.

## [0.3.0] - 2026-10-01

### Added

- **Gradient tool**
  - The tool edits any gradient fill of an element that has several.
    - `ToolSettings.gradientTargetFillUid` names the edited fill. `null` means the first gradient fill.
    - `Paplico.gradientSetTargetFill(uid)` switches the edited fill.
    - `getGradientFills` and `getGradientTargetFill` in `@paplico/core/utils` list an element's gradient fills and resolve the edited one.
    - `PaplicoCommands.updateGradientTargetFill(fill)` writes only to the edited fill.
  - A drag away from every handle redraws the selected element's gradient from the press point to the release point. The stops are kept.
  - Dragging the bar of a linear or radial gradient moves the whole gradient. `GradientEditUILine.hitId` makes an overlay line hit-testable.
  - `GradientEditUIHandle.screenOffset` places a handle a fixed number of screen pixels away from its world position.
- **Eyedropper**
  - A long press or a right click lists every element painted at that point. The list appears front to back in `toolSession` as `type: "eyedropper-candidates"`.
    - Groups and compound paths are listed when they carry their own appearance.
    - `Paplico.eyedropperPickCandidate` applies the chosen candidate.
- **Stroke width edit tool**
  - A long press on a point's centre handle deletes the point. It works on both the width profile and the erasure profile.
- **Shortcuts**
  - `paplico.tool.shapeCycle`, bound to M, switches the shape tool to the next shape type. From another tool it starts the shape tool at the rectangle.
- **Commands**
  - `PaplicoCommands.flipElements(ids, flip)` mirrors a selection along the axes of its selection frame.
  - `PaplicoCommands.updateElementTransforms(updates)` rewrites the transforms of several elements in one undo step. Rotation, scale and skew turn each element around the centre of its local bounds.
  - `PaplicoCommands.moveElements(elements, deltaX, deltaY)` moves elements by a world delta in one undo step and skips locked elements.
  - `PaplicoCommands.setElementVisibility(layerId, elementId, visible)` shows or hides an element regardless of its lock.
  - `PaplicoCommands.writeElement(layerId, elementId, updates)` writes to an element without checking its lock.
  - `PaplicoCommands.pasteElements` takes a `placementAnchorIds` option that resolves `placement` against these elements instead of the selection.
- **Document file**
  - `Paplico.wrapDocumentFile(papf)` wraps a stored papf into the same PDF-compatible file as `exportDocumentFile`. It leaves the editor's caches untouched.
- **Export**
  - `ExportContext.targetId` names the target through which `PNGExporter`, `JPEGExporter` and `TIFFExporter` draw artboards.
- **Timelapse**
  - `TimelapsePlayer.skipBy(elapsedMs)` advances the playback clock without building the frame.
  - `TimelapseExporter.exportMP4` takes a `signal` option that cancels the export. The returned promise rejects with the signal's reason.

### Changed

- **Breaking API changes**
  - `ElementTransform` is an affine matrix on the element's local origin instead of a transform around a per-element pivot. A local point `p` lands at `L·p + (x, y)`.
    - Migration `20260929` rewrites stored transforms so documents render where they did. It reads the measured layout of rotated or scaled texts from the migration context.
  - `PaplicoCommands.resizeElements(ids, frame, newBounds, flip)` takes the selection frame and maps its box onto `newBounds` in the frame's space.
  - `SelectionUIData` carries the frame's corners as `quad` instead of `rotation` and `rotationCenter`.
  - `TimelapsePlayer` hands out `TimelapseFrame` instead of a bare `Document`. A frame holds the replayed document and the elements changed since the previous frame.
    - `onFrame`, `advanceBy` and `restart` pass a `TimelapseFrame`.
    - `TimelapsePreviewSurface.render` and `renderToImageData` take a `TimelapseFrame`.
    - `TimelapsePreviewSurface.render` returns a promise.
  - M is bound to `paplico.tool.shapeCycle` instead of `paplico.tool.shapeRect`. `paplico.tool.shapeRect` has no default key.
  - `GRADIENT_MAP_PRESET_STOPS` holds its stop colors as HSV instead of RGB.
- **Select tool**
  - The selection frame of a lone rotated or skewed element tilts with the element instead of staying world-aligned. Snapping is off for a tilted frame.
- **Locks**
  - `toggleElementVisibility` and `toggleLayerVisibility` work on locked elements and layers. A readonly room still blocks them.
- **Gradient tool**
  - The tool selects an element whose gradient is not its first fill. An element with only solid or pattern fills is no longer selected.
  - `PaplicoCommands.deleteSelectedGradientStop` removes the stop from the edited fill instead of the first fill.
  - Handles keep 12 screen pixels away from the stops at any zoom.
  - A radial centre or radius handle moves by the drag distance instead of snapping to the cursor.
  - A radial gradient has no rotation handle. Dragging its end point sets the radius and the angle at once.
- **Tools**
  - Every long press takes 400ms. The mesh deform tool, the eyedropper and the pen's color pick used to take 500ms.
- **Eyedropper**
  - A click picks on release instead of on press.
- **Filters**
  - A blur no longer gets slower as its radius grows. This applies once the radius reaches 8 texels at the document's rasterization DPI.
- **Timelapse**
  - Playback and MP4 export no longer slow down toward the end of a recording with many filtered elements.
  - Playback draws the artboard the way the exported video does: fitted on white, without its own fill or a neighbouring artboard.
  - `TimelapsePreviewSurface.renderToImageData` also shows the frame on the preview canvas, so an MP4 export shows the frame it encodes.

### Fixed

- **SVG export**
  - Fix content under a blended alpha-locked or backdrop-reading element turning see-through.
  - Fix content stacked over an alpha-locked or backdrop-reading element being hidden by its rasterized area.
- **Locked elements**
  - Fix a locked element staying behind when its container is moved, aligned, resized or warped. A lock now blocks only operations aimed at the element itself.
  - Fix moving a text bound to a locked path doing nothing. The path now moves with the text.
- **Mesh deform tool**
  - Fix the tool ignoring presses on a group that holds a locked child.
- **Groups**
  - Fix `ungroupElements` and `extractChildFromGroup` dropping the rotation, skew or offset of the enclosing groups from the children.
- **Select tool**
  - Fix hit tests inside a rotated or scaled group missing parts of a child. This covers clicks, rectangle selection, eyedropper candidates and clip paths.
  - Fix the selection box, snapping and hit candidates of a rotated or scaled group being offset from its content.
- **Select tool / Path edit tool**
  - Fix Alt+drag duplicates landing on top of the layer instead of in front of the frontmost source. `duplicateElementsByIds` stacks its copies the same way.
- **Text**
  - Fix a text's selection frame drifting away from the text after a move or a transform edit.
- **Filters**
  - Fix an element with a raster filter inside a group re-running its filters on every pan frame and every pen stroke frame.
  - Fix a drop shadow ignoring the alpha of its shadow color. The shadow's strength is now the shadow opacity multiplied by that alpha.
  - Fix a backdrop filter ignoring the geometry filters of its element and of enclosing groups.
  - Fix a raster filter such as blur ignoring the geometry filters of an enclosing group.
  - Fix raster filters placed after a backdrop filter being cut off at the element's shape.
  - Fix a drop shadow on a group resetting the blend modes of its children to normal. This applies to a group whose only raster filter is the drop shadow, with normal blending, full opacity and no clip or mask of its own.
  - Fix a hidden element becoming visible inside a group that has a raster filter, an opacity or a mask.
- **Gradients**
  - Fix "used in submit while destroyed" when an element is drawn twice in one frame at different scales.
  - Fix "used in submit while destroyed" on a path with two gradient fills or two gradient strokes.
- **Gradient tool**
  - Fix a handle drag previewing the change on every fill of the element.
- **Color adjustment**
  - Fix color adjustment skipping texts and mesh content.
- **Collaboration**
  - Fix undoing an element's deletion sending an unreadable element to collaborators and the timelapse recording. yjs is upgraded to 13.6.33 for this fix.
- **Timelapse**
  - Fix playback stopping with an error at an unreadable element. Playback now leaves that element out.
  - Fix an MP4 export taking a long time to start on recordings made before `20260929`.

## [0.2.0] - 2026-09-27

### Added

- **Fonts**
  - `Paplico.create` takes a `fontLoaders` option listing the `FontLoader`s that resolve text fonts. No loader is registered by default.
  - A host app can add its own font loader by extending the abstract `FontLoader` class.
  - `paplico.fonts` is the instance's `FontManager`.
  - `LocalFontBackend` and `FontData` in `/typography` and `DomLocalFontBackend` in `/infra` build a `LocalFontsLoader` on any platform.
- **Collaboration**
  - `Paplico.connectCollaboration(factory, { document })` attaches a collaboration transport.
    - `document: "fromRemote"` discards the local document.
    - `document: "keepForRemote"` merges the local document into the room.
  - `CollaborationBase` in `/collaboration` is the base class for a host app's own transport.
- **Export**
  - `@paplico/core/export` entry.
    - Exporters: `PNGExporter`, `JPEGExporter`, `AvifHdrExporter`, `PSDExporter`, `TIFFExporter` and `SVGExporter`. Each takes its settings in the constructor.
    - Types: `IExporter`, `ExportContext`, `ExportRenderer` and `ExportResult`.
  - `Paplico.exportArtboard(exporter, artboardId)` exports an artboard through any `IExporter`.
  - `Paplico.renderElementsToPNG(elementIds, document, options)` renders elements to a PNG sized to their filter-expanded bounds.
- **Canvas targets**
  - `Paplico.activateCanvasTarget(targetId)` makes a canvas target active. The `activeCanvasTargetChange` event reports the switch, with `null` when the active target is removed.

### Changed

- **Breaking API changes**
  - `FontSource` is `{ loaderId, fontId }`. Documents saved earlier are migrated when opened.
  - `Paplico.importDocument` throws `PaplicoError` with the code `DOCUMENT_OPEN_WHILE_CONNECTED` while a collaboration transport is attached.
- **Canvas targets**
  - Only the active target draws tool overlays such as handles, the brush cursor, snap lines and selection outlines.
  - A press activates a target. Hovering no longer does.
  - Inactive targets ignore hover moves and tool wheel input. Plain wheel pan and zoom still work on every target.

### Removed

- **Fonts**
  - `getFontManager`. Use `paplico.fonts` instead.
  - The `googleFontsApiKey` option of `Paplico.create`. Pass a `GoogleFontsLoader` in `fontLoaders` instead.
  - `/infra/localfonts.tauri` and the `@tauri-apps/api` and `tauri-plugin-system-fonts-api` dependencies. Implement `LocalFontBackend` in the Tauri app instead.
- **Collaboration**
  - `Paplico.setCollaboration` and the `collaboration` option of `Paplico.create`. Use `connectCollaboration` instead.
- **Export**
  - The `exporter`, `psdExporter`, `tiffExporter` and `svgExporter` properties of `Paplico`. Pass an exporter from `/export` to `exportArtboard` instead.

### Fixed

- **Pen**
  - Fix a stroke that ends within 100ms of pen-down being committed at a flat width.
- **Path edit tool**
  - Fix deleting a middle anchor in a document with a clip group leaving the original path behind.
  - Fix deleting a middle anchor inside an editing scope making the whole path disappear.
- **Editing scope**
  - Fix the current layer jumping to the topmost visible layer inside an editing scope.
- **Select tool**
  - Fix resizing a group moving a rotated compound path or blend inside it away from the rest of the group.
- **Canvas targets**
  - Fix a paste or a keyboard shortcut running once per canvas target.

## [0.1.0] - 2026-09-26

### Added

- First release of the Paplico drawing engine as a standalone package.
- **Entry points**
  - `@paplico/core` holds the `Paplico` facade, errors and shortcuts.
  - `/schema`, `/document`, `/brush`, `/collaboration`, `/color`, `/io`, `/tools`, `/timelapse`, `/typography`, `/filters`, `/utils` and `/infra`.
  - `/infra/localfonts.tauri` holds the Tauri local font backend.
  - `/three-webgpu-compat` is the target for a bundler alias of `three`.
- **Host configuration**
  - `Paplico.create` takes a `fallbackFontUrl` option that names where the built-in Noto Sans JP fallback font is served.
  - `CollaborationConfig.relayHost` names the PartyKit host for the cloud and end-to-end encrypted transports.
  - `registerForHotReload(paplico)` marks the instance that development hot reloads re-attach to.
- **Dependencies**
  - `pngjs` is an optional peer dependency for the PNG decode fallback on Node WebGPU.
