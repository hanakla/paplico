export const HK_GLITCH_SHADER = /* wgsl */ `
struct Uniforms {
	resolution: vec2f,
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

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
	let dims = uniforms.resolution;
	let texCoord = input.texCoord;

	var shiftedCoord = texCoord;

	if (uniforms.intensity > 0.0) {
		// Calculate diagonal slices based on angle
		let angle = uniforms.angle * 3.14159;

		// Determine slice using rotated coordinate
		let sliceCoord = texCoord.x * sin(angle) + texCoord.y * cos(angle);
		let sliceIndex = floor(sliceCoord * uniforms.slices);

		let seed = uniforms.seed;
		let random = fract(sin(sliceIndex * 43758.5453 + seed) * 43758.5453);

		if (random < uniforms.intensity) {
			let shift = (random - 0.5 + uniforms.bias * 0.5) * uniforms.intensity;

			// Shift direction perpendicular to angle
			let shiftAngle = angle;
			let xShift = shift * cos(shiftAngle);
			let yShift = shift * sin(shiftAngle);

			shiftedCoord.x = clamp(texCoord.x + xShift, 0.0, 1.0);
			shiftedCoord.y = clamp(texCoord.y + yShift, 0.0, 1.0);
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
