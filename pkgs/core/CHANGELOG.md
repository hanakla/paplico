# Changelog

## [Unreleased]

### Added

- **Artboard tool**
  - Alt+drag an artboard to place a copy of it and the elements on it.
  - A dragged artboard snaps to the center lines of the other artboards.
- **Artboards**
  - `PaplicoCommands.duplicateArtboard` copies an artboard and the elements on it. Without an offset, the copy goes to the right of or below the source without overlapping another artboard.
- **Paste**
  - `PaplicoCommands.pasteElements` takes `layerRoot` to paste at the root of a given layer and `select: false` to keep the selection.

### Changed

- **Breaking API changes**
  - `TextRenderer.textElementToPaths` returns `bounds` as a `LocalBBox` instead of a `WorldBBox`. The bounds include the text's position but not its transform.
  - `Paplico.createTimelapsePlayer` returns a Promise instead of the player.
  - A timelapse read from a file keeps every block but the last in `TimelapseData.packedBlocks` instead of in `entries`.
- **Renderer**
  - Panning a zoomed-in document no longer stalls every few frames.
  - The frame after a pan ends no longer stalls.
  - Panning back over filtered elements in a zoomed-in document no longer stalls. Their results may use the part of `gpuCacheBudgetBytes` the other render caches leave unused.
  - Panning near a blur brush stroke no longer slows down.
  - Panning a zoomed-in document near a large clipping group no longer slows down.
  - Panning or editing near an element with `applyToBackdrop` on a filter no longer slows down.
  - Editing an element inside a mesh or used as a mask redraws the whole view instead of only the region around it.
- **Drop shadow filter**
  - Panning over a large drop-shadowed group in a zoomed-in document no longer stalls.
- **Kirakira filter**
  - Panning or zooming a document onto a wide kirakira glow no longer stalls.
  - An exported wide kirakira glow differs from earlier versions by a few levels of 255.
- **Path edit tool**
  - Dragging a vertex no longer stalls on its first frame or on release, and no longer slows down inside a drop-shadowed group.
- **SVG export**
  - An alpha-locked element is exported as an image of only what it paints, instead of turning it and every element under it into one image.
- **Collaboration**
  - `PartyKitCollaboration` connects to a PartyServer host through `y-partyserver` instead of to a PartyKit host through `y-partykit`.

### Fixed

- **Renderer**
  - Fix a filtered element just outside the screen appearing without its filter, or not at all, while panning it into view.
- **Filters**
  - Fix some filtered elements staying blurry after zooming in until the view moves.
  - Fix the drop shadow or another filter of a group not following an element edited inside it.
- **Text tool**
  - Fix a moved, rotated or resized text disappearing after its edit is confirmed.
- **Select tool**
  - Fix a text without a box getting a fixed box when resized, which showed the overflow mark once more characters were typed.
- **Select tool / Paste**
  - Fix a rotated element, or a group with rotated content, landing away from the pointer when Alt+drag duplicated or pasted.
- **SVG export**
  - Fix Illustrator reporting a missing linked file, leaving out the images and dropping some clipping masks when it opens an exported SVG.
  - Fix an alpha-locked element with a blend mode coming out in a different color from the canvas.
- **Extrude / Revolve filters**
  - Fix a glass solid in a hidden layer still showing on the canvas.
- **Layers**
  - Fix deleting a layer leaving the contents of its groups in the document, where a glass solid among them kept showing on the canvas.
- **Compound paths**
  - Fix a hidden source path still taking part in its compound path's shape.
- **Timelapse**
  - Fix opening a document with a long timelapse recording crashing on iPad.

## [0.10.0] - 2026-10-28

### Added

- **Select tool**
  - Hovering an unselected element outlines it.
- **Path edit tool**
  - Hovering an unselected path or element outlines it and shows the path's vertices, and hovering an unselected vertex rings it.
- **Selection**
  - `PaplicoSelection.followLayerOf(elementIds)` makes the frontmost layer holding the elements the current layer.
- **Tools**
  - `Tool.onPointerLeave` is called when the pointer leaves the canvas.
- **Renderer**
  - The `gpuCacheBudgetBytes` option of `Paplico.create` sets how much GPU memory the render caches keep between frames. It defaults to 1600 MiB.

### Changed

- **Breaking API changes**
  - `PaplicoCommands.replacePathWithPaths` takes the path id and the runs instead of a layer id first. The path's own layer is used.
  - `PaplicoSelection.setArtboardEditMode` is removed. Use `PaplicoSelection.selectArtboard(null)` to clear the artboard selection instead.
- **Artboards**
  - Every artboard's edge is always outlined by a black 1px line above the document instead of a gray line shown only while the artboard tool is active.
  - Moving or resizing an artboard no longer gets slower as the document grows.
- **Collaboration / Timelapse**
  - A path's segments and stroke widths are written to a room and a timelapse recording as binary instead of JSON text. Older app versions cannot read the paths this version writes there.
- **Compound paths**
  - Moving a compound path, or a group that holds one, no longer stalls when the move is committed.
- **Eyedropper**
  - Picking a color no longer switches the current layer.
- **Filters**
  - A filtered element inside a group that reaches far past the view no longer slows down drawing, path editing and the frame after a pan.
- **Groups**
  - While a group is being edited, the dimmed document behind it leaves that group out instead of showing a dimmed copy of it.
- **Paths**
  - Editing or committing a long stroke no longer stalls, and each edit adds less to the undo history.
  - Paths and text redraw faster after zooming, rotating or panning by part of a pixel, and a redraw that changes no path is faster too.
- **Renderer**
  - Canvases open side by side split one GPU cache budget instead of each keeping its own.
- **Selection**
  - Selecting an element, on the canvas or in the layer panel, makes its layer the current layer instead of a click on the canvas doing so.

### Fixed

- **Extrude / Revolve filters**
  - Fix a glass solid inside a group with a filter making the whole canvas fail to draw.
  - Fix a glass solid in a group being edited showing the group's other objects refracted inside it.
- **Filters**
  - Fix GPU memory jumping on every zoom step, and staying up after zooming stops, in documents with filtered elements.
- **Path edit tool**
  - Fix Shift+clicking another path to add it selecting every vertex of the paths whose vertices were already selected.
  - Fix clicking the fill of a selected path selecting every vertex of all the selected paths. A click selects that path alone, and a Shift+click takes it out of the selection.
  - Fix cutting or splitting a path outside the current layer leaving the new paths in no layer.
- **Path tool**
  - Fix the outline of a hovered path staying after the pointer leaves the canvas.
  - Fix hovering a path in another layer switching the current layer.
- **Renderer**
  - Fix the canvas looking blurry on high-density displays such as Retina. Backdrop filters, element filters and mix, blur and wet strokes stay as soft as before.

## [0.9.0] - 2026-10-18

### Added

- **Filters**
  - `Paplico.isUsableAsSubFilter(processor)` tells whether a filter can sit under a fill or stroke as a sub-filter. A filter handler declares it with `usableAsSubFilter`.

### Changed

- **Breaking API changes**
  - `createRendererState` is exported from `@paplico/core` instead of `@paplico/core/document`.
  - `FILTER_CATALOG` entries no longer have `canBeSubFilter`. Use `Paplico.isUsableAsSubFilter` instead.
- **Filters**
  - A sub-filter whose processor has no registered handler is rejected instead of added.
- **Geometry utilities**
  - `utils/geometry/` is split by role into `primitives/`, `space/`, `measure/`, `query/`, `generate/` and `reshape/` instead of one flat folder. Imports from `@paplico/core/utils` are unchanged.

## [0.8.0] - 2026-10-18

### Changed

- **Breaking API changes**
  - `PathSegment.cornerRadius` is the radius of the arc rounding the vertex instead of the distance from the vertex to where the rounding meets each edge. Documents saved before are converted when read, so their corners start rounding where they did.
- **Path edit tool**
  - The corner radius handle sits on the midpoint of the rounding arc instead of the corner radius away from the vertex.

### Fixed

- **Rounded corners**
  - Fix a rounded corner sharper or wider than a right angle not keeping a constant curvature. ([hanakla/paplico#3](https://github.com/hanakla/paplico/issues/3))
- **Groups**
  - Fix a filter such as blur or chromatic aberration, or an opacity, on a group resetting the blend modes of its children and of their fills to normal.
  - Fix a filter on an element two or more groups deep being dropped when an outer group has a filter or an opacity.

## [0.7.0] - 2026-10-12

### Added

- **Shape tool**
  - A polygon shape with any number of sides, stretched to fill the dragged box. Set it with `PaplicoTools.setShapeOption({ type: "polygon", sides })`.
  - M steps to a triangle after the rectangle.
  - A star's dent is set by `depth`, from 0, where its inner corners sit on the outline of the regular polygon through its tips, to 1, where they meet at the center.

### Changed

- **Breaking API changes**
  - `PaplicoCommands.commitArtboardMove` takes the elements riding on the artboard and the move delta instead of prebuilt element moves.
  - `ToolSettings.shapeOption` holds the shape and its parameters instead of `ToolSettings.shapeType`.
  - `ShapeToolOptions` takes a `shapeOption` instead of `shapeType`, `starPoints`, `starInnerRatio`, `spiralTurns` and `spiralDirection`.
  - The `"rectangle"` shape type is the 4-sided `"polygon"` instead.
- **Shape tool**
  - A star's first point faces the pointer instead of 90° away from it.
- **Commands**
  - `moveElements` and `commitArtboardMove` skip an element whose group is moved with it instead of moving it twice.
- **Text tool**
  - Picking a character or glyph, placing the caret, highlighting a selection and the overflow badges map a text's flow-chain regions and transform to the canvas through one shared path instead of separate copies.
- **Clip groups**
  - Zooming, and panning past the drawn area, no longer stall on a filtered group that holds a clip group clipped by a compound path.
- **Paths**
  - Panning past the drawn area takes less time on documents with many clip groups or filtered groups.

### Removed

- **Shape tool**
  - `PaplicoTools.setShapeType`. Use `PaplicoTools.setShapeOption` instead.
- **Migrations**
  - The unregistered `20260301_mig_appearance_opacity_blendmode` migration. Missing appearance opacity and blend mode are still filled in when a document, room or preset is read.

### Fixed

- **Soft proof**
  - Fix switching the proof profile while soft proof is on leaving the canvas without the proof until the next edit.
- **Shape tool**
  - Fix Shift turning a star or a spiral only to the diagonals, so a star could not point straight up or down. Shift turns a star's first point or a spiral's outer end straight up, then leans it in 45° steps toward the side the pointer moves to.
- **Path edit tool**
  - Fix the color swatch targeting the previously selected object instead of the objects whose vertices are selected.
- **Compound paths**
  - Fix a compound path disappearing, along with a clip group clipped by it, when its sources cross right by a vertex with a handle on one side only.
- **Artboards**
  - Fix the artboard background turning transparent over the area of an element just drawn, moved or deleted.

## [0.6.0] - 2026-10-04

### Changed

- **Extrude / Revolve filters**
  - Their multisampled scratch textures come from the canvas's texture pool instead of a pool of their own that could hold up to 384 MB each.
- **Filters**
  - The first frame after an export, an autosave or an eyedropper pick no longer stalls while every filtered element is drawn again.
- **Elements**
  - Drawing, adding, deleting, grouping and ungrouping elements no longer get slower as the document grows. This also covers their undo, redo and edits from collaborators.
- **Images**
  - Opening split view or the timelapse player no longer waits for every embedded image to load again.
- **Split view**
  - Typing no longer lays out the text once per canvas.
  - Editing compound paths, group outlines, blends and mesh warps no longer computes their shapes once per canvas.
  - Editing a group dims the rest of the document only in the canvas you are working in instead of in every canvas.

### Fixed

- **Brushes**
  - Fix a brush whose image tip or grain comes from a def stamping a round tip or applying no grain instead of the def's artwork.
- **Layers**
  - Fix an element moved to another layer still being picked from its old layer.
- **Rendering**
  - Fix GPU memory staying allocated after switching documents, deleting elements, or leaving the canvas idle.
- **Export**
  - Fix an artboard export leaving gigabytes of GPU memory allocated until the next edit.
  - Fix an export of a document with a backdrop filter leaving hundreds of megabytes of GPU memory allocated after it finishes.
- **Viewport**
  - Fix the canvas not redrawing, or redrawing only from a stretched stale frame, after `CanvasTarget.setViewport` is called directly.
- **Filters**
  - Fix a filter's effect stopping at an element's old edge after the element's shape changed, until the layer was hidden and shown again.
  - Fix GPU memory growing by gigabytes and textures being reallocated on every edit when a document with a high rasterization DPI has a filter applied to the backdrop.
- **Patterns / Brushes**
  - Fix an export, timelapse playback or a stored revision's preview pages drawing a pattern's old tile, or a brush's old def artwork, after the def was edited.
- **Gradients**
  - Fix every free and mesh gradient on the canvas being generated again after the timelapse player closes, or after a run of eyedropper picks or bucket fills.
- **Groups**
  - Fix a group's own fill or stroke keeping its old outline after a source path of a compound path inside the group is edited.
- **Mesh warp**
  - Fix a warped text that continues a text flow from outside the mesh showing the wrong characters after the flow's first text returns to earlier content, such as by undo.

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
