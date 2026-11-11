import { useMemo } from "react";
import { useTranslation } from "@/locales";

export function useCompositionModeItems() {
	const t = useTranslation();
	return useMemo(
		() => [
			{ value: "normal", label: t("filterPanel.compositionModes.normal") },
			{
				value: "alpha-lock",
				label: t("filterPanel.compositionModes.alpha-lock"),
			},
			{
				value: "knockout",
				label: t("filterPanel.compositionModes.knockout"),
			},
		],
		[t],
	);
}
