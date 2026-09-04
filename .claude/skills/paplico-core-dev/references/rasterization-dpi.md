# Rasterization resolution (DPI / R)

Verified against `pkgs/web/src/core/` on 2026-07-21. Re-check symbol names/line
numbers before relying on them — they drift.

## Why R exists

Rasterizing a filtered element (blur / frost-glass / drop-shadow / hanakla-kit,
and the extrude3d 3D solid) to an offscreen sized at
`element-bounds × viewport-zoom` makes the result wobble with viewport zoom,
display DPI, and export scale: every zoom changes the texel grid and the kernel
discretization. Paplico uses an Illustrator-style **fixed rasterization
resolution R** instead, analogous to "Document Raster Effects Settings".

## Definition of R

- `Document.rasterizationDpi?: number` (`schema.ts`). DPI unit. Default 72;
  `undefined` is treated as 72. It's document meta, alongside `colorProfile` /
  `hdr`.
- **R = rasterizationDpi / 72.** 72 DPI → R = 1.0 = 1 texel per world px.
- `CanvasLayer.getRasterScale()`:
  ```ts
  private getRasterScale(): number {
    return (this.activeDocument?.rasterizationDpi ?? 72) / 72;
  }
  ```
  Fixed for **all** zoom levels (even when zoom < R, it stays at R — no
  down-scaling). Derived purely from `activeDocument`; `FrameRequest` is
  unchanged.

## Where R is applied — and where it is NOT

R is threaded only through **filter-family** offscreen passes, via the optional
`rasterScale?` parameter of `OffscreenPresenter.createOffscreenPass`. Inside it,
`rasterZoom = rasterScale ?? zoom`, and both the texture size and the pass's
`effectiveZoom` use `rasterZoom` instead of the live viewport zoom.

**Passes R (fixed resolution):**
- `CanvasLayer.executeFilterPlans` — full-element offscreen + post-filters
- `CanvasLayer.executePerAppearanceFilterPlan` — per-appearance accumulator
- Group child pre-filter bakes
- **extrude3d**: opaque solids get R through `executeFilterPlans` (their
  `postProcess`); the glass driver's `prepareFrame` bakes at `getRasterScale()`
  too. (See `references/extrude-3d-appearance.md`.)
- `OffscreenPresenter.applyWorldMaskToTexture` and `bakeQuadToTexture` — no
  kernel of their own, but their input is a filter output / 3D bake already at
  R, so taking the zoom would only stretch an R-resolution image into a finer
  texture. They read R from an `OffscreenPresenter` dep rather than a
  `rasterScale` argument, so a new call site cannot fall back to the zoom by
  leaving the parameter off.

**Does NOT pass R (stays at live viewport zoom):**
- Clip masks and object masks (`ClipMaskAtlas`)
- Eraser
- Blend separation
- **Backdrop filters** (e.g. FrostGlass) — they sample the on-screen backdrop,
  which is at display resolution, so their kernel is defined in screen space.

R buys zoom-stability for a **kernel** and pays for it in resolution. A mask has
no kernel: it is drawn once and sampled, so its resolution is not a means to an
end, it is the output. Baking one at a fixed scale was tried on this branch and
had to be undone — it costs the mask's edge whatever the screen is showing it
at, for nothing in return. Bound the growth by shrinking what the texture covers
instead, as `ClipMaskAtlas.computeCoverage` does.

## Filter contract change (semantics only)

`FilterSceneInfo.zoom` is redefined to **"texels per world px of the source
texture"** (JSDoc only; no processor code changed):
- Element filters → `zoom` = R (possibly clamped by the GPU max texture
  dimension for very large elements).
- Backdrop filters → `zoom` = the live viewport zoom.

Filter processors already scale spatial parameters (blur radius, kernel size)
by `sceneInfo.zoom`, so they need no change. The existing quad blit
(`blitUvRect` + `coverageBounds`) rescales the R-resolution texture up/down to
the display size, so the compositing/blit side is untouched.

## Persistence & collaboration

- **Write:** `PaplicoCommands.setRasterizationDpi(dpi)` →
  `YjsProvider.setRasterizationDpi(dpi)` → `yMeta.set("rasterizationDpi", dpi)`.
- **Default / cleanup:** on document set, `yMeta` gets `rasterizationDpi ?? 72`;
  `delete("rasterizationDpi")` is handled so a document swap doesn't leak a stale
  value.
- **Undo:** NOT tracked by `UndoManager` (same as other meta settings — changing
  the raster DPI is not an undoable edit).
- **Read:** `extractDocumentFromYDoc` reads `yMeta.get("rasterizationDpi")` and
  falls back to 72 unless it's a finite, positive number.
- **File io:** persisted through `io/papf/`. Migration
  `io/migrations/20260705_mig_rasterization_dpi.ts` backfills 72 for documents
  saved before the field existed (meta-schema minor bump; the field is optional
  so serialization is otherwise automatic).

## Gotchas / open edges

- **Scene3D is under R, but clamped.** `Reference3DElementRenderer` sizes scene
  textures from R through `clampReference3DRasterScale` ([0.25, 4]) with a
  2048 px side cap, since a full 3D scene is a different memory tradeoff from a
  filter bake. Zoom never re-renders scenes; changing the document DPI does.
- **Any new renderer that samples a filtered/rasterized intermediary** must size
  its offscreen with `getRasterScale()`, not viewport zoom, or it re-discretizes
  on zoom and reintroduces the exact wobble R was added to remove. It also has
  no upper bound: a texture sized `bounds × zoom` grows until it hits the device
  dimension limit, which is 8192 or 16384 — 268 MB to 2 GB for a single texture,
  allocated per masked element. Sized at R the texture depends only on the
  element's world extent, and the existing quad blit scales it to whatever the
  viewport shows.
- The GPU max texture dimension can clamp the effective R below the requested
  value for very large elements; treat `sceneInfo.zoom` (the actual texels per
  world px) as authoritative, not `rasterizationDpi/72`.
