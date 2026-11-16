# Changelog

## [Unreleased]

### Changed

- **Tools**
  - Committing a text with Escape or Cmd/Ctrl+Enter switches to the select tool instead of staying in the text tool.
- **Document**
  - Paste to front and paste to back put elements copied from an artboard at the same spot on the artboard last pressed instead of where they were copied from. A press outside every artboard makes them paste where they were copied from.

## [0.11.0] - 2026-11-16

### Added

- **Tools**
  - **Artboard tool**
    - Alt+drag an artboard to place a copy of it and the elements on it.
    - A dragged artboard snaps to the center lines of the other artboards.
  - **Path edit tool**
    - Sculpt mode reshapes the selected paths by a freehand stroke: a stroke that starts inside a path adds the region it encloses, and one that starts outside carves that region away. `PaplicoTools.setPathEditMode("sculpt")` turns it on.
      - An open path with a fill that shows is reshaped as the region its joined ends enclose and comes out closed. An open path without one stays a line that follows the stroke between the places the stroke crosses it.
      - The corners where the stroke meets the path are rounded in proportion to the gap between them, and the path keeps its direction, pressure and tilt.
      - The stroke is smoothed with the pen tool's `stabilization` and `smoothingMethod` settings.
- **Elements**
  - A grid repeat takes `rowFlip` and `columnFlip`, which mirror every other row or column.
  - A radial gradient takes `focalX` and `focalY`, the point it starts from.
  - Every element type takes `isGuide`, not only paths. A guide group makes every element inside it a guide.
  - `PaplicoCommands.makeGuides` and `PaplicoCommands.releaseGuides` turn the given unlocked elements into guides and back in one undo step.
- **Text**
  - A text style takes `textOrientation`. `"mixed"` lays Latin and other proportional characters on their side in vertical writing.
  - `SelectionStyleSummary.fontVariations` holds the variable font axis values of the selected text. It updates when the font of the selection finishes loading.
- **Color**
  - Add the `hue`, `saturation`, `color` and `luminosity` blend modes.
  - The `knockout` composition mode makes an element replace what is under it inside its parent instead of showing it through its own transparency.
  - `createCmykToRgbConverter` in `@paplico/core/color` converts CMYK to RGB through a CMYK profile, or, when there is no profile, approximates a coated offset press with colors sampled from the FOGRA39L coated profile (zlib/libpng license).
- **Document**
  - `PaplicoCommands.duplicateArtboard` copies an artboard and the elements on it. Without an offset, the copy goes to the right of or below the source without overlapping another artboard.
  - `EmbeddedFile` takes `sourcePath`, the path of the file its bytes were read from. `PaplicoCommands.setEmbeddedFileSourcePath` sets or removes it. The path stays on the device and in the papf it saves; collaborators never receive it.
  - `Paplico.dropImageFile` places an image file at a viewport position, for hosts that receive drops outside the canvas `drop` event.
  - `PaplicoCommands.replaceEmbeddedFile` points every image that shows a file at a replacement in one undo step.
  - `PaplicoCommands.removeUnusedFiles` removes the embedded files nothing in the document uses, clears the undo history, and returns how many files it removed. `findUnusedFileUids` in `@paplico/core/io` lists those files. Neither counts the built-in brush and paper textures.
  - `Paplico.fitViewportToBounds` moves and zooms a canvas so the given bounds fill it. `insets` leaves out the edges floating UI covers.
  - `PaplicoCommands.pasteImageFile` takes `sourcePath` to link the pasted image to its file.
  - `PaplicoCommands.pasteElements` takes `layerRoot` to paste at the root of a given layer and `select: false` to keep the selection.
  - `Paplico.exportDocument` and `Paplico.exportDocumentFile` take `timelapse`, `rewriteSourcePath` and `appData` to leave out the timelapse, rewrite linked file paths and keep host app data in the written file.
  - `Paplico.importDocument` returns the `appData` a file holds.
- **Export**
  - `Paplico.exportArtboard` takes `rasterizationDpi` to rasterize filters at another resolution than the document's.
- **Renderer**
  - The `documentResolutionScale` option of `Paplico.create` draws the document at a fraction of the canvas resolution and stretches it over the canvas, which takes less GPU memory. Tool overlays keep the full resolution. It defaults to 1.
  - `Paplico.deviceLimits` returns the limits of the GPU device the renderer draws with, such as the largest side a texture can have.
- **Package**
  - `calculateSegmentListBounds` in `@paplico/core/utils` measures a list of segments.
  - `linearMatrixToTransform` in `@paplico/core/utils` turns a matrix into an element transform.
  - `compressDeflate` and `decompressDeflate` in `@paplico/core/io` compress and decompress bytes with deflate.
  - `createMeshWarpObject` in `@paplico/core/document` wraps elements in a mesh warp whose cage covers a given box.
  - The published package includes its `LICENSE` file.

### Changed

- **Breaking API changes**
  - `TextStyle.fontStyle` is removed. Choose an italic face with `fontSource`, or set `ital` in `fontVariationSettings` instead.
  - `TextEditState.selectionStyle` is a `SelectionStyleSummary`. Each style key holds `{ mixed: true }` or `{ mixed: false, value }` instead of being left out when the selected runs differ.
  - `TextEditState.hasSelection` moved to `SelectionStyleSummary.hasSelection`.
  - `TextToolController.updateSelectionStyle` takes one `SelectionStyleSummary` instead of a style and `hasSelection`.
  - `TextRenderer.textElementToPaths` returns `bounds` as a `LocalBBox` instead of a `WorldBBox`. The bounds include the text's position but not its transform.
  - `TimelapsePlayer.seekTo`, `advanceBy`, `skipBy` and `restart` return Promises.
  - A timelapse read from a file keeps every block but the last in `TimelapseData.packedBlocks` instead of in `entries`.
- **Tools**
  - Drawing a stroke with the pen tool no longer gets slower as the document grows.
  - Dragging a vertex with the path edit tool no longer stalls on its first frame or on release, and no longer slows down inside a drop-shadowed group.
- **Elements**
  - Duplicating, pasting or deleting a group with many nested elements no longer takes seconds in a large document, nor do their undo and redo.
  - Moving an element that no blend uses as a key takes less time in a large document.
  - A guide is drawn as a thin cyan outline above the artboards and below the other tool UI instead of with its own paint.
  - A click or a marquee selects a guide path, compound path or image only on that outline instead of anywhere on its fill or stroke.
- **Filters**
  - **Kirakira filter**
    - An exported wide kirakira glow differs from earlier versions by a few levels of 255.
- **Text**
  - Outlining a text puts its fills and strokes on the group of glyph paths instead of on each glyph path, so a gradient spans the outlined text. Glyphs filled differently keep their own fill.
  - A text flowed inside a shape starts its first line with the top of its characters at the shape's top instead of the top of its line height, so the lines move up by the leading above the first line.
- **Document**
  - `PaplicoCommands.alignSelectedElements` aligns a single selected element to the artboard it rides on, and does nothing when it rides on none.
  - A document is saved at schema version 20261115. A build older than guides on every element type refuses to open it instead of drawing its guides as artwork.
  - Opening an older document moves an italic text style into the `ital` coordinate of `fontVariationSettings`, so a variable font with an `ital` axis keeps its italic.
  - Saving a document that embeds large images is far faster after its first save.
  - The first save after a document opens no longer freezes the page.
  - An edit to a document without guides no longer gets slower as the document grows.
  - An edit takes less time to apply in a large document.
  - `PartyKitCollaboration` connects to a PartyServer host through `y-partyserver` instead of to a PartyKit host through `y-partykit`.
- **Export**
  - An alpha-locked element is exported to SVG as an image of only what it paints, instead of turning it and every element under it into one image.
- **Renderer**
  - Panning a zoomed-in document no longer stalls every few frames, nor on the frame after the pan ends.
  - Panning back over filtered elements in a zoomed-in document no longer stalls. Their results may use the part of `gpuCacheBudgetBytes` the other render caches leave unused.
  - Panning or zooming onto a large drop-shadowed group or a wide kirakira glow in a zoomed-in document no longer stalls.
  - Panning near a blur brush stroke, a large clipping group or an element with `applyToBackdrop` on a filter no longer slows down.
  - Panning over nested clipping groups no longer gets slower as the document grows.
  - Panning and zooming a document with many elements no longer slow down with each element added.
  - Panning a document with many clipping groups no longer stalls for seconds when they leave the view.
  - Panning a document with more than 32 patterns no longer draws them all again each time the pan redraws.
  - Panning over a large filtered element in a zoomed-in document no longer bakes it again each time the pan redraws only a strip of the view.
  - Panning onto a part of a document with many paths not shown yet no longer takes seconds to finish drawing.
  - A pan or zoom keeps moving through slow redraws. After a redraw of 100 ms or more, and in a view whose full redraw takes 200 ms or more, it shows the last picture. The redraw of the part of the view that picture does not cover starts within a second.
  - Panning onto text and images that are still loading no longer redraws the whole view each time one finishes. Those that finish during the pan appear when it ends.
  - The redraw after a pan waits up to 400 ms for the images the pan was heading to, instead of drawing again as each arrives.
  - Images that finish loading no longer redraw the whole document each time one arrives.
  - Zooming out until most of the document is in view finishes in one redraw instead of three.
  - Zooming out no longer slows down each time the zoom halves.
  - After a zoom shows the view first, the area around it is drawn a strip at a time instead of redrawing the view with it.
  - Zooming and panning a document with many clip groups take less time to finish. This covers clip groups up to 256 px on screen whose content holds no blend mode, group opacity or filter.
  - A view with many clipping groups that hold several elements redraws about 10% faster.
  - Redrawing a document with many texts takes less time.
  - Redrawing a view that holds more than 32 mesh gradients no longer slows down on every frame.
  - The redraw after an edit takes less time in a document with deeply nested groups.
  - Editing an element inside a mesh or used as a mask redraws the whole view instead of only the region around it.
  - Text is laid out in the background once the document opens instead of when it first comes into view.
  - An image drawn small uses a 512 px preview instead of the whole image. The previews load once the document opens, until the image textures reach their budget.
  - Image textures stay within a budget of their own, half the size of `gpuCacheBudgetBytes` and on top of it, apart from the ones the view is drawing. Past it, the images drawn longest ago are freed and load again when they are next drawn, instead of staying loaded until the canvas closes.
  - Zooming into a document with many filtered elements, or with a color-only filter such as gradient map on `applyToBackdrop`, takes less GPU memory.
  - Zooming to between two powers of two takes less GPU memory in a document with filtered elements.
  - Panning takes less GPU memory, most of all a two-finger pan near 100% zoom.
  - The frames after a zoom-in take less GPU memory.
  - Filtered elements sharpen over a few frames after a zoom or pan instead of all in one frame.
  - A pinch that pauses and moves on takes far less GPU memory. Filter bakes still waiting and newly loaded resources are drawn once the gesture stops.
  - Safari and the other WebKit browsers give back the memory of offscreen textures soon after a zoom or pan replaces them, instead of holding it for seconds.
  - On Safari and the other WebKit browsers, the sharp re-render after a pan or zoom waits until the memory of the textures replaced by the one before is given back. Until then the last frame drawn is shown scaled, and the part of the view it does not cover stays empty.

### Fixed

- **Tools**
  - Fix a brush stroke drawn with the pen tool at a high zoom showing no preview while drawing.
  - Fix a moved, rotated or resized text disappearing after its edit with the text tool is confirmed.
  - Fix the eyedropper picking, and the eraser cutting, the paint a guide does not show.
  - **Select tool**
    - Fix a text without a box getting a fixed box when resized, which showed the overflow mark once more characters were typed.
    - Fix a click on a long thin line, or a marquee across it, missing the line in places along it.
    - Fix a click or a marquee on a filled path missing it, or picking it from outside, near an S-shaped edge or inside a single curve that loops back to its start.
    - Fix a click just inside the curved edge of a filled path missing it when zoomed in beyond about 1300%.
    - Fix a rotated element, or a group with rotated content, landing away from the pointer when Alt+drag duplicated or pasted.
- **Elements**
  - Fix a hidden source path still taking part in its compound path's shape.
  - Fix a 3D reference made a guide vanishing from the canvas with nothing left to select. `makeGuides` leaves an image and a 3D reference as artwork.
  - Fix releasing an element inside a guide group doing nothing. `releaseGuides` releases the group that makes it a guide.
  - Fix outlining a guide turning it into painted paths.
- **Filters**
  - **Path offset filter**
    - Fix a hole in a shape, such as the counter of a letter, growing with a positive offset instead of shrinking. A hole the shape closes over is dropped.
- **Text**
  - Fix the caret, the selection and clicks landing above a character laid on its side in vertical writing.
  - Fix a character with a negative kerning in vertical writing moving down onto the character after it instead of up toward the one before it.
  - Fix a centered or right-aligned paragraph in vertical writing starting at the top of its column. Without a box, the text's position is the middle or the end of the column.
  - Fix vertical forms such as `︙` and symbols such as `①` and `※` lying on their side in vertical writing with `textOrientation: "mixed"`. The orientation of each character follows its Unicode Vertical_Orientation.
  - Fix tate-chu-yoko split across several runs, such as `!` and `?` styled apart, stacking its characters on top of each other in vertical text without a box instead of setting them side by side in one cell.
  - Fix a tate-chu-yoko group with kerning or a space at its end sitting off the center of its column. Spaces at either end stay out of the centering.
  - Fix a character the chosen font lacks showing as a tofu box instead of being drawn with the fallback font.
  - Fix color fonts such as Twitter Color Emoji drawing their emoji in the text color, and text in a COLR color font not showing at all. Outlined text and SVG export keep the colors too.
    - Glyphs from the `SVG ` table keep their colors when they use only fills; a glyph with strokes, patterns or masks is still drawn in the text color. COLR v1 glyphs are not supported.
  - Fix `DomLocalFontBackend` returning every font without its PostScript name and `queryFontsByPostScriptNames` returning all fonts instead of the named ones.
  - Fix `LocalFontsLoader` failing to load a font that a document names by its full name.
- **Document**
  - Fix deleting a layer leaving the contents of its groups in the document, where a glass solid among them kept showing on the canvas.
- **Export**
  - Fix Illustrator reporting a missing linked file, leaving out the images and dropping some clipping masks when it opens an exported SVG.
  - Fix an alpha-locked element with a blend mode coming out in a different color from the canvas in SVG export.
  - Fix a text's gradient being written to SVG once per character instead of once across the text.
  - Fix opening a document with a long timelapse recording, or opening the recording in the timelapse dialog, crashing on iPad.
  - Fix seeking back to near the start of a timelapse recording made by an older build failing.
- **Renderer**
  - Fix an image wider or taller than the GPU's texture limit leaving the whole canvas undrawn. It is drawn scaled down to fit the limit.
  - Fix panning or zooming stalling while a document's images load. New image loads wait until the gesture ends.
  - Fix a filtered element just outside the screen appearing without its filter, or not at all, while panning it into view.
  - Fix some filtered elements staying blurry after zooming in until the view moves.
  - Fix a filtered element inside a clip group turning blurry when zoomed in.
  - Fix the backdrop under a color-only filter on `applyToBackdrop` looking softer than the rest of the canvas at most zoom levels.
  - Fix a smudge brush stroke that was moved, or sits in a moved group, still picking up the colors from where it was drawn.
  - Fix the drop shadow or another filter of a group not following an element edited inside it.
  - Fix the separation of the chromatic aberration filter moving its center while panning or zooming a large element.
  - Fix the kirakira glow above 50% strength, the directional blur streak and the turbulence filter's warped edges at a large displacement being cut off in a straight edge.
  - Fix a spray or other noise filter changing its grain between the frame that shows a zoomed view first and the frame after it.
  - Fix a glass solid in a hidden layer still showing on the canvas.
  - Fix a glass 3D solid that is a guide being drawn over everything else.
  - Fix the elements inside a guide group showing their own paint while the group is being edited.
  - Fix a guide inside a mesh warp still showing its paint.
  - Fix a thin line of what lies behind showing along the edge two clip groups share, when zoomed or rasterized. A clip shape's edge now reaches a quarter of a pixel further out.
  - Fix the edge of a clip shape being drawn up to a pixel softer than the edge of a path with the same outline.
  - Fix an object mask showing the whole element instead of only the part the mask keeps.
  - Fix a fill or stroke on a group covering the holes of the paths and compound paths inside it.
  - Fix text with a path offset or another shape filter on one of its fills or strokes being drawn as a coarse image instead of sharp outlines.
  - Fix a text's gradient restarting at every character, and each character's stroke being covered by the next character's fill. Characters given a fill of their own share one gradient across all the characters with that fill.
  - Fix a dash of length 0 drawing nothing instead of a dot at each repeat with a round cap, or a square with a square cap.
  - Fix a dash pattern with a gap of length 0 dropping the dash after the gap.

## [0.10.0] - 2026-10-28

### Added

- **Tools**
  - Hovering an unselected element with the select tool outlines it.
  - Hovering an unselected path or element with the path edit tool outlines it and shows the path's vertices, and hovering an unselected vertex rings it.
  - `Tool.onPointerLeave` is called when the pointer leaves the canvas.
- **Document**
  - `PaplicoSelection.followLayerOf(elementIds)` makes the frontmost layer holding the elements the current layer.
- **Renderer**
  - The `gpuCacheBudgetBytes` option of `Paplico.create` sets how much GPU memory the render caches keep between frames. It defaults to 1600 MiB.
  - The `panMarginPx` option of `Paplico.create` sets how far around the view a frame is drawn ahead for pans. A smaller value takes less GPU memory. It defaults to 256.

### Changed

- **Breaking API changes**
  - `PaplicoCommands.replacePathWithPaths` takes the path id and the runs instead of a layer id first. The path's own layer is used.
  - `PaplicoSelection.setArtboardEditMode` is removed. Use `PaplicoSelection.selectArtboard(null)` to clear the artboard selection instead.
- **Tools**
  - Picking a color with the eyedropper no longer switches the current layer.
- **Elements**
  - Moving a compound path, or a group that holds one, no longer stalls when the move is committed.
  - Editing or committing a long stroke no longer stalls, and each edit adds less to the undo history.
- **Document**
  - Selecting an element, on the canvas or in the layer panel, makes its layer the current layer instead of a click on the canvas doing so.
  - Every artboard's edge is always outlined by a black 1px line above the document instead of a gray line shown only while the artboard tool is active.
  - Moving or resizing an artboard no longer gets slower as the document grows.
  - A path's segments and stroke widths are written to a room and a timelapse recording as binary instead of JSON text. Older app versions cannot read the paths this version writes there.
- **Renderer**
  - A filtered element inside a group that reaches far past the view no longer slows down drawing, path editing and the frame after a pan.
  - Paths and text redraw faster after zooming, rotating or panning by part of a pixel, and a redraw that changes no path is faster too.
  - While a group is being edited, the dimmed document behind it leaves that group out instead of showing a dimmed copy of it.
  - Canvases open side by side split one GPU cache budget instead of each keeping its own.

### Fixed

- **Tools**
  - **Path edit tool**
    - Fix Shift+clicking another path to add it selecting every vertex of the paths whose vertices were already selected.
    - Fix clicking the fill of a selected path selecting every vertex of all the selected paths. A click selects that path alone, and a Shift+click takes it out of the selection.
    - Fix cutting or splitting a path outside the current layer leaving the new paths in no layer.
  - **Path tool**
    - Fix the outline of a hovered path staying after the pointer leaves the canvas.
    - Fix hovering a path in another layer switching the current layer.
- **Renderer**
  - Fix a glass solid inside a group with a filter making the whole canvas fail to draw.
  - Fix a glass solid in a group being edited showing the group's other objects refracted inside it.
  - Fix GPU memory jumping on every zoom step, and staying up after zooming stops, in documents with filtered elements.
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
- **Package**
  - `utils/geometry/` is split by role into `primitives/`, `space/`, `measure/`, `query/`, `generate/` and `reshape/` instead of one flat folder. Imports from `@paplico/core/utils` are unchanged.

## [0.8.0] - 2026-10-18

### Changed

- **Breaking API changes**
  - `PathSegment.cornerRadius` is the radius of the arc rounding the vertex instead of the distance from the vertex to where the rounding meets each edge. Documents saved before are converted when read, so their corners start rounding where they did.
- **Tools**
  - The corner radius handle of the path edit tool sits on the midpoint of the rounding arc instead of the corner radius away from the vertex.

### Fixed

- **Elements**
  - Fix a rounded corner sharper or wider than a right angle not keeping a constant curvature. ([hanakla/paplico#3](https://github.com/hanakla/paplico/issues/3))
- **Renderer**
  - Fix a filter such as blur or chromatic aberration, or an opacity, on a group resetting the blend modes of its children and of their fills to normal.
  - Fix a filter on an element two or more groups deep being dropped when an outer group has a filter or an opacity.

## [0.7.0] - 2026-10-12

### Added

- **Tools**
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
- **Tools**
  - A star drawn with the shape tool points its first point at the pointer instead of 90° away from it.
- **Document**
  - `moveElements` and `commitArtboardMove` skip an element whose group is moved with it instead of moving it twice.
- **Renderer**
  - Zooming, and panning past the drawn area, no longer stall on a filtered group that holds a clip group clipped by a compound path.
  - Panning past the drawn area takes less time on documents with many clip groups or filtered groups.

### Removed

- **Tools**
  - `PaplicoTools.setShapeType`. Use `PaplicoTools.setShapeOption` instead.
- **Document**
  - The unregistered `20260301_mig_appearance_opacity_blendmode` migration. Missing appearance opacity and blend mode are still filled in when a document, room or preset is read.

### Fixed

- **Tools**
  - Fix Shift turning a star or a spiral drawn with the shape tool only to the diagonals, so a star could not point straight up or down. Shift turns a star's first point or a spiral's outer end straight up, then leans it in 45° steps toward the side the pointer moves to.
  - Fix the color swatch of the path edit tool targeting the previously selected object instead of the objects whose vertices are selected.
- **Elements**
  - Fix a compound path disappearing, along with a clip group clipped by it, when its sources cross right by a vertex with a handle on one side only.
- **Color**
  - Fix switching the proof profile while soft proof is on leaving the canvas without the proof until the next edit.
- **Renderer**
  - Fix the artboard background turning transparent over the area of an element just drawn, moved or deleted.

## [0.6.0] - 2026-10-04

### Changed

- **Document**
  - Drawing, adding, deleting, grouping and ungrouping elements no longer get slower as the document grows. This also covers their undo, redo and edits from collaborators.
- **Renderer**
  - The extrude and revolve filters take up to 384 MB less GPU memory each.
  - The first frame after an export, an autosave or an eyedropper pick no longer stalls while every filtered element is drawn again.
  - Opening split view or the timelapse player no longer waits for every embedded image to load again.
  - In split view, typing and editing compound paths, group outlines, blends and mesh warps no longer get slower with each canvas open.
  - In split view, editing a group dims the rest of the document only in the canvas you are working in instead of in every canvas.

### Fixed

- **Brushes**
  - Fix a brush whose image tip or grain comes from a def stamping a round tip or applying no grain instead of the def's artwork.
- **Text**
  - Fix a warped text that continues a text flow from outside the mesh showing the wrong characters after the flow's first text returns to earlier content, such as by undo.
- **Document**
  - Fix an element moved to another layer still being picked from its old layer.
- **Export**
  - Fix an artboard export leaving gigabytes of GPU memory allocated until the next edit.
  - Fix an export of a document with a backdrop filter leaving hundreds of megabytes of GPU memory allocated after it finishes.
- **Renderer**
  - Fix GPU memory staying allocated after switching documents, deleting elements, or leaving the canvas idle.
  - Fix the canvas not redrawing, or redrawing only from a stretched stale frame, after `CanvasTarget.setViewport` is called directly.
  - Fix a filter's effect stopping at an element's old edge after the element's shape changed, until the layer was hidden and shown again.
  - Fix GPU memory growing by gigabytes and textures being reallocated on every edit when a document with a high rasterization DPI has a filter applied to the backdrop.
  - Fix an export, timelapse playback or a stored revision's preview pages drawing a pattern's old tile, or a brush's old def artwork, after the def was edited.
  - Fix every free and mesh gradient on the canvas being generated again after the timelapse player closes, or after a run of eyedropper picks or bucket fills.
  - Fix a group's own fill or stroke keeping its old outline after a source path of a compound path inside the group is edited.

## [0.5.0] - 2026-10-03

### Added

- **Tools**
  - **Path edit tool**
    - Shift+drag locks anchors, path faces, whole elements and control points to 45° steps from the press point.
    - Selected anchors get a padded frame whose handles scale and rotate those anchors with their control points, as the Select tool's frame does.
- **Document**
  - `E2EECollaboration` emits `messageRejected` with the error when a message from a peer cannot be applied.
  - `Paplico` emits `clipboardWriteFailed` with the error when a copy or cut cannot write to the system clipboard.
- **Package**
  - `calculateResizedBounds` takes an `aspectDriver` option that picks the axis whose size sets the other under `constrainAspect`.

### Changed

- **Tools**
  - The outline the select, path edit and gradient tools trace along a selected shape is 1px wide instead of 2px.
- **Elements**
  - `outlineElements` turns a compound path with no vector stroke into one path of its combined shape instead of leaving it unchanged. `canOutlineStrokes` accepts every compound path.
- **Document**
  - A cut whose clipboard write fails keeps the selected elements instead of deleting them.

### Fixed

- **Tools**
  - Fix an Alt+drag copy with the select or path edit tool starting 10 units away from its original and lagging behind the pointer.
  - Fix a resize with the select tool dropping the Shift aspect lock and the Alt centre anchor when an edge snaps.
- **Elements**
  - Fix a self-crossing source with a handle only on one side of a vertex making the whole compound path disappear.
- **Document**
  - Fix `flipElements` on a single rotated element mirroring it across its own tilted axis instead of the screen's.
  - Fix `PartyKitCollaboration` never sending `roomToken` to the relay.
  - Fix one message that fails to apply stopping `E2EECollaboration` from processing every message after it.
- **Renderer**
  - Fix a Repeat object inside an object mask hiding the mask's owner.
  - Fix the color correction filter coloring the transparent area around its element and skewing the color of semi-transparent pixels.
  - Fix the gradient map, posterization and color replacement filters skewing the color of semi-transparent pixels.
  - Fix the elements above a backdrop-filter element in the same group not being drawn.

## [0.4.0] - 2026-10-01

### Added

- **Export**
  - `SVGExporter` takes a `disableIncompatibleFilters` option that exports the artboard as if every filter SVG cannot hold were turned off. The document itself is not modified.

### Changed

- **Export**
  - `SVGExporter` exports a path or compound path as vectors even when a fill or stroke has its own blend mode or sub-filters, instead of rasterizing it. A sub-filter with no SVG equivalent still rasterizes the element.
  - `ExportRenderer` includes `dropDocumentCaches`.

## [0.3.0] - 2026-10-01

### Added

- **Tools**
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
  - A long press on a point's centre handle with the stroke width edit tool deletes the point, in both the width profile and the erasure profile.
- **Document**
  - `paplico.tool.shapeCycle`, bound to M, switches the shape tool to the next shape type. From another tool it starts the shape tool at the rectangle.
  - `PaplicoCommands.flipElements(ids, flip)` mirrors a selection along the axes of its selection frame.
  - `PaplicoCommands.updateElementTransforms(updates)` rewrites the transforms of several elements in one undo step. Rotation, scale and skew turn each element around the centre of its local bounds.
  - `PaplicoCommands.moveElements(elements, deltaX, deltaY)` moves elements by a world delta in one undo step and skips locked elements.
  - `PaplicoCommands.setElementVisibility(layerId, elementId, visible)` shows or hides an element regardless of its lock.
  - `PaplicoCommands.writeElement(layerId, elementId, updates)` writes to an element without checking its lock.
  - `PaplicoCommands.pasteElements` takes a `placementAnchorIds` option that resolves `placement` against these elements instead of the selection.
  - `Paplico.wrapDocumentFile(papf)` wraps a stored papf into the same PDF-compatible file as `exportDocumentFile`. It leaves the editor's caches untouched.
- **Export**
  - `ExportContext.targetId` names the target through which `PNGExporter`, `JPEGExporter` and `TIFFExporter` draw artboards.
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
- **Tools**
  - Every long press takes 400ms instead of 500ms in the mesh deform tool, the eyedropper and the pen's color pick.
  - The eyedropper picks on release instead of on press.
  - The selection frame of a lone rotated or skewed element tilts with the element instead of staying world-aligned. Snapping is off for a tilted frame.
  - **Gradient tool**
    - The tool selects an element whose gradient is not its first fill. An element with only solid or pattern fills is no longer selected.
    - `PaplicoCommands.deleteSelectedGradientStop` removes the stop from the edited fill instead of the first fill.
    - Handles keep 12 screen pixels away from the stops at any zoom.
    - A radial centre or radius handle moves by the drag distance instead of snapping to the cursor.
    - A radial gradient has no rotation handle. Dragging its end point sets the radius and the angle at once.
- **Document**
  - `toggleElementVisibility` and `toggleLayerVisibility` work on locked elements and layers. A readonly room still blocks them.
- **Export**
  - Timelapse playback and MP4 export no longer slow down toward the end of a recording with many filtered elements.
  - Timelapse playback draws the artboard the way the exported video does: fitted on white, without its own fill or a neighbouring artboard.
  - `TimelapsePreviewSurface.renderToImageData` also shows the frame on the preview canvas, so an MP4 export shows the frame it encodes.
- **Renderer**
  - A blur no longer gets slower as its radius grows. This applies once the radius reaches 8 texels at the document's rasterization DPI.

### Fixed

- **Tools**
  - Fix the mesh deform tool ignoring presses on a group that holds a locked child.
  - Fix a handle drag with the gradient tool previewing the change on every fill of the element.
  - Fix a text's selection frame drifting away from the text after a move or a transform edit.
  - **Select tool**
    - Fix hit tests inside a rotated or scaled group missing parts of a child. This covers clicks, rectangle selection, eyedropper candidates and clip paths.
    - Fix the selection box, snapping and hit candidates of a rotated or scaled group being offset from its content.
    - Fix Alt+drag duplicates with the select or path edit tool landing on top of the layer instead of in front of the frontmost source. `duplicateElementsByIds` stacks its copies the same way.
- **Color**
  - Fix color adjustment skipping texts and mesh content.
- **Document**
  - Fix a locked element staying behind when its container is moved, aligned, resized or warped. A lock now blocks only operations aimed at the element itself.
  - Fix moving a text bound to a locked path doing nothing. The path now moves with the text.
  - Fix `ungroupElements` and `extractChildFromGroup` dropping the rotation, skew or offset of the enclosing groups from the children.
  - Fix undoing an element's deletion sending an unreadable element to collaborators and the timelapse recording. yjs is upgraded to 13.6.33 for this fix.
- **Export**
  - Fix content under a blended alpha-locked or backdrop-reading element turning see-through in SVG export.
  - Fix content stacked over an alpha-locked or backdrop-reading element being hidden by its rasterized area in SVG export.
  - Fix timelapse playback stopping with an error at an unreadable element. Playback leaves that element out.
  - Fix an MP4 export taking a long time to start on recordings made before `20260929`.
- **Renderer**
  - Fix an element with a raster filter inside a group re-running its filters on every pan frame and every pen stroke frame.
  - Fix a drop shadow ignoring the alpha of its shadow color. The shadow's strength is the shadow opacity multiplied by that alpha.
  - Fix a backdrop filter ignoring the geometry filters of its element and of enclosing groups.
  - Fix a raster filter such as blur ignoring the geometry filters of an enclosing group.
  - Fix raster filters placed after a backdrop filter being cut off at the element's shape.
  - Fix a drop shadow on a group resetting the blend modes of its children to normal. This applies to a group whose only raster filter is the drop shadow, with normal blending, full opacity and no clip or mask of its own.
  - Fix a hidden element becoming visible inside a group that has a raster filter, an opacity or a mask.
  - Fix "used in submit while destroyed" when an element is drawn twice in one frame at different scales, or on a path with two gradient fills or two gradient strokes.

## [0.2.0] - 2026-09-27

### Added

- **Text**
  - `Paplico.create` takes a `fontLoaders` option listing the `FontLoader`s that resolve text fonts. No loader is registered by default.
  - A host app can add its own font loader by extending the abstract `FontLoader` class.
  - `paplico.fonts` is the instance's `FontManager`.
  - `LocalFontBackend` and `FontData` in `/typography` and `DomLocalFontBackend` in `/infra` build a `LocalFontsLoader` on any platform.
- **Document**
  - `Paplico.connectCollaboration(factory, { document })` attaches a collaboration transport.
    - `document: "fromRemote"` discards the local document.
    - `document: "keepForRemote"` merges the local document into the room.
  - `CollaborationBase` in `/collaboration` is the base class for a host app's own transport.
  - `Paplico.activateCanvasTarget(targetId)` makes a canvas target active. The `activeCanvasTargetChange` event reports the switch, with `null` when the active target is removed.
- **Export**
  - The `@paplico/core/export` entry holds the exporters `PNGExporter`, `JPEGExporter`, `AvifHdrExporter`, `PSDExporter`, `TIFFExporter` and `SVGExporter`, each taking its settings in the constructor.
    - Types: `IExporter`, `ExportContext`, `ExportRenderer` and `ExportResult`.
  - `Paplico.exportArtboard(exporter, artboardId)` exports an artboard through any `IExporter`.
  - `Paplico.renderElementsToPNG(elementIds, document, options)` renders elements to a PNG sized to their filter-expanded bounds.

### Changed

- **Breaking API changes**
  - `FontSource` is `{ loaderId, fontId }`. Documents saved earlier are migrated when opened.
  - `Paplico.importDocument` throws `PaplicoError` with the code `DOCUMENT_OPEN_WHILE_CONNECTED` while a collaboration transport is attached.
- **Document**
  - Only the active canvas target draws tool overlays such as handles, the brush cursor, snap lines and selection outlines.
  - A press activates a canvas target instead of hovering.
  - Inactive canvas targets ignore hover moves and tool wheel input. Plain wheel pan and zoom still work on every target.

### Removed

- **Text**
  - `getFontManager`. Use `paplico.fonts` instead.
  - The `googleFontsApiKey` option of `Paplico.create`. Pass a `GoogleFontsLoader` in `fontLoaders` instead.
  - `/infra/localfonts.tauri` and the `@tauri-apps/api` and `tauri-plugin-system-fonts-api` dependencies. Implement `LocalFontBackend` in the Tauri app instead.
- **Document**
  - `Paplico.setCollaboration` and the `collaboration` option of `Paplico.create`. Use `connectCollaboration` instead.
- **Export**
  - The `exporter`, `psdExporter`, `tiffExporter` and `svgExporter` properties of `Paplico`. Pass an exporter from `/export` to `exportArtboard` instead.

### Fixed

- **Tools**
  - Fix a pen stroke that ends within 100ms of pen-down being committed at a flat width.
  - Fix resizing a group with the select tool moving a rotated compound path or blend inside it away from the rest of the group.
  - **Path edit tool**
    - Fix deleting a middle anchor in a document with a clip group leaving the original path behind.
    - Fix deleting a middle anchor inside an editing scope making the whole path disappear.
- **Document**
  - Fix the current layer jumping to the topmost visible layer inside an editing scope.
  - Fix a paste or a keyboard shortcut running once per canvas target.

## [0.1.0] - 2026-09-26

### Added

- First release of the Paplico drawing engine as a standalone package.
- **Package**
  - `@paplico/core` holds the `Paplico` facade, errors and shortcuts.
  - `/schema`, `/document`, `/brush`, `/collaboration`, `/color`, `/io`, `/tools`, `/timelapse`, `/typography`, `/filters`, `/utils` and `/infra`.
  - `/infra/localfonts.tauri` holds the Tauri local font backend.
  - `/three-webgpu-compat` is the target for a bundler alias of `three`.
  - `Paplico.create` takes a `fallbackFontUrl` option that names where the built-in Noto Sans JP fallback font is served.
  - `CollaborationConfig.relayHost` names the PartyKit host for the cloud and end-to-end encrypted transports.
  - `registerForHotReload(paplico)` marks the instance that development hot reloads re-attach to.
  - `pngjs` is an optional peer dependency for the PNG decode fallback on Node WebGPU.
