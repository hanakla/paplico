import { memo } from "react";
import { FakeInput } from "@/components/FakeInput";
import type { HKRadialRotDirFilter } from "@/core/renderer/filters";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";
import { type FilterSliderDef, FilterSliders } from "./FilterSliders";
import { Vec2Pad } from "./Vec2Pad";

const RADIAL_ROT_DIR_SLIDERS: FilterSliderDef[] = [
	{
		labelKey: "filterPanel.rrdStrength",
		paramKey: "strength",
		min: 0,
		max: 100,
		step: 1,
		defaultValue: 10,
		unit: "px",
		precision: 0,
	},
	{
		labelKey: "filterPanel.rrdRadialRate",
		paramKey: "radialRate",
		min: 0,
		max: 100,
		step: 1,
		defaultValue: 0,
		scale: 100,
	},
	{
		labelKey: "filterPanel.rrdRotateAngle",
		paramKey: "rotateAngle",
		min: -180,
		max: 180,
		step: 1,
		defaultValue: 0,
		unit: "°",
		precision: 0,
	},
	// The handler consumes this as a -100..100 percentage (relativePos / 100)
	{
		labelKey: "filterPanel.rrdRelativePos",
		paramKey: "relativePos",
		min: -100,
		max: 100,
		step: 1,
		defaultValue: 0,
		precision: 0,
	},
	{
		labelKey: "filterPanel.rrdQuality",
		paramKey: "quality",
		min: 4,
		max: 64,
		step: 1,
		defaultValue: 16,
		precision: 0,
	},
];

export const RadialRotDirFilterControls = memo(
	function RadialRotDirFilterControls({
		filter,
		onUpdate,
	}: {
		filter: HKRadialRotDirFilter;
		onUpdate: (p: Record<string, unknown>) => void;
	}) {
		const t = useTranslation();
		const handleUpdate = useEventCallback(onUpdate);
		const params = filter.paramData.params;

		// The direction pad maps its 0..1 space onto the -1..1 unit vector
		const handleDirectionPadChange = useEventCallback(
			(px: number, py: number) => {
				handleUpdate({ directionX: px * 2 - 1, directionY: py * 2 - 1 });
			},
		);
		const handleDirectionXChange = useEventCallback(
			(val: string | undefined) => {
				const parsed = parseSignedPercent(val);
				if (parsed == null) return;
				handleUpdate({ directionX: parsed });
			},
		);
		const handleDirectionYChange = useEventCallback(
			(val: string | undefined) => {
				const parsed = parseSignedPercent(val);
				if (parsed == null) return;
				handleUpdate({ directionY: parsed });
			},
		);

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
				sliders={RADIAL_ROT_DIR_SLIDERS}
				params={params}
				onUpdate={onUpdate}
			>
				<div className="space-y-2">
					<div className="text-muted-foreground text-xs">
						{t("filterPanel.rrdDirection")}
					</div>
					<Vec2Pad
						x={(params.directionX + 1) / 2}
						y={(params.directionY + 1) / 2}
						onChange={handleDirectionPadChange}
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
							value={(params.directionX * 100).toFixed(0)}
							onChange={handleDirectionXChange}
						/>
						<span>Y</span>
						<FakeInput
							type="number"
							step={1}
							unit="%"
							$behaviour="click"
							$side="end"
							$size="xs"
							value={(params.directionY * 100).toFixed(0)}
							onChange={handleDirectionYChange}
						/>
					</div>
				</div>
				<div className="space-y-2">
					<div className="text-muted-foreground text-xs">
						{t("filterPanel.rrdCenter")}
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

function parseSignedPercent(val: string | undefined): number | null {
	if (val == null) return null;
	const parsed = Number.parseFloat(val.trim());
	if (Number.isNaN(parsed)) return null;
	return Math.min(1, Math.max(-1, parsed / 100));
}
