import { memo, useMemo } from "react";
import { Checkbox } from "@/components/Checkbox";
import { FakeInput } from "@/components/FakeInput";
import type { SvgConvolveMatrixFilter } from "@/core/renderer/filters";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";
import { identityKernel } from "./createDefaultFilter";
import { type FilterSliderDef, FilterSliders } from "./FilterSliders";
import { MatrixGrid } from "./MatrixGrid";
import { SelectRow } from "./SelectRow";
import { SvgInputSelect } from "./SvgInputSelect";

const ORDER_ITEMS = [3, 5, 7].map((n) => ({
	value: String(n),
	label: `${n}×${n}`,
}));

const SLIDERS: FilterSliderDef[] = [
	{
		labelKey: "filterPanel.svgBias",
		paramKey: "bias",
		min: -1,
		max: 1,
		step: 0.01,
		defaultValue: 0,
		precision: 2,
	},
];

export const SvgConvolveMatrixFilterControls = memo(
	function SvgConvolveMatrixFilterControls({
		filter,
		onUpdate,
	}: {
		filter: SvgConvolveMatrixFilter;
		onUpdate: (p: Record<string, unknown>) => void;
	}) {
		const t = useTranslation();
		const handleUpdate = useEventCallback(onUpdate);
		const params = filter.paramData.params;
		const edgeModeItems = useMemo(
			() => [
				{ value: "duplicate", label: t("filterPanel.svgEdgeModeDuplicate") },
				{ value: "wrap", label: t("filterPanel.svgEdgeModeWrap") },
				{ value: "none", label: t("filterPanel.svgEdgeModeNone") },
			],
			[t],
		);
		// A new order needs a kernel of matching size; start from identity.
		const handleOrderChange = useEventCallback((value: string) => {
			const order = Number(value);
			handleUpdate({ order, kernelMatrix: identityKernel(order) });
		});
		const handleDivisorAuto = useEventCallback((checked: boolean) =>
			handleUpdate({ divisor: checked ? null : 1 }),
		);
		const handleDivisor = useEventCallback((raw?: string) => {
			const divisor = Number.parseFloat(raw ?? "");
			if (Number.isFinite(divisor) && divisor !== 0) handleUpdate({ divisor });
		});

		return (
			<FilterSliders sliders={SLIDERS} params={params} onUpdate={onUpdate}>
				<SvgInputSelect
					labelKey="filterPanel.svgInput"
					value={params.in}
					onChange={(input) => handleUpdate({ in: input })}
				/>
				<SelectRow
					label={t("filterPanel.svgKernelOrder")}
					items={ORDER_ITEMS}
					value={String(params.order)}
					onValueChange={handleOrderChange}
				/>
				<MatrixGrid
					columns={params.order}
					values={
						params.kernelMatrix.length === params.order ** 2
							? params.kernelMatrix
							: identityKernel(params.order)
					}
					onChange={(kernelMatrix) => handleUpdate({ kernelMatrix })}
					step={0.1}
				/>
				<div className="flex items-center justify-between text-muted-foreground text-xs">
					<span>{t("filterPanel.svgDivisor")}</span>
					<div className="flex items-center gap-2">
						{params.divisor !== null && (
							<FakeInput
								type="number"
								$size="xs"
								$behaviour="click"
								$side="end"
								step={0.1}
								value={String(params.divisor)}
								onChange={handleDivisor}
							/>
						)}
						{/* biome-ignore lint/a11y/noLabelWithoutControl: custom checkbox component */}
						<label className="flex items-center gap-1 cursor-pointer">
							<Checkbox
								checked={params.divisor === null}
								onCheckedChange={handleDivisorAuto}
							/>
							{t("filterPanel.svgDivisorAuto")}
						</label>
					</div>
				</div>
				<SelectRow
					label={t("filterPanel.svgEdgeMode")}
					items={edgeModeItems}
					value={params.edgeMode}
					onValueChange={(edgeMode) => handleUpdate({ edgeMode })}
				/>
				{/* biome-ignore lint/a11y/noLabelWithoutControl: custom checkbox component */}
				<label className="flex items-center gap-2 text-muted-foreground text-xs cursor-pointer">
					<Checkbox
						checked={params.preserveAlpha}
						onCheckedChange={(preserveAlpha) => handleUpdate({ preserveAlpha })}
					/>
					{t("filterPanel.svgPreserveAlpha")}
				</label>
			</FilterSliders>
		);
	},
);
