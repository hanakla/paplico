import { Layers2 } from "lucide-react";
import { memo } from "react";
import { IconButton } from "@/components/IconButton";
import { Tooltip } from "@/components/Tooltip";
import { usePaplico } from "@/contexts/PaplicoContext";
import type { Filter } from "@/core/schema";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";

/**
 * Common "apply to layers below" toggle shown at the top-left of a filter's
 * settings. Reroutes the filter's postProcess onto the captured backdrop
 * (masked to the element shape). Renders nothing when the flag has no effect
 * for this filter (geometry/appearance filters, render-replacing ones, and
 * always-backdrop handlers).
 */
export const FilterBackdropToggle = memo(function FilterBackdropToggle({
	filter,
	filterIndex,
}: {
	filter: Filter;
	filterIndex: number;
}) {
	const paplico = usePaplico();
	const t = useTranslation();

	const handleToggle = useEventCallback(() => {
		paplico.commands.updateFilterForSelectedElement(filterIndex, {
			applyToBackdrop: !(filter.applyToBackdrop ?? false),
		});
	});

	if (!paplico.canApplyFilterToBackdrop(filter)) return null;

	return (
		<div className="flex items-center">
			<Tooltip content={t("filterPanel.applyToBackdrop")}>
				<IconButton
					$size="xs"
					$variant="ghost"
					$pressed={filter.applyToBackdrop ?? false}
					aria-label={t("filterPanel.applyToBackdrop")}
					onClick={handleToggle}
				>
					<Layers2 size={12} />
				</IconButton>
			</Tooltip>
		</div>
	);
});
