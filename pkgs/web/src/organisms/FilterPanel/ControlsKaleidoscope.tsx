import { memo } from "react";
import { FakeInput } from "@/components/FakeInput";
import { SimpleSelect } from "@/components/SimpleSelect";
import type { HKKaleidoscopeFilter } from "@/core/renderer/filters";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";
import { type FilterSliderDef, FilterSliders } from "./FilterSliders";
import { Vec2Pad } from "./Vec2Pad";

const KALEIDOSCOPE_SLIDERS: FilterSliderDef[] = [
	{
		labelKey: "filterPanel.kaleidoSegments",
		paramKey: "segments",
		min: 2,
		max: 32,
		step: 1,
		defaultValue: 6,
		precision: 0,
	},
	{
		labelKey: "filterPanel.kaleidoRotation",
		paramKey: "rotation",
		min: 0,
		max: 360,
		step: 1,
		defaultValue: 0,
		unit: "°",
		precision: 0,
	},
	{
		labelKey: "filterPanel.kaleidoZoom",
		paramKey: "zoom",
		min: 0.1,
		max: 5,
		step: 0.1,
		defaultValue: 1,
	},
	{
		labelKey: "filterPanel.kaleidoDistortion",
		paramKey: "distortion",
		min: 0,
		max: 100,
		step: 1,
		defaultValue: 0,
		scale: 100,
	},
	{
		labelKey: "filterPanel.kaleidoComplexity",
		paramKey: "complexity",
		min: 0,
		max: 5,
		step: 0.1,
		defaultValue: 1,
	},
	{
		labelKey: "filterPanel.kaleidoColorShift",
		paramKey: "colorShift",
		min: 0,
		max: 100,
		step: 1,
		defaultValue: 0,
		scale: 100,
	},
	{
		labelKey: "filterPanel.kaleidoCellEffect",
		paramKey: "cellEffect",
		min: 0,
		max: 100,
		step: 1,
		defaultValue: 0,
		scale: 100,
	},
	{
		labelKey: "filterPanel.kaleidoCellSize",
		paramKey: "cellSize",
		min: 10,
		max: 100,
		step: 1,
		defaultValue: 0.3,
		scale: 100,
	},
	{
		labelKey: "filterPanel.kaleidoPadding",
		paramKey: "padding",
		min: 0,
		max: 100,
		step: 1,
		defaultValue: 0,
		unit: "px",
		precision: 0,
	},
];

export const KaleidoscopeFilterControls = memo(
	function KaleidoscopeFilterControls({
		filter,
		onUpdate,
	}: {
		filter: HKKaleidoscopeFilter;
		onUpdate: (p: Record<string, unknown>) => void;
	}) {
		const t = useTranslation();
		const handleUpdate = useEventCallback(onUpdate);
		const params = filter.paramData.params;

		const handlePatternChange = useEventCallback((value: string) => {
			handleUpdate({ pattern: value });
		});
		const handleBlendModeChange = useEventCallback((value: string) => {
			handleUpdate({ blendMode: value });
		});

		const handleCenterPadChange = useEventCallback((px: number, py: number) => {
			handleUpdate({ centerX: px, centerY: py });
		});
		const handleCenterXChange = useEventCallback((val: string | undefined) => {
			const parsed = parsePercent(val);
			if (parsed == null) return;
			handleUpdate({ centerX: parsed });
		});
		const handleCenterYChange = useEventCallback((val: string | undefined) => {
			const parsed = parsePercent(val);
			if (parsed == null) return;
			handleUpdate({ centerY: parsed });
		});

		return (
			<FilterSliders
				sliders={KALEIDOSCOPE_SLIDERS}
				params={params}
				onUpdate={onUpdate}
			>
				<div>
					<div className="text-muted-foreground text-xs mb-1">
						{t("filterPanel.kaleidoPattern")}
					</div>
					<SimpleSelect
						$size="sm"
						items={[
							{
								label: t("filterPanel.kaleidoPatternTriangular"),
								value: "triangular",
							},
							{
								label: t("filterPanel.kaleidoPatternSquare"),
								value: "square",
							},
							{
								label: t("filterPanel.kaleidoPatternHexagonal"),
								value: "hexagonal",
							},
							{
								label: t("filterPanel.kaleidoPatternOctagonal"),
								value: "octagonal",
							},
							{
								label: t("filterPanel.kaleidoPatternCircular"),
								value: "circular",
							},
							{
								label: t("filterPanel.kaleidoPatternSpiral"),
								value: "spiral",
							},
							{
								label: t("filterPanel.kaleidoPatternFractal"),
								value: "fractal",
							},
							{
								label: t("filterPanel.kaleidoPatternComposite"),
								value: "composite",
							},
						]}
						value={params.pattern ?? "triangular"}
						onValueChange={handlePatternChange}
					/>
				</div>
				<div>
					<div className="text-muted-foreground text-xs mb-1">
						{t("filterPanel.blendMode")}
					</div>
					<SimpleSelect
						$size="sm"
						items={[
							{ label: t("filterPanel.kaleidoBlendNormal"), value: "normal" },
							{
								label: t("filterPanel.kaleidoBlendKaleidoscope"),
								value: "kaleidoscope",
							},
							{ label: t("filterPanel.kaleidoBlendMirror"), value: "mirror" },
							{
								label: t("filterPanel.kaleidoBlendRotational"),
								value: "rotational",
							},
						]}
						value={params.blendMode ?? "normal"}
						onValueChange={handleBlendModeChange}
					/>
				</div>
				<div className="space-y-2">
					<div className="text-muted-foreground text-xs">
						{t("filterPanel.kaleidoCenter")}
					</div>
					<Vec2Pad
						x={params.centerX}
						y={params.centerY}
						onChange={handleCenterPadChange}
					/>
					<div className="flex items-center gap-2 text-muted-foreground text-xs">
						<span>X</span>
						<FakeInput
							type="number"
							step={1}
							unit="%"
							$behaviour="click"
							$side="end"
							$size="xs"
							value={(params.centerX * 100).toFixed(0)}
							onChange={handleCenterXChange}
						/>
						<span>Y</span>
						<FakeInput
							type="number"
							step={1}
							unit="%"
							$behaviour="click"
							$side="end"
							$size="xs"
							value={(params.centerY * 100).toFixed(0)}
							onChange={handleCenterYChange}
						/>
					</div>
				</div>
			</FilterSliders>
		);
	},
);

function parsePercent(val: string | undefined): number | null {
	if (val == null) return null;
	const parsed = Number.parseFloat(val.trim());
	if (Number.isNaN(parsed)) return null;
	return Math.min(1, Math.max(0, parsed / 100));
}
