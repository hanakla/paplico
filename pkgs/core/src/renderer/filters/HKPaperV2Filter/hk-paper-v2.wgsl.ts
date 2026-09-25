// Stage B of the hk:paper-v2 generator: lights and composites the generated
// paper height field (stage A texture) into the element, masked by the
// element's own alpha. Physically-based lighting (normal map from the height
// field, GGX specular) ported from the original ai-deno texture-paper-v2
// compute shader; coating/gloss integration follows how coated stock is
// actually finished (the coat layer buries fibers and flattens the relief,
// calendering raises the specular sheen — see the source URLs on the paper
// table in hk-paper-v2-papers.ts).

export const HK_PAPER_V2_SHADER = /* wgsl */ `
struct Uniforms {
	resolution: vec2f,
	contentOffset: vec2f,
	// Texture top-left relative to the element rect's top-left, in world px
	// (Y-down) — see hk-paper-v2-gen.wgsl.ts.
	worldOrigin: vec2f,
	baseColor: vec3f,
	dpiScale: f32,
	lightingEnabled: f32,
	lightIntensity: f32,
	lightAngle: f32,
	depthEffect: f32,
	surfaceRoughness: f32,
	invert: f32,
	coating: f32,
	gloss: f32,
	paperOpacity: f32,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var paperTexture: texture_2d<f32>;
@group(0) @binding(2) var inputSampler: sampler;
@group(0) @binding(3) var sourceTexture: texture_2d<f32>;

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

fn hash(n: f32) -> f32 {
	return fract(sin(n) * 43758.5453);
}

fn vnoise(p: vec2f) -> f32 {
	let i = floor(p);
	let f = fract(p);

	let a = hash(i.x + i.y * 57.0);
	let b = hash(i.x + 1.0 + i.y * 57.0);
	let c = hash(i.x + i.y * 57.0 + 1.0);
	let d = hash(i.x + 1.0 + i.y * 57.0 + 1.0);

	let u = f * f * (3.0 - 2.0 * f);

	return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

fn calculateLighting(normal: vec3f, roughness: f32, f0: f32) -> f32 {
	let lightDir = normalize(vec3f(cos(radians(uniforms.lightAngle)), sin(radians(uniforms.lightAngle)), 0.8));
	let viewDir = vec3f(0.0, 0.0, 1.0);
	let halfDir = normalize(lightDir + viewDir);

	let diffuse = max(dot(normal, lightDir), 0.0);

	let NdotH = max(dot(normal, halfDir), 0.0);
	let alpha = roughness * roughness;
	let D = alpha * alpha / (3.14159 * pow(NdotH * NdotH * (alpha * alpha - 1.0) + 1.0, 2.0));

	let F = f0 + (1.0 - f0) * pow(1.0 - max(dot(viewDir, halfDir), 0.0), 5.0);

	let k = (roughness + 1.0) * (roughness + 1.0) / 8.0;
	let NdotV = max(dot(normal, viewDir), 0.0);
	let NdotL = max(dot(normal, lightDir), 0.0);
	let G = (NdotV * NdotL) / ((NdotV * (1.0 - k) + k) * (NdotL * (1.0 - k) + k));

	let specular = (D * F * G) / (4.0 * NdotV * NdotL + 0.001);

	let ambient = 0.2;

	return ambient + (diffuse + specular * (1.0 + uniforms.gloss * 2.0)) * uniforms.lightIntensity;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
	let texCoord = input.texCoord;

	// Sample everything up front (uniform control flow for textureSample).
	let srcA = textureSample(sourceTexture, inputSampler, texCoord).a;
	let height = textureSample(paperTexture, inputSampler, texCoord).r;
	// Normal-map step of exactly 1 world px, DPI-invariant.
	let stepUv = vec2f(uniforms.dpiScale) / uniforms.resolution;
	let hL = textureSample(paperTexture, inputSampler, texCoord - vec2f(stepUv.x, 0.0)).r;
	let hR = textureSample(paperTexture, inputSampler, texCoord + vec2f(stepUv.x, 0.0)).r;
	let hT = textureSample(paperTexture, inputSampler, texCoord - vec2f(0.0, stepUv.y)).r;
	let hB = textureSample(paperTexture, inputSampler, texCoord + vec2f(0.0, stepUv.y)).r;

	// The coat layer buries the fibers and flattens the relief.
	let buried = mix(height, 1.0, uniforms.coating * 0.85);
	let depthEff = uniforms.depthEffect * (1.0 - uniforms.coating * 0.8);

	let strength = depthEff * 2.0;
	let normal = normalize(vec3f(-(hR - hL) * strength, -(hB - hT) * strength, 1.0));

	// Calendering / natural sheen raises the Fresnel base and tightens the lobe.
	let f0 = mix(0.04, 0.18, uniforms.gloss);
	let rough = clamp(uniforms.surfaceRoughness * (1.0 - uniforms.gloss * 0.6), 0.05, 1.0);
	let lighting = calculateLighting(normal, rough, f0);

	// Fiber depth variation, world-anchored so it does not swim across DPI.
	let world = (texCoord * uniforms.resolution - uniforms.contentOffset) / uniforms.dpiScale
		+ uniforms.worldOrigin;
	let noise1 = vnoise(world * 0.7) * 0.05;
	let noise2 = vnoise(world * 0.22) * 0.1;
	let depthVariation = mix(1.0, noise1 + noise2, depthEff * 0.5);
	let subsurface = vnoise(world * 0.09) * depthEff * 0.1;

	let albedo = uniforms.baseColor * buried;
	let colorWithDepth = albedo * (0.97 + depthVariation) + vec3f(subsurface);

	var rgb = albedo;
	if (uniforms.lightingEnabled > 0.5) {
		rgb = colorWithDepth * lighting;
	}
	if (uniforms.invert > 0.5) {
		rgb = vec3f(1.0) - rgb;
	}

	// Premultiplied output, shaped by the element's silhouette and thinned by
	// the sheet opacity (tengujo-class papers are translucent).
	let a = srcA * uniforms.paperOpacity;
	return vec4f(clamp(rgb, vec3f(0.0), vec3f(1.0)) * a, a);
}
`;
