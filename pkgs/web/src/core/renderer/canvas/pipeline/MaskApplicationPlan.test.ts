import type { BoundingBox } from "../../../schema";
import {
	type GroupCompositionFacts,
	groupPlanNeedsBackdrop,
	groupPlanRequiresSurface,
	maskPlanRequiresSurface,
	type PlannedMask,
	planGroupComposition,
	planMaskApplication,
} from "./MaskApplicationPlan";
import type { SurfacePlacement } from "./RenderSurface";

describe("planGroupComposition", () => {
	it("passes through a Group with no compositing effect", () => {
		const plan = planGroupComposition(groupFacts());

		expect(plan).toEqual({ kind: "passthrough" });
		expect(groupPlanRequiresSurface(plan)).toBe(false);
	});

	it("isolates a normal Group with its own mask", () => {
		const plan = planGroupComposition(groupFacts({ hasOwnMask: true }));

		expect(plan).toEqual({ kind: "isolated", reasons: ["mask"] });
		expect(groupPlanRequiresSurface(plan)).toBe(true);
	});

	it.each([
		["clip", { hasOwnClip: true }],
		["opacity", { hasOpacity: true }],
		["filter", { hasFilter: true }],
	] as const)("isolates a Group with its own %s", (_, effect) => {
		expect(planGroupComposition(groupFacts(effect))).toMatchObject({
			kind: "isolated",
		});
	});

	it("gives backdrop dependency precedence over isolation", () => {
		const plan = planGroupComposition(
			groupFacts({
				hasOwnMask: true,
				hasFilter: true,
				dependsOnBackdrop: true,
			}),
		);

		expect(plan).toEqual({
			kind: "backdrop-dependent",
			reasons: ["mask", "filter"],
		});
		expect(groupPlanNeedsBackdrop(plan)).toBe(true);
	});
});

describe("planMaskApplication", () => {
	it("returns none without a mask", () => {
		expect(
			planMaskApplication({
				node: "leaf",
				masks: [],
				outputPlacement: "world-aabb",
				hasPostFilter: false,
				requiresSubtreeBoundary: false,
			}),
		).toEqual({ kind: "none" });
	});

	it("uses the inline path only for one AABB mask on an eligible leaf", () => {
		const plan = planMaskApplication({
			node: "leaf",
			masks: [mask("own")],
			outputPlacement: "world-aabb",
			hasPostFilter: false,
			requiresSubtreeBoundary: false,
		});

		expect(plan).toEqual({ kind: "inline-leaf", mask: mask("own") });
		expect(maskPlanRequiresSurface(plan)).toBe(false);
	});

	it("preserves nested masks in outer-to-inner order", () => {
		const outer = mask("outer");
		const own = mask("own");
		const plan = planMaskApplication({
			node: "leaf",
			masks: [outer, own],
			outputPlacement: "world-aabb",
			hasPostFilter: false,
			requiresSubtreeBoundary: false,
		});

		expect(plan).toEqual({
			kind: "subtree-composite",
			masks: [outer, own],
		});
		expect(maskPlanRequiresSurface(plan)).toBe(true);
	});

	it.each([
		{
			name: "quad output",
			outputPlacement: "world-quad" as const,
			hasPostFilter: false,
		},
		{
			name: "post-filter",
			outputPlacement: "world-aabb" as const,
			hasPostFilter: true,
		},
	])("falls back to subtree compositing for $name", (facts) => {
		expect(
			planMaskApplication({
				node: "leaf",
				masks: [mask("own")],
				outputPlacement: facts.outputPlacement,
				hasPostFilter: facts.hasPostFilter,
				requiresSubtreeBoundary: false,
			}),
		).toMatchObject({ kind: "subtree-composite" });
	});

	it("needs no plan for a group that draws its children inline", () => {
		const plan = planMaskApplication({
			node: "subtree",
			masks: [mask("outer")],
			outputPlacement: "world-aabb",
			hasPostFilter: false,
			requiresSubtreeBoundary: false,
			inlineContainer: true,
		});

		expect(plan).toEqual({ kind: "none" });
		expect(maskPlanRequiresSurface(plan)).toBe(false);
	});

	it("uses subtree compositing for a Group boundary", () => {
		expect(
			planMaskApplication({
				node: "subtree",
				masks: [mask("own")],
				outputPlacement: "world-aabb",
				hasPostFilter: false,
				requiresSubtreeBoundary: true,
			}),
		).toMatchObject({ kind: "subtree-composite" });
	});

	it("preserves a three-level clip stack from outermost to innermost", () => {
		const plan = planMaskApplication({
			node: "subtree",
			masks: [mask("outer"), mask("middle"), mask("inner")],
			outputPlacement: "world-aabb",
			hasPostFilter: false,
			requiresSubtreeBoundary: true,
		});

		expect(plan).toMatchObject({
			kind: "subtree-composite",
			masks: [{ key: "outer" }, { key: "middle" }, { key: "inner" }],
		});
	});

	it("keeps a Group own mask after its inherited clip stack", () => {
		const plan = planMaskApplication({
			node: "subtree",
			masks: [mask("outer-clip"), mask("inner-clip"), mask("own-mask")],
			outputPlacement: "world-aabb",
			hasPostFilter: false,
			requiresSubtreeBoundary: true,
		});

		expect(plan).toMatchObject({
			kind: "subtree-composite",
			masks: [
				{ key: "outer-clip" },
				{ key: "inner-clip" },
				{ key: "own-mask" },
			],
		});
	});

	it.each([
		["quad output", { outputPlacement: "world-quad" as const }],
		["post-filter output", { hasPostFilter: true }],
	])("falls back to a subtree surface for %s", (_, override) => {
		expect(
			planMaskApplication({
				node: "leaf",
				masks: [mask("own")],
				outputPlacement: "world-aabb",
				hasPostFilter: false,
				requiresSubtreeBoundary: false,
				...override,
			}),
		).toMatchObject({ kind: "subtree-composite" });
	});

	it("keeps every mask on a glass route before final placement", () => {
		const masks = [mask("clip"), mask("object")];
		const groupPlan = planGroupComposition(
			groupFacts({ hasOwnMask: true, dependsOnBackdrop: true }),
		);
		const maskPlan = planMaskApplication({
			node: "subtree",
			masks,
			outputPlacement: "world-quad",
			hasPostFilter: false,
			requiresSubtreeBoundary: true,
		});

		expect(groupPlan.kind).toBe("backdrop-dependent");
		expect(maskPlan).toMatchObject({
			kind: "subtree-composite",
			masks: [{ key: "clip" }, { key: "object" }],
		});
	});

	it("keeps the complete outer stack for a nested clip result", () => {
		const plan = planMaskApplication({
			node: "subtree",
			masks: [mask("outer-a"), mask("outer-b")],
			outputPlacement: "world-aabb",
			hasPostFilter: false,
			requiresSubtreeBoundary: true,
		});

		expect(plan).toMatchObject({
			kind: "subtree-composite",
			masks: [{ key: "outer-a" }, { key: "outer-b" }],
		});
	});
});

function groupFacts(
	overrides: Partial<GroupCompositionFacts> = {},
): GroupCompositionFacts {
	return {
		hasOwnMask: false,
		hasOwnClip: false,
		hasOpacity: false,
		hasFilter: false,
		dependsOnBackdrop: false,
		...overrides,
	};
}

function mask(key: string): PlannedMask {
	return {
		key,
		coverage: placement(),
		inverted: false,
	};
}

function placement(): Extract<SurfacePlacement, { kind: "world-aabb" }> {
	return {
		kind: "world-aabb",
		bounds: box(0, 0, 100, 100),
		uvRect: { minU: 0, minV: 0, maxU: 1, maxV: 1 },
	};
}

function box(
	minX: number,
	minY: number,
	maxX: number,
	maxY: number,
): BoundingBox {
	return {
		minX,
		minY,
		maxX,
		maxY,
		width: maxX - minX,
		height: maxY - minY,
	};
}
