import { useMemo } from "react";
import { useTranslation } from "@/locales";

export function useBlendModeItems() {
	const t = useTranslation();
	return useMemo(
		() => [
			{ value: "normal", label: t("layerPanel.blendModes.normal") },
			{ value: "multiply", label: t("layerPanel.blendModes.multiply") },
			{ value: "screen", label: t("layerPanel.blendModes.screen") },
			{ value: "overlay", label: t("layerPanel.blendModes.overlay") },
			{ value: "darken", label: t("layerPanel.blendModes.darken") },
			{ value: "lighten", label: t("layerPanel.blendModes.lighten") },
			{
				value: "color-dodge",
				label: t("layerPanel.blendModes.color-dodge"),
			},
			{
				value: "color-burn",
				label: t("layerPanel.blendModes.color-burn"),
			},
			{
				value: "hard-light",
				label: t("layerPanel.blendModes.hard-light"),
			},
			{
				value: "soft-light",
				label: t("layerPanel.blendModes.soft-light"),
			},
			{
				value: "difference",
				label: t("layerPanel.blendModes.difference"),
			},
			{ value: "exclusion", label: t("layerPanel.blendModes.exclusion") },
			{ value: "hue", label: t("layerPanel.blendModes.hue") },
			{ value: "saturation", label: t("layerPanel.blendModes.saturation") },
			{ value: "color", label: t("layerPanel.blendModes.color") },
			{ value: "luminosity", label: t("layerPanel.blendModes.luminosity") },
		],
		[t],
	);
}
