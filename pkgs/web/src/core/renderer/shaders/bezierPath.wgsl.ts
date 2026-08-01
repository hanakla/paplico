/**
 * Unified bezier rendering shader for all UI shapes (stroke and fill).
 *
 * Inspired by Vello's unified fill/stroke approach where all shapes are rendered
 * through a single pipeline (GPU-friendly Stroke Expansion,
 * Levien & Uguray 2024, https://arxiv.org/abs/2405.00127).
 * See also: https://github.com/linebender/vello/blob/main/vello_shaders/shader/flatten.wgsl
 *
 * Strokes and fills are expanded to filled quads by offsetting along the curve
 * normal by ±halfWidth, producing a triangle-list quad strip.
 *
 * Vertex buffer 0 (stepMode: vertex):  [t, side] per vertex.
 *   - t:    parametric position along the curve (0..1)
 *   - side: lateral offset direction (-1 or +1)
 *
 * Vertex buffer 1 (stepMode: instance): per bezier segment data (14 floats).
 *   - halfWidth0/halfWidth1 enable variable-width strokes:
 *     - Constant width (outlines): halfWidth0 == halfWidth1
 *     - Tapered fills (diamonds):  halfWidth0 != halfWidth1
 *     - Thick fills (rectangles, circles): halfWidth = shape extent
 *
 * All UI shapes (outlines, filled rectangles, filled circles, diamonds) are
 * represented as cubic bezier segments and rendered through this single pipeline.
 */
export const BEZIER_PATH_SHADER = /* wgsl */ `
struct Uniforms {
  viewportX: f32,
  viewportY: f32,
  zoom: f32,
  canvasWidth: f32,
  canvasHeight: f32,
  rotSin: f32,
  rotCos: f32,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

struct VertexInput {
  @location(0) tAndSide: vec2<f32>,  // x = parametric t, y = side (-1 or +1)
}

struct InstanceInput {
  @location(1) p0:         vec2<f32>,
  @location(2) cp1:        vec2<f32>,
  @location(3) cp2:        vec2<f32>,
  @location(4) p1:         vec2<f32>,
  @location(5) color:      vec4<f32>,
  @location(6) halfWidth0: f32,       // half-width at t=0 (start)
  @location(7) halfWidth1: f32,       // half-width at t=1 (end)
}

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec4<f32>,
  @location(1) side: f32,
  @location(2) halfWidth: f32,
}

@vertex
fn vertexMain(vertex: VertexInput, instance: InstanceInput) -> VertexOutput {
  var output: VertexOutput;

  let t    = vertex.tAndSide.x;
  let side = vertex.tAndSide.y;

  let mt  = 1.0 - t;
  let mt2 = mt * mt;
  let mt3 = mt2 * mt;
  let t2  = t * t;
  let t3  = t2 * t;

  // Cubic bezier position: B(t) = (1-t)³P0 + 3(1-t)²tP1 + 3(1-t)t²P2 + t³P3
  let pos = mt3        * instance.p0
          + 3.0*mt2*t  * instance.cp1
          + 3.0*mt *t2 * instance.cp2
          + t3         * instance.p1;

  // Tangent direction (proportional to B'(t)/3 — magnitude irrelevant for normalize)
  let tang = mt2             * (instance.cp1 - instance.p0)
           + 2.0 * mt * t   * (instance.cp2 - instance.cp1)
           + t2              * (instance.p1  - instance.cp2);

  var tangFinal = tang;
  let tangLen = length(tang);
  if (tangLen < 0.00001) {
    // Degenerate bezier (e.g. p0==cp1 or cp2==p1): tangent is zero at endpoints.
    // Fall back to chord direction p0→p1.
    tangFinal = instance.p1 - instance.p0;
  }
  let finalLen = length(tangFinal);
  var normal = vec2<f32>(0.0, 0.0);
  if (finalLen > 0.00001) {
    normal = vec2<f32>(-tangFinal.y, tangFinal.x) / finalLen;
  }

  // Linearly interpolate half-width along the curve (enables tapered fills)
  let hw = mix(instance.halfWidth0, instance.halfWidth1, t);

  let worldPos = pos + normal * side * hw;

  let relX = (worldPos.x - uniforms.viewportX) * uniforms.zoom;
  let relY = (worldPos.y - uniforms.viewportY) * uniforms.zoom;
  let rotX = relX * uniforms.rotCos - relY * uniforms.rotSin;
  let rotY = relX * uniforms.rotSin + relY * uniforms.rotCos;
  let ndcX = rotX / (uniforms.canvasWidth / 2.0);
  let ndcY = rotY / (uniforms.canvasHeight / 2.0);

  output.position  = vec4<f32>(ndcX, ndcY, 0.0, 1.0);
  output.color     = instance.color;
  output.side      = side;
  output.halfWidth = hw;
  return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  let edge_dist = (1.0 - abs(input.side)) * input.halfWidth;
  let aa_width = max(fwidth(edge_dist), 1e-6);
  let alpha = smoothstep(0.0, aa_width, edge_dist);
  let a = input.color.a * alpha;
  return vec4f(input.color.rgb * a, a);
}
`;
