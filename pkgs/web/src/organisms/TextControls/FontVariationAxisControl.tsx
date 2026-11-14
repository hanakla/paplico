import type { Font } from "@cantoo/fontkit";
import { RotateCcw } from "lucide-react";
import { FakeInput } from "@/components/FakeInput";
import { IconButton } from "@/components/IconButton";
import { Slider } from "@/components/Slider";
import { Tooltip } from "@/components/Tooltip";
import { useTranslation } from "@/locales";

export function FontVariationAxisControl({
	tag,
	axis,
	value,
	onChange,
	label = axis.name || tag,
	slider = true,
}: {
	tag: string;
	axis: Font["variationAxes"][string];
	value: number | undefined;
	onChange: (value: number | null) => void;
	label?: string;
	/** False leaves only the number field, which still changes the value by dragging. */
	slider?: boolean;
}) {
	const t = useTranslation();
	const step =
		tag === "ital" || tag === "wght" ? 1 : (axis.max - axis.min) / 1_000 || 1;
	return (
		<div className="flex flex-col gap-1">
			<div className="flex items-center gap-2">
				<span className="min-w-0 flex-1 type-label text-muted-foreground">
					{label}
				</span>
				<FakeInput
					type="number"
					$size="xs"
					className="w-20 text-right tabular-nums"
					aria-label={label}
					min={axis.min}
					max={axis.max}
					step={step}
					value={value === undefined ? "" : String(value)}
					placeholder={t("contextActions.variableFontMixedValue")}
					onChange={(next) => {
						if (next === undefined || !Number.isFinite(Number(next))) return;
						onChange(Math.max(axis.min, Math.min(axis.max, Number(next))));
					}}
				/>
				<Tooltip content={t("contextActions.variableFontReset")}>
					<IconButton
						$size="xs"
						$variant="ghost"
						aria-label={`${label}: ${t("contextActions.variableFontReset")}`}
						onClick={() => {
							onChange(null);
						}}
					>
						<RotateCcw size={14} />
					</IconButton>
				</Tooltip>
			</div>
			{slider && (
				<Slider
					aria-label={label}
					min={axis.min}
					max={axis.max}
					step={step}
					value={value ?? axis.default}
					hideThumb={value === undefined}
					onValueChange={onChange}
					className="px-1"
				/>
			)}
		</div>
	);
}
