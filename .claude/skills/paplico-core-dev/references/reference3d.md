# Reference3D (atari / reference scenes)

Names verified against `pkgs/core/src/` on dev, 2026-11-06.

**Reference3D is unrelated to the extrude3d appearance.** extrude3d is a 2D element's
own appearance (self-built WebGPU, no three.js). Reference3D is a distinct **element
type + document-level shared scenes** for building rough 3D layouts ("atari") a
comic artist traces over — primitives, poseable VRM figures, and camera-derived
perspective guides. It is a reference aid, deliberately **not** a full 3D editor.
It is the engine's only three.js user.

## Data model (`schema.ts`)

- `Reference3DElement extends ArtObject` (`type: "reference3d"`): a 2D placement rectangle
  (`x/y/width/height`) that shows a rendered view of a shared scene. Carries
  `sceneId`, its **own** `camera` (`Reference3DCamera`), `displayMode: "lineart" |
  "flat"`, optional `lineart` (`Lineart3DParams`), `lightDir`, export inclusion.
  From the 2D pipeline it behaves like an `ImageObject`.
- `Document.references3d?: Record<string, Reference3DDef>` — shared scene definitions.
  One scene, many `Reference3DElement`s → the same scene appears in multiple panels
  from different camera angles. `Reference3DDef = { id, name?, nodes: Reference3DNode[] }`.
- `Reference3DNode` union: `primitive` (shape + `Transform3D` + params), `figure`
  (VRM `fileUid` + `Transform3D` + `VRMPoseData`), `mesh` (static glTF `fileUid` +
  `Transform3D`). VRM/glTF binaries live in `Document.files[]` (EmbeddedFile).
- Guard: `isReference3D`. Units are meters (VRM/glTF convention).

## three.js boundary (`core/reference3d/`)

- three.js is a **lazy-loaded chunk** reached only through `loadReference3DService()`
  (`reference3d/index.ts`); `reference3d/types.ts` keeps three's types out of the
  `Reference3DServiceApi` signatures. `core/` must not statically import `three` —
  there is a guard test on the module graph.
- `Reference3DService.ts` renders scenes off the main pipeline (its own three.js
  renderer / offscreen canvas). `runtime/SceneInstanceStore.ts` diffs node JSON to
  apply changes; `runtime/primitives.ts` builds primitive meshes;
  `runtime/GLBMeshCache.ts` caches static-mesh geometry.
- `lineart/LineartPipeline.ts` — depth/normal edge-detection post-process
  (`Lineart3DParams`: `lineWidthPx`, `depthEdgeThreshold`, `normalEdgeThreshold`,
  `creaseAngleDeg`, `color`). The atari deliverable; shading/material are not the
  point.
- `vrm/` — `VRMFigureManager.ts` (load/pose figures), `ikSolver.ts` (CCD IK on
  normalized bones), `pose.ts`, `presetPoses.ts`.
- `perspective/vanishingPoints.ts` + `projection.ts` — pure, three-free; derive
  vanishing points from a scene camera so a pen tool can snap strokes to
  perspective (the "3D → 2D tool" leak is limited to world-space 2D guide data).

## Rendering & tools

- `renderer/canvas/elements/Reference3DElementRenderer.ts` blits the scene texture,
  the same shape as `ImageElementRenderer` (sync texture cache + async render +
  blit). Export pre-warms scene textures like text/image.
- `tools/Reference3DTool.ts` + `tools/Reference3DController.ts` — enter-to-edit session
  (TextToolController pattern; owned by Paplico so it survives tool re-creation).
  Mode ladder object → pose; Escape climbs back down. Camera orbit/pan/dolly,
  object gizmos, and pose bone handles are UILayer overlays hit-tested via
  `uiHitTest` (hitId), not hand-written distance math.
