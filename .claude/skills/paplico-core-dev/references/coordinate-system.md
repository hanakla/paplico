# Coordinate System Reference

## Why three coordinate systems exist

Each system serves a different stage of the pipeline:

- **Screen space** — What the browser gives us (pointer events). Origin top-left, Y-down. This is the raw input
- **World space** — What we store and sync. Origin center, Y-up. Zoom-independent, so elements don't change position when the user zooms. This is why we can collaborate — all users share the same world coordinates regardless of their viewport
- **NDC** — What WebGPU expects (-1 to 1). The vertex shader converts world → NDC using the viewport uniform buffer. Application code rarely touches NDC directly

## Screen → World conversion

The key insight: screen (400, 300) on an 800x600 canvas at viewport (0, 0, zoom=1) maps to world (0, 0) — the screen center is the viewport center.

Conversion accounts for:
1. Offset from canvas center (screen position - canvas center)
2. Zoom scaling (divide by zoom to get world distance)
3. Viewport offset (add viewport position)
4. Y-axis flip (screen Y-down → world Y-up)

Utility: `screenToWorld` / `worldToScreen` in `core/utils/coordinates.ts`.

## Viewport

`Viewport { x, y, zoom, rotation }`:
- `x, y` — World coordinates of what's at the screen center
- `zoom` — Scale factor (1.0 = 100%). World distances * zoom = screen distances
- `rotation` — Canvas rotation in radians

Managed by `CanvasTarget` (user interaction) and `ViewportManager` (GPU uniform buffer).

Multiple CanvasTargets can have independent viewports — this is how split view works. Each CanvasTarget holds its own Viewport.

## Hit testing and spatial queries

`SpatialIndex` operates in world coordinates. The flow:

1. Screen click → `screenToWorld` → world point
2. Query `SpatialIndex.findElementAtPoint(worldX, worldY)` — checks Quadtree
3. Candidates checked for precise bounds (AABB first, then path intersection for paths)
4. Topmost hit element returned (respects layer/group ordering)

For rotated elements, the test point is inverse-rotated around the element's transform origin before bounds checking. This is cheaper than rotating the bounds.

## Common pitfalls when working with coordinates

- **Forgetting Y-flip** — Screen Y increases downward, world Y increases upward. Every manual conversion must flip Y. Use the utility functions
- **Forgetting viewport offset** — A world point at (100, 200) is NOT at screen (100, 200). It depends on the current viewport pan
- **Mixing zoom scales** — A 10px distance on screen is 10/zoom units in world space. When computing world-space distances from screen input, always divide by zoom
- **Element rotation** — Rotated elements have world-space bounds that are axis-aligned in the element's local space, not in world space. The AABB in world space is the rotated bounding box
- **Sub-pixel precision** — World coordinates are floating-point. Never round during computation. Only round when converting to final screen pixels for rendering
