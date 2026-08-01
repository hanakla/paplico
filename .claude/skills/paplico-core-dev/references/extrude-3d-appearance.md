# Extrude3D appearance

The 3D-extrusion appearance of a 2D element (Path / Group / Text / Blend): a
`postProcess` filter that renders the element's outline as a lit, extruded solid
in place of its flat fill/stroke, via a self-built WebGPU mesh pipeline.

## Handler & core

`Extrude3DFilterHandler` is the `postProcess` filter; the rendering core is
`renderer/filters/ExtrudeMeshBaker.ts` (`buildOutline` + `bakeAppearance`),
shared by the opaque and glass paths below.

The element's own flat fill/stroke render is suppressed by the
**processor-agnostic `isElementRenderReplaced(element, filterRenderer)`**
(`FilterRenderer.ts`) — `ElementRenderer.renderPath` and the CanvasLayer group
branch early-return when it's true (i.e. some enabled appearance renders the
element in place of its flat look). This is NOT gated on a specific processor
name; `hasEnabledExtrude3d` gates only the glass driver's own solids.

### Opaque path — `postProcess`

- `executeFilterPlans` builds a `FilterGeometryContext` (element, elementsMap,
  caches, `renderElementToTexture`, text/pattern resolvers) and passes it as
  `ctx.geometry`.
- `Extrude3DFilterHandler.postProcess` → `baker.buildOutline` +
  `baker.bakeAppearance` → returns a self-sized `PostProcessResult` (a
  `BlitLayer`: texture + bounds + `uvRect` + optional transformed `quad` +
  opacity); the main pass blits it at those bounds, not the element's flat
  bounds. A **blend** element returns `PostProcessResult[]` — one solid per
  blend instance (`bakeBlendInstances`), each with its own depth/rotation.
- `getRenderConfigure` returns `needsSourceTexture:false`, so the caller skips
  rasterizing the flat look before invoking (it would be discarded).

### Glass path — `GeometryBackdropDriver`

Glass extrudes (ior>1 / aberration / blur — `getRenderConfigure` reports
`needsBackdrop`) need the backdrop at the element's z-order, so they can't run
in the pre-pass filter path. The handler owns one driver per canvas:

- `ExtrudeAppearanceRenderer` implements the generic `GeometryBackdropDriver`
  interface (`beginFrame` / `prepareFrame` / `unionSolidBounds` /
  `hasInlineComposite` / `composeInline`), defined in `FilterRenderer.ts`.
- Registered via `FilterHandler.attachCanvas(canvasId, resources)` /
  `getGeometryBackdropDriver(canvasId)`. `CanvasLayer` holds
  `backdropDrivers: GeometryBackdropDriver[]`.
- `prepareFrame` bakes the glass solids (`bakeAppearance(glassOnly=true)` skips
  opaque ones — those go through `postProcess`) **before** the main pass, on the
  same encoder — a separate pass because a depth-tested mesh pass can't nest
  inside another render pass.
- During the main pass, when `hasInlineComposite(element)` is true the caller
  ends its render pass and calls `composeInline`, which captures the backdrop
  and warps it under the solid at the element's z-order (the driver opens its
  own pass). `unionSolidBounds` feeds viewport culling.

### Mesh, GPU pass, cache

- `buildOutline` exhaustively switches over **path / group / text / blend** (a
  `neverReached` default forces a decision when a new element type is added;
  compound-path/image/mesh/scene3d return null). A group extrudes the
  world-space union of every descendant's outline; its albedo is baked by
  re-rendering the children.
- Mesh: `renderer/geometry/extrudeMesh.ts` (pure CPU — flatten →
  polygon-clipping union → earcut caps → side walls/bevels; positions rebased
  to the outline center for fp32 depth precision; per-face surface `uv2` for
  material patterns).
- GPU pass: `MeshPassRenderer` (`pipeline/MeshPassRenderer.ts`) — generic
  `Material3D` lit mesh via `shaders/meshLit.wgsl.ts`, owned by the handler.
  Depth pre-pass (front-most only) + color pass, MSAA-resolved internally (the
  rest of the renderer antialiases analytically in-shader; a raster 3D
  silhouette has none, so without MSAA the background shows through seams/edges).
- Mesh cache: `AppearanceCache` keyed by outline geometry only — rotation,
  lighting, material, and element transform stay out of the hash, so
  rotating/moving/relighting reuses the mesh.
