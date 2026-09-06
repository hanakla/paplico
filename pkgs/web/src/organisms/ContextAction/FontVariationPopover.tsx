import type { Font } from "fontkit";
import { Ellipsis, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import { subscribe } from "valtio";
import { IconButton } from "@/components/IconButton";
import { Input } from "@/components/Input";
import { Popover } from "@/components/Popover";
import { Slider } from "@/components/Slider";
import { Tooltip } from "@/components/Tooltip";
import { usePaplico } from "@/contexts/PaplicoContext";
import { getFontManager } from "@/core/typography/fonts/FontManager";
import { useTranslation } from "@/locales";
import { uiState } from "@/stores/uiStore";
import { useEventCallback } from "@/utils/hooks";

export function FontVariationPopover() {
	const t = useTranslation();
	const paplico = usePaplico();
	const manager = getFontManager();
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
				className="w-72"
			>
				<fieldset
					data-context-actions-popover
					aria-label={t("contextActions.variableFont")}
					className="flex max-h-[min(24rem,var(--available-height,100dvh)-3rem)] flex-col gap-3 overflow-y-auto"
					onKeyDown={(event) => {
						event.stopPropagation();
						if (event.key === "Escape") {
							event.preventDefault();
							setOpen(false);
						}
					}}
				>
					<span className="text-xs font-medium">
						{t("contextActions.variableFont")}
					</span>
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
					) : Object.keys(axes).length === 0 ? (
						<p className="text-xs text-muted-foreground">
							{t("contextActions.variableFontNone")}
						</p>
					) : (
						Object.entries(axes).map(
							([tag, axis]) =>
								axis && (
									<VariationAxisControl
										key={`${sourceKey}:${tag}`}
										tag={tag}
										axis={axis}
										value={selection?.values[tag]}
										onChange={changeAxis}
									/>
								),
						)
					)}
				</fieldset>
			</Popover.Content>
		</Popover.Root>
	);
}

function VariationAxisControl({
	tag,
	axis,
	value,
	onChange,
}: {
	tag: string;
	axis: NonNullable<Font["variationAxes"][string]>;
	value: number | undefined;
	onChange: (tag: string, value: number | null) => void;
}) {
	const t = useTranslation();
	const [draft, setDraft] = useState<string | null>(null);
	const label = axis.name || tag;
	const commitInput = () => {
		if (
			draft !== null &&
			draft.trim() !== "" &&
			Number.isFinite(Number(draft))
		) {
			onChange(tag, Number(draft));
		}
		setDraft(null);
	};
	return (
		<div className="flex flex-col gap-1.5">
			<div className="flex items-center gap-2">
				<span className="min-w-0 flex-1 text-xs">{label}</span>
				<Input
					type="number"
					$size="xs"
					className="w-20"
					aria-label={label}
					min={axis.min}
					max={axis.max}
					step="any"
					value={draft ?? (value === undefined ? "" : String(value))}
					placeholder={t("contextActions.variableFontMixedValue")}
					onChange={(event) => setDraft(event.target.value)}
					onBlur={commitInput}
					onKeyDown={(event) => {
						if (event.key === "Enter") {
							event.preventDefault();
							commitInput();
						}
					}}
				/>
				<Tooltip content={t("contextActions.variableFontReset")}>
					<IconButton
						$size="xs"
						$variant="ghost"
						aria-label={`${label}: ${t("contextActions.variableFontReset")}`}
						onClick={() => {
							setDraft(null);
							onChange(tag, null);
						}}
					>
						<RotateCcw size={14} />
					</IconButton>
				</Tooltip>
			</div>
			<Slider
				aria-label={label}
				min={axis.min}
				max={axis.max}
				step={tag === "ital" ? 1 : (axis.max - axis.min) / 1_000 || 1}
				value={value ?? axis.default}
				hideThumb={value === undefined}
				onValueChange={(next) => {
					setDraft(null);
					onChange(tag, next);
				}}
			/>
		</div>
	);
}
