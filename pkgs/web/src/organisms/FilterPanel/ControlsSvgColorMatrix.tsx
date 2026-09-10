import { memo, useMemo } from "react";
import { Button } from "@/components/Button";
import type {
	SvgColorMatrixFilter,
	SvgColorMatrixType,
} from "@/core/renderer/filters";
import { SVG_COLOR_MATRIX_IDENTITY } from "@/core/renderer/filters";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";
import { type FilterSliderDef, FilterSliders } from "./FilterSliders";
import { MatrixGrid } from "./MatrixGrid";
import { SelectRow } from "./SelectRow";
import { SvgInputSelect } from "./SvgInputSelect";

const SATURATE_SLIDERS: FilterSliderDef[] = [
	{
		labelKey: "filterPanel.saturation",
		paramKey: "0",
		min: 0,
		max: 2,
		step: 0.01,
		defaultValue: 1,
		precision: 2,
	},
];

const HUE_ROTATE_SLIDERS: FilterSliderDef[] = [
	{
		labelKey: "filterPanel.svgHueRotate",
		paramKey: "0",
		min: 0,
		max: 360,
		step: 1,
		defaultValue: 0,
		unit: "°",
		precision: 0,
	},
];

export const SvgColorMatrixFilterControls = memo(
	function SvgColorMatrixFilterControls({
		filter,
		onUpdate,
	}: {
		filter: SvgColorMatrixFilter;
		onUpdate: (p: Record<string, unknown>) => void;
	}) {
		const t = useTranslation();
		const handleUpdate = useEventCallback(onUpdate);
		const params = filter.paramData.params;

		const typeItems = useMemo(
			() => [
				{ value: "matrix", label: t("filterPanel.svgColorMatrixTypeMatrix") },
				{
					value: "saturate",
					label: t("filterPanel.svgColorMatrixTypeSaturate"),
				},
				{
					value: "hueRotate",
					label: t("filterPanel.svgColorMatrixTypeHueRotate"),
				},
				{
					value: "luminanceToAlpha",
					label: t("filterPanel.svgColorMatrixTypeLuminanceToAlpha"),
				},
			],
			[t],
		);
		const handleTypeChange = useEventCallback((type: string) =>
			handleUpdate({
				type,
				values: defaultValuesFor(type as SvgColorMatrixType),
			}),
		);
		// The single-value types reuse FilterSliders by treating the values
		// array as the params object (its only key is "0").
		const handleScalar = useEventCallback((p: Record<string, unknown>) =>
			handleUpdate({ values: [p["0"] as number] }),
		);
		const handleMatrix = useEventCallback((values: number[]) =>
			handleUpdate({ values }),
		);
		const handleReset = useEventCallback(() =>
			handleUpdate({ values: [...SVG_COLOR_MATRIX_IDENTITY] }),
		);

		return (
			<div className="space-y-2">
				<SvgInputSelect
					labelKey="filterPanel.svgInput"
					value={params.in}
					onChange={(input) => handleUpdate({ in: input })}
				/>
				<SelectRow
					label={t("filterPanel.svgColorMatrixType")}
					items={typeItems}
					value={params.type}
					onValueChange={handleTypeChange}
				/>
				{params.type === "matrix" && (
					<div className="space-y-1">
						<div className="flex items-center justify-between">
							<span className="text-muted-foreground text-xs">
								{t("filterPanel.svgMatrix")}
							</span>
							<Button $variant="ghost" $size="sm" onClick={handleReset}>
								{t("filterPanel.svgMatrixReset")}
							</Button>
						</div>
						<MatrixGrid
							columns={5}
							values={
								params.values.length === 20
									? params.values
									: SVG_COLOR_MATRIX_IDENTITY
							}
							onChange={handleMatrix}
						/>
					</div>
				)}
				{params.type === "saturate" && (
					<FilterSliders
						sliders={SATURATE_SLIDERS}
						params={params.values}
						onUpdate={handleScalar}
					/>
				)}
				{params.type === "hueRotate" && (
					<FilterSliders
						sliders={HUE_ROTATE_SLIDERS}
						params={params.values}
						onUpdate={handleScalar}
					/>
				)}
			</div>
		);
	},
);

function defaultValuesFor(type: SvgColorMatrixType): number[] {
	switch (type) {
		case "matrix":
			return [...SVG_COLOR_MATRIX_IDENTITY];
		case "saturate":
			return [1];
		case "hueRotate":
			return [0];
		default:
			return [];
	}
}
