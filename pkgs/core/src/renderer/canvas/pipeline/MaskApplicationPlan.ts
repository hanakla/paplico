import { neverReached } from "../../../utils/lang";
import type { SurfacePlacement } from "./RenderSurface";

export interface PlannedMask {
	key: string;
	coverage: SurfacePlacement;
	inverted: boolean;
}

type NonEmptyMaskStack = readonly [PlannedMask, ...PlannedMask[]];

export type MaskApplicationPlan =
	| { kind: "none" }
	| { kind: "inline-leaf"; mask: PlannedMask }
	| { kind: "subtree-composite"; masks: NonEmptyMaskStack };

interface MaskApplicationFacts {
	node: "leaf" | "subtree";
	masks: readonly PlannedMask[];
	outputPlacement: SurfacePlacement["kind"];
	hasPostFilter: boolean;
	requiresSubtreeBoundary: boolean;
	/** A subtree whose children draw straight onto the target (a passthrough
	 *  group, or a clip group drawn through its effective mask). Its children
	 *  carry their own inline masks, so the subtree itself needs no plan. */
	inlineContainer?: boolean;
}

type GroupIsolationReason = "mask" | "clip" | "opacity" | "filter";

export type GroupCompositionPlan =
	| { kind: "passthrough" }
	| { kind: "isolated"; reasons: readonly GroupIsolationReason[] }
	| {
			kind: "backdrop-dependent";
			reasons: readonly GroupIsolationReason[];
	  };

export interface GroupCompositionFacts {
	hasOwnMask: boolean;
	hasOwnClip: boolean;
	hasOpacity: boolean;
	hasFilter: boolean;
	dependsOnBackdrop: boolean;
}

export function planMaskApplication(
	facts: MaskApplicationFacts,
): MaskApplicationPlan {
	if (facts.masks.length === 0) return { kind: "none" };
	if (
		facts.node === "subtree" &&
		facts.inlineContainer &&
		!facts.hasPostFilter &&
		!facts.requiresSubtreeBoundary
	) {
		return { kind: "none" };
	}

	const [firstMask] = facts.masks;
	if (
		facts.node === "leaf" &&
		facts.masks.length === 1 &&
		firstMask.coverage.kind === "world-aabb" &&
		facts.outputPlacement === "world-aabb" &&
		!facts.hasPostFilter &&
		!facts.requiresSubtreeBoundary
	) {
		return { kind: "inline-leaf", mask: firstMask };
	}

	return {
		kind: "subtree-composite",
		masks: facts.masks as NonEmptyMaskStack,
	};
}

export function planGroupComposition(
	facts: GroupCompositionFacts,
): GroupCompositionPlan {
	const reasons: GroupIsolationReason[] = [];
	if (facts.hasOwnMask) reasons.push("mask");
	if (facts.hasOwnClip) reasons.push("clip");
	if (facts.hasOpacity) reasons.push("opacity");
	if (facts.hasFilter) reasons.push("filter");

	if (facts.dependsOnBackdrop) {
		return { kind: "backdrop-dependent", reasons };
	}
	if (reasons.length > 0) return { kind: "isolated", reasons };
	return { kind: "passthrough" };
}

export function maskPlanRequiresSurface(plan: MaskApplicationPlan): boolean {
	switch (plan.kind) {
		case "none":
		case "inline-leaf":
			return false;
		case "subtree-composite":
			return true;
		default:
			return neverReached(plan, "unhandled mask application plan");
	}
}

export function groupPlanRequiresSurface(plan: GroupCompositionPlan): boolean {
	switch (plan.kind) {
		case "passthrough":
			return false;
		case "isolated":
		case "backdrop-dependent":
			return true;
		default:
			return neverReached(plan, "unhandled group composition plan");
	}
}

export function groupPlanNeedsBackdrop(plan: GroupCompositionPlan): boolean {
	switch (plan.kind) {
		case "passthrough":
		case "isolated":
			return false;
		case "backdrop-dependent":
			return true;
		default:
			return neverReached(plan, "unhandled group composition plan");
	}
}
