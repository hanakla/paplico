import { useSnapshot } from "valtio";
import type { Paplico } from "@/core/Paplico";
import { uiState } from "@/stores/uiStore";
import { useEventCallback } from "@/utils/hooks";

type CanvasTargetResolver = Pick<
	Paplico,
	"getCanvasTarget" | "getPrimaryTarget"
>;

export function useCurrentCanvasTargetResolver(): {
	getCurrentCanvasTarget: (
		paplico: Paplico,
	) => ReturnType<Paplico["getPrimaryTarget"]>;
} {
	const { currentTargetId } = useSnapshot(uiState);
	const getCurrentCanvasTarget = useEventCallback((paplico: Paplico) => {
		return resolveCurrentCanvasTarget(paplico, currentTargetId);
	});

	return { getCurrentCanvasTarget };
}

function resolveCurrentCanvasTarget(
	paplico: CanvasTargetResolver,
	currentTargetId: string | null,
): ReturnType<Paplico["getPrimaryTarget"]> {
	const currentTarget = currentTargetId
		? paplico.getCanvasTarget(currentTargetId)
		: null;
	return currentTarget ?? paplico.getPrimaryTarget();
}
