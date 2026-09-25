import { describe, expect, it } from "vitest";
import type { ElementTransform, Reference3DCamera } from "../../schema";
import { composeTransforms } from "../../utils/geometry/geometry";
import {
	computePerspectiveGuides,
	guideSourceAffectedByDelta,
	type PerspectiveGuideData,
} from "./vanishingPoints";

const IDENTITY: ElementTransform = {
	x: 0,
	y: 0,
	rotation: 0,
	scaleX: 1,
	scaleY: 1,
};
const RECT = { cx: 0, cy: 0, width: 400, height: 300 };

/** Camera on the +Z axis looking straight down -Z (image plane = XY plane). */
const LOOK_DOWN_Z: Reference3DCamera = {
	projection: "perspective",
	position: [0, 1, 10],
	target: [0, 1, 0],
	fovDeg: 90,
};

function guidesFor(
	camera: Reference3DCamera,
	transform: ElementTransform = IDENTITY,
): PerspectiveGuideData {
	return computePerspectiveGuides({
		elementId: "reference3d-el",
		camera,
		localRect: RECT,
		transform,
	});
}

function axisOf(guides: PerspectiveGuideData, axis: "x" | "y" | "z") {
	return guides.axes.find((a) => a.axis === axis);
}

describe("computePerspectiveGuides", () => {
	it("should treat screen-parallel axes as infinite directions and the view axis as a finite center VP", () => {
		const guides = guidesFor(LOOK_DOWN_Z);

		const x = axisOf(guides, "x")!;
		expect(x.kind).toBe("infinite");
		if (x.kind === "infinite") {
			expect(x.direction.x).toBeCloseTo(1, 9);
			expect(x.direction.y).toBeCloseTo(0, 9);
		}

		const y = axisOf(guides, "y")!;
		expect(y.kind).toBe("infinite");
		if (y.kind === "infinite") {
			expect(y.direction.x).toBeCloseTo(0, 9);
			expect(y.direction.y).toBeCloseTo(1, 9);
		}

		// Lines parallel to the viewing axis converge at the principal point.
		const z = axisOf(guides, "z")!;
		expect(z.kind).toBe("finite");
		if (z.kind === "finite") {
			expect(z.point.x).toBeCloseTo(0, 9);
			expect(z.point.y).toBeCloseTo(0, 9);
		}
	});

	it("should derive the horizon from one finite and one infinite ground axis", () => {
		const guides = guidesFor(LOOK_DOWN_Z);

		expect(guides.horizon).not.toBeNull();
		expect(guides.horizon!.point.x).toBeCloseTo(0, 9);
		expect(guides.horizon!.point.y).toBeCloseTo(0, 9);
		expect(guides.horizon!.direction.x).toBeCloseTo(1, 9);
		expect(guides.horizon!.direction.y).toBeCloseTo(0, 9);
	});

	it("should produce two finite ground VPs and a horizon through them for an oblique camera", () => {
		const guides = guidesFor({
			projection: "perspective",
			position: [4, 3, 6],
			target: [0, 1, 0],
			fovDeg: 50,
		});

		const x = axisOf(guides, "x")!;
		const z = axisOf(guides, "z")!;
		expect(x.kind).toBe("finite");
		expect(z.kind).toBe("finite");
		if (x.kind !== "finite" || z.kind !== "finite") return;

		const horizon = guides.horizon!;
		expect(horizon).not.toBeNull();
		// Horizon passes through the X VP toward the Z VP (unit direction).
		expect(horizon.point).toEqual(x.point);
		const dx = z.point.x - x.point.x;
		const dy = z.point.y - x.point.y;
		const len = Math.hypot(dx, dy);
		expect(horizon.direction.x).toBeCloseTo(dx / len, 9);
		expect(horizon.direction.y).toBeCloseTo(dy / len, 9);
	});

	it("should return only infinite directions under an orthographic camera", () => {
		const guides = guidesFor({
			projection: "orthographic",
			position: [4, 3, 6],
			target: [0, 1, 0],
			fovDeg: 50,
			orthoHeight: 5,
		});

		expect(guides.axes).toHaveLength(3);
		for (const axis of guides.axes) {
			expect(axis.kind).toBe("infinite");
			if (axis.kind === "infinite") {
				expect(Math.hypot(axis.direction.x, axis.direction.y)).toBeCloseTo(
					1,
					9,
				);
			}
		}
	});

	it("should omit an orthographic axis pointing along the view axis (no direction)", () => {
		const guides = guidesFor({
			projection: "orthographic",
			position: [0, 1, 10],
			target: [0, 1, 0],
			fovDeg: 50,
			orthoHeight: 5,
		});

		expect(axisOf(guides, "z")).toBeUndefined();
		expect(axisOf(guides, "x")?.kind).toBe("infinite");
		expect(axisOf(guides, "y")?.kind).toBe("infinite");
	});

	it("should map guides through the element transform (translation moves finite VPs)", () => {
		const guides = guidesFor(LOOK_DOWN_Z, {
			x: 50,
			y: 20,
			rotation: 0,
			scaleX: 1,
			scaleY: 1,
		});

		const z = axisOf(guides, "z")!;
		expect(z.kind).toBe("finite");
		if (z.kind === "finite") {
			expect(z.point.x).toBeCloseTo(50, 9);
			expect(z.point.y).toBeCloseTo(20, 9);
		}
	});

	it("should rotate infinite directions with the element (90° rotated element)", () => {
		const guides = guidesFor(LOOK_DOWN_Z, {
			x: 0,
			y: 0,
			rotation: Math.PI / 2,
			scaleX: 1,
			scaleY: 1,
		});

		const x = axisOf(guides, "x")!;
		expect(x.kind).toBe("infinite");
		if (x.kind === "infinite") {
			expect(x.direction.x).toBeCloseTo(0, 9);
			expect(x.direction.y).toBeCloseTo(1, 9);
		}

		const y = axisOf(guides, "y")!;
		expect(y.kind).toBe("infinite");
		if (y.kind === "infinite") {
			expect(y.direction.x).toBeCloseTo(-1, 9);
			expect(y.direction.y).toBeCloseTo(0, 9);
		}
	});
});

describe("guideSourceAffectedByDelta", () => {
	// Parent chain: reference3d-el → group-1 → group-outer.
	const parentOf = (id: string): string | null =>
		id === "reference3d-el"
			? "group-1"
			: id === "group-1"
				? "group-outer"
				: null;

	it("should refresh when an ancestor group moves, and the recomputed VP follows the group", () => {
		// A delta updating only the ancestor group must invalidate the guides…
		const delta = {
			updated: new Map<string, unknown>([["group-1", {}]]),
			deleted: new Set<string>(),
		};
		expect(guideSourceAffectedByDelta("reference3d-el", delta, parentOf)).toBe(
			true,
		);

		// …and recomputing with the moved group's transform composed in
		// carries the finite vanishing point along with it.
		const groupMove: ElementTransform = {
			x: 100,
			y: 40,
			rotation: 0,
			scaleX: 1,
			scaleY: 1,
		};
		const before = axisOf(guidesFor(LOOK_DOWN_Z, IDENTITY), "z")!;
		const after = axisOf(
			guidesFor(LOOK_DOWN_Z, composeTransforms(groupMove, IDENTITY)),
			"z",
		)!;
		expect(before.kind).toBe("finite");
		expect(after.kind).toBe("finite");
		if (before.kind !== "finite" || after.kind !== "finite") return;
		expect(after.point.x).toBeCloseTo(before.point.x + 100, 9);
		expect(after.point.y).toBeCloseTo(before.point.y + 40, 9);
	});

	it("should detect changes across deeper ancestor levels and direct source edits", () => {
		const outerDelta = {
			updated: new Map<string, unknown>([["group-outer", {}]]),
			deleted: new Set<string>(),
		};
		expect(
			guideSourceAffectedByDelta("reference3d-el", outerDelta, parentOf),
		).toBe(true);

		const selfDelta = {
			updated: new Map<string, unknown>([["reference3d-el", {}]]),
			deleted: new Set<string>(),
		};
		expect(
			guideSourceAffectedByDelta("reference3d-el", selfDelta, parentOf),
		).toBe(true);
	});

	it("should ignore deltas that touch neither the source nor its ancestors", () => {
		const delta = {
			updated: new Map<string, unknown>([["unrelated-path", {}]]),
			deleted: new Set<string>(["another-el"]),
		};
		expect(guideSourceAffectedByDelta("reference3d-el", delta, parentOf)).toBe(
			false,
		);
	});
});
