import type { FilterEntry } from "@paplico/core/schema";
import { getGradientFills, getGradientTargetFill } from "@paplico/core/utils";
import { useSnapshot } from "valtio";
import { ColorSwatch } from "@/components/ColorSwatch";
import { IconButton } from "@/components/IconButton";
import { Separator } from "@/components/Separator";
import { Tooltip } from "@/components/Tooltip";
import { usePaplico } from "@/contexts/PaplicoContext";
import { useTranslation } from "@/locales";

/**
 * Chooses which gradient fill of the single selected element the gradient
 * tool edits. Shown only when the element carries more than one.
 */
export function GradientTargetFillActions() {
	const t = useTranslation();
	const paplico = usePaplico();
	const snap = useSnapshot(paplico.uiState);
	const toolSnap = useSnapshot(paplico.tools.state);

	const filters = snap.document.objects[snap.selectedElementIds[0]]?.filters as
		| FilterEntry[]
		| undefined;
	const fills = getGradientFills(filters);
	if (fills.length < 2) return null;

	const targetUid = getGradientTargetFill(
		filters,
		toolSnap.gradientTargetFillUid,
	)?.uid;

	return (
		<>
			{fills.map((fillApp) => (
				<Tooltip
					key={fillApp.uid}
					content={t("contextActions.gradientTargetFill")}
					side="bottom"
				>
					<IconButton
						$size="md"
						$variant="ghost"
						$pressed={fillApp.uid === targetUid}
						className="text-foreground"
						onClick={() => paplico.gradientSetTargetFill(fillApp.uid)}
					>
						<ColorSwatch
							color={fillApp.paramData.params.fill}
							variant="fill"
							size={20}
						/>
					</IconButton>
				</Tooltip>
			))}
			<Separator orientation="vertical" className="mx-0.5 h-5" />
		</>
	);
}
