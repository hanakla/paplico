import type { Font } from "@cantoo/fontkit";
import { RotateCcw } from "lucide-react";
import { useState } from "react";
import { IconButton } from "@/components/IconButton";
import { Input } from "@/components/Input";
import { Slider } from "@/components/Slider";
import { Tooltip } from "@/components/Tooltip";
import { useTranslation } from "@/locales";

export function FontVariationAxisControl({
	tag,
	axis,
	value,
	onChange,
	label = axis.name || tag,
	showLabel = true,
}: {
	tag: string;
	axis: Font["variationAxes"][string];
	value: number | undefined;
	onChange: (value: number | null) => void;
	label?: string;
	showLabel?: boolean;
}) {
	const t = useTranslation();
	const [draft, setDraft] = useState<string | null>(null);
	const commitInput = () => {
		if (
			draft !== null &&
			draft.trim() !== "" &&
			Number.isFinite(Number(draft))
		) {
			onChange(Math.max(axis.min, Math.min(axis.max, Number(draft))));
		}
		setDraft(null);
	};
	return (
		<div className="flex flex-col gap-1.5">
			<div className="flex items-center gap-2">
				<span className="min-w-0 flex-1 text-xs">
					{showLabel ? label : null}
				</span>
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
							onChange(null);
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
				step={
					tag === "ital" || tag === "wght"
						? 1
						: (axis.max - axis.min) / 1_000 || 1
				}
				value={value ?? axis.default}
				hideThumb={value === undefined}
				onValueChange={(next) => {
					setDraft(null);
					onChange(next);
				}}
			/>
		</div>
	);
}
