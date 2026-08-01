import { memo } from "react";
import { Checkbox } from "@/components/Checkbox";
import { FakeInput } from "@/components/FakeInput";
import { SimpleSelect } from "@/components/SimpleSelect";
import type { HKChromaticAberrationFilter } from "@/core/renderer/filters";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";
import { twm } from "@/utils/tailwind";
import { type FilterSliderDef, FilterSliders } from "./FilterSliders";
import { Vec2Pad } from "./Vec2Pad";

const CA_SLIDERS: FilterSliderDef[] = [
	{
		labelKey: "filterPanel.caStrength",
		paramKey: "strength",
		min: 0,
		max: 50,
		step: 0.5,
		defaultValue: 5,
	},
	{
		labelKey: "filterPanel.caAngle",
		paramKey: "angle",
		min: 0,
		max: 360,
		step: 1,
		defaultValue: 0,
		unit: "°",
	},
	{
		labelKey: "filterPanel.caOpacity",
		paramKey: "opacity",
		min: 0,
		max: 100,
		step: 1,
		defaultValue: 1,
		scale: 100,
	},
];

const FOCUS_GRADIENT_SLIDERS: FilterSliderDef[] = [
	{
		labelKey: "filterPanel.caFocusGradient",
		paramKey: "focusGradient",
		min: 0,
		max: 2,
		step: 0.01,
		defaultValue: 1,
		precision: 2,
	},
];

export const ChromaticAberrationFilterControls = memo(
	function ChromaticAberrationFilterControls({
		filter,
		onUpdate,
	}: {
		filter: HKChromaticAberrationFilter;
		onUpdate: (p: Record<string, unknown>) => void;
	}) {
		const t = useTranslation();
		const handleUpdate = useEventCallback(onUpdate);
		const params = filter.paramData.params;

		const handleColorModeChange = useEventCallback((value: string) => {
			handleUpdate({ colorMode: value });
		});
		const handleShiftTypeChange = useEventCallback((value: string) => {
			handleUpdate({ shiftType: value });
		});
		const handleBlendModeChange = useEventCallback((value: string) => {
			handleUpdate({ blendMode: value });
		});
		const handleUseFocusPointChange = useEventCallback((checked: boolean) => {
			handleUpdate({ useFocusPoint: checked });
		});
		const handleFocusPointChange = useEventCallback((x: number, y: number) => {
			handleUpdate({ focusPointX: x, focusPointY: y });
		});
		const handleFocusXChange = useEventCallback((val: string | undefined) => {
			const parsed = parsePercent(val);
			if (parsed == null) return;
			handleUpdate({ focusPointX: parsed });
		});
		const handleFocusYChange = useEventCallback((val: string | undefined) => {
			const parsed = parsePercent(val);
			if (parsed == null) return;
			handleUpdate({ focusPointY: parsed });
		});

		return (
			<div className="space-y-2">
				<div>
					<div className="text-muted-foreground text-xs mb-1">
						{t("filterPanel.caColorMode")}
					</div>
					<SimpleSelect
						$size="sm"
						items={[
							{ label: t("filterPanel.caColorModeRgb"), value: "rgb" },
							{ label: t("filterPanel.caColorModeCmyk"), value: "cmyk" },
							{ label: t("filterPanel.caColorModeRc"), value: "rc" },
							{ label: t("filterPanel.caColorModePastel"), value: "pastel" },
						]}
						value={params.colorMode}
						onValueChange={handleColorModeChange}
					/>
				</div>

				<div>
					<div className="text-muted-foreground text-xs mb-1">
						{t("filterPanel.caShiftType")}
					</div>
					<SimpleSelect
						$size="sm"
						items={[
							{ label: t("filterPanel.caShiftTypeMove"), value: "move" },
							{ label: t("filterPanel.caShiftTypeZoom"), value: "zoom" },
						]}
						value={params.shiftType}
						onValueChange={handleShiftTypeChange}
					/>
				</div>

				<div>
					<div className="text-muted-foreground text-xs mb-1">
						{t("filterPanel.caBlendMode")}
					</div>
					<SimpleSelect
						$size="sm"
						items={[
							{ label: t("filterPanel.caBlendModeOver"), value: "over" },
							{ label: t("filterPanel.caBlendModeUnder"), value: "under" },
						]}
						value={params.blendMode}
						onValueChange={handleBlendModeChange}
					/>
				</div>

				<FilterSliders
					sliders={CA_SLIDERS}
					params={params}
					onUpdate={onUpdate}
				/>

				{/* biome-ignore lint/a11y/noLabelWithoutControl: custom checkbox component */}
				<label className="flex items-center gap-2 text-muted-foreground text-xs cursor-pointer">
					<Checkbox
						checked={params.useFocusPoint}
						onCheckedChange={handleUseFocusPointChange}
					/>
					{t("filterPanel.caUseFocusPoint")}
				</label>

				<div
					className={twm(
						"space-y-2",
						!params.useFocusPoint && "pointer-events-none opacity-40",
					)}
				>
					<Vec2Pad
						x={params.focusPointX}
						y={params.focusPointY}
						onChange={handleFocusPointChange}
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
							value={(params.focusPointX * 100).toFixed(0)}
							onChange={handleFocusXChange}
						/>
						<span>Y</span>
						<FakeInput
							type="number"
							step={1}
							unit="%"
							$behaviour="click"
							$side="end"
							$size="xs"
							value={(params.focusPointY * 100).toFixed(0)}
							onChange={handleFocusYChange}
						/>
					</div>
					<FilterSliders
						sliders={FOCUS_GRADIENT_SLIDERS}
						params={params}
						onUpdate={onUpdate}
					/>
				</div>
			</div>
		);
	},
);

function clamp01(v: number): number {
	return Math.min(1, Math.max(0, v));
}

function parsePercent(val: string | undefined): number | null {
	if (val == null) return null;
	const parsed = Number.parseFloat(val.trim());
	if (Number.isNaN(parsed)) return null;
	return clamp01(parsed / 100);
}
