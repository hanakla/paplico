export const FILL_TRIANGLE_SHADER = /* wgsl */ `
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

struct InstanceInput {
  @location(0) p0: vec2<f32>,
  @location(1) p1: vec2<f32>,
  @location(2) p2: vec2<f32>,
  @location(3) color: vec4<f32>,
  @location(4) boundaryMask: f32,
}

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec4<f32>,
  @location(1) barycentric: vec3<f32>,
  @location(2) @interpolate(flat) boundaryMask: u32,
}

@vertex
fn vertexMain(
  @builtin(vertex_index) vertexIndex: u32,
  instance: InstanceInput,
) -> VertexOutput {
  var output: VertexOutput;
  let positions = array(instance.p0, instance.p1, instance.p2);
  let barycentrics = array(
    vec3f(1.0, 0.0, 0.0),
    vec3f(0.0, 1.0, 0.0),
    vec3f(0.0, 0.0, 1.0),
  );
  let worldPos = positions[vertexIndex];
  let relX = (worldPos.x - uniforms.viewportX) * uniforms.zoom;
  let relY = (worldPos.y - uniforms.viewportY) * uniforms.zoom;
  let rotX = relX * uniforms.rotCos - relY * uniforms.rotSin;
  let rotY = relX * uniforms.rotSin + relY * uniforms.rotCos;

  output.position = vec4f(
    rotX / (uniforms.canvasWidth / 2.0),
    rotY / (uniforms.canvasHeight / 2.0),
    0.0,
    1.0,
  );
  output.color = instance.color;
  output.barycentric = barycentrics[vertexIndex];
  output.boundaryMask = u32(instance.boundaryMask);
  return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  let edgeWidth = max(fwidth(input.barycentric), vec3f(1e-6));
  var coverage = 1.0;
  if ((input.boundaryMask & 1u) != 0u) {
    coverage *= smoothstep(0.0, edgeWidth.x, input.barycentric.x);
  }
  if ((input.boundaryMask & 2u) != 0u) {
    coverage *= smoothstep(0.0, edgeWidth.y, input.barycentric.y);
  }
  if ((input.boundaryMask & 4u) != 0u) {
    coverage *= smoothstep(0.0, edgeWidth.z, input.barycentric.z);
  }
  let alpha = input.color.a * coverage;
  return vec4f(input.color.rgb * alpha, alpha);
}
`;
