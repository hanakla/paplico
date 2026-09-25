import {
	abs,
	clamp,
	dot,
	length,
	max,
	min,
	select,
	smoothstep,
	sqrt,
	step,
	texture,
	uniform,
	uv,
	vec2,
	vec4,
} from "three/tsl";
import * as THREE from "three/webgpu";
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

/** Sobel kernel taps as (offset, weight) — the 3×3 neighborhood minus the center. */
const SOBEL_TAPS: readonly (readonly [dx: number, dy: number])[] = [
	[-1, -1],
	[0, -1],
	[1, -1],
	[-1, 0],
	[1, 0],
	[-1, 1],
	[0, 1],
	[1, 1],
];

/**
 * Lineart extraction pipeline, fully contained in the three.js world. The
 * contour is purely image-space (2D post-process) — no geometric wireframe
 * edges are drawn:
 *
 * 1. normals + depth via MeshNormalMaterial override → normal target
 * 2. fullscreen Sobel over both buffers (silhouette + crease) → sobel target
 * 3. combine (Sobel contour over ground shadow) → output target
 *
 * The output target holds premultiplied RGBA8 in the working (linear) color
 * space; the caller reads its pixels back.
 */
export class LineartPipeline {
	private normalTarget = createNormalTarget(1, 1);
	private sobelTarget = createColorTarget(1, 1, THREE.NearestFilter);
	// Linear filtering keeps the PCF-softened shadow edge smooth when the
	// underlay is composited at the canvas resolution.
	private shadowTarget = createColorTarget(1, 1, THREE.LinearFilter);
	private outputTarget = createColorTarget(1, 1, THREE.NearestFilter);
	private readonly normalMaterial = new THREE.MeshNormalMaterial();

	private readonly tNormal = texture(this.normalTarget.texture);
	private readonly tDepth = texture(this.normalTarget.depthTexture!);
	private readonly tSobel = texture(this.sobelTarget.texture);
	private readonly tShadow = texture(this.shadowTarget.texture);
	private readonly resolution = uniform(new THREE.Vector2(1, 1));
	private readonly kernelRadius = uniform(1);
	private readonly depthEdgeThreshold = uniform(0.02);
	private readonly normalEdgeThreshold = uniform(0.4);
	private readonly creaseCos = uniform(Math.cos((40 * Math.PI) / 180));
	private readonly lineColor = uniform(new THREE.Vector4(0, 0, 0, 1));
	private readonly cameraNear = uniform(0.1);
	private readonly cameraFar = uniform(100);
	private readonly isPerspective = uniform(1);

	private readonly edgeMaterial = this.createEdgeMaterial();
	private readonly combineMaterial = this.createCombineMaterial();
	private readonly edgeQuad = new THREE.QuadMesh(this.edgeMaterial);
	private readonly combineQuad = new THREE.QuadMesh(this.combineMaterial);

	/** Renders the lineart view and returns the target holding the result. */
	public render(
		renderer: THREE.WebGPURenderer,
		scene: THREE.Scene,
		camera: THREE.Camera,
		options: LineartRenderOptions,
	): THREE.RenderTarget {
		this.ensureSize(options.width, options.height);
		const { params } = options;
		const color = colorToRawRGBA(
			params.color ?? { type: "rgb", r: 0, g: 0, b: 0, a: 1 },
		);

		// Pass 0: ground-shadow underlay. Only the shadow catcher's layer is
		// visible; the shadow map itself is generated from every castShadow
		// mesh regardless of the view camera's layers.
		renderer.setRenderTarget(this.shadowTarget);
		camera.layers.set(SHADOW_CATCHER_LAYER);
		renderer.render(scene, camera);
		camera.layers.set(0);

		// Pass 1: view-space normals + depth (camera layer 0 — edges excluded).
		scene.overrideMaterial = this.normalMaterial;
		renderer.setRenderTarget(this.normalTarget);
		renderer.render(scene, camera);
		scene.overrideMaterial = null;

		// Pass 2: fullscreen edge detection → sobel target.
		this.resolution.value.set(options.width, options.height);
		this.kernelRadius.value = params.lineWidthPx * options.rasterScale;
		this.depthEdgeThreshold.value = params.depthEdgeThreshold;
		this.normalEdgeThreshold.value = params.normalEdgeThreshold;
		this.creaseCos.value = Math.cos((params.creaseAngleDeg * Math.PI) / 180);
		this.lineColor.value.set(color.r, color.g, color.b, color.a);
		this.cameraNear.value = options.cameraNear;
		this.cameraFar.value = options.cameraFar;
		this.isPerspective.value = (camera as THREE.PerspectiveCamera)
			.isPerspectiveCamera
			? 1
			: 0;
		renderer.setRenderTarget(this.sobelTarget);
		this.edgeQuad.render(renderer);

		// Pass 3: combine the Sobel contour over the ground shadow.
		renderer.setRenderTarget(this.outputTarget);
		this.combineQuad.render(renderer);

		return this.outputTarget;
	}

	public dispose(): void {
		this.disposeTargets();
		this.normalMaterial.dispose();
		this.edgeMaterial.dispose();
		this.edgeQuad.geometry.dispose();
		this.combineMaterial.dispose();
		this.combineQuad.geometry.dispose();
	}

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
	private createEdgeMaterial(): THREE.NodeMaterial {
		const texel = this.kernelRadius.div(this.resolution);
		const baseUv = uv();
		const tapUv = (dx: number, dy: number) =>
			baseUv.add(texel.mul(vec2(dx, dy)));

		// Depth-buffer values are [0, 1] in both WebGL and WebGPU; the
		// perspective linearization yields distance / far.
		const linearDepth = (dx: number, dy: number) => {
			const d = this.tDepth.sample(tapUv(dx, dy)).x;
			const perspective = this.cameraNear.div(
				this.cameraFar.sub(d.mul(this.cameraFar.sub(this.cameraNear))),
			);
			return select(this.isPerspective.greaterThan(0.5), perspective, d);
		};
		const viewNormal = (dx: number, dy: number) =>
			this.tNormal.sample(tapUv(dx, dy)).xyz.mul(2).sub(1);

		// Sobel X weights: right column minus left column (center rows doubled).
		// Sobel Y weights: bottom row minus top row.
		const taps = SOBEL_TAPS.map(([dx, dy]) => ({
			depth: linearDepth(dx, dy),
			normal: viewNormal(dx, dy),
			weightX: dx * (dy === 0 ? 2 : 1),
			weightY: dy * (dx === 0 ? 2 : 1),
		}));
		const depthGx = taps
			.map((tap) => tap.depth.mul(tap.weightX))
			.reduce((sum, term) => sum.add(term));
		const depthGy = taps
			.map((tap) => tap.depth.mul(tap.weightY))
			.reduce((sum, term) => sum.add(term));
		const normalGx = taps
			.map((tap) => tap.normal.mul(tap.weightX))
			.reduce((sum, term) => sum.add(term));
		const normalGy = taps
			.map((tap) => tap.normal.mul(tap.weightY))
			.reduce((sum, term) => sum.add(term));
		const depthGrad = length(vec2(depthGx, depthGy));
		const normalGrad = sqrt(
			dot(normalGx, normalGx).add(dot(normalGy, normalGy)),
		);

		// Grazing-angle attenuation: view-facing surfaces have |normal.z| ≈ 1.
		const center = viewNormal(0, 0);
		const facing = clamp(abs(center.z), 0.1, 1.0);
		const depthThreshold = this.depthEdgeThreshold.div(facing);
		const depthEdge = smoothstep(
			depthThreshold,
			depthThreshold.mul(2),
			depthGrad,
		);

		// Crease gate: the sharpest angle to a neighbor must exceed creaseAngle.
		const minDot = taps
			.map((tap) => dot(center, tap.normal))
			.reduce((lowest, candidate) => min(lowest, candidate));
		const creaseGate = step(minDot, this.creaseCos);
		const normalEdge = smoothstep(
			this.normalEdgeThreshold,
			this.normalEdgeThreshold.mul(2),
			normalGrad,
		).mul(creaseGate);

		// Silhouettes against the empty background need no coverage gate: the
		// cleared depth is the far plane, so the depth gradient fires there and
		// background-to-background pixels have zero gradient.
		const edge = max(depthEdge, normalEdge).mul(this.lineColor.a);

		return createFullscreenMaterial(vec4(this.lineColor.rgb.mul(edge), edge));
	}

	/**
	 * Premultiplied "over": the 2D Sobel contour on top of the ground-shadow
	 * underlay. No geometric edge overlay — the contour is purely image-space.
	 */
	private createCombineMaterial(): THREE.NodeMaterial {
		const sobel = this.tSobel.sample(uv());
		const shadow = this.tShadow.sample(uv());
		const coverage = sobel.a.oneMinus();
		return createFullscreenMaterial(
			vec4(
				sobel.rgb.add(shadow.rgb.mul(coverage)),
				sobel.a.add(shadow.a.mul(coverage)),
			),
		);
	}

	private ensureSize(width: number, height: number): void {
		if (
			this.outputTarget.width === width &&
			this.outputTarget.height === height
		) {
			return;
		}
		this.disposeTargets();
		this.normalTarget = createNormalTarget(width, height);
		this.sobelTarget = createColorTarget(width, height, THREE.NearestFilter);
		this.shadowTarget = createColorTarget(width, height, THREE.LinearFilter);
		this.outputTarget = createColorTarget(width, height, THREE.NearestFilter);
		this.tNormal.value = this.normalTarget.texture;
		this.tDepth.value = this.normalTarget.depthTexture!;
		this.tSobel.value = this.sobelTarget.texture;
		this.tShadow.value = this.shadowTarget.texture;
	}

	private disposeTargets(): void {
		this.normalTarget.dispose();
		this.sobelTarget.dispose();
		this.shadowTarget.dispose();
		this.outputTarget.dispose();
	}
}

// Helpers

/** Post-process material: writes `output` straight, no blending or depth. */
function createFullscreenMaterial(output: THREE.Node): THREE.NodeMaterial {
	const material = new THREE.NodeMaterial();
	material.fragmentNode = output;
	material.blending = THREE.NoBlending;
	material.depthTest = false;
	material.depthWrite = false;
	return material;
}

function createNormalTarget(width: number, height: number): THREE.RenderTarget {
	return new THREE.RenderTarget(width, height, {
		minFilter: THREE.NearestFilter,
		magFilter: THREE.NearestFilter,
		depthTexture: new THREE.DepthTexture(width, height),
	});
}

function createColorTarget(
	width: number,
	height: number,
	filter: THREE.MagnificationTextureFilter,
): THREE.RenderTarget {
	return new THREE.RenderTarget(width, height, {
		minFilter: filter,
		magFilter: filter,
		depthBuffer: false,
	});
}
