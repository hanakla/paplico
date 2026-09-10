import { memo, useEffect, useMemo, useState } from "react";
import type { SvgTransferFunction } from "@/core/renderer/filters";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";
import { type FilterSliderDef, FilterSliders } from "./FilterSliders";
import { SelectRow } from "./SelectRow";

const LINEAR_SLIDERS: FilterSliderDef[] = [
	{
		labelKey: "filterPanel.svgSlope",
		paramKey: "slope",
		min: -5,
		max: 5,
		step: 0.01,
		defaultValue: 1,
		precision: 2,
	},
	{
		labelKey: "filterPanel.svgIntercept",
		paramKey: "intercept",
		min: -1,
		max: 1,
		step: 0.01,
		defaultValue: 0,
		precision: 2,
	},
];

const GAMMA_SLIDERS: FilterSliderDef[] = [
	{
		labelKey: "filterPanel.amplitude",
		paramKey: "amplitude",
		min: 0,
		max: 5,
		step: 0.01,
		defaultValue: 1,
		precision: 2,
	},
	{
		labelKey: "filterPanel.svgExponent",
		paramKey: "exponent",
		min: 0,
		max: 5,
		step: 0.01,
		defaultValue: 1,
		precision: 2,
	},
	{
		labelKey: "filterPanel.offset",
		paramKey: "offset",
		min: -1,
		max: 1,
		step: 0.01,
		defaultValue: 0,
		precision: 2,
	},
];

/** One feFunc{R,G,B,A} editor: the function type and its parameters. */
export const ChannelFnEditor = memo(function ChannelFnEditor({
	label,
	value,
	onChange,
}: {
	label: string;
	value: SvgTransferFunction;
	onChange: (fn: SvgTransferFunction) => void;
}) {
	const t = useTranslation();
	const typeItems = useMemo(
		() => [
			{ value: "identity", label: t("filterPanel.svgTransferIdentity") },
			{ value: "table", label: t("filterPanel.svgTransferTable") },
			{ value: "discrete", label: t("filterPanel.svgTransferDiscrete") },
			{ value: "linear", label: t("filterPanel.svgTransferLinear") },
			{ value: "gamma", label: t("filterPanel.svgTransferGamma") },
		],
		[t],
	);
	const handleTypeChange = useEventCallback((type: string) =>
		onChange(defaultTransferFunction(type as SvgTransferFunction["type"])),
	);
	const handleParams = useEventCallback((p: Record<string, unknown>) =>
		onChange({ ...value, ...p } as SvgTransferFunction),
	);
	const handleTable = useEventCallback((tableValues: number[]) => {
		if (value.type === "table" || value.type === "discrete") {
			onChange({ type: value.type, tableValues });
		}
	});

	return (
		<div className="space-y-2">
			<SelectRow
				label={`${label} · ${t("filterPanel.svgTransferType")}`}
				items={typeItems}
				value={value.type}
				onValueChange={handleTypeChange}
			/>
			{(value.type === "table" || value.type === "discrete") && (
				<NumberListInput
					label={t("filterPanel.svgTableValues")}
					values={value.tableValues}
					onChange={handleTable}
				/>
			)}
			{value.type === "linear" && (
				<FilterSliders
					sliders={LINEAR_SLIDERS}
					params={value}
					onUpdate={handleParams}
				/>
			)}
			{value.type === "gamma" && (
				<FilterSliders
					sliders={GAMMA_SLIDERS}
					params={value}
					onUpdate={handleParams}
				/>
			)}
		</div>
	);
});

function defaultTransferFunction(
	type: SvgTransferFunction["type"],
): SvgTransferFunction {
	switch (type) {
		case "table":
		case "discrete":
			return { type, tableValues: [0, 1] };
		case "linear":
			return { type, slope: 1, intercept: 0 };
		case "gamma":
			return { type, amplitude: 1, exponent: 1, offset: 0 };
		default:
			return { type: "identity" };
	}
}

/** Free-form "0 0.5 1" list; the text resets to the stored values on blur. */
function NumberListInput({
	label,
	values,
	onChange,
}: {
	label: string;
	values: readonly number[];
	onChange: (values: number[]) => void;
}) {
	const canonical = values.join(" ");
	const [text, setText] = useState(canonical);
	useEffect(() => setText(canonical), [canonical]);

	const handleChange = useEventCallback(
		(e: React.ChangeEvent<HTMLInputElement>) => {
			setText(e.target.value);
			const parsed = e.target.value
				.split(/[\s,]+/)
				.filter((s) => s.length > 0)
				.map(Number);
			if (parsed.length > 0 && parsed.every(Number.isFinite)) {
				onChange(parsed);
			}
		},
	);
	const handleBlur = useEventCallback(() => setText(canonical));

	return (
		<div>
			<div className="text-muted-foreground text-xs mb-1">{label}</div>
			<input
				type="text"
				value={text}
				onChange={handleChange}
				onBlur={handleBlur}
				aria-label={label}
				className="w-full min-w-0 rounded border border-border bg-background px-1.5 py-0.5 text-xs font-mono text-foreground"
				spellCheck={false}
			/>
		</div>
	);
}
