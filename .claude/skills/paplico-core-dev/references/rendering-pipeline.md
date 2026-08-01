# Rendering Pipeline Reference

## Why the pipeline is structured this way

The renderer must handle thousands of elements across multiple layers with blend modes, filters, and clip groups while maintaining 60fps during pan/zoom. This drives every major design decision:

- **GPU resource reuse** retains compatible auxiliary textures and buffers
- **Dirty strategy** skips expensive work during interaction
- **Offscreen passes** isolate blend mode and filter computation
- **Batch rendering** minimizes draw calls for brush strokes
- **Separate submit per uniform state** because WebGPU reads uniforms at submit time, not draw time

## Render Trigger → Frame

RenderScheduler collects dirty reasons (document change, viewport change, preview update, etc.) and resolves them into a strategy:

- `full` — Re-render everything. Triggered by document mutation, resize, collaboration sync, animation tick
- `fullInteraction` — Re-render but skip backdrop filters. Triggered by viewport change during active interaction. Backdrop filters (frost glass) are expensive and produce no visible difference during a fast pan
- `overlayOnly` — Only redraw UILayer (selection handles, cursor, guides). Triggered by preview path update, selection change, hover change

The strategy resolution exists because a naive "re-render everything on every change" approach drops to ~15fps during pan/zoom on complex documents.

## FrameGraph (declarative frame composition)

`canvas/pipeline/FrameGraph.ts`. Each `CanvasLayer.render` constructs a
**fresh single-frame graph** (instances are cheap; `execute` throws if called
twice), declares the frame as passes over virtual texture handles, then runs
it once via `CanvasLayer.executeFrame`.

### Structure

- **`FGTextureHandle`** — a branded number naming a virtual texture. Two
  kinds of slots:
  - `createTexture(desc)` — frame-transient; physically acquired from
    `TexturePool` only at execute time
  - `importTexture(texture)` — wraps an externally-owned texture (prebuf,
    swapchain/render target, persistent caches); the graph never
    acquires or releases it
- **`addPass(name, { reads, writes, neverCull?, execute })`** — a "pass" is
  an *encoding span*, not a single `GPURenderPassEncoder`: its `execute`
  callback may open and close several GPU passes (capture, pyramid, mask,
  blit) as long as every resource it touches is declared in `reads`/`writes`.
- **`FGExecuteContext`** — inside `execute`, handles resolve via `ctx.get()`
  / `ctx.view()`. Accessing a handle the pass did not declare **throws**;
  `view()` is never cached, so a created texture's view cannot outlive its
  pass.

### What execute() does

1. **Declaration-order execution** — passes run in the order added; there is
   no reordering.
2. **Dead-pass culling** — walking backwards, a pass survives only if it is
   `neverCull`-protected or writes a texture that is observable (an imported
   texture, or a created handle some later surviving pass reads). Consumers
   mark their producers alive through the handles they read.
3. **Lifetime interval allocation** — each created texture is acquired from
   the `TexturePool` right before its first surviving pass and released right
   after its last, so handles with **disjoint pass ranges alias onto one
   physical texture**. A texture used only by culled passes is never
   acquired. A `finally` block releases everything even when a pass throws.

### Integration in CanvasLayer

`render` imports the render target (`"render-target"`, and `"swapchain"` for
the post-process blit), threads the graph plus imported prebuf/stencil
handles into `renderDocument`, then `executeFrame` runs
`graph.execute(encoder, texturePool)` and is the **single owner of frame
commit/abort/release**: it returns a `CanvasFrameTransaction` whose
`commit`/`abort` settle the frame transaction, and releases per-frame
resources (filtered textures, backdrop captures/pyramids, filter handler
GPU pools) on both success and throw paths.

### Gotchas

- **Declare reads/writes precisely.** Culling, lifetime aliasing, and the
  undeclared-access guard all derive from the declarations. Resolving through
  `ctx.get()` instead of capturing a raw `GPUTexture` in the closure is what
  keeps a pass's real accesses in step with its declared ones — capturing a
  created texture directly would break aliasing silently. (Planned load/store
  resolution builds on the same declarations.)
- **`neverCull` is for invisible side effects** — passes whose value the
  graph cannot see through texture writes (wet-ink simulation updates, cache
  bakes into persistent atlas slots). Without it, a pass writing only to
  created handles nobody reads is culled.
- **A created handle is only valid inside its first-use..last-use pass
  range** — resolving it outside throws (`resolved outside its pass range`).

Unit tests: `canvas/pipeline/FrameGraph.test.ts` (ordering, aliasing,
culling, undeclared-access rejection, throw-path release).

## Per-frame render phases

Each CanvasLayer runs these phases per frame:

### 1. Auxiliary-resource check (`DocumentCache`)

The current renderer renders document content directly every frame; the former
1.5x layer-content cache has been removed. `DocumentCache` now retains
size-matched stencil, composite, prebuffer, final-blit, and backdrop-mask GPU
textures. A descriptor hit reuses the resource; a size mismatch replaces it.
`CanvasLayer` owns final destruction and replacement destruction is deferred until
in-flight GPU work is safe. The complete policy is in
`references/cache-strategy.md`.

### 2. Element dispatch (ElementRenderer)

ElementRenderer.dispatchElementDirect branches on element type and routes to the appropriate renderer:

- Path with stroke → BrushStrokeRenderer (stamp-based instanced rendering)
- Path with fill → ElementRenderer.renderSimpleFill or GradientRenderer (triangulated fill)
- Image → ImageElementRenderer (texture sampling)
- Text → TextElementRenderer (glyph path triangulation via TextRenderer)
- Group → Recursive dispatch of children
- CompoundPath → Stencil-based boolean operations on child paths

When adding a new element type, this is the dispatch point that must be extended.

### 3. Filter application (FilterRenderer)

Filters from `ArtObject.filters[]` are applied per-element after rendering. FilterRenderer uses a ping-pong between two temporary textures for multi-pass filters (e.g., blur requires horizontal + vertical passes). The final result is copied back to the element's texture.

Pre-filters (`preProcess`) modify path geometry before rendering — they never touch textures. Post-filters (`postProcess`) usually operate on the already-rendered texture (same-size, in place; e.g. blur). But `postProcess` is also the home of **self-sizing geometry filters** (extrude3d): they read `ctx.geometry`, build their own output, and return a self-sized `PostProcessResult` blitted at its own bounds. fill/stroke, by contrast, still produce the flat look in `ElementRenderer`'s appearance loop, not via `FilterRenderer` (see SKILL.md "Two filter hooks").

Filter offscreens are rasterized at the fixed **rasterization resolution R** (`getRasterScale()`), not viewport zoom, so results stay stable across zoom — see `references/rasterization-dpi.md`.

### 4. Offscreen compositing (OffscreenPresenter / CompositeRenderer)

Elements with non-normal blend modes or clip groups cannot be rendered directly to the canvas. They need a clean offscreen texture to composite correctly.

OffscreenPresenter creates a temporary texture (from the `TexturePool`) sized to the element bounds, renders the element into it, then CompositeRenderer blits it onto the canvas with the correct blend mode. This is expensive (texture allocation + extra render pass), which is why normal-blend elements bypass this entirely. Note: an offscreen pass sets `viewportState.bounds = null`; treat that as "skip viewport culling", since the null-bounds cull path otherwise falls back to the canvas viewport and drops off-view content (see SKILL.md "Renderer gotchas").

Clip groups use stencil operations: the clip path writes to the stencil buffer, then children render with stencil test enabled.

## GPU resource ownership and destroy() chain

Every class that allocates GPU resources must release them. The ownership chain:

- RenderOrchestrator owns: GPU device, BrushTextureManager, FilterRenderer, and per-target CanvasLayers
- CanvasLayer owns: ViewportManager, DocumentCache textures, stencil texture, all sub-renderers
- ViewportManager owns: uniform buffer, transform storage buffer

`destroy()` must call children's `destroy()` before releasing own resources. Missing a child destroy causes GPU memory leaks that are silent until the device runs out of memory.

RenderOrchestrator handles device loss by releasing all GPU resources via `releaseGPUResources()`, then re-initializing via `attemptRecovery()`. Any new GPU resource type added must be released in both `destroy()` and `releaseGPUResources()`.

## Shader architecture

Shared pipeline WGSL shaders live in `core/renderer/shaders/`; filter-specific shaders live next to their processors in `core/renderer/filters/`. Compiled via `compileShaderModule` from `utils/wgpu-utils.ts`, which also provides typed `uniformViews` for automatic padding/alignment.

Uniform binding layout convention:
- Group 0 = viewport uniforms (shared across all draws)
- Group 1 = per-element/per-draw uniforms

`UniformScope` provides per-pass uniform buffers for offscreen passes. This prevents offscreen rendering from corrupting the main pass uniform buffer — a subtle bug that is hard to diagnose because it manifests as random visual glitches depending on render order.
