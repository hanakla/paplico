export const HK_GLITCH_SHADER = /* wgsl */ `
struct Uniforms {
	resolution: vec2f,
	contentOffset: vec2f,
	worldOrigin: vec2f,
	elementSize: vec2f,
	dpiScale: f32,
	intensity: f32,
	colorShift: f32,
	slices: f32,
	angle: f32,
	bias: f32,
	seed: f32,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var inputSampler: sampler;

struct VertexOutput {
	@builtin(position) position: vec4f,
	@location(0) texCoord: vec2f,
}

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
	var output: VertexOutput;
	let x = f32((vertexIndex & 1u) << 1u);
	let y = f32(vertexIndex & 2u);
	output.position = vec4f(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);
	output.texCoord = vec2f(x, y);
	return output;
}

// World-anchored position: the editor clamps the bake to the viewport, so
// texCoord 0 is not the element corner and the texture scale follows the live
// zoom. Mapping back through contentOffset/dpiScale and shifting by
// worldOrigin anchors the slice pattern to the full element rect, keeping it
// fixed while zooming or panning.
fn glitchWorldPos(texCoord: vec2f) -> vec2f {
	return (texCoord * uniforms.resolution - uniforms.contentOffset) / uniforms.dpiScale
		+ uniforms.worldOrigin;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
	let dims = uniforms.resolution;
	let texCoord = input.texCoord;

	var shiftedCoord = texCoord;

	if (uniforms.intensity > 0.0) {
		// Calculate diagonal slices based on angle
		let angle = uniforms.angle * 3.14159;

		// Determine slice using rotated coordinate in element-rect UV, so the
		// slicing stays anchored to the element instead of the bake rect
		let stableUV = glitchWorldPos(texCoord) / uniforms.elementSize;
		let sliceCoord = stableUV.x * sin(angle) + stableUV.y * cos(angle);
		let sliceIndex = floor(sliceCoord * uniforms.slices);

		let seed = uniforms.seed;
		let random = fract(sin(sliceIndex * 43758.5453 + seed) * 43758.5453);

		if (random < uniforms.intensity) {
			let shift = (random - 0.5 + uniforms.bias * 0.5) * uniforms.intensity;

			// Shift direction perpendicular to angle
			let shiftAngle = angle;
			let xShift = shift * cos(shiftAngle);
			let yShift = shift * sin(shiftAngle);

			// The shift is sized in element-rect UV units; convert to bake UV
			// so the displacement covers the same world distance at any zoom
			let uvScale = uniforms.elementSize * uniforms.dpiScale / uniforms.resolution;
			shiftedCoord.x = clamp(texCoord.x + xShift * uvScale.x, 0.0, 1.0);
			shiftedCoord.y = clamp(texCoord.y + yShift * uvScale.y, 0.0, 1.0);
		}
	}

	let rOffset = uniforms.colorShift;

	let rCoord = clamp(vec2f(shiftedCoord.x + rOffset, shiftedCoord.y), vec2f(0.0), vec2f(1.0));
	let gCoord = shiftedCoord;
	let bCoord = clamp(vec2f(shiftedCoord.x - rOffset, shiftedCoord.y), vec2f(0.0), vec2f(1.0));

	let rC = textureSample(inputTexture, inputSampler, rCoord);
	let gC = textureSample(inputTexture, inputSampler, gCoord);
	let bC = textureSample(inputTexture, inputSampler, bCoord);

	let a = (rC.a + gC.a + bC.a) / 3.0;

	let outColor = vec4f(rC.r, gC.g, bC.b, a);

	return outColor;
}
`;
