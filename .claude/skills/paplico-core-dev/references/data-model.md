# Data Model Reference

All types defined in `core/schema.ts`.

## Why normalized (flat objects + ID references)

`Document.objects` is `Record<id, AnyArtObject>` — a flat map. Layers reference elements by `Layer.elementIds: string[]`. Groups reference children by `Group.childIds: string[]`.

This is normalized for two reasons:

1. **Yjs CRDT merging** — Each element is an independent Y.Map. Concurrent edits to different elements never conflict regardless of their position in the layer/group hierarchy. A nested tree structure would require Yjs to merge at every tree level, which is fragile and slow.

2. **O(1) element lookup** — Any code can access any element by ID without traversing the tree. The renderer, tools, and spatial index all benefit from this.

The tradeoff is that "move element to different layer/group" requires updating both the source and target ID arrays atomically. YjsProvider handles this in a single Yjs transaction.

## ArtObject base

Every element extends `ArtObject`:
- `id`, `opacity`, `blendMode`, `visible`, `locked` — standard properties
- `transform: ElementTransform` — position, scale, rotation relative to element origin
- `filters: Appearance<T>[]` — unified styling (see Appearance system below)

## Element types (AnyArtObject union)

- **Path** — Bezier segments + width. Stroke and/or fill via Appearances
- **Group** — `childIds: string[]` referencing other elements. Optional `clipPathId` for clipping mask
- **ImageObject** — `fileUid` referencing `Document.files[]`, position + dimensions in world space
- **CompoundPath** — `sources: CompoundPathSource[]` with per-source `BooleanOperation`. Non-destructive boolean ops applied sequentially
- **TextElement** — Rich text content with `TextContent` / `TextStyle` / `TextLayout`. Optional `pathBinding` for text-on-path
- **MeshArtObject** (`type: "mesh"`) — Warp/deformation mesh: `vertices` + `faces` over a `width`×`height` region (edited by MeshDeformTool)
- **BlendObject** (`type: "blend"`) — Illustrator-style blend between `objectIds`, optionally distributed along a `spineSourceId` with `spacing` and `tiltToSpine`
- **Scene3DElement** (`type: "scene3d"`) — A 2D placement rectangle showing a rendered view of a shared 3D scene (see "Scene3D" below)

When adding a new element type: extend `ArtObject`, add to `AnyArtObject`, handle in renderer dispatch, spatial index bounds, and serialization.

## Appearance system (why fill/stroke/filter are unified)

`ArtObject.filters[]` contains `Appearance<T>` entries that control all visual output:

- **FillAppearance** — Fill color (`FillColor` = SolidColor | LinearGradient | RadialGradient | FreeGradient)
- **StrokeAppearance** — Stroke color + `BrushSettings` + width
- **ContentAppearance** — Marker for where element content renders (text body, group children)
- **BlurFilter, DropShadowFilter, FrostGlassFilter** — Post-processing (texture-based)
- **ZigzagFilter** — Pre-processing (geometry modifier)

Array order = draw order. This is the reason fill, stroke, and effects are in the same array: the user can put a drop shadow between two fills, or a blur before a stroke. Separate `fill`/`stroke`/`filters` properties would make this ordering impossible.

`Appearance.subFilters` scopes effects to a single appearance (e.g., blur only the second fill, not the whole element).

## Path geometry (CubicBezierSegment / PathSegment)

Why cp1/cp2 are relative offsets: Moving an anchor automatically moves its handles. If they were absolute, every anchor move would require updating both handles — easy to forget. Use `resolveSegment()` from `utils/geometry/segmentOps.ts` to get absolute coordinates.

- `start` exists only on segment[0] of each subpath. All others use previous segment's `end`
- `isMoved: true` starts a new subpath (SVG moveTo equivalent)
- `isClosed: true` closes the current subpath (SVG Z equivalent)
- `PathSegment` extends `CubicBezierSegment` with `cornerRadius` for rounded corners

## Viewport

`Viewport { x, y, zoom, rotation }` — center of the viewport in world coordinates, plus scale and rotation. Used by ViewportManager to compute uniform buffer values and by coordinate conversion utilities.

## Scene3D (shared 3D scenes)

`Scene3DElement` (`type: "scene3d"`) looks like an `ImageObject` to the 2D
pipeline — a placement rect (`x/y/width/height`) showing a rendered view — but
its content comes from a **document-level shared scene**, not an embedded image:

- `Document.scenes3d?: Record<string, Scene3DDef>` holds the shared scene
  definitions. A `Scene3DElement` references one by `sceneId` and carries its
  **own** `camera` (`Scene3DCamera`), so one scene appears in multiple panels
  from different angles (copying an element keeps the same `sceneId`).
- `Scene3DDef = { id, name?, nodes: Scene3DNode[] }`; a `Scene3DNode` is a
  `primitive`, a `figure` (VRM `fileUid` + `VRMPoseData`), or a static `mesh`
  (glTF `fileUid`) — each with a `Transform3D` (meters).
- `displayMode: "lineart" | "flat"`, optional `Lineart3DParams`, `lightDir`.

Yjs: scenes live under a `scenes3d` Y.Map (node arrays as JSON, like
`Path.segments`), tracked by UndoManager. This is a distinct feature (atari /
reference scenes, three.js) — full detail in `references/scene3d.md`. It is
**unrelated to the extrude3d appearance**.

## EmbeddedFile

Binary assets stored in `Document.files[]`, referenced by `fileUid` from `ImageObject`, brush textures, and Scene3D `figure`/`mesh` nodes (VRM / glTF binaries). Included in CBOR export. This avoids external file dependencies — documents are self-contained.
