import type { Quat, Vec3, VRMPoseData } from "../../schema";

/**
 * VRMPoseData helpers (pure, three-vrm-free). The stored format is 1:1 with
 * three-vrm's normalized pose: sparse per-bone rest-relative quaternions
 * plus an optional hips translation.
 */

/** three-vrm VRMPose shape (structural — no runtime three-vrm import). */
type ThreeVrmPoseLike = Record<
	string,
	{
		rotation?: [number, number, number, number];
		position?: [number, number, number];
	}
>;

const QUAT_IDENTITY_EPSILON = 1e-4;
const POSITION_EPSILON = 1e-5;

/** Convert stored pose data into three-vrm's setNormalizedPose argument. */
export function toThreeVrmPose(pose: VRMPoseData): ThreeVrmPoseLike {
	const result: ThreeVrmPoseLike = {};
	for (const [bone, rotation] of Object.entries(pose.bones)) {
		result[bone] = { rotation: [...rotation] };
	}
	if (pose.hipsPosition) {
		result.hips = {
			...result.hips,
			position: [...pose.hipsPosition],
		};
	}
	return result;
}

/**
 * Drop near-identity bone rotations (and a near-zero hips offset) so the
 * committed pose stays a sparse rest-relative dictionary.
 */
export function sparsifyPose(pose: VRMPoseData): VRMPoseData {
	const bones: Record<string, Quat> = {};
	for (const [bone, rotation] of Object.entries(pose.bones)) {
		if (!isIdentityQuat(rotation)) bones[bone] = rotation;
	}
	const hips =
		pose.hipsPosition && !isZeroVec3(pose.hipsPosition)
			? pose.hipsPosition
			: undefined;
	return { bones, ...(hips ? { hipsPosition: hips } : {}) };
}

// Helpers

function isIdentityQuat(q: Quat): boolean {
	// q and -q encode the same rotation; compare via |w| and vector part.
	return (
		Math.abs(q[0]) < QUAT_IDENTITY_EPSILON &&
		Math.abs(q[1]) < QUAT_IDENTITY_EPSILON &&
		Math.abs(q[2]) < QUAT_IDENTITY_EPSILON &&
		Math.abs(Math.abs(q[3]) - 1) < QUAT_IDENTITY_EPSILON
	);
}

function isZeroVec3(v: Vec3): boolean {
	return (
		Math.abs(v[0]) < POSITION_EPSILON &&
		Math.abs(v[1]) < POSITION_EPSILON &&
		Math.abs(v[2]) < POSITION_EPSILON
	);
}
