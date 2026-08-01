import { describe, expect, it } from "vitest";
import type { Vec3 } from "../../schema";
import {
	applyIKConstraint,
	computeWorldJoints,
	distanceVec3,
	type IKChainDef,
	type IKRigData,
	normalizeVec3,
	quatFromAxisAngle,
	quatToAxisAngle,
	rotateVec3,
	solveCCD,
	solveLookAt,
	subVec3,
} from "./ikSolver";

/**
 * Minimal arm rig: shoulder at [0.1, 1.5, 0], upper arm 0.3m, forearm 0.3m,
 * all stretched along +X in rest pose (like the normalized VRM left arm).
 */
const ARM_RIG: IKRigData = {
	bones: [
		{ name: "hips", parent: null, restPosition: [0, 1, 0] },
		{ name: "shoulder", parent: "hips", restPosition: [0, 0.5, 0] },
		{ name: "upperArm", parent: "shoulder", restPosition: [0.1, 0, 0] },
		{ name: "lowerArm", parent: "upperArm", restPosition: [0.3, 0, 0] },
		{ name: "hand", parent: "lowerArm", restPosition: [0.3, 0, 0] },
	],
};

const ARM_CHAIN: IKChainDef = {
	links: [
		{ bone: "upperArm", constraint: { type: "ball", maxAngleDeg: 120 } },
		{
			bone: "lowerArm",
			constraint: { type: "hinge", axis: [0, 1, 0], minDeg: 0, maxDeg: 150 },
		},
	],
	effector: "hand",
};

const EMPTY_POSE = { bones: {} };

function effectorAfterSolve(target: Vec3): {
	position: Vec3;
	rotations: ReturnType<typeof solveCCD>;
} {
	const rotations = solveCCD({
		rig: ARM_RIG,
		pose: EMPTY_POSE,
		chain: ARM_CHAIN,
		targetWorld: target,
	});
	const joints = computeWorldJoints(ARM_RIG, { bones: rotations });
	return { position: joints.get("hand")!.position, rotations };
}

describe("computeWorldJoints", () => {
	it("should accumulate rest positions down the hierarchy in rest pose", () => {
		const joints = computeWorldJoints(ARM_RIG, EMPTY_POSE);
		expect(joints.get("hand")!.position[0]).toBeCloseTo(0.7, 9);
		expect(joints.get("hand")!.position[1]).toBeCloseTo(1.5, 9);
		expect(joints.get("hand")!.position[2]).toBeCloseTo(0, 9);
	});

	it("should offset everything by hipsPosition and the root transform", () => {
		const joints = computeWorldJoints(
			ARM_RIG,
			{ bones: {}, hipsPosition: [0, -0.4, 0] },
			{ position: [2, 0, 0], rotation: [0, 0, 0, 1] },
		);
		expect(joints.get("hand")!.position[0]).toBeCloseTo(2.7, 9);
		expect(joints.get("hand")!.position[1]).toBeCloseTo(1.1, 9);
	});

	it("should rotate child joints around their parent's rotation", () => {
		// Rotate the lower arm 90° around +Y: the hand folds toward -Z.
		const joints = computeWorldJoints(ARM_RIG, {
			bones: { lowerArm: quatFromAxisAngle([0, 1, 0], Math.PI / 2) },
		});
		const hand = joints.get("hand")!.position;
		expect(hand[0]).toBeCloseTo(0.4, 6);
		expect(hand[2]).toBeCloseTo(-0.3, 6);
	});
});

describe("solveCCD", () => {
	it("should reach a reachable target within tolerance", () => {
		const target: Vec3 = [0.4, 1.5, -0.3];
		const { position } = effectorAfterSolve(target);
		expect(distanceVec3(position, target)).toBeLessThan(0.02);
	});

	it("should stretch the chain toward an unreachable target", () => {
		const target: Vec3 = [2, 1.5, 0];
		const { position } = effectorAfterSolve(target);
		const shoulderJoint: Vec3 = [0.1, 1.5, 0];
		const towardTarget = normalizeVec3(subVec3(target, shoulderJoint));
		const towardHand = normalizeVec3(subVec3(position, shoulderJoint));
		const alignment =
			towardTarget[0] * towardHand[0] +
			towardTarget[1] * towardHand[1] +
			towardTarget[2] * towardHand[2];
		expect(alignment).toBeGreaterThan(0.99);
		// Fully extended: reach stays at the 0.6m chain length.
		expect(distanceVec3(position, shoulderJoint)).toBeCloseTo(0.6, 2);
	});

	it("should keep the elbow hinge within its mechanical range", () => {
		// A target behind the shoulder tempts the elbow to hyper-extend.
		const rotations = solveCCD({
			rig: ARM_RIG,
			pose: EMPTY_POSE,
			chain: ARM_CHAIN,
			targetWorld: [-0.4, 1.5, 0.2],
		});
		const { axis, angle } = quatToAxisAngle(rotations.lowerArm);
		const signed = angle * Math.sign(axis[1] || 1);
		expect(signed).toBeGreaterThanOrEqual(-1e-6);
		expect(signed).toBeLessThanOrEqual((150 * Math.PI) / 180 + 1e-6);
		// Hinge purity: any non-zero rotation happens strictly about the axis.
		if (Math.abs(angle) > 1e-6) {
			expect(Math.abs(axis[0])).toBeLessThan(1e-6);
			expect(Math.abs(axis[2])).toBeLessThan(1e-6);
		}
	});

	it("should respect the ball limit on the shoulder link", () => {
		const rotations = solveCCD({
			rig: ARM_RIG,
			pose: EMPTY_POSE,
			chain: ARM_CHAIN,
			targetWorld: [-0.5, 1.5, 0],
		});
		const { angle } = quatToAxisAngle(rotations.upperArm);
		expect(Math.abs(angle)).toBeLessThanOrEqual((120 * Math.PI) / 180 + 1e-6);
	});

	it("should return only the chain's link rotations", () => {
		const rotations = solveCCD({
			rig: ARM_RIG,
			pose: EMPTY_POSE,
			chain: ARM_CHAIN,
			targetWorld: [0.4, 1.5, -0.3],
		});
		expect(Object.keys(rotations).sort()).toEqual(["lowerArm", "upperArm"]);
	});
});

describe("applyIKConstraint", () => {
	it("should clamp a hinge rotation into [minDeg, maxDeg]", () => {
		const over = applyIKConstraint(
			quatFromAxisAngle([0, 1, 0], (170 * Math.PI) / 180),
			{ type: "hinge", axis: [0, 1, 0], minDeg: 0, maxDeg: 150 },
		);
		expect(quatToAxisAngle(over).angle).toBeCloseTo((150 * Math.PI) / 180, 6);

		const under = applyIKConstraint(
			quatFromAxisAngle([0, 1, 0], (-20 * Math.PI) / 180),
			{ type: "hinge", axis: [0, 1, 0], minDeg: 0, maxDeg: 150 },
		);
		expect(quatToAxisAngle(under).angle).toBeCloseTo(0, 6);
	});

	it("should project off-axis rotation onto the hinge axis", () => {
		// A pure X rotation has no twist about the Y hinge — clamps to rest.
		const projected = applyIKConstraint(
			quatFromAxisAngle([1, 0, 0], Math.PI / 4),
			{ type: "hinge", axis: [0, 1, 0], minDeg: 0, maxDeg: 150 },
		);
		expect(quatToAxisAngle(projected).angle).toBeCloseTo(0, 6);
	});

	it("should shorten a ball rotation to its swing limit", () => {
		const clamped = applyIKConstraint(
			quatFromAxisAngle([1, 0, 0], (150 * Math.PI) / 180),
			{ type: "ball", maxAngleDeg: 90 },
		);
		expect(quatToAxisAngle(clamped).angle).toBeCloseTo(Math.PI / 2, 6);
	});
});

describe("solveLookAt", () => {
	const HEAD_RIG: IKRigData = {
		bones: [
			{ name: "hips", parent: null, restPosition: [0, 1, 0] },
			{ name: "head", parent: "hips", restPosition: [0, 0.7, 0] },
		],
	};

	it("should aim the bone's forward axis at the target", () => {
		const rotation = solveLookAt({
			rig: HEAD_RIG,
			pose: EMPTY_POSE,
			bone: "head",
			forward: [0, 0, 1],
			// Head sits at [0, 1.7, 0]; target due +X at head height.
			targetWorld: [5, 1.7, 0],
			maxAngleDeg: 120,
		});
		expect(rotation).not.toBeNull();
		const aimed = rotateVec3(rotation!, [0, 0, 1]);
		expect(aimed[0]).toBeCloseTo(1, 6);
		expect(aimed[2]).toBeCloseTo(0, 6);
	});

	it("should clamp the aim to the swing limit", () => {
		const rotation = solveLookAt({
			rig: HEAD_RIG,
			pose: EMPTY_POSE,
			bone: "head",
			forward: [0, 0, 1],
			targetWorld: [5, 1.7, 0],
			maxAngleDeg: 60,
		});
		expect(quatToAxisAngle(rotation!).angle).toBeCloseTo(Math.PI / 3, 6);
	});
});
