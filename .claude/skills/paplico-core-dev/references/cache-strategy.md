# Core Cache Strategy Reference

Verified against `pkgs/web/src/core/` on 2026-07-10.

This is the inventory of current cross-call and cross-frame reuse under
`core/`. It covers content/derived-data caches, GPU resource caches and pools,
in-flight work deduplication, and dirty-state mechanisms that decide when a
cache is valid. It deliberately excludes one-shot local variables and domain
state that is not retained to avoid work.

## Vocabulary and the current rendering model

| Term | Meaning in this codebase |
| --- | --- |
| **Content cache** | Reuses a result derived from document data, normally with an ID plus a fingerprint/hash. |
| **Resource cache** | Reuses a GPU texture, buffer, bind group, pipeline, or WebGL target while its shape/identity remains compatible. |
| **Pool** | Reuses frame-transient resources by slot or descriptor. A pool does not assert that the rendered content is still valid. |
| **In-flight deduplication** | Stores a pending `Promise` or key so concurrent requests share one asynchronous load or render. |
| **Index / dirty state** | Retains derived lookup data or batches invalidations. It controls cache validity but is not necessarily a content cache. |

### `DocumentCache` is not a document-content cache

`CanvasLayer` renders document content directly every frame;
`invalidateDocumentCache()` only drops the composite frame cache that
viewport-only frames blit and reproject. The `DocumentCache` name refers to
persistent, size-matched GPU auxiliary textures only. Do not design an
invalidation path on the assumption that it stores rendered layer contents.

`DocumentCache` retains the main stencil texture, composite textures
(`capture`, `layer`, `prebuf`, `canvasBase`), final-blit stencil, and backdrop
mask color/stencil textures. A hit requires the corresponding textures to exist
with the requested width and height; a size mismatch replaces the resources.
`CanvasLayer` owns their final destruction, while replaced resources are deferred
through `OffscreenPresenter` so an in-flight command buffer can finish safely.

Sources: `renderer/canvas/CanvasLayer.ts` (`invalidateDocumentCache` and
`destroy`), `renderer/canvas/pipeline/DocumentCache.ts`.

## Lifetime and invalidation map

| Lifetime | Main owners | Reset / eviction boundary |
| --- | --- | --- |
| One render frame | `TexturePool` leases, `UniformScope`, draw-buffer pools, backdrop batches, filter ping-pong resources | Frame start/end, submit completion, or the next safe destroy point |
| Per `CanvasLayer` / canvas target | render caches, image/text/scene textures, clip masks, `DocumentCache` auxiliary textures | Canvas destruction, device-loss release, object removal, compatible descriptor miss |
| Per renderer / engine | brush textures, filter pipelines, text layouts, spatial/definition indexes | Engine/renderer destruction, document delta, explicit clear, or device recovery |
| Process/module singleton | font assets and glyph outlines, colour engine import/LUT cache, lazy Scene3D service | Explicit loader/backend replacement where available; otherwise process lifetime |

GPU resource replacement must not destroy a texture or buffer referenced by an
already encoded command buffer. The renderer uses `OffscreenPresenter.deferDestroy`,
`pendingDestroy` queues, or submit-completion callbacks for that boundary. A new
GPU cache must declare which object performs its final `destroy()` and which
mechanism defers replacement destruction.

## Renderer derived-data caches

`RenderCacheManager` is created per canvas target. On full render strategies it
prunes entries for objects no longer present; `full` also invalidates transform/
bounds state and clip masks. Its caches are not one generic policy: every cache
has its own key and resource lifetime.

| Cache | Retained value and key | Validity / invalidation | Ownership |
| --- | --- | --- | --- |
| `GeometryCache` | Flattened subpaths, world offset, geometry hash keyed by element ID | Reused only when geometry hash and offset match; removed-object prune. A geometry miss removes the stencil-fill entry. | CPU-only; `RenderCacheManager` |
| `StrokeCache` | CPU tessellation plus solid-stroke GPU buffer, geometry/color hashes, gradient bounds, transform index; key `elementId:stroke[:filterUIDs]` | Geometry/color/transform/resource checks determine a hit. Replacement, deletion, and clear destroy its buffer immediately. | `StrokeCache` |
| `StencilFillCache` | Fan/fringe GPU buffers, fringe data, bounds, solid flag, transform index, geometry hash; key element ID | Geometry hash and transform index must match. Replaced/deleted buffers are queued until next frame start. | `StencilFillCache` plus `CanvasLayer` frame flush |
| `GradientCache` | Dedicated uniform/stops/vertex buffers and bind group for linear/radial gradients | Caller key plus gradient/bounds/geometry/transform fingerprint. Replace/delete/clear destroys all owned buffers. | `GradientCache` |
| `CompoundPathCache` | Boolean-operation segments keyed by compound-path ID | Fingerprint includes source filters, transforms, and segments. Removed-object prune or clear. | CPU-only |
| `GroupPathCache` | Recursive group appearance segments keyed by group ID | Recursive child structure/segments/transforms fingerprint. Removed-object prune or clear. | CPU-only |
| `BlendCache` | Blend intermediates keyed by blend ID | Blend settings and source/spine filters, transforms, segments, opacity fingerprint. Removed-object prune or clear. | CPU-only |
| `StampCache` | CPU `StampBuffer` for generated brush stamps | Exact key is `path.id:fingerprint:nibAspect:hashStampInput`; viewport culling still runs each frame after a hit. | `RenderCacheManager` |
| `AppearanceCache` | Opaque `{ hash, destroy() }` per appearance | Key is `${elementId}::${appearanceUid}`. The handler owns hash semantics; replacing/removing queues entry-specific destruction until the next safe flush. | `AppearanceCache` |
| `BindGroupCache` | Immutable bind groups for a texture combination | Slot index plus one, two, or three `GPUTexture` identities must match. No explicit eviction; bind groups have no `destroy()`. | The renderer instance that owns the cache |

### Current `StampCache` pruning behavior

`RenderCacheManager.onDocumentChange()` derives an object ID by splitting only
on `::`, while `StrokeBatchContext` creates stamp keys with a single `:` after
the path ID. Consequently, an `onDocumentChange()` prune does not match a stamp
key to a live object ID and removes those entries. Treat the stamp cache as
document-change-invalidated in the current implementation; do not rely on it
surviving a full render.

Sources: `renderer/canvas/caches/RenderCacheManager.ts`,
`renderer/canvas/caches/{Geometry,Stroke,StencilFill,Gradient,CompoundPath,GroupPath,Blend,Stamp,Appearance,BindGroup}Cache.ts`,
`renderer/canvas/elements/ElementRenderer.ts`,
`renderer/canvas/elements/GradientRenderer.ts`,
`renderer/canvas/pipeline/stroke/StrokeBatchContext.ts`.

## GPU resource reuse and pools

| Component | Reuse key / mechanism | Eviction and destruction |
| --- | --- | --- |
| `TexturePool` | Quantized `width × height × format × sampleCount × usage`; dimensions round to 128 px buckets | Returned pool-owned textures are available next frame. At frame start, pool memory over 128 MiB is evicted by bucket/Map insertion order, not a global LRU. `CanvasLayer.destroy()` destroys the pool. |
| `ClipMaskAtlas` | `clipPathId` plus fingerprint of quantized texture size, effective zoom, and coverage bounds | Matching clip masks skip rerasterization. Full/full-transform strategies invalidate all; inactive entries release. Large groups use padded, snapped coverage to reduce pan churn. Color masks persist across frames; temporary stencil leases come from `TexturePool`. |
| `ViewportManager` | Element-ID bounds cache; composed transform/parent-group data; grow-only transform GPU buffer, bind group, `ArrayBuffer`, and typed arrays | Full transform invalidation clears all derived state; preview geometry invalidates the element and ancestor groups. Buffers grow only when capacity is insufficient and are destroyed by `ViewportManager`. |
| `UniformScope` | No descriptor key: each offscreen/export/clip pass receives the next frame-local slot | Resets the slot index every frame and grows to peak concurrent passes. No budget eviction; `CanvasLayer` destroys all buffers. |
| `CompositeRenderer` | Frame-indexed pools for blit/quad/composite uniform buffers | Reuse by slot after frame reset; destroy releases buffers and the dummy base texture. |
| `BackdropEffectCoordinator` | One frame-local backdrop batch may share sharp capture and blur-pyramid levels when its union covers later requests | Draw dirtiness patches only intersecting capture/pyramid regions; at least 50% dirty coverage rebuilds a level. Frame textures return through deferred release and uniform buffers reuse frame slots. |
| `BackdropCaptureManager` | Reuses resample pipeline/layout/sampler for a compatible format | Each capture texture is created per request rather than pooled by this class. |
| `FilterRenderer` | Two ping-pong filter textures reuse exact `(width, height, format)` matches | Descriptor change moves old textures to `pendingDestroy`; the next safe frame flush destroys them. |

`OffscreenPresenter.deferDestroy()` is the bridge between a consumer and the
pool: pool-owned textures are released; non-pool textures are destroyed after
the in-flight work is safe. Use it instead of destroying a replacement texture
inside an encoded pass.

Sources: `renderer/canvas/pipeline/{TexturePool,ClipMaskAtlas,ViewportManager,UniformScope,CompositeRenderer,BackdropEffectCoordinator,BackdropCaptureManager,FilterRenderer,OffscreenPresenter}.ts`.

## Brushes, fills, gradients, and images

### Brush textures and batches

- `BrushTextureManager` is a device-lifetime map from brush UID to `GPUTexture`
  and dimensions. Default texture loading is one-shot. Def-rasterized textures
  are aliases and retain DefRasterizer ownership; ordinary textures are released
  by the manager. There is no LRU or capacity policy.
- `BrushTextureArrayBuilder` caches `texture_2d_array` resources by the sorted,
  deduplicated brush UID set joined with `|`. Source texture revision is not in
  the key. The builder owns all arrays until `destroy()`.
- `StrokeBatchContext` pools stamp/path-meta/color-stop GPU buffers by frame slot,
  preallocates CPU arrays from the previous peak, caches views by UID, and keeps
  the immediately previous normal-brush bind-group tuple. Its `destroy()` frees
  those resources and the array builder.
- `WetInkPass` has separate result caches: `simCache` (128 entries / 192 MiB
  LRU), `driedCache` (512 MiB, insertion-order eviction because hits do not
  refresh recency), and `groupResultCache` (48 entries / 128 MiB; true LRU on
  hits). Ping-pong pigment/water textures are quantized and grow-only; its uniform
  pool returns buffers only after submit completion and uses a generation guard
  against post-destroy callbacks.

Sources: `renderer/canvas/pipeline/brush/{BrushTextureManager,BrushTextureArrayBuilder}.ts`,
`renderer/canvas/pipeline/stroke/{StrokeBatchContext,WetInkPass}.ts`.

### Fill and gradient resources

- `ElementRenderer` reuses a shared fill vertex buffer sized from the previous
  frame peak; first-frame and overflow paths use a per-draw buffer pool. This is
  frame-local resource reuse, not a document-content cache.
- `GradientCache` covers only linear/radial gradient fills and strokes. Free,
  mesh, and pattern gradients use separate paths.
- `GradientTextureGenerator` caches free-gradient raster textures by complete
  definition plus output size. It evicts entries unused for 10 frames or beyond
  32 entries, and reuses grow-only compute buffers.
- `MeshGradientTextureGenerator` actively caches prepared vertex/face/edge-curve
  GPU data by hash with the same 10-frame/32-entry policy. Its `textureCache`
  field currently has no `set()` call, so it is not an active texture cache.

Sources: `renderer/canvas/elements/{ElementRenderer,GradientRenderer}.ts`,
`renderer/generators/{GradientTextureGenerator,MeshGradientTextureGenerator}.ts`.

### Embedded images

`ImageElementRenderer` caches one `GPUTexture` per embedded-file UID for a
`CanvasLayer` and deduplicates decode/upload work with `pendingImageLoads`.
It has no content hash or LRU; `CanvasLayer` teardown destroys all image textures.

Source: `renderer/canvas/elements/ImageElementRenderer.ts`.

## Text and font caches

| Component | Key and retained value | Invalidation / lifetime |
| --- | --- | --- |
| `TextRenderer.layoutCache` | Content/style/layout/path-binding key (intentionally excludes x/y) → layout result | Per-element prefix invalidation or full clear; `RenderOrchestrator` owns it. |
| `TextElementRenderer.pathCache` | The text cache key → glyph `Path[]` plus local bounds | A pending-key set deduplicates async extraction. Invalidated fresh paths move to `stalePathCache` so a prior path can render until replacement is ready. |
| `FontManager.glyphPathCache` | `postScriptName:cp<codePoint>`, `.notdef`, or vertical-glyph key → em-normalized outline | Process singleton; no explicit LRU/clear. Size is deliberately absent from the key. |
| Google/local loaders | Loaded font and in-flight promise keyed by `family:weight` or `postScriptName:weight` | Pending promises delete after settlement. Google list/files clear on API-key change; replacing the local backend replaces its loader and caches. |

`TextLayoutEngine` itself has no cross-call cache. Text bounds also feed the
shared `localBoundsCache`, which updates the spatial index only if precise bounds
change.

Sources: `typography/TextRenderer.ts`, `renderer/canvas/elements/TextElementRenderer.ts`,
`typography/fonts/{FontManager,FontLoader,GoogleFontsLoader,LocalFontsLoader}.ts`.

## Filter and appearance caches

- A normal `FilterHandler` keeps its initialized pipeline/layout/structured
  views for the handler lifetime. `FilterRenderer.destroy()` delegates handler
  cleanup.
- `DropShadowFilterProcessor` reuses `originalCopyTexture` while dimensions
  match and defers an old texture's destruction through `FilterRenderer`.
- `PathUnionFilterHandler` is a 32-entry CPU LRU keyed by
  `hashSegments:segmentCount:mode`; it returns copies and does not memoize
  no-op or failed operations.
- `FrostGlassFilterProcessor` retains H/V uniform buffers for its handler
  lifetime. By contrast, `BlurFilterProcessor` creates pass-local uniforms and
  sampler resources; that is intentionally not a cache.

### Extrude3D

Extrude uses `AppearanceCache` in two layers:

1. The mesh entry hashes outline segments, depth, bevel, tolerance bucket, and
   UV inset. It deliberately excludes rotation, lighting, and element transform
   so those changes reuse vertex/index buffers.
2. The baked-output entry hashes material, rotation, perspective, zoom, pattern
   revision, and source readiness. Opaque postprocess copies a cache-owned result
   to a frame-owned pool texture so downstream release cannot destroy the cached
   original. Glass refraction remains a live, frame-local backdrop composite.

The glass driver is per canvas. Its frame entries, textures, and backdrop
requests release at frame end; `RefractionCompositor` uses a frame-slot uniform
pool and destroys it with the driver.

Sources: `renderer/canvas/pipeline/FilterRenderer.ts`,
`renderer/filters/{DropShadowFilterProcessor,PathUnionFilterProcessor,FrostGlassFilterProcessor,Extrude3DFilterHandler,ExtrudeRenderCache}.ts`,
`renderer/filters/Extrude3D/{ExtrudeMeshBaker,ExtrudeAppearanceRenderer,RefractionCompositor}.ts`.

## Scene3D caches

| Component | Strategy | Lifetime / invalidation |
| --- | --- | --- |
| `Scene3DElementRenderer` | Element ID → GPU texture plus a hash of scene nodes, camera, display/lineart/light, raster dimensions/scale, WebGL context epoch, and async-asset epoch | Shares pending render promises per element. Draws stale texture during a miss; replacement destroys the old texture. Renderer/device teardown destroys all textures. |
| `loadScene3DService()` | Module-level service promise and instance | One lazy singleton; no current reset API. |
| `SceneInstanceStore` | Scene ID → runtime scene; node ID → JSON fingerprint/object | Unchanged node JSON skips rebuild. Changed/removed nodes dispose; scene/service disposal clears entries. |
| `GLBMeshCache` | File UID → parsed group plus pending/failed state | Loaded clones share geometry/material. A failed UID does not retry until service disposal. |
| `VRMFigureManager` | Node ID → parsed/in-flight VRM; file UID → normalized rig; scene ID → live-node set | File change/removal/orphan completion disposes the VRM scene; rigs remain until `disposeAll()`. |
| `LineartPipeline` | Normal/depth, Sobel, and shadow render targets | Exact size hit; size miss disposes targets. Service destruction releases targets/materials/geometry. |
| Perspective guides | One source-derived guide set in `Paplico` | Recompute when source/camera/transform/preview changes; clear when source disappears. |

Scene asset arrival increments `assetsEpoch`; WebGL context loss/restoration
increments `contextEpoch`. Both are part of the 2D scene-texture validity key.
`scene3dDefPreviews` is not a cache: it is the authoritative transient preview
while dragging, outside Yjs.

Sources: `renderer/canvas/elements/Scene3DElementRenderer.ts`, `scene3d/index.ts`,
`scene3d/Scene3DService.ts`, `scene3d/runtime/{SceneInstanceStore,GLBMeshCache}.ts`,
`scene3d/vrm/VRMFigureManager.ts`, `scene3d/lineart/LineartPipeline.ts`, `Paplico.ts`.

## Core indexes, loaders, and tool caches

| Component | Retained value / key | Invalidation and lifetime |
| --- | --- | --- |
| `SpatialIndex` | Bounds by element ID, Quadtree by layer ID, child→parent reverse index, objects `Map` keyed by source-record identity | Delta updates alter only affected bounds/tree/parents; document-reference change rebuilds indexes while retaining known text bounds. Owned by `Paplico`. |
| `DefIndex` | Member→def reverse index; def revision/fingerprint | Full sync rebuilds; object delta increments owning-def revision. The revision belongs in dependent render-cache keys. |
| `ToolContext.cachedViewportImageData` | One `ImageData` keyed by viewport x/y/zoom/rotation and canvas dimensions | Document/selection render requests clear it; viewport/size mismatch replaces it. Used by Bucket Fill. |
| Bucket Fill session | Flood mask, path, and bounds by fill-area ID | Click/cut/gap-closing recomputes an area; confirm/cancel/removal clears session data. |
| `PathEditTool.cachedControlPoints` | Path ID → screen/world handles | Viewport x/y/zoom change clears all; segment change clears one path; selection refresh clears all. |
| `ArtboardTool` handle cache | Four bounds values → eight resize handles | A one-entry replacement cache for tool lifetime. |
| Pressure curve memo | Control-point array identity → 256-bin LUT in a `WeakMap` | Garbage collection after key becomes unreachable; callers must provide a new array for changed points. |
| `ColorEngine` soft-proof LUT | Display space, intent, grid size, proof/display hashes → result promise | Rejected promise is removed; successful LUT has no capacity eviction. `Paplico` generation-gates stale async results after settings changes. |
| Timelapse player | Keyframe snapshot every 50 events plus final snapshot | Player lifetime; seek replays only the residual delta and final preview restores in O(1). |
| PAPF reader | Eager TOC maps (`byKey`, `fileByUid`) and sorted timelapse block list | `PapfFile` handle lifetime; embedded payload contents are loaded on demand rather than memoized. |

Sources: `document/{SpatialIndex,DefIndex}.ts`, `tools/{ToolContext,BucketFillTool,PathEditTool,ArtboardTool}.ts`,
`utils/pressureCurve.ts`, `color/ColorEngine.ts`, `timelapse/TimelapsePlayer.ts`, `io/papf/reader.ts`.

## Dirty batching and intentionally non-cache state

These mechanisms affect cache freshness but should not be mistaken for
cross-frame content caches:

- `RenderScheduler` coalesces dirty reasons in a per-frame set and retains a
  100 ms interaction settle window to choose `fullInteraction` versus heavier
  render strategies.
- `DocumentChangeSubscriber` incrementally updates `SpatialIndex` and clears
  changed bounds from Yjs deltas.
- `YjsProvider` batches added/updated/deleted IDs and full/layer-sync flags for
  one transaction/update, then selects delta versus full extraction. Its
  `objectsSnapshot` and `layerElementIdsSnapshot` fields are currently
  declared/reset only and are not active caches.
- `CanvasTarget` lazily memoizes its configured `GPUCanvasContext` until HDR
  reconfiguration or disposal.
- `GPUTimingProfiler` reuses two readback buffers and accumulates per-label
  timings until the reporting interval clears them.
- `computeWorldJoints()` and mesh-gradient edge maps are function-local memos;
  they exist only for one computation.
- `PaplicoUI.preToolingSnapshot` and pattern-edit working IDs are operation
  recovery state, not performance caches.

Sources: `renderer/{RenderScheduler,DocumentChangeSubscriber,CanvasTarget,GPUTimingProfiler}.ts`,
`collaboration/YjsProvider.ts`, `scene3d/vrm/ikSolver.ts`,
`utils/geometry/meshGradient.ts`, `ui/PaplicoUI.ts`, `PaplicoPatternEdit.ts`.

## Rules for adding or changing a cache

1. **Choose the lifetime first.** Document-derived results belong in a
   fingerprinted cache; same-frame scratch resources belong in a pool; one
   pending operation belongs in an in-flight map.
2. **Make the validity key complete.** Include every input that changes retained
   contents. Do not include transforms or lighting in a mesh key only when the
   cached resource is intentionally invariant to them, as Extrude mesh entries
   are.
3. **Attach invalidation to the real source of change.** Object deletion must
   prune ID-keyed entries; viewport descriptor changes must replace compatible
   resources; async context/asset epochs must participate in texture keys.
4. **Define GPU ownership and safe release.** State who calls `destroy()` and
   use deferred release when an encoder may still reference the resource.
5. **Do not invent a layer-content `DocumentCache` dependency.** The current
   renderer renders document content directly each frame.
6. **Document the policy here.** Record the retained value, key, hit path,
   invalidation/eviction, and owning destroy path before adding a new cache.
