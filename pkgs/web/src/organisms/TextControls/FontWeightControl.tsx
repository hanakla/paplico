import { useEffect, useMemo } from "react";
import { Select } from "@/components/Select";
import { usePaplico } from "@/contexts/PaplicoContext";
import {
	useActiveFontSettings,
	useFontList,
} from "@/hooks/useCurrentFontSetting";
import { useTranslation } from "@/locales";
import { buildFontSource } from "@/utils/font";
import { FontVariationAxisControl } from "./FontVariationAxisControl";

export function FontWeightControl({
	showLabel = true,
}: {
	showLabel?: boolean;
}) {
	const t = useTranslation();
	const manager = usePaplico().fonts;
	const { currentFont, currentFontWeight, fontFaces, handleFontWeightChange } =
		useActiveFontSettings();
	const { loadedVersion } = useFontList(manager);
	// biome-ignore lint/correctness/useExhaustiveDependencies: loadedVersion refreshes axes after the font is parsed.
	const axis = useMemo(
		() =>
			currentFont
				? manager.getVariationAxes(buildFontSource(currentFont))?.wght
				: undefined,
		[currentFont, manager, loadedVersion],
	);

	useEffect(() => {
		if (!currentFont) return;
		const source = buildFontSource(currentFont);
		if (manager.getVariationAxes(source) !== undefined) return;
		void manager.loadFont(source).catch(() => null);
	}, [currentFont, manager]);

	if (axis) {
		return (
			<FontVariationAxisControl
				tag="wght"
				axis={axis}
				value={currentFontWeight}
				label={t("actionsPanel.weight")}
				showLabel={showLabel}
				onChange={(value) => handleFontWeightChange(value ?? axis.default)}
			/>
		);
	}

	return (
		<div className="flex flex-col gap-1.5">
			{showLabel && (
				<span className="type-section text-muted-foreground">
					{t("actionsPanel.weight")}
				</span>
			)}
			<Select.Root
				items={fontFaces.map((font) => ({
					value: font.fontId,
					label: font.style,
				}))}
				value={
					currentFontWeight === undefined ? null : (currentFont?.fontId ?? null)
				}
				onValueChange={(value) => {
					const face = fontFaces.find((font) => font.fontId === value);
					if (face) handleFontWeightChange(face.weight, face);
				}}
				disabled={fontFaces.length === 0}
			>
				<Select.Trigger $size="xs" aria-label={t("actionsPanel.weight")}>
					<Select.Value placeholder={t("actionsPanel.mixed")} />
					<Select.Icon />
				</Select.Trigger>
				<Select.Portal>
					<Select.Positioner>
						<Select.Popup>
							{fontFaces.map((font) => (
								<Select.Item key={font.fontId} value={font.fontId} $size="xs">
									<Select.ItemIndicator $size="xs" />
									<Select.ItemText className="col-start-2">
										{font.style}
									</Select.ItemText>
								</Select.Item>
							))}
						</Select.Popup>
					</Select.Positioner>
				</Select.Portal>
			</Select.Root>
		</div>
	);
}
