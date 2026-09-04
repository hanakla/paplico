# Brush engine

Verified against `pkgs/web/src/core/` on 2026-08-05. Re-check symbol names and
line numbers before relying on them — they drift.

## What the engine is

A brush is a settings object; **the settings decide which of four pipelines
draws the stroke, and where in the frame that pipeline runs.** Nothing about a
stroke's appearance is decided by the tool that made it.

```
BrushSettings
  ├── engine: "dab" | "ribbon" | "geometric"
  ├── properties: Partial<Record<BrushPropertyId, BrushPropertyConfig>>
  │                        base value + curves, evaluated per dab
  ├── tip / stroking / grain / wetEdge / mixing / wet / inputDynamics
  ├── paintMode: "buildup" | "wash"
  └── strokeOpacity, randomSeed, taperStart/End
```

Files:

| Concern | Path (under `core/`) |
| --- | --- |
| v1 -> v2 migration | `io/migrations/brushV2/` |
| Property registry, domains | `brush/properties.ts` |
| Curve baking / evaluation | `brush/curves.ts`, `brush/evaluateProperties.ts` |
| Dab generation | `renderer/canvas/pipeline/brush/DabEvaluator.ts` |
| Dab instance ABI | `renderer/canvas/pipeline/brush/DabInstanceLayout.ts` |
| Tip falloff LUT | `renderer/canvas/pipeline/brush/TipMaskBuilder.ts` |
| Ribbon geometry | `renderer/canvas/pipeline/brush/RibbonGenerator.ts` |
| Colour mixing | `renderer/canvas/pipeline/brush/MixPass.ts`, `MixStrokeRenderer.ts` |
| Wet layer | `renderer/canvas/pipeline/stroke/WetLayerPass.ts` |
| Draw plumbing | `renderer/canvas/pipeline/stroke/StrokeBatchContext.ts` |
| Shaders | `renderer/shaders/brushDab.wgsl.ts`, `dabColor.wgsl.ts`, `brushMix.wgsl.ts`, `wetLayer*.wgsl.ts`, `ribbonStroke.wgsl.ts` |

## Routing

`BrushSettings.engine` is the single routing decision, read once per stroke by
the caller (CanvasLayer / PathElementRenderer).

```ts
type BrushEngineKind = "dab" | "ribbon" | "geometric"
```

**Read it from the stored value, never from the flat brush-panel view.** That
view drops paint mode, curves and the wet/mixing config, so a route taken from
it silently selects the wrong pipeline — the failure is a plausible-looking
stroke, not an error.

## Where in the frame a stroke is drawn

Four different seams, selected by the settings:

| Settings | Seam | Why |
| --- | --- | --- |
| plain dab / ribbon | inline in the main pass | nothing to isolate |
| `paintMode: "wash"` | per-appearance isolation texture | `strokeOpacity` must apply once, not per dab |
| `wet.enabled` | per-appearance isolation texture | migration forces wash (see below) |
| `mixing.enabled` | `BackdropEffectDriver` inline composite | needs the composite *below* the stroke |

Two consequences that are not visible from the settings:

- **A wet brush is always a wash brush.** The brush v2 migration forces
  `paintMode: "wash"` whenever `wet.enabled` is true, so a wet stroke always
  arrives through the isolation route and never through the inline stroke
  branch. Code that hooks wet rendering into the inline branch never runs.
- **The isolation route cannot read the backdrop.** Per-appearance isolation is
  executed in the "Element Filters" pass, before the main pass has drawn
  anything, so the target still holds nothing. A stroke that reads what is
  beneath it must instead use the inline-composite seam, where the main pass
  ends at the stroke's z-order, the driver draws, and the pass restarts
  (`CanvasLayer.renderElements`, the `hasInlineComposite` branch).

Rule of thumb: **a stroke that reads what is beneath it belongs on the
inline-composite seam; a stroke that only needs isolation from itself belongs on
the appearance route.**

## Properties and the curve matrix

`BRUSH_PROPERTY_REGISTRY` (`brush/properties.ts`) defines every modulatable
property: its `domain`, clamp range, default base, and UI group.

```
scale  domain: value = base * clamp(1 + Σ curves, 0, MAX_SCALE_FACTOR)
offset domain: value = base + Σ curves
                       then clamped to [min, max]
```

A property config is `{ base, curves?: BrushCurve[] }`; a curve is
`{ input: BrushInputId, points: [x, y][] }`, baked into a 256-bin LUT once per
stroke (`bakeBrushProperties`) and sampled per dab (`evalBrushProperty`).

Inputs (`BrushInputId`): `pressure`, `speedFine`, `speedGross`, `accel`,
`tiltMagnitude`, `tiltAzimuth`, `twist`, `direction`, `strokeT`, `fade`,
`distance`, `randomPerDab`, `randomPerStroke`.

**Speed inputs are world-based.** Normalization divides world speed by a
reference speed (`inputDynamics.speedRef`, or `clamp(size * 0.06, 0.5, 2.0)`
when unset), never by viewport zoom, so the same stroke produces the same dab
list at any zoom and on any collaborating client.

**Settings that feed input computation are not properties.** `speedRef`, the
speed EMA time constants and the direction filter live in `InputDynamicsConfig`
and carry no curves — a speed curve wired into `speedRef` would recurse.

`brush/evaluateProperties.ts` owns baking and evaluation; both the dab evaluator
and the ribbon generator resolve through it, so a property's domain and clamping
behave identically whichever engine draws the stroke.

## Dab generation

`evaluateDabs(segments, settings, options): DabBuffer` walks the stroke's
segments and emits dab instances.

- **Spacing** takes the earlier of a distance threshold (`size * spacing`) and a
  timed interval (`1000 / dabsPerSecond`), Krita-style. Both accumulators reset
  per emitted dab.
- **A held stylus still sprays.** A zero-length segment accrues no distance but
  does accrue time, so it emits at the timed interval at its anchor and decays
  both speed EMAs toward zero. Without this an airbrush held in place lays down
  nothing at all, because the sample walk is driven by arc length.
- **Chunked evaluation is bit-identical to a whole-stroke one** as long as every
  chunk receives the same `totalLength`. `DabEvalState` carries the walk state
  (velocity EMAs, accumulators, RNG state, previous anchor) between chunks; the
  live stroke path re-fits only the tail and resumes.
- **Alpha depends on paint mode.** Buildup applies MyPaint's `opaque_linearize`
  so overlapping dabs at a given spacing sum to the intended opacity; wash writes
  `flow` directly, because `strokeOpacity` is applied once at composite time.
- Output is `{ data, count, mixParams, state, totalLength }`. `mixParams` is a
  separate per-dab `vec4` array (colorRate / alphaRate / smudgeLength) allocated
  only when `mixing.enabled` — the instance ABI has no room for it.

## Per-dab and per-path GPU layouts

### Dab instance — `DabInstanceLayout.ts`

**Frozen at 24 floats (96 bytes).** CPU writers, the WGSL struct
(`generateDabInstanceWgsl`) and the layout tests all derive from this module.

New per-dab data reuses a slot or bit-packs into one, because widening the
instance costs every brush the same bytes whether it uses the field or not:

- `packedColorShift0/1` — `pack2x16snorm` of the hue/saturation/value offsets.
  **Pack signed values as snorm, not as offset unorm**: an unwritten dab then
  decodes to zero shift instead of a maximum-magnitude one.
- `packedWetCoefficients` — five wet field coefficients at 6 bits each. 1.6% of
  a coefficient's range, below what a diffusion coefficient can show.
- `packedMeta` — path index in the low bits, texture-array layer above.

### Path meta — `shaders/dabColor.wgsl.ts`

`PATH_META_WGSL` (the struct) and `PATH_META_FLOATS` (its stride) are the single
definition. Every shader that indexes the path meta buffer includes the former —
the dab shader, the mix pass and the ribbon shader all read the same buffer.

**A second copy of the struct, or a second hand-written CPU writer,
desynchronizes the stride the moment either side gains a field.** Index 0 still
lines up, so the symptom only appears with two or more paths in a batch: later
paths pick up a neighbour's colour, gradient and transform index.

Both CPU writers go through `writeSinglePathMeta`; the batch writer owns only
the shared colour-stop arena and delegates the fields.

## Colour resolution

`resolveDabColor(dab, pathMeta, worldPos, pathT, acrossDistance)` in
`dabColor.wgsl.ts` is the single definition of a dab's colour, included by the
fragment stage and by the mix pass so the two cannot disagree.

Gradient modes and what each can express:

| Mode | Input | Per-dab? |
| --- | --- | --- |
| solid | path meta colour | yes |
| within (bbox linear) | transformed dab centre | yes — the vertex stage builds `worldPos` from the dab centre only |
| along path | `dab.pathT` | yes |
| across width | signed distance across the stroke | **no** — varies within one dab |

Colour dynamics (hue / saturation / value) apply on top of the resolved colour,
so they compose with gradients and with mixing rather than replacing either.

The across-width mode is why mixing resolves at `acrossDistance = 0` (the
width's centre): mixing owns one colour per dab and cannot carry a gradient
inside a single dab.

## Paper grain

The dab fragment samples a paper texture at a **canvas-fixed UV**
(`worldPos / grainScale + perStrokeOffset`), so the grain stays put under the
stroke instead of travelling with each dab. Modes: `multiply`
(`α *= mix(1, g, strength)`) and `subtract` (`α = max(0, α - (1-g) * strength)`),
scaled by the dab's own `grainStrength`.

The grain texture and sampler are **bound unconditionally** — a 1×1 white
texture when the brush has none — because implicit derivatives require uniform
control flow, so the sample cannot sit inside the mode branch.

Built-in papers are generated, not shipped as assets
(`generatePaperGrainPixels` in `brush/presets.ts`): tiling value noise at two
frequencies, seeded into the document's embedded files and GC-protected
alongside the brush textures. The lattice wraps, which the repeating sampler
requires.

## Wash paint mode

A wash stroke renders its appearance into an isolation texture at opacity 1;
`plan.opacity * strokeOpacity` is applied once when that texture composites onto
the per-appearance accumulator. A self-crossing stroke therefore cannot exceed
`strokeOpacity` — with a hard tip and `flow: 1` the crossing and the arms read
identically, while a partly transparent tip (a ribbon texture, a soft dab) still
darkens where it overlaps but stays under the cap.

`RenderPlanner.classifyElementFilters` gates the route: `hasWashStroke` sits
beside `hasNonNormalAppearanceBlend`, and `AppearancePlan` carries
`washStrokeOpacity`, `washBrushSize` and `washWetEdge`.

**Wet edge** (`WashCompositor`) is a separable min-filter erosion producing a
rim mask, optionally blurred through a downsampling pyramid, then composited:
the rim darkens the straight colour and raises alpha. Wet edge and the wet layer
are exclusive — a wet stroke's rim comes from `edgeDarkening` instead.

Results are cached across frames per element, keyed on the stroke's geometry,
settings, transform, raster scale and texture bounds. Accumulators clamp to
4096 px per side so a large stroke's result always fits the cache; the isolated
render scales down to match.

**A live preview is bounded by the viewport instead.** A transient wash preview
re-runs its isolation every frame and is uncacheable by design, so
`resolveTransientWashDomain` clips its bounds to the viewport (padded by the wet
edge's reach) and caps its resolution at the on-screen pixel density. Committed
strokes still render once at full document scale.

## Colour mixing

Mixing reads the composite below the stroke, so it runs on the
`BackdropEffectDriver` seam (`MixStrokeRenderer`). Per stroke:

1. Capture the backdrop on the fixed-R grid (`acquireFixedRRegion`).
2. Evaluate the dabs and their `mixParams`.
3. For each chunk of 64 dabs, in order:
   - `cs_sample` — one workgroup per dab; 64 threads average the backdrop plus
     the stroke buffer painted so far across an 8×8 footprint weighted by the
     tip falloff LUT.
   - `cs_scan` — one thread walks the chunk in dab order:
     ```
     bucket = mix(sample, bucket, smudgeLength)
     rgb    = styleMix(bucket.rgb, brushColor.rgb, colorRate²)   // Krita's squared rate
     alpha  = mix(bucket.a, brushColor.a, alphaRate)
     ```
   - a ranged dab draw with the resolved colours (`drawMixedDabChunk`).
4. Blit the stroke buffer back through the restarted main pass.

`blendStyle` interpolates vivid (OkLCH, chroma-preserving) against muted (OkLAB,
straight-line); `sampleTrail` offsets the footprint along the stroke direction.

The bucket buffer persists across chunks, which makes the result a pure function
of (backdrop, dab list). Chunking is a fixed 64 — an adaptive split would make
the result depend on how the work happened to be divided.

**Caching and invalidation.** A resolved stroke is kept across frames; its key
covers the stroke's own content, the rasterization grid, the visible world rect
(the backdrop capture is canvas-clamped, so a stroke running off screen resolves
differently once panned into view) and the identity of everything drawn below it
that overlaps it. Object identity is content identity, so a per-object serial
suffices — **except that it is not transitive**: a stroke that mixed from
another mixing stroke embeds that stroke's *result key*, or editing something
only the lower stroke reads leaves the upper one serving a stale texture.

Gradient and pattern stroke colours resolve per dab through `resolveDabColor`,
so they mix like solid ones.

## Wet layer

A watercolour field simulation (`WetLayerPass`), run per stroke:

1. **Seed** — the dabs rasterize into six colour attachments (`WET_SEED_TARGETS`
   in `brushDab.wgsl.ts`, fragment entry `fs_wet`).
2. **Diffuse** — 32 iterations of `wetLayerDiffuse.wgsl` with `dt = 1/32`, so the
   total effect is independent of the iteration count. Only pigment and moisture
   ping-pong; the seed targets stay bound read-only.
3. **Composite** — `wetLayerFinish.wgsl` decodes the log-space pigment density
   into premultiplied colour and shapes it with the paper and the drying rim.

### Seed target layout

| loc | Format | Contents | Blend |
| --- | --- | --- | --- |
| 0 | rgba16float | pigment: `rgb = colour * density`, `a = density` | additive |
| 1 | rgba16float | `rg = direction * coverage * directionality`, `b = coverage` | additive |
| 2 | rgba16float | `r = speed * cov`, `g = accel * cov`, `b = water`, `a = pooling` | additive |
| 3 | rg8unorm | absorption, granulation | src-alpha |
| 4 | rg8unorm | bleedSoftness, edgeDarkening | src-alpha |
| 5 | r8unorm | edgeRoughness | src-alpha |

Total 29 bytes per sample, against the guaranteed 32.

Why it is shaped this way:

- **The coefficients need their own targets** because there is one blend state
  per target. Coverage must accumulate additively; a coefficient must be taken
  from whichever dab covers the texel (`dst = mix(dst, value, coverage)`, driven
  by coverage in the fragment's alpha). Sharing a target forces one of the two
  to be wrong, and summing coefficients into an 8-bit target clips outright.
- **Narrow formats are what make it fit.** `rgba8unorm` costs 8 bytes per sample,
  not 4 — three float fields plus one `rgba8unorm` already reaches the ceiling.
  All five coefficients together cost 5 bytes as `rg8unorm` ×2 + `r8unorm`.
- **The coefficient targets clear to the stroke's base values**, so texels no dab
  covers still carry sane coefficients; the field targets clear to zero.
- Two things are deliberately not stored: the edge factor (a pure function of
  coverage, recomputed where used) and a second copy of coverage (it lives in
  the velocity field).

### Diffusion

The kernel reads **every coefficient per texel** — absorption, granulation and
bleed softness from the coefficient targets, wetness and directionality
recovered from the seeds by dividing out the coverage they were multiplied by.
That is what lets one stroke dry faster where it slowed, granulate only where it
pooled, and bleed softly at one end while staying sharp at the other.

Physics: explicit-Euler water diffusion (coefficient capped below the 0.25
stability limit), semi-Lagrangian pigment advection with a drift correction
(~3% per advected pixel), exponential drying. Invariants worth preserving —
nothing is created from nothing, a uniform field stays put, no water means no
bleed, the result is independent of the iteration count.

### Domain

`resolveSimulationDomain(bounds, brushSize, maxTextureSide)` gives world-per-texel
from the brush size (96 texels per brush diameter, clamped to [0.125, 1]), never
from the viewport, and tiles with overlap when it outgrows one texture. That is
what makes bleeding a pure function of the stroke.

It also means the domain is several times finer than the target for a small
brush, so **the composite box-filters** over the field. One tap per target pixel
skips whole rows: the stroke draws with stripes, or with a hole through its
middle.

Picking up the colour underneath is *not* part of the wet layer — that is
mixing's responsibility, and mixing-resolved colours enter as the pigment seed.

## Ribbon strokes

`RibbonGenerator` emits one instance per segment (28 floats: cubic control
points, half-widths and signed stroke widths at both ends, arc-length offset,
UV mode, flips, tile spacing, opacity). Art brushes stretch one tile over the
path; pattern brushes repeat with optional gaps.

- Width and opacity evaluate the `size` and `flow` curves **at each segment's
  endpoints** and interpolate between them — the granularity taper already uses.
  A stroke whose settings carry no curves keeps the flat pressure factor.
- Tiling (stretch, UV offset, texture aspect, stamp angle) lives in the **path
  meta**, per path. A batch-wide uniform would let whichever ribbon was added
  last dictate the tiling of every ribbon in the batch.
- Ribbons take the wash route like dabs; nothing about the isolation is
  dab-specific.

## Caches

| Cache | Key | Owner |
| --- | --- | --- |
| Dab buffers | path id + settings fingerprint + geometry hash | `StampCache` |
| GPU dab residency | cache entry lease | `BoundedStampStore` ("Resident Dab Instances") |
| Wash results | geometry + settings + transform + raster scale + texture bounds | `CanvasLayer.washResultCache` |
| Mixing results | the above + visible rect + backdrop content key | `MixStrokeRenderer` |
| Tip falloff LUT | hardness quantized to 32 layers | `TipMaskBuilder` |

Committed strokes re-upload but never re-evaluate; pans and zooms hit the caches.
A live preview deliberately bypasses them (its geometry hash changes on every
pointermove) and uses a frame-pooled buffer instead.

## Testing

What can and cannot be asserted:

- **Numeric and mechanism tests only.** Dab spacing, curve evaluation, mixing
  arithmetic against a TS reference recurrence, routing decisions, cache
  invalidation, determinism. Visual quality is judged by eye, not by comparison
  against a previous rendering.
- **The unit environment cannot decode embedded images** (`createImageBitmap` is
  absent), so anything needing a real brush or paper texture cannot be asserted
  there. Test the generator that produces the pixels.
- **`copyTextureToBuffer` needs `bytesPerRow` to be a multiple of 256.** A 64×64
  rgba8 readback works; 32×32 is dropped as a validation error and the test then
  reads zeros and reports that the renderer drew nothing. Wrap a suspect submit
  in `pushErrorScope("validation")` before believing a blank result.
- **Prove a test can fail.** Revert the change, watch it fail, restore. Two
  shapes that invite a false pass here: a "spreads further" assertion where the
  alpha curve saturates either way, and an overlap-based invalidation test whose
  fixture overlaps through a second path. `calculateElementBounds` includes
  stroke width, so bounds are wider than the geometry suggests.
