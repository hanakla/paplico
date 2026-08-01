import * as THREE from "three";
import type { Reference3DNode, Transform3D } from "../../schema";

type PrimitiveNode = Extract<Reference3DNode, { kind: "primitive" }>;

/** Neutral grey used by all primitive meshes (flat mode; lineart overrides materials). */
const PRIMITIVE_COLOR = 0xcccccc;

/**
 * Render layer of the invisible ground-shadow catcher. Kept off layer 0 so
 * the lineart normal/edge passes and node raycasts never see it; the shadow
 * map itself is generated from every castShadow mesh regardless of the view
 * camera's layers.
 */
export const SHADOW_CATCHER_LAYER = 2;

/** Build a mesh for a primitive node with its transform applied. */
export function buildPrimitiveObject(node: PrimitiveNode): THREE.Mesh {
	const mesh = new THREE.Mesh(
		createPrimitiveGeometry(node),
		new THREE.MeshLambertMaterial({
			color: PRIMITIVE_COLOR,
			side: node.shape === "plane" ? THREE.DoubleSide : THREE.FrontSide,
		}),
	);
	mesh.castShadow = true;
	applyTransform3D(mesh, node.transform);
	return mesh;
}

/** Half-extent of the fixed shadow camera's coverage (room scale, meters). */
const SHADOW_AREA_HALF_EXTENT = 12;
/** Ground-shadow darkness on the invisible catcher. */
const SHADOW_OPACITY = 0.35;
/** Catcher plane side length — large enough to read as an infinite ground. */
const SHADOW_CATCHER_SIZE = 200;
/** Distance of the directional light from the origin (meters). */
const SHADOW_LIGHT_DISTANCE = 15;
/** Default light direction (toward the light) when the element sets none. */
export const DEFAULT_SHADOW_LIGHT_DIR: [number, number, number] = [6, 10, 4];

export interface ShadowRig {
	group: THREE.Group;
	light: THREE.DirectionalLight;
}

/**
 * Fixed key light + invisible ground plane that only renders received
 * shadows (ShadowMaterial), so scene objects ground themselves without a
 * floor node. The catcher lives on SHADOW_CATCHER_LAYER. The light direction
 * is set per render via setShadowLightDir.
 */
export function buildShadowRig(): ShadowRig {
	const group = new THREE.Group();

	const light = new THREE.DirectionalLight(0xffffff, 0.8);
	light.castShadow = true;
	light.shadow.mapSize.set(2048, 2048);
	light.shadow.camera.near = 0.5;
	light.shadow.camera.far = SHADOW_LIGHT_DISTANCE * 3;
	light.shadow.camera.left = -SHADOW_AREA_HALF_EXTENT;
	light.shadow.camera.right = SHADOW_AREA_HALF_EXTENT;
	light.shadow.camera.top = SHADOW_AREA_HALF_EXTENT;
	light.shadow.camera.bottom = -SHADOW_AREA_HALF_EXTENT;
	light.shadow.bias = -0.0005;
	light.shadow.normalBias = 0.02;
	setShadowLightDir(light, DEFAULT_SHADOW_LIGHT_DIR);
	group.add(light);
	group.add(light.target);

	const catcher = new THREE.Mesh(
		new THREE.PlaneGeometry(SHADOW_CATCHER_SIZE, SHADOW_CATCHER_SIZE),
		new THREE.ShadowMaterial({ opacity: SHADOW_OPACITY }),
	);
	catcher.rotation.x = -Math.PI / 2;
	catcher.receiveShadow = true;
	catcher.layers.set(SHADOW_CATCHER_LAYER);
	group.add(catcher);

	return { group, light };
}

/** Place the directional light along `dir` (toward the light) at a fixed distance. */
export function setShadowLightDir(
	light: THREE.DirectionalLight,
	dir: readonly [number, number, number],
): void {
	const len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
	const s = SHADOW_LIGHT_DISTANCE / len;
	light.position.set(dir[0] * s, dir[1] * s, dir[2] * s);
	light.target.position.set(0, 0, 0);
	light.target.updateMatrixWorld();
}

export function applyTransform3D(
	object: THREE.Object3D,
	transform: Transform3D,
): void {
	object.position.set(...transform.position);
	object.quaternion.set(...transform.rotation);
	object.scale.set(...transform.scale);
}

/** Recursively dispose geometries and materials owned by an object tree. */
export function disposeObject3D(object: THREE.Object3D): void {
	object.traverse((child) => {
		if (!(child instanceof THREE.Mesh)) return;
		child.geometry.dispose();
		const materials = Array.isArray(child.material)
			? child.material
			: [child.material];
		for (const material of materials) material.dispose();
	});
}

// Helpers

function createPrimitiveGeometry(node: PrimitiveNode): THREE.BufferGeometry {
	const params = node.params ?? {};
	switch (node.shape) {
		case "box":
			return new THREE.BoxGeometry(
				params.width ?? 1,
				params.height ?? 1,
				params.depth ?? 1,
			);
		case "sphere":
			return new THREE.SphereGeometry(params.radius ?? 0.5, 32, 16);
		case "cylinder": {
			const radius = params.radius ?? 0.5;
			return new THREE.CylinderGeometry(radius, radius, params.height ?? 1, 32);
		}
		case "cone":
			return new THREE.ConeGeometry(
				params.radius ?? 0.5,
				params.height ?? 1,
				32,
			);
		case "plane":
			return new THREE.PlaneGeometry(params.width ?? 1, params.height ?? 1);
	}
}
