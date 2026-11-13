import { Ellipsis } from "lucide-react";
import { useEffect, useState } from "react";
import { subscribe } from "valtio";
import { IconButton } from "@/components/IconButton";
import { Popover } from "@/components/Popover";
import { Tooltip } from "@/components/Tooltip";
import { usePaplico } from "@/contexts/PaplicoContext";
import { useTranslation } from "@/locales";
import { FontVariationAxisControl } from "@/organisms/TextControls/FontVariationAxisControl";
import { FontWeightControl } from "@/organisms/TextControls/FontWeightControl";
import { uiState } from "@/stores/uiStore";
import { useEventCallback } from "@/utils/hooks";

export function FontVariationPopover() {
	const t = useTranslation();
	const paplico = usePaplico();
	const manager = paplico.fonts;
	const [open, setOpen] = useState(false);
	const [, refresh] = useState(0);
	const [loadError, setLoadError] = useState(false);
	const tool = paplico.textToolController?.getTextTool();
	const selection = tool?.getSelectionFontVariations();
	const source = selection?.fontSource;
	const axes = source ? manager.getVariationAxes(source) : undefined;
	const sourceKey = JSON.stringify(source);

	useEffect(() => {
		if (!open) return;
		// Selection summaries can stay mixed while individual coordinates change.
		return subscribe(uiState.textEditState, () =>
			refresh((version) => version + 1),
		);
	}, [open]);

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
				if (!active) return;
				setLoadError(!font);
				refresh((version) => version + 1);
			})
			.catch(() => {
				if (active) setLoadError(true);
			});
		return () => {
			active = false;
		};
	}, [open, sourceKey, manager]);

	const changeAxis = useEventCallback((tag: string, value: number | null) => {
		tool?.changeSelectionFontVariation(tag, value);
		refresh((version) => version + 1);
	});

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
								.map(
									([tag, axis]) =>
										axis && (
											<FontVariationAxisControl
												key={`${sourceKey}:${tag}`}
												tag={tag}
												axis={axis}
												value={selection?.values[tag]}
												onChange={(value) => changeAxis(tag, value)}
											/>
										),
								)
						)}
					</div>
				</fieldset>
			</Popover.Content>
		</Popover.Root>
	);
}
