# Render-pipeline perf profiling (monkey-patch)

When a render path gets slow (the recurring one: **zoom becomes extremely
slow**), attribute the cost to a concrete stage with a console-pasted
monkey-patch that wraps the pipeline methods with `performance.now()` timers.

Default shape:

- **Auto start/stop over a fixed window** (e.g. 10s): on paste, immediately begin
  measuring and `setTimeout` the stop+print, so you just paste and interact — no
  manual reset/report juggling.
- **Print the result as a single JSON blob**, `JSON.stringify(result, null, 2)`
  in one `console.log` (not `console.table`), so the output is
  select-all-and-copy in one go.
- **Keep originals in a `{proto, name, orig}[]` list** and expose a `stop()` that
  restores them and clears the timer, and call the previous session's `stop()`
  before re-installing — so re-pasting never double-wraps.

CPU vs GPU: a monkey-patch measures **CPU wall-clock on the main thread** — how
long it takes to *record and submit* the frame, not how long the GPU takes to
*execute* it. For GPU-side timestamps use the existing `GPUTimingProfiler`
(`renderer/GPUTimingProfiler.ts`), which the render path already threads through
(`RenderOrchestrator.render` → `profiler.beginFrame()/resolve()/readback()`).
The two are complementary: a frame that is cheap on CPU but janky on screen is a
GPU-execution problem; a frame expensive on CPU is a recording/allocation
problem the monkey-patch will localize.

## Access points (dev build only)

`window.__paplico` is assigned in `app/page.tsx` (`window.__paplico = p`) under
`NODE_ENV === "development"`, and `core/dev-hmr.ts` relies on it. From it:

| Reach | Path from `window.__paplico` (`p`) | Notes |
|-------|-----------------------------------|-------|
| `RenderOrchestrator` | `p.renderer` | private `renderer` field; TS-private is reachable at runtime |
| target data map | `p.renderer.targets` | `Map<id, { canvasLayer, uiLayer, context, ... }>` |
| `CanvasLayer` instance | `[...p.renderer.targets.values()][0].canvasLayer` | |
| `UILayer` instance | `...[0].uiLayer` | |
| `RenderScheduler` | `[...p.canvasTargets.values()][0].scheduler` | `canvasTargets: Map<id, CanvasTargetEntry>` |

TS `private` is a compile-time fiction; all of the above are plain properties at
runtime, so no bracket-notation escape is needed.

## Stage tree and where the boundaries are

One frame is `RenderOrchestrator.render(request, uiState)`. Inside it
(`renderer/RenderOrchestrator.ts`):

```
frame          RenderOrchestrator.render        // whole CPU frame
  ├─ canvasLayer     CanvasLayer.render          // document layer
  │    ├─ renderDocument   CanvasLayer.renderDocument   // element passes recording
  │    └─ executeFrame     CanvasLayer.executeFrame      // FrameGraph execution
  ├─ uiLayer         UILayer.render              // overlay layer
  └─ (device.queue.submit + profiler.readback + overhead)  // = frame - canvasLayer - uiLayer
```

`request.strategy` (a `RenderStrategy`) is the first-arg field on both
`RenderOrchestrator.render` and `CanvasLayer.render`, so bucket frame cost by it
to see *which* strategy is slow — during pan/zoom the scheduler resolves to
`viewportBlit` (or `fullInteraction` when a preview rides along), and comparing
those buckets tells you whether interaction fast-paths are actually engaging.

`RenderScheduler.markDirty(reason)` is the frame-request entry point; counting
its `reason` argument shows what keeps requesting frames during the gesture
(expected: mostly `"viewport"`; anything else appearing at viewport frequency is
a redraw the zoom should not be triggering).

## Technique

1. **Patch the prototype, not the instance** — get it with
   `Object.getPrototypeOf(instance)`. One patch then covers every target/canvas.
2. **Wrap with a try/finally timer** so an exception mid-frame still records and
   still restores `curFrame`.
3. **Open a frame-scoped breakdown in the frame-root wrapper**
   (`RenderOrchestrator.render`): stash the previous `curFrame`, install a fresh
   record, let inner wrappers write their `dt` into it, then on exit push the
   record and restore the previous one. Because the whole pipeline is
   synchronous on one thread, a single module-level `curFrame` is race-free —
   the save/restore only matters if a frame can re-enter (export mid-frame).
4. **Label stages explicitly.** `render` is a method on **three** different
   prototypes (orchestrator, CanvasLayer, UILayer); keying stats by the method
   name alone silently merges all three into one bogus bucket. Pass an explicit
   label per wrap.
5. **Make it idempotent and reversible.** Keep a `{proto, name, orig}[]` list;
   `stop()` restores every original, and re-installing calls the previous
   session's `stop()` first (otherwise you wrap the wrapper and double-count).

## Gotchas

- **Instances may not exist yet.** No canvas target ⇒ no `canvasLayer`. Guard and
  bail with a message rather than patching `undefined`.
- **`RenderOrchestrator` is reconstructed** on device loss/HDR toggle
  (`this.renderer = new RenderOrchestrator()` runs in more than one place). The
  prototype patch survives that (same class), but a cached *instance* reference
  or a patched *instance method* would not — patch the prototype.
- **CPU timing hides GPU cost and vice versa.** A slow-looking frame that is
  cheap in every CPU bucket means the cost is in GPU execution or in
  `getCurrentTexture()`/`submit` back-pressure — switch to `GPUTimingProfiler`.
- **Don't leave it installed.** It adds a closure to every frame; `stop()` when
  done. It lives in the console, not in `core/`.
