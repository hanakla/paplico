import type { TextStyle } from "@paplico/core/schema";
import { Ellipsis } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useSnapshot } from "valtio";
import { IconButton } from "@/components/IconButton";
import { Popover } from "@/components/Popover";
import { Tooltip } from "@/components/Tooltip";
import { usePaplico } from "@/contexts/PaplicoContext";
import { useFontList } from "@/hooks/useCurrentFontSetting";
import { useTranslation } from "@/locales";
import { FontVariationAxisControl } from "@/organisms/TextControls/FontVariationAxisControl";
import { FontWeightControl } from "@/organisms/TextControls/FontWeightControl";
import { uiState } from "@/stores/uiStore";

export function FontVariationPopover({
	textStyles,
	onVariationChange,
}: {
	textStyles?: readonly TextStyle[];
	onVariationChange?: (tag: string, value: number | null) => void;
}) {
	const t = useTranslation();
	const paplico = usePaplico();
	const manager = paplico.fonts;
	const [open, setOpen] = useState(false);
	const [loadError, setLoadError] = useState(false);
	const selection = useSnapshot(uiState).textEditState.selectionStyle;
	const { loadedVersion } = useFontList(manager);
	const fontSource = selection?.style.fontSource;
	const selectedSource = textStyles?.[0]?.fontSource;
	const source = textStyles
		? textStyles.every(
				(style) =>
					JSON.stringify(style.fontSource) === JSON.stringify(selectedSource),
			)
			? selectedSource
			: undefined
		: fontSource && !fontSource.mixed
			? fontSource.value
			: undefined;
	const sourceKey = JSON.stringify(source);
	// biome-ignore lint/correctness/useExhaustiveDependencies: loadedVersion refreshes axes after the font is parsed.
	const axes = useMemo(
		() => (source ? manager.getVariationAxes(source) : undefined),
		[source, manager, loadedVersion],
	);

	useEffect(() => {
		if (!open || !sourceKey) return;
		const fontSource = JSON.parse(sourceKey) as NonNullable<typeof source>;
		if (!fontSource) return;
		let active = true;
		setLoadError(false);
		if (manager.getVariationAxes(fontSource) !== undefined) return;
		void manager
			.loadFont(fontSource)
			.then((font) => {
				if (active) setLoadError(!font);
			})
			.catch(() => {
				if (active) setLoadError(true);
			});
		return () => {
			active = false;
		};
	}, [open, sourceKey, manager]);

	return (
		<Popover.Root open={open} onOpenChange={setOpen}>
			<Tooltip content={t("contextActions.variableFont")} side="bottom">
				<Popover.Trigger>
					<IconButton
						$size="md"
						$variant="ghost"
						aria-label={t("contextActions.variableFont")}
					>
						<Ellipsis size={18} />
					</IconButton>
				</Popover.Trigger>
			</Tooltip>
			<Popover.Content
				side="top"
				sideOffset={12}
				positionMethod="absolute"
				className="w-72 p-2"
			>
				<fieldset
					data-context-actions-popover
					aria-label={t("contextActions.variableFont")}
					className="max-h-[min(24rem,var(--available-height,100dvh)-3rem)] overflow-y-auto"
					onKeyDown={(event) => {
						event.stopPropagation();
						if (event.key === "Escape") {
							event.preventDefault();
							setOpen(false);
						}
					}}
				>
					<div className="flex flex-col gap-3 p-1">
						<FontWeightControl />
						{!source ? (
							<p className="text-xs text-muted-foreground">
								{t("contextActions.variableFontMixed")}
							</p>
						) : loadError ? (
							<p className="text-xs text-muted-foreground">
								{t("contextActions.variableFontLoadError")}
							</p>
						) : !axes ? (
							<p className="text-xs text-muted-foreground">
								{t("actionsPanel.loading")}
							</p>
						) : (
							Object.entries(axes)
								.filter(([tag]) => tag !== "wght")
								.map(([tag, axis]) => {
									const values = textStyles?.map(
										(style) =>
											style.fontVariationSettings?.[tag] ?? axis?.default,
									);
									const current = values
										? values.every((value) => value === values[0])
											? { mixed: false as const, value: values[0] }
											: { mixed: true as const }
										: selection?.fontVariations[tag];
									return (
										axis && (
											<FontVariationAxisControl
												key={`${sourceKey}:${tag}`}
												tag={tag}
												axis={axis}
												value={
													current && !current.mixed ? current.value : undefined
												}
												onChange={(value) => {
													if (onVariationChange) onVariationChange(tag, value);
													else
														paplico.textToolController
															?.getTextTool()
															?.changeSelectionFontVariation(tag, value);
												}}
											/>
										)
									);
								})
						)}
					</div>
				</fieldset>
			</Popover.Content>
		</Popover.Root>
	);
}
