import { describe, expect, it } from "vitest";
import type { VRMPoseData } from "../../schema";
import { quatFromAxisAngle } from "./ikSolver";
import { sparsifyPose, toThreeVrmPose } from "./pose";
import { PRESET_POSES } from "./presetPoses";

describe("sparsifyPose", () => {
	it("should drop near-identity rotations (both quaternion signs) and zero hips", () => {
		const pose: VRMPoseData = {
			bones: {
				spine: [0, 0, 0, 1],
				neck: [0.00001, 0, 0, -0.99999],
				leftUpperArm: quatFromAxisAngle([0, 0, 1], Math.PI / 4),
			},
			hipsPosition: [0, 0.0000001, 0],
		};

		const sparse = sparsifyPose(pose);

		expect(Object.keys(sparse.bones)).toEqual(["leftUpperArm"]);
		expect(sparse.hipsPosition).toBeUndefined();
	});

	it("should keep meaningful hips offsets", () => {
		const sparse = sparsifyPose({ bones: {}, hipsPosition: [0, -0.4, 0] });
		expect(sparse.hipsPosition).toEqual([0, -0.4, 0]);
	});
});

describe("toThreeVrmPose", () => {
	it("should map bone rotations and the hips position into three-vrm's shape", () => {
		const rotation = quatFromAxisAngle([1, 0, 0], Math.PI / 6);
		const result = toThreeVrmPose({
			bones: { leftUpperLeg: rotation },
			hipsPosition: [0, -0.2, 0.1],
		});

		expect(result.leftUpperLeg?.rotation).toEqual(rotation);
		expect(result.hips?.position).toEqual([0, -0.2, 0.1]);
	});

	it("should round-trip through sparsify without losing posed bones", () => {
		const pose = PRESET_POSES.find((p) => p.id === "sit")!.pose;
		const sparse = sparsifyPose(pose);
		const converted = toThreeVrmPose(sparse);

		for (const bone of Object.keys(pose.bones)) {
			expect(converted[bone]?.rotation).toEqual(pose.bones[bone]);
		}
		expect(converted.hips?.position).toEqual(pose.hipsPosition);
	});
});

describe("PRESET_POSES", () => {
	it("should provide the five atari poses with unique ids", () => {
		expect(PRESET_POSES.map((p) => p.id)).toEqual([
			"stand",
			"walk",
			"run",
			"sit",
			"crouch",
		]);
	});

	it("should contain only unit quaternions (valid rest-relative rotations)", () => {
		for (const preset of PRESET_POSES) {
			for (const [bone, q] of Object.entries(preset.pose.bones)) {
				const length = Math.hypot(q[0], q[1], q[2], q[3]);
				expect.soft(length, `${preset.id}/${bone}`).toBeCloseTo(1, 6);
			}
		}
	});
});
