import type { Quat, Vec3, VRMPoseData } from "../../schema";
import { clamp } from "../../utils/math";

/**
 * CCD IK solver on VRM normalized bones.
 *
 * Pure logic, no three.js / three-vrm at runtime: the rig is a plain
 * rest-pose skeleton (parent-relative joint positions on the normalized
 * T-pose rig, where every model shares world-aligned bone axes), and poses
 * are VRMPoseData-shaped sparse rotation dictionaries. This keeps the solver
 * unit-testable in happy-dom and independent of the lazy three chunk.
 */

export interface IKRigBone {
	name: string;
	parent: string | null;
	/** Rest-pose position relative to the parent joint (meters, T-pose). */
	restPosition: Vec3;
}

export interface IKRigData {
	bones: IKRigBone[];
}

export type IKConstraint =
	| {
			type: "hinge";
			/** Rotation axis in the bone's local (= world-aligned rest) space. */
			axis: Vec3;
			minDeg: number;
			maxDeg: number;
	  }
	| { type: "ball"; maxAngleDeg: number };

export interface IKChainDef {
	/** Rotated joints ordered root → tip. */
	links: Array<{ bone: string; constraint: IKConstraint | null }>;
	/** Joint pulled toward the target. Not rotated itself. */
	effector: string;
}

export interface RootTransform {
	position: Vec3;
	rotation: Quat;
}

export interface WorldJoint {
	position: Vec3;
	rotation: Quat;
}

export const IK_DEFAULT_ITERATIONS = 16;
export const IK_DEFAULT_TOLERANCE = 0.005;

const IDENTITY_QUAT: Quat = [0, 0, 0, 1];
const IDENTITY_ROOT: RootTransform = {
	position: [0, 0, 0],
	rotation: IDENTITY_QUAT,
};

/**
 * Standard VRM limb chains on the normalized rig: hand/foot effectors with
 * a hinged elbow/knee and a ball-limited shoulder/hip link. Axis signs
 * follow the world-aligned T-pose (left arm +X, right arm -X, legs -Y).
 */
export const VRM_IK_CHAINS = {
	leftArm: {
		links: [
			{ bone: "leftUpperArm", constraint: { type: "ball", maxAngleDeg: 120 } },
			{
				bone: "leftLowerArm",
				constraint: { type: "hinge", axis: [0, 1, 0], minDeg: 0, maxDeg: 150 },
			},
		],
		effector: "leftHand",
	},
	rightArm: {
		links: [
			{ bone: "rightUpperArm", constraint: { type: "ball", maxAngleDeg: 120 } },
			{
				bone: "rightLowerArm",
				constraint: {
					type: "hinge",
					axis: [0, -1, 0],
					minDeg: 0,
					maxDeg: 150,
				},
			},
		],
		effector: "rightHand",
	},
	leftLeg: {
		links: [
			{ bone: "leftUpperLeg", constraint: { type: "ball", maxAngleDeg: 120 } },
			{
				bone: "leftLowerLeg",
				constraint: {
					type: "hinge",
					axis: [-1, 0, 0],
					minDeg: 0,
					maxDeg: 150,
				},
			},
		],
		effector: "leftFoot",
	},
	rightLeg: {
		links: [
			{ bone: "rightUpperLeg", constraint: { type: "ball", maxAngleDeg: 120 } },
			{
				bone: "rightLowerLeg",
				constraint: {
					type: "hinge",
					axis: [-1, 0, 0],
					minDeg: 0,
					maxDeg: 150,
				},
			},
		],
		effector: "rightFoot",
	},
} as const satisfies Record<string, IKChainDef>;

/**
 * Forward kinematics: world position + rotation for every joint of the rig
 * under the given pose (hipsPosition offsets the hips joint) and an optional
 * figure root transform. Figure scale is not modeled (P3 figures are 1:1).
 */
export function computeWorldJoints(
	rig: IKRigData,
	pose: VRMPoseData,
	root: RootTransform = IDENTITY_ROOT,
): Map<string, WorldJoint> {
	const byName = new Map(rig.bones.map((bone) => [bone.name, bone]));
	const result = new Map<string, WorldJoint>();

	const resolve = (name: string): WorldJoint | null => {
		const cached = result.get(name);
		if (cached) return cached;
		const bone = byName.get(name);
		if (!bone) return null;

		const parent = bone.parent ? resolve(bone.parent) : null;
		const parentJoint: WorldJoint = parent ?? {
			position: root.position,
			rotation: root.rotation,
		};

		let rest = bone.restPosition;
		if (name === "hips" && pose.hipsPosition) {
			rest = addVec3(rest, pose.hipsPosition);
		}

		const local = pose.bones[name] ?? IDENTITY_QUAT;
		const joint: WorldJoint = {
			position: addVec3(
				parentJoint.position,
				rotateVec3(parentJoint.rotation, rest),
			),
			rotation: quatNormalize(quatMultiply(parentJoint.rotation, local)),
		};
		result.set(name, joint);
		return joint;
	};

	for (const bone of rig.bones) resolve(bone.name);
	return result;
}

/**
 * Cyclic Coordinate Descent: iteratively rotate each chain link so the
 * effector approaches the target, applying the link constraint after every
 * adjustment. Returns only the rotations of the chain's link bones (merge
 * into VRMPoseData.bones by the caller).
 */
export function solveCCD(args: {
	rig: IKRigData;
	pose: VRMPoseData;
	chain: IKChainDef;
	targetWorld: Vec3;
	root?: RootTransform;
	iterations?: number;
	tolerance?: number;
}): Record<string, Quat> {
	const { rig, chain, targetWorld } = args;
	const root = args.root ?? IDENTITY_ROOT;
	const iterations = args.iterations ?? IK_DEFAULT_ITERATIONS;
	const tolerance = args.tolerance ?? IK_DEFAULT_TOLERANCE;

	const rotations: Record<string, Quat> = { ...args.pose.bones };
	const workingPose: VRMPoseData = {
		bones: rotations,
		hipsPosition: args.pose.hipsPosition,
	};

	for (let iteration = 0; iteration < iterations; iteration++) {
		let joints = computeWorldJoints(rig, workingPose, root);
		const effector = joints.get(chain.effector);
		if (!effector) break;
		if (distanceVec3(effector.position, targetWorld) <= tolerance) break;

		for (let i = chain.links.length - 1; i >= 0; i--) {
			const link = chain.links[i];
			const joint = joints.get(link.bone);
			const eff = joints.get(chain.effector);
			if (!joint || !eff) continue;

			const toEffector = normalizeVec3(subVec3(eff.position, joint.position));
			const toTarget = normalizeVec3(subVec3(targetWorld, joint.position));
			if (lengthVec3(toEffector) < 1e-9 || lengthVec3(toTarget) < 1e-9) {
				continue;
			}

			// World-space corrective rotation, mapped into the bone's local
			// space through its parent's world rotation.
			const worldDelta = quatFromTo(toEffector, toTarget);
			const local = rotations[link.bone] ?? IDENTITY_QUAT;
			const parentWorld = quatMultiply(joint.rotation, quatInvert(local));
			const localDelta = quatMultiply(
				quatInvert(parentWorld),
				quatMultiply(worldDelta, parentWorld),
			);
			let nextLocal = quatNormalize(quatMultiply(localDelta, local));
			if (link.constraint) {
				nextLocal = applyIKConstraint(nextLocal, link.constraint);
			}
			rotations[link.bone] = nextLocal;

			// Chains are 2-3 links; full FK recompute per adjustment is cheap.
			joints = computeWorldJoints(rig, workingPose, root);
		}
	}

	const changed: Record<string, Quat> = {};
	for (const link of chain.links) {
		changed[link.bone] = rotations[link.bone] ?? IDENTITY_QUAT;
	}
	return changed;
}

/**
 * Aim a bone (head look-at) so its local `forward` axis points at the
 * target, clamped to a ball limit. Returns the bone's new local rotation.
 */
export function solveLookAt(args: {
	rig: IKRigData;
	pose: VRMPoseData;
	bone: string;
	/** Bone-local forward axis on the rest rig (VRM models face -Z? +Z varies; pass explicitly). */
	forward: Vec3;
	targetWorld: Vec3;
	maxAngleDeg: number;
	root?: RootTransform;
}): Quat | null {
	const root = args.root ?? IDENTITY_ROOT;
	const joints = computeWorldJoints(args.rig, args.pose, root);
	const joint = joints.get(args.bone);
	if (!joint) return null;

	const local = args.pose.bones[args.bone] ?? IDENTITY_QUAT;
	const parentWorld = quatMultiply(joint.rotation, quatInvert(local));

	// Target direction in the bone's parent space; aim from the rest forward.
	const targetDir = normalizeVec3(
		rotateVec3(
			quatInvert(parentWorld),
			subVec3(args.targetWorld, joint.position),
		),
	);
	if (lengthVec3(targetDir) < 1e-9) return null;

	return applyIKConstraint(quatFromTo(normalizeVec3(args.forward), targetDir), {
		type: "ball",
		maxAngleDeg: args.maxAngleDeg,
	});
}

/** Clamp a local rotation to its constraint (hinge projection or ball limit). */
export function applyIKConstraint(
	rotation: Quat,
	constraint: IKConstraint,
): Quat {
	if (constraint.type === "hinge") {
		const axis = normalizeVec3(constraint.axis);
		// Twist extraction: signed angle of the rotation about the hinge axis.
		const projected =
			rotation[0] * axis[0] + rotation[1] * axis[1] + rotation[2] * axis[2];
		let angle = 2 * Math.atan2(projected, rotation[3]);
		// Normalize into (-π, π] before clamping the mechanical range.
		if (angle > Math.PI) angle -= 2 * Math.PI;
		if (angle < -Math.PI) angle += 2 * Math.PI;
		const clamped = clamp(
			angle,
			(constraint.minDeg * Math.PI) / 180,
			(constraint.maxDeg * Math.PI) / 180,
		);
		return quatFromAxisAngle(axis, clamped);
	}

	const { axis, angle } = quatToAxisAngle(rotation);
	const max = (constraint.maxAngleDeg * Math.PI) / 180;
	if (Math.abs(angle) <= max) return rotation;
	return quatFromAxisAngle(axis, Math.sign(angle) * max);
}

// ---------------------------------------------------------------------------
// Quaternion / vector helpers (exported for pose-mode FK math in the tool)
// ---------------------------------------------------------------------------

export function quatMultiply(a: Quat, b: Quat): Quat {
	return [
		a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
		a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
		a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
		a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
	];
}

export function quatInvert(q: Quat): Quat {
	return [-q[0], -q[1], -q[2], q[3]];
}

export function quatNormalize(q: Quat): Quat {
	const len = Math.hypot(q[0], q[1], q[2], q[3]);
	if (len < 1e-12) return [0, 0, 0, 1];
	return [q[0] / len, q[1] / len, q[2] / len, q[3] / len];
}

export function quatFromAxisAngle(axis: Vec3, angle: number): Quat {
	const half = angle / 2;
	const s = Math.sin(half);
	return quatNormalize([axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(half)]);
}

export function quatToAxisAngle(q: Quat): { axis: Vec3; angle: number } {
	const n = quatNormalize(q);
	const sinHalf = Math.hypot(n[0], n[1], n[2]);
	if (sinHalf < 1e-9) return { axis: [1, 0, 0], angle: 0 };
	const angle = 2 * Math.atan2(sinHalf, n[3]);
	return {
		axis: [n[0] / sinHalf, n[1] / sinHalf, n[2] / sinHalf],
		angle,
	};
}

/** Shortest-arc rotation carrying unit vector `from` onto unit vector `to`. */
export function quatFromTo(from: Vec3, to: Vec3): Quat {
	const dot = from[0] * to[0] + from[1] * to[1] + from[2] * to[2];
	if (dot > 1 - 1e-9) return [0, 0, 0, 1];
	if (dot < -1 + 1e-9) {
		// Antiparallel: rotate 180° around any axis orthogonal to `from`.
		const orthogonal = normalizeVec3(
			Math.abs(from[0]) < 0.9
				? crossVec3(from, [1, 0, 0])
				: crossVec3(from, [0, 1, 0]),
		);
		return quatFromAxisAngle(orthogonal, Math.PI);
	}
	const cross = crossVec3(from, to);
	return quatNormalize([cross[0], cross[1], cross[2], 1 + dot]);
}

export function rotateVec3(q: Quat, v: Vec3): Vec3 {
	// v' = v + 2 * cross(q.xyz, cross(q.xyz, v) + q.w * v)
	const qv: Vec3 = [q[0], q[1], q[2]];
	const t = scaleVec3(
		crossVec3(qv, addVec3(crossVec3(qv, v), scaleVec3(v, q[3]))),
		2,
	);
	return addVec3(v, t);
}

export function addVec3(a: Vec3, b: Vec3): Vec3 {
	return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function subVec3(a: Vec3, b: Vec3): Vec3 {
	return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function scaleVec3(a: Vec3, s: number): Vec3 {
	return [a[0] * s, a[1] * s, a[2] * s];
}

export function crossVec3(a: Vec3, b: Vec3): Vec3 {
	return [
		a[1] * b[2] - a[2] * b[1],
		a[2] * b[0] - a[0] * b[2],
		a[0] * b[1] - a[1] * b[0],
	];
}

export function lengthVec3(a: Vec3): number {
	return Math.hypot(a[0], a[1], a[2]);
}

export function distanceVec3(a: Vec3, b: Vec3): number {
	return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

export function normalizeVec3(a: Vec3): Vec3 {
	const len = lengthVec3(a);
	return len < 1e-12 ? [0, 0, 0] : scaleVec3(a, 1 / len);
}
