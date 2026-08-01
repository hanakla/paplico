import * as THREE from "three";
import { colorToRawRGBA, type Lineart3DParams } from "../../schema";
import { SHADOW_CATCHER_LAYER } from "../runtime/primitives";

interface LineartRenderOptions {
	width: number;
	height: number;
	/** Rasterization scale; multiplies the edge kernel radius. */
	rasterScale: number;
	params: Lineart3DParams;
	cameraNear: number;
	cameraFar: number;
}

const EDGE_VERTEX_SHADER = /* glsl */ `
varying vec2 vUv;
void main() {
	vUv = uv;
	gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/**
 * Fullscreen Sobel edge detection over the normal + depth buffers.
 *
 * - Depth edges: Sobel over linearized depth, with grazing-angle attenuation
 *   (surfaces nearly parallel to the view ray produce steep depth gradients
 *   that are not silhouettes — the threshold is raised there).
 * - Normal edges: Sobel over view-space normals, gated by the crease angle
 *   (the max angular difference to neighboring normals must exceed it).
 *
 * Output is premultiplied lineColor with alpha = edge strength over a
 * transparent background (blending disabled; the pass owns every pixel).
 */
const EDGE_FRAGMENT_SHADER = /* glsl */ `
precision highp float;

varying vec2 vUv;

uniform sampler2D tNormal;
uniform sampler2D tDepth;
uniform vec2 resolution;
uniform float kernelRadius;
uniform float depthEdgeThreshold;
uniform float normalEdgeThreshold;
uniform float creaseCos;
uniform vec4 lineColor;
uniform float cameraNear;
uniform float cameraFar;
uniform float isPerspective;

float linearDepth(vec2 uv) {
	float d = texture2D(tDepth, uv).x;
	if (isPerspective > 0.5) {
		float z = d * 2.0 - 1.0;
		return (2.0 * cameraNear) / (cameraFar + cameraNear - z * (cameraFar - cameraNear));
	}
	return d;
}

vec3 viewNormal(vec2 uv) {
	return texture2D(tNormal, uv).xyz * 2.0 - 1.0;
}

void main() {
	vec2 texel = kernelRadius / resolution;

	float d00 = linearDepth(vUv + texel * vec2(-1.0, -1.0));
	float d10 = linearDepth(vUv + texel * vec2( 0.0, -1.0));
	float d20 = linearDepth(vUv + texel * vec2( 1.0, -1.0));
	float d01 = linearDepth(vUv + texel * vec2(-1.0,  0.0));
	float d21 = linearDepth(vUv + texel * vec2( 1.0,  0.0));
	float d02 = linearDepth(vUv + texel * vec2(-1.0,  1.0));
	float d12 = linearDepth(vUv + texel * vec2( 0.0,  1.0));
	float d22 = linearDepth(vUv + texel * vec2( 1.0,  1.0));

	float depthGx = (d20 + 2.0 * d21 + d22) - (d00 + 2.0 * d01 + d02);
	float depthGy = (d02 + 2.0 * d12 + d22) - (d00 + 2.0 * d10 + d20);
	float depthGrad = length(vec2(depthGx, depthGy));

	vec3 n00 = viewNormal(vUv + texel * vec2(-1.0, -1.0));
	vec3 n10 = viewNormal(vUv + texel * vec2( 0.0, -1.0));
	vec3 n20 = viewNormal(vUv + texel * vec2( 1.0, -1.0));
	vec3 n01 = viewNormal(vUv + texel * vec2(-1.0,  0.0));
	vec3 n11 = viewNormal(vUv);
	vec3 n21 = viewNormal(vUv + texel * vec2( 1.0,  0.0));
	vec3 n02 = viewNormal(vUv + texel * vec2(-1.0,  1.0));
	vec3 n12 = viewNormal(vUv + texel * vec2( 0.0,  1.0));
	vec3 n22 = viewNormal(vUv + texel * vec2( 1.0,  1.0));

	vec3 normalGx = (n20 + 2.0 * n21 + n22) - (n00 + 2.0 * n01 + n02);
	vec3 normalGy = (n02 + 2.0 * n12 + n22) - (n00 + 2.0 * n10 + n20);
	float normalGrad = sqrt(dot(normalGx, normalGx) + dot(normalGy, normalGy));

	// Grazing-angle attenuation: view-facing surfaces have |normal.z| ≈ 1.
	float facing = clamp(abs(n11.z), 0.1, 1.0);
	float depthThreshold = depthEdgeThreshold / facing;
	float depthEdge = smoothstep(depthThreshold, depthThreshold * 2.0, depthGrad);

	// Crease gate: the sharpest angle to a neighbor must exceed creaseAngle.
	float minDot = min(
		min(min(dot(n11, n01), dot(n11, n21)), min(dot(n11, n10), dot(n11, n12))),
		min(min(dot(n11, n00), dot(n11, n22)), min(dot(n11, n20), dot(n11, n02)))
	);
	float creaseGate = step(minDot, creaseCos);
	float normalEdge =
		smoothstep(normalEdgeThreshold, normalEdgeThreshold * 2.0, normalGrad) *
		creaseGate;

	// Silhouettes against the empty background need no coverage gate: the
	// cleared depth is the far plane, so the depth gradient fires there and
	// background-to-background pixels have zero gradient.
	float edge = max(depthEdge, normalEdge) * lineColor.a;
	gl_FragColor = vec4(lineColor.rgb * edge, edge);
}
`;

const COMBINE_FRAGMENT_SHADER = /* glsl */ `
precision highp float;

varying vec2 vUv;

uniform sampler2D tSobel;
uniform sampler2D tShadow;

void main() {
	// Premultiplied "over": the 2D Sobel contour on top of the ground-shadow
	// underlay. No geometric edge overlay — the contour is purely image-space.
	vec4 sobel = texture2D(tSobel, vUv);
	vec4 shadow = texture2D(tShadow, vUv);
	gl_FragColor = vec4(
		sobel.rgb + shadow.rgb * (1.0 - sobel.a),
		sobel.a + shadow.a * (1.0 - sobel.a)
	);
}
`;

/**
 * Lineart extraction pipeline, fully contained in the three.js world. The
 * contour is purely image-space (2D post-process) — no geometric wireframe
 * edges are drawn:
 *
 * 1. normals + depth via MeshNormalMaterial override → target A
 * 2. fullscreen Sobel over both buffers (silhouette + crease) → target B
 * 3. combine (Sobel contour over ground shadow) → canvas
 */
export class LineartPipeline {
	private target: THREE.WebGLRenderTarget | null = null;
	private sobelTarget: THREE.WebGLRenderTarget | null = null;
	private shadowTarget: THREE.WebGLRenderTarget | null = null;
	private readonly normalMaterial = new THREE.MeshNormalMaterial();
	private readonly edgeScene = new THREE.Scene();
	private readonly edgeCamera = new THREE.OrthographicCamera(
		-1,
		1,
		1,
		-1,
		0,
		1,
	);
	private readonly edgeMaterial: THREE.ShaderMaterial;
	private readonly edgeQuad: THREE.Mesh;
	private readonly combineScene = new THREE.Scene();
	private readonly combineMaterial: THREE.ShaderMaterial;
	private readonly combineQuad: THREE.Mesh;

	public constructor() {
		this.edgeMaterial = new THREE.ShaderMaterial({
			vertexShader: EDGE_VERTEX_SHADER,
			fragmentShader: EDGE_FRAGMENT_SHADER,
			uniforms: {
				tNormal: { value: null },
				tDepth: { value: null },
				resolution: { value: new THREE.Vector2(1, 1) },
				kernelRadius: { value: 1 },
				depthEdgeThreshold: { value: 0.02 },
				normalEdgeThreshold: { value: 0.4 },
				creaseCos: { value: Math.cos((40 * Math.PI) / 180) },
				lineColor: { value: new THREE.Vector4(0, 0, 0, 1) },
				cameraNear: { value: 0.1 },
				cameraFar: { value: 100 },
				isPerspective: { value: 1 },
			},
			// The pass writes premultiplied output over a transparent clear.
			blending: THREE.NoBlending,
			depthTest: false,
			depthWrite: false,
		});
		this.edgeQuad = new THREE.Mesh(
			new THREE.PlaneGeometry(2, 2),
			this.edgeMaterial,
		);
		this.edgeQuad.frustumCulled = false;
		this.edgeScene.add(this.edgeQuad);

		this.combineMaterial = new THREE.ShaderMaterial({
			vertexShader: EDGE_VERTEX_SHADER,
			fragmentShader: COMBINE_FRAGMENT_SHADER,
			uniforms: {
				tSobel: { value: null },
				tShadow: { value: null },
			},
			blending: THREE.NoBlending,
			depthTest: false,
			depthWrite: false,
		});
		this.combineQuad = new THREE.Mesh(
			new THREE.PlaneGeometry(2, 2),
			this.combineMaterial,
		);
		this.combineQuad.frustumCulled = false;
		this.combineScene.add(this.combineQuad);
	}

	public render(
		renderer: THREE.WebGLRenderer,
		scene: THREE.Scene,
		camera: THREE.Camera,
		options: LineartRenderOptions,
	): void {
		const target = this.ensureTarget(options.width, options.height);
		const sobelTarget = this.ensureSobelTarget(options.width, options.height);
		const shadowTarget = this.ensureShadowTarget(options.width, options.height);
		const { params } = options;
		const color = colorToRawRGBA(
			params.color ?? { type: "rgb", r: 0, g: 0, b: 0, a: 1 },
		);
		const lineWidthPx = params.lineWidthPx * options.rasterScale;

		// Pass 0: ground-shadow underlay. Only the shadow catcher's layer is
		// visible; the shadow map itself is generated from every castShadow
		// mesh regardless of the view camera's layers.
		renderer.setRenderTarget(shadowTarget);
		renderer.setClearColor(0x000000, 0);
		renderer.clear();
		camera.layers.set(SHADOW_CATCHER_LAYER);
		renderer.render(scene, camera);
		camera.layers.set(0);

		// Pass 1: view-space normals + depth (camera layer 0 — edges excluded).
		scene.overrideMaterial = this.normalMaterial;
		renderer.setRenderTarget(target);
		renderer.setClearColor(0x000000, 0);
		renderer.clear();
		renderer.render(scene, camera);
		scene.overrideMaterial = null;

		// Pass 2: fullscreen edge detection → sobel target.
		const uniforms = this.edgeMaterial.uniforms;
		uniforms.tNormal.value = target.texture;
		uniforms.tDepth.value = target.depthTexture;
		(uniforms.resolution.value as THREE.Vector2).set(
			options.width,
			options.height,
		);
		uniforms.kernelRadius.value = lineWidthPx;
		uniforms.depthEdgeThreshold.value = params.depthEdgeThreshold;
		uniforms.normalEdgeThreshold.value = params.normalEdgeThreshold;
		uniforms.creaseCos.value = Math.cos(
			(params.creaseAngleDeg * Math.PI) / 180,
		);
		(uniforms.lineColor.value as THREE.Vector4).set(
			color.r,
			color.g,
			color.b,
			color.a,
		);
		uniforms.cameraNear.value = options.cameraNear;
		uniforms.cameraFar.value = options.cameraFar;
		uniforms.isPerspective.value = (camera as THREE.PerspectiveCamera)
			.isPerspectiveCamera
			? 1
			: 0;

		renderer.setRenderTarget(sobelTarget);
		renderer.setClearColor(0x000000, 0);
		renderer.clear();
		renderer.render(this.edgeScene, this.edgeCamera);

		// Pass 3: combine the Sobel contour over the ground shadow onto canvas.
		this.combineMaterial.uniforms.tSobel.value = sobelTarget.texture;
		this.combineMaterial.uniforms.tShadow.value = shadowTarget.texture;
		renderer.setRenderTarget(null);
		renderer.setClearColor(0x000000, 0);
		renderer.clear();
		renderer.render(this.combineScene, this.edgeCamera);
	}

	public dispose(): void {
		this.target?.dispose();
		this.target = null;
		this.sobelTarget?.dispose();
		this.sobelTarget = null;
		this.shadowTarget?.dispose();
		this.shadowTarget = null;
		this.normalMaterial.dispose();
		this.edgeMaterial.dispose();
		this.edgeQuad.geometry.dispose();
		this.combineMaterial.dispose();
		this.combineQuad.geometry.dispose();
	}

	private ensureTarget(width: number, height: number): THREE.WebGLRenderTarget {
		if (this.target?.width === width && this.target?.height === height) {
			return this.target;
		}
		this.target?.dispose();
		this.target = new THREE.WebGLRenderTarget(width, height, {
			minFilter: THREE.NearestFilter,
			magFilter: THREE.NearestFilter,
			depthTexture: new THREE.DepthTexture(width, height),
		});
		return this.target;
	}

	private ensureSobelTarget(
		width: number,
		height: number,
	): THREE.WebGLRenderTarget {
		if (
			this.sobelTarget?.width === width &&
			this.sobelTarget?.height === height
		) {
			return this.sobelTarget;
		}
		this.sobelTarget?.dispose();
		this.sobelTarget = new THREE.WebGLRenderTarget(width, height, {
			minFilter: THREE.NearestFilter,
			magFilter: THREE.NearestFilter,
			depthBuffer: false,
		});
		return this.sobelTarget;
	}

	private ensureShadowTarget(
		width: number,
		height: number,
	): THREE.WebGLRenderTarget {
		if (
			this.shadowTarget?.width === width &&
			this.shadowTarget?.height === height
		) {
			return this.shadowTarget;
		}
		this.shadowTarget?.dispose();
		// Linear filtering keeps the PCF-softened shadow edge smooth when the
		// underlay is composited at the canvas resolution.
		this.shadowTarget = new THREE.WebGLRenderTarget(width, height, {
			minFilter: THREE.LinearFilter,
			magFilter: THREE.LinearFilter,
		});
		return this.shadowTarget;
	}
}
