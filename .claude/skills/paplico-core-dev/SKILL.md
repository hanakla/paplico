---
name: paplico-core-dev
description: Paplico drawing engine (core/) architecture, change impact, and development guide. Trigger when adding, changing, or refactoring code within core/; working on renderer, tools, collaboration, or data model.
---

# Paplico Core Development Guide

Scope: `pkgs/web/src/core/`. External boundary is `Paplico.ts` (facade). No references to React, Valtio stores, Next.js, or anything outside `core/`.

## Module Diagram

```
Paplico.ts (facade — public API boundary)
  ├── PaplicoCommands / PaplicoSelection / PaplicoTools / PaplicoShortcuts
  ├── SpatialIndex          (hit testing via Quadtree — document/SpatialIndex.ts)
  ├── collaboration/        (createCollaboration → Collaboration | PartyKitCollaboration)
  │   └── YjsProvider       (owns the Y.Doc + UndoManager; single source of truth)
  ├── scene3d/              (three.js runtime, lazy-loaded chunk — VRM figures,
  │                          primitives, lineart, vanishing points)
  └── RenderOrchestrator (renderer/)
      ├── CanvasTarget           (DOM canvas wrapper, resize, viewport state)
      ├── RenderScheduler        (rAF scheduling, dirty → full/fullTransformOnly/
      │                            fullInteraction/overlayOnly)
      ├── FilterRenderer         (registered FilterHandlers — pipeline/FilterRenderer.ts;
      │                            owns per-size ping-pong temp pairs reused across frames)
      ├── UILayer                (renderer/ui/ — overlays, gizmos, guides, cursors)
      │
      └── CanvasLayer (renderer/canvas/ — per-canvas document pipeline)
          ├── FrameGraph              (pipeline/ — per-frame declarative pass graph:
          │                            declared reads/writes, dead-pass culling,
          │                            lifetime-aliased pool textures)
          ├── RenderPlanner           (pipeline/ — routes each element: inline vs
          │                            offscreen vs per-appearance plan)
          ├── ViewportManager         (viewport uniform buffer, transforms buffer, bounds cache)
          ├── DocumentCache           (persistent auxiliary GPU textures; not document-content cache)
          ├── CompositeRenderer       (texture/quad blit, blend-mode compositing)
          ├── OffscreenPresenter      (offscreen passes, clip groups, group/element bake)
          ├── BackdropCaptureManager + BackdropEffectCoordinator (backdrop capture/pyramid)
          ├── ClipMaskAtlas / TexturePool / UniformScope (GPU resource machinery)
          ├── RenderCacheManager (caches/) — AppearanceCache, GeometryCache,
          │       StencilFillCache, StampCache, Compound/GroupPathCache, ...
          ├── ElementRenderer (elements/ — element-type dispatch)
          │   ├── GradientRenderer / ImageElementRenderer / TextElementRenderer / MeshElementRenderer
          │   └── Reference3DElementRenderer (blits the three.js scene texture)
          └── pipeline/brush/ + pipeline/stroke/ — stroke engines
              ├── DabEvaluator (curve matrix -> dab instances) + TipMaskBuilder
              ├── RibbonGenerator (bezier ribbon instances)
              ├── MixPass / MixStrokeRenderer (colour mixing off the live backdrop)
              └── WetLayerPass (watercolour field simulation)

renderer/filters/ (FilterHandlers + their WGSL)
  ├── Solid3DFilterHandlerBase   (shared 3D-solid core; Extrude3D/Revolve3D
  │     subclasses supply the mesh strategy)
  ├── Extrude3D/                 (ExtrudeMeshBaker, ExtrudeAppearanceRenderer
  │     [glass z-order driver], RefractionCompositor)
  ├── JumpFloodDistanceField     (shared JFA distance field — outline,
  │     drop-shadow spread, inner glow)
  └── hanakla-kit/               (hk:* handlers)
```

> Names drift as the code moves. This diagram was verified against
> `renderer/` on 2026-07-12; re-`ls` the directory rather than trusting it
> blindly. Notable renames from older docs: `OffscreenRenderer` →
> `OffscreenPresenter`; `Scene3DElementRenderer` → `Reference3DElementRenderer`;
> `ExtrudeAppearanceRenderer` moved from `canvas/elements/` to
> `filters/Extrude3D/`; the flat `renderer/` tree is now
> `renderer/canvas/{pipeline,elements,caches}` + `renderer/ui`.

## Why the Architecture Is This Way

### Why normalized data model (Document.objects + ID references)

Elements are stored flat in `Document.objects` and referenced by ID from `Layer.elementIds` and `Group.childIds`. This avoids deep nesting, which would make Yjs CRDT merges unreliable — concurrent edits to elements in different layers would conflict if the tree structure required parent-path-aware merging. Flat storage means each element is an independent Y.Map, mergeable without knowing its position in the tree.

### Why all mutations go through YjsProvider

Undo/redo and real-time collaboration both depend on Yjs tracking every change. If you mutate state directly, UndoManager misses it and undo breaks. If you bypass Yjs, remote peers never see the change. There is no exception to this rule.

### Why renderer/ has no dependency on collaboration/ or tools/

The renderer is a pure read-only consumer of document state. If it depended on collaboration, device-loss recovery would need to reason about network state. If it depended on tools, adding a tool would risk breaking rendering. The isolation also means the renderer can be tested with a plain Document object — no Yjs setup needed.

### Why tools receive ToolContext (callbacks) instead of direct access

Tools need to create/update elements but must not know about Yjs internals. ToolContext provides `previewUpdate`, `strokeComplete`, etc. as injected callbacks. This keeps tools testable with mock callbacks and prevents tools from accidentally bypassing YjsProvider.

### Why Appearance unifies fill/stroke/filter into one array

Before this design, fill, stroke, and post-processing were separate properties on `ArtObject`. This made ordering impossible — you couldn't put a drop shadow between two fills. By unifying everything as `Appearance<T>` entries in `ArtObject.filters[]`, draw order is simply array order. `ContentAppearance` acts as a marker for where the element's own content (text body, group children) renders relative to fills and strokes.

### What DocumentCache caches now

`DocumentCache` no longer stores rendered document or layer contents. `CanvasLayer`
renders document content directly every frame, and `invalidateDocumentCache()` is a
no-op. The class retains only size-matched auxiliary GPU textures: stencil,
composite, prebuffer, final-blit, and backdrop-mask resources. Recreate these when
their descriptor changes, defer replacement destruction until in-flight GPU work is
safe, and let `CanvasLayer` destroy the surviving resources. Full cache policy →
`references/cache-strategy.md`.

### Why ViewportManager has 3 methods (set / writeToGPU / restore)

WebGPU reads uniform buffer values at `queue.submit()` time, not at draw call time. During export or offscreen passes, the renderer temporarily needs a different viewport (e.g., artboard-sized instead of canvas-sized). `writeViewportUniformsToGPU` changes only the GPU buffer without touching the saved state. `restoreViewportUniformsToGPU` puts it back after. If you used `setViewportUniforms` for a temporary override, the saved state would be corrupted and the main canvas would render at the wrong viewport after the export.

### Why RenderScheduler resolves dirty reasons into strategies

Not all changes need the same rendering work. A cursor move needs only the overlay redrawn (`overlayOnly`). A pan during interaction can skip expensive backdrop filters (`fullInteraction`). Only a document change needs a full re-render (`full`). Without this, every mouse move would trigger a full pipeline pass, killing frame rate.

### Why BrushStrokeRenderer uses batching + stamp caching

Each brush stroke is composed of hundreds of stamp sprites. Issuing a draw call per stamp would be far too slow. BrushStrokeRenderer accumulates stamps from multiple paths into a single vertex buffer, grouped by texture, and issues one draw per texture type. Cached stamp positions for unchanged paths skip the recomputation entirely.

### Why CubicBezierSegment stores cp1/cp2 as relative offsets

Control points are stored relative to their anchor (cp1 relative to start, cp2 relative to end). This means moving an anchor automatically moves its handles without extra code. If they were absolute, every anchor move would require manually updating both handles — easy to forget and a source of bugs.

## Change Impact Guide

### Adding a new element type

**Impact:** schema → YjsProvider → ElementRenderer → SpatialIndex → (tool) → (export) → (io)

1. `schema.ts` — Define type extending `ArtObject`, add to `AnyArtObject` union
2. `ElementRenderer.dispatchElementDirect` — Add rendering branch. Create dedicated renderer if complex (follow `ImageElementRenderer` pattern)
3. `SpatialIndex` — Add bounds calculation. **Without this, selection and hit-testing won't work for the new type**
4. `YjsProvider` — Existing generic element methods usually suffice. Only add methods if the new type has nested Y.Map/Y.Array structures
5. `core/tools/` — New tool if needed
6. `core/io/` — Export rasterization (PaplicoExporter) and papf (CBOR) serialization

**Easy to miss:**
- SpatialIndex bounds — the element will render but be unselectable
- OffscreenPresenter handles Group children recursively — if the new type can be inside a Group with non-normal blend mode, it will pass through offscreen compositing automatically
- DocumentCache dirty tracking fires on any element change — no extra work unless the new type needs special invalidation

### Adding a new tool

**Impact:** tools/ → Paplico.ts (registration only)

1. `core/tools/` — Implement `Tool` interface. Constructor takes `ToolContext` + options
2. `Paplico.ts` — Register in tool switching

Tools are isolated. Adding one cannot break rendering or collaboration. The key contract is: tools produce document mutations through ToolContext callbacks, never directly.

Test with `testUtils/pointerEvent.ts` — `ev()`, `testViewport`, `testCanvasWidth`, `testCanvasHeight`.

### Two filter hooks — and the "self-sizing geometry filter" variant

A `FilterHandler` has exactly two processing hooks, typed by what flows through them:

| Kind | Type signature | Hook | Examples |
|------|----------------|------|----------|
| **Geometry modifier** | segments → segments | `preProcess` | zigzag, corner radius |
| **Image effect** | raster → raster (same size, in place) | `postProcess` → `void` | blur, drop shadow, frost glass, pixelate, halftone |
| **Self-sizing geometry filter** | geometry → new self-sized raster | `postProcess` → `PostProcessResult` | **extrude3d / revolve3d** (shared `Solid3DFilterHandlerBase`) |

fill/stroke still produce the element's flat look in `ElementRenderer`'s appearance
loop (they are not `FilterHandler`s). **extrude3d, however, IS a real `postProcess`
filter** — `postProcess` was generalized so a geometry-driven renderer can live in
it (superseding the older "metadata-only handler / appearance loop" design):

- `FilterProcessorContext.geometry?` (`FilterGeometryContext`) hands the filter the
  `element`, `elementsMap`, caches, `renderElementToTexture`, and text/pattern
  resolvers, so it can build its mesh and bake the source appearances.
- `postProcess` returns a `PostProcessResult` (a `BlitLayer`: its own texture +
  bounds + `uvRect` + optional transformed `quad`), or `PostProcessResult[]` for
  a multi-solid case (extrude3d bakes one per blend instance); the main pass
  blits each at its own bounds instead of the element's flat bounds. A plain
  image filter returns `void` (writes in place into the same-size `targetTexture`).
- `getRenderConfigure(filter)` declares `{ needsBackdrop, needsSourceTexture }`
  per-filter. extrude3d returns `needsSourceTexture:false` (builds from geometry, so
  the caller skips rendering the flat look) and `needsBackdrop` from the material.
- `startFrame()` resets the handler's per-frame GPU pools.

An enabled extrude3d suppresses the element's own fill/stroke: `ElementRenderer.renderPath`
and the CanvasLayer group branch early-return via the processor-agnostic
`isElementRenderReplaced(element, filterRenderer)` (true when any enabled
appearance renders the element in place of its flat look). See "3D & extrude
appearance" below.

### Adding an image-effect filter (postProcess) or geometry modifier (preProcess)

**Impact:** schema → FilterHandler → WGSL shader → FilterRenderer registration

1. `schema.ts` — Define params and filter type extending `Appearance<T>`, add to `Filter` union
2. Implement `FilterHandler` (`pipeline/FilterRenderer.ts`) — `initialize`, `onScaleFilter`, `getExpansionMargin`, and either `preProcess` (geometry) or `postProcess` (pixels). `postProcess` gets `sourceTexture`/`targetTexture` of the **same** (content) size — an in-place image transform
3. WGSL shader as `<filterName>.wgsl.ts` in `core/renderer/filters/` next to its processor (shared pipeline shaders live in `core/renderer/shaders/`)
4. `FilterRenderer.registerHandler` — Register with processor name

**Easy to miss:**
- `onScaleFilter` — Without this, spatial filter params don't scale during export and the filter looks wrong at non-1x resolution
- `getExpansionMargin(filter, bounds?)` — Without this, blur/shadow effects get clipped to element bounds. It is a **symmetric scalar** margin; the optional `bounds` (planned content size in world px) lets zoom/rotate-style filters derive it from the content diagonal. A filter whose output is off-center (like a 3D projection) still cannot express its bounds through it
- Per-frame GPU resource hooks — `startFrame()` (reset per-frame pools), `releaseFrame(release)` (hand frame-scoped textures back for deferred destroy), `flushPendingDestroy()` (drain the handler's own deferred destroys; called by `FilterRenderer.flushPendingDestroy` once per frame after the previous submit)
- Distance-to-silhouette effects should build on the shared `JumpFloodDistanceField` (outline, drop-shadow spread and inner glow do) instead of per-pixel neighbourhood scans — an O(weight²) scan saturates the GPU at high DPI
- `getRenderConfigure(filter)` → a partial `{ needsBackdrop?, needsSourceTexture? }` merged over the defaults `{ false, true }` (`resolveRenderConfigure`); omit entirely for a plain in-place filter. `needsBackdrop:true` (frost glass) gets `BackdropFilterProcessorContext` (with `backdropTexture`) and the main-pass z-order path instead of the pre-pass `executeFilterPlans`. `needsSourceTexture:false` (a self-sizing geometry filter that builds from `ctx.geometry`) lets the caller skip rasterizing the flat look
- To emit a **self-sized** output (bounds larger/off-center than the element, e.g. a 3D projection), return a `PostProcessResult` from `postProcess` and read `ctx.geometry`; add `startFrame()` if the handler owns per-frame GPU pools
- `onAdjustColor(params, adjustColor)` — implement it if the filter has `Color` fields (light/shadow/tint/etc.), or those colors are invisible to the document-wide color collect/adjust feature (`utils/color.ts`). Mirror `DropShadowFilterProcessor.onAdjustColor`
- Spatial params must scale by `sceneInfo.zoom`, which is **texels per world px of the source texture** (= rasterization scale for element filters, live viewport zoom for backdrop filters), NOT literally the canvas zoom — see "Rasterization resolution" below

### Adding a per-element rendering property (mask, clip, tint, …)

**Impact:** schema → YjsProvider (both enumerations) → the transforms buffer /
shaders → **every** path that puts an element's pixels on the canvas → SpatialIndex

An element's pixels reach the canvas through two mechanisms, and they behave
completely differently for anything applied per element:

| Mechanism | Applies per-element GPU state? |
|-----------|-------------------------------|
| Geometry draw (unified / brush / ribbon pipelines) | Yes — samples BG3 and the transforms-buffer entry |
| **Texture blit** (`blitTextureToCanvas`, `blitQuadToCanvas`, `compositeTextureToCanvas`, a `GeometryBackdropDriver`'s inline compose) | **No** — each runs its own pipeline and never looks at BG3 |

So a property wired only into the geometry pipeline silently does nothing for
every blit-drawn element, and the failure is invisible: no error, the element
just renders as if the property were absent. Blit-drawn elements need the
property multiplied into their texture instead.

Enumerate the blit sites from the code (`grep` the element loop in
`CanvasLayer.renderElements` for `blitTextureToCanvas|blitQuadToCanvas|
compositeTextureToCanvas|composeInline`) rather than from memory, and express
the routing rule as **one predicate** ("does this element draw via a texture?"),
not as a growing chain of special cases. Fixing these one bug report at a time
is how a feature ships four times and is still broken.

**Easy to miss:**
- `postFilters` **excludes** a render-replacing appearance whose
  `getRenderConfigure` says `needsBackdrop` (glass extrude / revolve). Those
  elements have **no entry in `framePlan.filterPlans`**, so "has a filter plan"
  is not a proxy for "is drawn offscreen" — glass composes mid-pass through its
  driver instead
- `BlitLayer.quad` is set by `Solid3DFilterHandlerBase` / `ExtrudeMeshBaker`
  whenever the element has a transform, so **quad layers are the normal case**
  for 3D solids, not a corner. A quad layer's texture maps to four corners, not
  to its world AABB, so anything sampled in world space has to flatten it onto
  its AABB first
- Images are always a blit, even with no filter
- **`composeInline` returns nothing in its common case.** With no downstream
  filters it refracts straight onto `targetTexture` and `return`s void; only
  when downstream filters exist does it render into its own texture and return
  a `BlitLayer`. Post-processing "the returned layer" therefore does nothing at
  all for a plain glass solid — the pixels are already final by the time the
  caller gets control back. Pass `renderToSeparateTexture` to force the
  returning route when the caller must act on the result. Read a compose
  function's body before hanging work off its return value
- **A world-space sampled texture must span where the element actually paints,
  not its flat bounds.** Anything sampled by world position (the mask atlas,
  and `applyOuterClipMask`) treats "outside the texture" as uncovered, so a
  texture sized to `calculateElementBounds` crops a 3D solid to its pre-extrude
  footprint and silently cuts off everything the solid paints beyond it. Union
  in the extents that actually matter — the engine's own answer for an
  appearance-replaced element is `expandBoundsForExtrude`, which unions the
  override layers' bounds plus each driver's `unionSolidBounds`
- SpatialIndex — a property that removes part of an element should remove the
  same part from hit testing, or the invisible area still swallows clicks

### Adding a new brush

**Impact:** brush settings → assets → BrushTextureManager → the engine its route
selects

1. `core/schema.ts` — extend `BrushSettingsV2` (or add a property to
   `BRUSH_PROPERTY_REGISTRY` if the value should be curve-modulated)
2. `core/assets/` or `core/brush/presets.ts` — texture, generated procedurally
   if it can be
3. `BrushTextureManager` — register the texture
4. the engine for the route (`core/brush/renderRoute.ts` decides): dab strokes
   go through `DabEvaluator` + `brushDab.wgsl`, ribbons through
   `RibbonGenerator` + `ribbonStroke.wgsl`

### Brush engine v2: what decides where a stroke is drawn

`resolveBrushRenderRoute(storedSettings)` is the single routing decision, taken
once per stroke. **Resolve it from the stored value, never from the legacy view**
— the down-converted view drops paint mode, curves and wet/mixing config, so a
route taken from it silently picks the wrong pipeline.

Which pipeline draws a stroke follows from its settings, and three of the four
answers are not the inline stroke branch:

- **plain dab / ribbon** — drawn inline in the main pass.
- **wash paint mode** — drawn into a per-appearance isolation texture, with
  `strokeOpacity` applied once when that texture composites. This is what keeps
  a self-crossing stroke from darkening at the crossing.
- **wet** — `normalizeBrushSettingsV2` forces a wet brush into wash paint mode,
  so **every wet stroke is a wash stroke** and arrives through the isolation
  route. The wet simulation stands in for the appearance's offscreen render.
- **mixing** — needs the composite that exists *below* the stroke, which the
  isolation route cannot provide: it runs before the main pass, when the target
  still holds nothing. Mixing therefore uses the `BackdropEffectDriver`
  inline-composite seam (the same one glass refraction uses), where the main
  pass ends at the stroke's z-order, the driver draws, and the pass restarts.

**A stroke that reads what is beneath it belongs on the inline-composite seam.
A stroke that only needs isolation from itself belongs on the appearance route.**

Full detail — the settings model, dab generation, wash, mixing, the wet layer,
ribbons, the caches and what can be tested — is in `references/brush-engine.md`.

### Per-dab and per-path GPU data layouts

Two structs carry everything the dab shaders read, and both have exactly one
definition:

- **`DabInstanceLayout.ts`** — the dab instance ABI, **frozen at 24 floats**.
  New per-dab data reuses a slot or bit-packs into one (five wet coefficients
  share a slot at 6 bits each; colour-dynamics offsets ride in two slots as
  snorm). Widening the instance would cost every non-wet brush the same bytes.
  Pack signed values as snorm, not as offset unorm, so an unwritten dab decodes
  to zero rather than to a maximum-magnitude offset.
- **`shaders/dabColor.wgsl.ts`** — `PATH_META_WGSL` (the struct) and
  `PATH_META_FLOATS` (its stride). Every shader that indexes the path meta
  buffer includes the former; every CPU writer strides by the latter. **A second
  copy of the struct, or a second hand-written CPU writer, desynchronizes the
  stride the moment either side gains a field** — and index 0 still lines up, so
  the failure only appears with two or more paths in a batch.

### Changing the rendering pipeline

**Impact varies. Key areas:**

- **Viewport uniforms** — Use the correct ViewportManager method. See "Why 3 methods" above
- **FrameGraph passes** — new render work in CanvasLayer is declared as a FrameGraph pass with precise `reads`/`writes` (resolve textures via `ctx.get`, never capture created textures in the closure) and `neverCull` for side-effect-only passes, or it gets dead-pass-culled / breaks lifetime aliasing. See the FrameGraph section of `references/rendering-pipeline.md`
- **Cache** — DocumentCache manages size-matched auxiliary textures, not element-content invalidation. Viewport resize recreates compatible resources. For any new cache texture, define its key, invalidation, and safe destroy owner; see `references/cache-strategy.md`
- **Offscreen rendering** — OffscreenPresenter creates temporary textures (from `TexturePool`) for blend modes and clip groups. Each offscreen pass gets its own uniform scope via `UniformScope` to avoid corrupting the main pass uniforms
- **Rasterization resolution** — a pass with a kernel (filter/extrude) sizes to `getRasterScale()` (fixed R); one without (mask, clip, eraser, blend separation) stays at the viewport zoom and bounds its *coverage* instead; see the "Rasterization resolution" section
- **Submit boundaries** — Each distinct viewport/uniform state needs its own `queue.submit()`. Batching draws across different uniform states silently produces wrong results

### Changing collaboration / adding synced state

**Impact:** YjsProvider → extractDocumentFromYDoc → (UndoManager)

YjsProvider has two sync modes:
- **Full sync** — `extractDocumentFromYDoc` converts entire Y.Doc → Document. Used for structural changes (layer add/remove) and undo/redo
- **Delta sync** — `onObjectsChange` callback sends only added/updated/deleted object IDs. Used for normal element edits. Much cheaper than full sync

To add new persistent data:
1. Add Y.Map/Y.Array to YjsProvider and mutation methods
2. Add reading logic in `extractDocumentFromYDoc`
3. Add delta sync support if the data changes frequently (otherwise full sync is fine)
4. If it should be undoable, add the Y type to UndoManager's tracked roots

**A new `ArtObject` field must be added to two separate enumerations.**
`objectToStoredFields` writes an element on **create**; `updateElement` writes
single fields on **mutate**, matching each key against `SCALAR_FIELDS` /
`JSON_FIELDS` and **silently dropping anything in neither**. A field added to
only one of them saves once and then never updates again — the symptom is a
control that appears to do nothing at all, with no error anywhere.
`yjsFieldCoverage.test.ts` holds the two in sync; keep it passing rather than
re-deriving the invariant by hand.

Both enumerations, and every other walk that switches on `AnyArtObject["type"]`
(the Yjs serializer, the papf GC reachability sweep, the clone id remap, the def
subtree walks), list all cases and end in `neverReached(element, …)` from
`utils/lang`. That is what makes adding a ninth element type a compile error
instead of a silent omission — without it the new type compiles cleanly and is
then quietly unpersisted, unreachable, or un-remapped.

### Changing hit-testing / snapping

**Impact:** SpatialIndex → utils/geometry/bounds

SpatialIndex uses Quadtree for spatial queries and maintains a parent-group reverse index for O(1) lookups. Bounds are computed in `utils/geometry/bounds`. Snapping (`snapElements`, `snapArtboard`) aligns to artboard edges, element edges, and center lines.

New element types need bounds calculation in `utils/geometry/bounds` — without it, the element is invisible to all spatial queries.

## Rasterization resolution (DPI / R)

Filter and 3D-appearance offscreen passes rasterize at a **fixed resolution R =
`Document.rasterizationDpi / 72`** (`CanvasLayer.getRasterScale()`; 72 DPI = 1
texel per world px), decoupled from viewport zoom / display DPI / export scale so
blur radii, kernels, and extrude tessellation stay stable across zoom.
`FilterSceneInfo.zoom` carries R (texels per world px of the source texture), not
the canvas zoom.

**R is for kernels, and only for kernels.** Ask of an offscreen pass: does
anything in it read neighbouring texels at a radius given in world units? If yes
it takes R, and the lost sharpness is the price of a stable kernel. If no — masks,
clip groups, eraser, blend separation — the pass draws something and puts it back
on screen, so its resolution *is* its output, and fixing the scale spends the
edge for nothing. This branch baked masks at R and had to undo it: clip outlines
and alpha lock both came out visibly softer. Bound those passes by shrinking what
the texture covers instead.

**A stroke simulation has its own fixed resolution, derived from the stroke.**
`resolveSimulationDomain(bounds, brushSize, maxTextureSide)` gives the wet layer
and any other neighbourhood-reading stroke pass a world-per-texel taken from the
brush size (96 texels per brush diameter, clamped), never from the viewport or
from R, and tiles it with overlap when it outgrows one texture. That is what
makes bleeding and mixing a pure function of the stroke — and it is why the
composite that puts the result on screen has to filter (see the gotchas).

Full detail — which passes use R vs. live viewport zoom, the filter contract,
persistence/sync/migration, and gotchas — is in `references/rasterization-dpi.md`.

## 3D features (two unrelated subsystems)

Paplico has two independent 3D features — **do not conflate them**:

- **extrude3d appearance** — a *2D element's own appearance* (self-built WebGPU,
  no three.js). A `postProcess` filter: opaque solids self-size through
  `postProcess`, glass solids composite at z-order via a per-canvas
  `GeometryBackdropDriver`; flat fill/stroke is suppressed by the
  processor-agnostic `isElementRenderReplaced`.
  Detail → `references/extrude-3d-appearance.md`.
- **Scene3D (atari / reference scenes)** — a *distinct element type* (`scene3d`) +
  document-level shared scenes (`Document.scenes3d`), built on three.js
  (lazy-loaded, blitted like an image): primitives, poseable VRM figures + IK,
  lineart extraction, camera-derived perspective guides. A tracing aid, not a 3D
  editor. Detail → `references/scene3d.md`.

## Renderer gotchas (hard-won)

- **A pooled texture nobody wrote is invisible until it isn't.** Every path that
  acquires from `TexturePool` and hands the texture on must actually write it.
  `composeInline` acquires its composite before looping the entries, and only the
  first entry's pass carries the `loadOp: "clear"` — so a compose that declines
  every entry (`acquireSample` returns null for a fully off-screen region)
  returned a texture holding the previous frame's content. Cold pool: fresh
  allocations read transparent and nothing shows. Warm pool: a ghost of an
  unrelated element. The symptom is not a wrong picture but *two renders of the
  same thing disagreeing*, so idempotency tests catch it and snapshots do not.
- **A kind written to storage must be read back by derivation, not by a list.**
  `yMapToLayer` matched one `transientKind` by hand, so a mask-edit working layer
  was written transient and read back ordinary — and undo, which re-extracts the
  whole document, turned it into a real layer with the mask's contents on the
  canvas. Derive the check from the const map so a new member cannot be dropped
  by omission.
- **One authority per stack.** Editing scopes and undo each had two entry points:
  one that knew about sessions and one that did not, and the UI used the second.
  A session pushes its working layer onto the scope stack, so popping that entry
  from underneath leaves it believing it is open with its layer stranded. Put the
  decision where the state lives (`PaplicoSelection` for the scope stack,
  `PaplicoCommands.undo` for history) and let every caller inherit it, rather
  than guarding the one path that was reported.
- **Entering a canvas mode from a button leaves focus on the button.** Every
  canvas keybinding is gated on `canvasFocused`, so Escape does nothing until the
  user clicks the canvas — which a dimmed canvas invites least. Whatever starts
  the mode calls `PaplicoUI.focusCanvas()` itself; a call site cannot be relied on
  to remember, and there are already three of them.

- **FrameGraph passes run in declaration order.** A pass that draws element
  content with its real appearance must be declared *after* the def pre-passes
  (`Pattern Defs`, `Brush Defs`), or it renders before those textures exist and
  bakes the wrong thing. Ordering bugs here produce plausible-looking output,
  not errors.
- **`composeTransforms` is not associative.** It scales the rotated offset along
  the *parent's* axes, so `compose(compose(a,b),c) ≠ compose(a,compose(b,c))`
  as soon as `a` rotates. Re-parenting an element by folding its old parent's
  local transform into it is therefore only correct when the new parent is the
  identity — with a rotated group two levels up it lands tens of units away. Go
  through the composed transform and back down with `solveChildTransform`.
- **A group is not a coordinate-space scaffold.** A group's transform pivots on
  the centre of its children's local bounds, so resizing any child moves the
  origin and shifts everything under it by `originDelta * (1 - scale)`. Parenting
  content to a group purely to borrow a frame looks right until the first
  resize. (Translation-only parents are immune, which is what makes this survive
  casual testing.)
- **An editing session's authoring space must equal its storage space.** Tools
  author in world space. A session that stores its subject in some other frame
  (an owner's local space, say) has to convert on the way in *and* on the way
  out, covering elements added mid-session too — otherwise everything drawn or
  pasted during the session jumps by that frame's transform on the way out, while
  looking correct until then.
- **A session that edits the document in place has nothing to confirm.** Pattern
  edit expands a def into throwaway working copies, so its edits are held apart
  under an origin the main UndoManager does not track, and committing writes them
  back. Mask edit has one owner and edits the real objects, so there is nothing to
  confirm or discard — it is a scope to enter and leave. Copying the commit/cancel
  shape across cost real behaviour: the session's edits were tagged, and closing
  it destroyed the only stack that tracked them, so everything drawn into a mask
  became permanently unreachable by undo. Tag the session's own bookkeeping if it
  should not be an undo step; leave the user's edits untagged.
- **Offscreen viewport culling.** `createOffscreenPass` sets
  `viewportState.bounds = null` intending "don't cull by the main viewport", but
  the per-element cull *falls back* to `boundsIntersectViewport(viewportState.current)`
  when bounds is null — i.e. it still culls against the canvas viewport. Content
  outside the current view but inside the offscreen target gets dropped. A null
  `bounds` must be treated as "skip culling" for offscreen passes.
- **fp32 depth precision.** GPU geometry carrying absolute **world** coordinates
  (a group extrude) loses depth bits to catastrophic cancellation when multiplied
  by the mvp in fp32, so non-overlapping parts quantize to the same depth and
  fall back to draw order. Rebase positions to the outline center on the CPU and
  post-multiply the mvp by `T(center)` (`extrudeMesh` `rebaseToCenter`).
- **AppearanceCache** (`caches/AppearanceCache.ts`) is the generic per-
  `(elementId, appearanceUid)` cache an appearance handler stores opaque
  `{ hash, destroy() }` entries in; liveness/eviction is engine-driven. Use it
  for any cross-frame per-appearance GPU resource (the extrude mesh is its first
  user).
- **Never single-slot-cache a texture whose size alternates within a frame.**
  A "recreate when the size differs" cache (old filter temps, drop-shadow copy,
  DocumentCache stencils) churns hundreds of MB of zero-initialized allocations
  per second when differently-sized chains run each frame — the GPU **process
  CPU** saturates on allocation while the JS profiler and the pass-level GPU
  trace both look idle. Keep a small per-size map (FIFO/LRU-capped, deferred
  destroy) instead, and never evict entries already used in the current frame.
  Same class of bug: a `TexturePool` budget smaller than one frame's pooled
  working set makes `resetFrame` evict everything just to re-allocate it.
- **Frame-end texture ownership.** CanvasLayer deferDestroys every
  `PostProcessResult`/override-layer texture at frame end. A handler that wants
  to return a **cache-owned** texture (reused next frame) must mark the layer
  `retainedTexture: true` (`BlitLayer`) so the sweep skips it — the extrude
  bake's caller clone does this.

- **A colour attachment costs more bytes than its texels.** The guaranteed
  `maxColorAttachmentBytesPerSample` is 32, and the per-format cost is not the
  texel size: `rgba8unorm` costs **8**, `rgba16float` 8, `rg8unorm` 2,
  `r8unorm` 1. Three float fields plus one `rgba8unorm` already sit at the
  ceiling. Narrow formats are also how a pass gets more *blend states*: there is
  one per target, so values that accumulate (coverage) and values that should be
  taken from whichever draw covers the texel (a coefficient) cannot share a
  target — putting them together forces one of the two to be wrong.
- **`textureSample` must be called from uniform control flow.** Implicit
  derivatives are undefined inside a branch. Sample unconditionally and branch on
  the *result*; bind a 1×1 dummy texture for the case that does not want it.
- **A frame's GPU buffers must not be destroyed at end of frame.** The
  orchestrator submits *after* `render()` returns, so a `releaseFrame` that calls
  `buffer.destroy()` invalidates the command buffer that still references it —
  and the whole frame silently produces nothing, not just that pass. Retire
  buffers one frame late (hand them to a list the next `beginFrame` destroys).
  Textures are exempt only because `deferDestroy` already defers them.
- **Compositing a fixed-R field onto a coarser target needs a box filter.** The
  simulation domain is sized from the stroke, not the viewport, so for a small
  brush it is several times finer than what it composites onto. One tap per
  target pixel then skips whole rows of the field: the result reads as stripes,
  or as a hole through the middle of a stroke. Average a box covering the target
  pixel's footprint.
- **A content key over document objects is an identity key.** Document updates
  are immutable, so object identity *is* content identity — a per-object serial
  is a complete content key and needs no deep hashing. It is not transitive on
  its own: a stroke that reads the *rendered result* of another stroke must
  embed that stroke's own key, or editing something only the lower stroke reads
  leaves the upper one serving a stale texture.

## Test-writing gotchas (GPU)

- **`copyTextureToBuffer` requires `bytesPerRow` to be a multiple of 256.** A
  64×64 rgba8 readback is 256 and works; 32×32 is 128 and the copy is dropped as
  a validation error — the test then reads an all-zero buffer and reports the
  renderer drew nothing. Wrap suspect submits in
  `pushErrorScope("validation")` / `popErrorScope()` before believing a blank
  result.
- **The unit test environment cannot decode embedded images.** `createImageBitmap`
  is absent, so `BrushTextureManager` never loads a document's embedded PNGs.
  Anything that needs a real brush or paper texture cannot be asserted there;
  test the generator that produces the pixels instead.
- **The frame plan caches on `document.objects` identity.** A test that mutates
  `doc.objects[id]` in place changes nothing the renderer can see — it keeps the
  cached plan and the previous element. Replace the map
  (`doc.objects = { ...doc.objects, [id]: next }`) the way a real edit does.
- **`webgpu-utils` cannot build a structured view for a fixed-size vector
  array.** `array<vec4f, 64>` in a storage binding throws `unknown type: vec4f`
  at `makeStructuredView`; declare it unsized (`array<vec4f>`) and size the
  buffer from the CPU.
- **Prove a test can fail before trusting it.** A test whose fixture accidentally
  satisfies the assertion by another route passes with the fix reverted, which is
  worse than no test. Revert the change, watch it fail, restore. Two shapes that
  invite this: a "spread further" assertion where an alpha curve saturates either
  way, and an overlap-based invalidation test whose fixture overlaps through a
  second path. `calculateElementBounds` includes stroke width, so bounds are
  wider than the geometry suggests — measure the real value rather than
  estimating it.

## Key Interfaces

| Interface | Location | Role |
|-----------|----------|------|
| `ArtObject`, `AnyArtObject` | schema.ts | Element base and union |
| `Document`, `Layer`, `Viewport` | schema.ts | Document structure |
| `Appearance<T>`, `Filter`, `FillColor` | schema.ts | Unified styling system |
| `CubicBezierSegment`, `PathSegment` | schema.ts | Path geometry (cp1/cp2 relative) |
| `ElementTransform` | schema.ts | Per-element transform |
| `Material3D`, `Extrude3DParams` | schema.ts | Shared 3D material + extrude appearance params |
| `Document.rasterizationDpi` | schema.ts | Fixed rasterization resolution (R = dpi/72) |
| `Tool`, `PointerEventData` | tools/Tool.ts | Tool contract |
| `ToolContext` | (injected via constructor) | Tool → engine bridge |
| `FilterHandler`, `FilterProcessorContext` | pipeline/FilterRenderer.ts | Filter processing contract (pre/post; `postProcess` may return a self-sized `PostProcessResult` and read `ctx.geometry`) |
| `FilterGeometryContext`, `PostProcessResult`, `FilterRenderRequirements` | pipeline/FilterRenderer.ts | Self-sizing geometry-filter inputs/outputs + per-filter requirements |
| `isElementRenderReplaced` | pipeline/FilterRenderer.ts | Processor-agnostic "an appearance renders the element in place of its flat look" (suppresses fill/stroke) |
| `GeometryBackdropDriver` | pipeline/FilterRenderer.ts | Per-canvas z-order backdrop-compositing driver a `FilterHandler` owns via `attachCanvas` (glass extrude) |
| `Solid3DFilterHandlerBase` | filters/Solid3DFilterHandlerBase.ts | Shared 3D-solid handler core (extrude3d / revolve3d subclasses) |
| `ExtrudeMeshBaker`, `ExtrudeFrameEntry` | filters/Extrude3D/ | Mesh build/bake core + frame-local extrude result |
| `MeshPassRenderer` | pipeline/MeshPassRenderer.ts | Lit-mesh GPU pass |
| `JumpFloodDistanceField` | filters/JumpFloodDistanceField.ts | Shared JFA distance field over an alpha silhouette |
| `AppearanceCache` | caches/AppearanceCache.ts | Per-(elementId, appearanceUid) cross-frame cache |
| `ICollaboration`, `CollaborationConfig` | collaboration/ICollaboration.ts | Network transport |
| `YjsProviderCallbacks` | collaboration/YjsProvider.ts | Outbound sync |
| `RendererState` | Paplico.ts (factory: document/rendererState.ts) | Shared state shape |
| `FrameRequest`, `UIOverlayState` | renderer/types.ts | Render input |

## Reference Documents

- `references/extrude-3d-appearance.md` — extrude3d appearance filter (opaque postProcess vs glass GeometryBackdropDriver), ExtrudeMeshBaker, MeshPassRenderer, mesh/cache
- `references/scene3d.md` — Scene3D atari feature: three.js boundary, scene data model, VRM/IK, lineart, perspective guides, Scene3DTool
- `references/brush-engine.md` — Brush settings model and curve matrix, routing and the four draw seams, dab/path GPU layouts, wash, colour mixing, the wet layer, ribbons, caches, testing constraints
- `references/rasterization-dpi.md` — Fixed rasterization resolution (R), where it applies, persistence, gotchas
- `references/rendering-pipeline.md` — FrameGraph (declarative pass graph), render pass structure, cache, compositing, GPU resource ownership
- `references/cache-strategy.md` — Current cache, pool, dirty-state, and GPU resource ownership inventory
- `references/data-model.md` — Normalized data model, Appearance system, type relationships
- `references/collaboration.md` — Yjs integration, undo/redo, full vs delta sync
- `references/tools.md` — Tool interface, ToolContext, testing patterns
- `references/coordinate-system.md` — Coordinate transforms, viewport, hit testing
- `references/perf-profiling.md` — How to write a console monkey-patch CPU profiler for the render pipeline (zoom-slowness triage): access points via `window.__paplico`, stage tree, strategy/markDirty buckets, patching technique, recommended shape (auto 10s window, JSON output), gotchas
