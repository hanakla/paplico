import type { VRMPoseData } from "../../schema";
import { quatFromAxisAngle, quatMultiply } from "./ikSolver";

/**
 * Built-in starting poses for VRM figures. Poses are normalized
 * (T-pose relative), so they transplant across models. Documents only ever
 * store the applied result — these presets are engine data, not schema.
 *
 * Rotations are rough atari poses, expressed as axis-angle products on the
 * world-aligned normalized rig (left arm +X, right arm -X, forward -Z).
 */

type PresetPoseId = "stand" | "walk" | "run" | "sit" | "crouch";

interface PresetPose {
	id: PresetPoseId;
	name: string;
	pose: VRMPoseData;
}

const deg = (value: number): number => (value * Math.PI) / 180;

// Axis shorthands on the normalized rig.
const X: [number, number, number] = [1, 0, 0];
const Y: [number, number, number] = [0, 1, 0];
const Z: [number, number, number] = [0, 0, 1];

/** Relaxed stand: arms lowered along the body. */
const STAND: VRMPoseData = {
	bones: {
		leftUpperArm: quatFromAxisAngle(Z, deg(70)),
		rightUpperArm: quatFromAxisAngle(Z, deg(-70)),
		leftLowerArm: quatFromAxisAngle(Y, deg(10)),
		rightLowerArm: quatFromAxisAngle(Y, deg(-10)),
	},
};

/** Mid-stride walk: opposite arm/leg swing. */
const WALK: VRMPoseData = {
	bones: {
		leftUpperArm: quatMultiply(
			quatFromAxisAngle(Z, deg(65)),
			quatFromAxisAngle(X, deg(-25)),
		),
		rightUpperArm: quatMultiply(
			quatFromAxisAngle(Z, deg(-65)),
			quatFromAxisAngle(X, deg(25)),
		),
		leftLowerArm: quatFromAxisAngle(Y, deg(15)),
		rightLowerArm: quatFromAxisAngle(Y, deg(-15)),
		leftUpperLeg: quatFromAxisAngle(X, deg(25)),
		rightUpperLeg: quatFromAxisAngle(X, deg(-20)),
		leftLowerLeg: quatFromAxisAngle(X, deg(-15)),
		rightLowerLeg: quatFromAxisAngle(X, deg(-30)),
		spine: quatFromAxisAngle(X, deg(3)),
	},
};

/** Running: deeper limb swing, bent elbows, forward lean. */
const RUN: VRMPoseData = {
	bones: {
		leftUpperArm: quatMultiply(
			quatFromAxisAngle(Z, deg(60)),
			quatFromAxisAngle(X, deg(-45)),
		),
		rightUpperArm: quatMultiply(
			quatFromAxisAngle(Z, deg(-60)),
			quatFromAxisAngle(X, deg(45)),
		),
		leftLowerArm: quatFromAxisAngle(Y, deg(80)),
		rightLowerArm: quatFromAxisAngle(Y, deg(-80)),
		leftUpperLeg: quatFromAxisAngle(X, deg(50)),
		rightUpperLeg: quatFromAxisAngle(X, deg(-35)),
		leftLowerLeg: quatFromAxisAngle(X, deg(-30)),
		rightLowerLeg: quatFromAxisAngle(X, deg(-80)),
		spine: quatFromAxisAngle(X, deg(12)),
	},
	hipsPosition: [0, -0.05, 0],
};

/** Sitting on a chair-height surface. */
const SIT: VRMPoseData = {
	bones: {
		leftUpperArm: quatFromAxisAngle(Z, deg(70)),
		rightUpperArm: quatFromAxisAngle(Z, deg(-70)),
		leftLowerArm: quatFromAxisAngle(Y, deg(25)),
		rightLowerArm: quatFromAxisAngle(Y, deg(-25)),
		leftUpperLeg: quatFromAxisAngle(X, deg(85)),
		rightUpperLeg: quatFromAxisAngle(X, deg(85)),
		leftLowerLeg: quatFromAxisAngle(X, deg(-85)),
		rightLowerLeg: quatFromAxisAngle(X, deg(-85)),
	},
	hipsPosition: [0, -0.4, 0],
};

/** Deep crouch: folded legs, arms resting on knees. */
const CROUCH: VRMPoseData = {
	bones: {
		leftUpperArm: quatMultiply(
			quatFromAxisAngle(Z, deg(60)),
			quatFromAxisAngle(X, deg(-30)),
		),
		rightUpperArm: quatMultiply(
			quatFromAxisAngle(Z, deg(-60)),
			quatFromAxisAngle(X, deg(30)),
		),
		leftLowerArm: quatFromAxisAngle(Y, deg(40)),
		rightLowerArm: quatFromAxisAngle(Y, deg(-40)),
		leftUpperLeg: quatFromAxisAngle(X, deg(115)),
		rightUpperLeg: quatFromAxisAngle(X, deg(115)),
		leftLowerLeg: quatFromAxisAngle(X, deg(-130)),
		rightLowerLeg: quatFromAxisAngle(X, deg(-130)),
		spine: quatFromAxisAngle(X, deg(15)),
	},
	hipsPosition: [0, -0.55, 0],
};

export const PRESET_POSES: readonly PresetPose[] = [
	{ id: "stand", name: "Stand", pose: STAND },
	{ id: "walk", name: "Walk", pose: WALK },
	{ id: "run", name: "Run", pose: RUN },
	{ id: "sit", name: "Sit", pose: SIT },
	{ id: "crouch", name: "Crouch", pose: CROUCH },
];
