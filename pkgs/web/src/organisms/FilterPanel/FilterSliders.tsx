import type { ReactNode } from "react";
import { FakeInput } from "@/components/FakeInput";
import { Slider } from "@/components/Slider";
import { type LocalizeKeys, useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";

export interface FilterSliderDef {
	labelKey: LocalizeKeys;
	paramKey: string;
	min: number;
	max: number;
	step: number;
	defaultValue: number;
	/** When set, slider value = paramValue * scale, displayed as integer % */
	scale?: number;
	/** Unit suffix for direct-value sliders (e.g. "px") */
	unit?: string;
	/** Decimal places for direct-value display (default: 1) */
	precision?: number;
}

export function FilterSliders<P extends object>({
	sliders,
	params,
	onUpdate,
	children,
}: {
	sliders: FilterSliderDef[];
	params: P;
	onUpdate: (params: Record<string, unknown>) => void;
	children?: ReactNode;
}) {
	const t = useTranslation();
	const handleUpdate = useEventCallback(onUpdate);
	const p = params as Record<string, unknown>;

	return (
		<div className="space-y-2">
			{sliders.map((s) => {
				const raw = (p[s.paramKey] as number) ?? s.defaultValue;
				const scale = s.scale ?? 1;
				const displayValue = raw * scale;
				const numericText = s.scale
					? displayValue.toFixed(0)
					: displayValue.toFixed(s.precision ?? 1);
				const unit = s.scale ? "%" : (s.unit ?? "");

				return (
					<div key={s.paramKey} className="text-muted-foreground text-xs">
						<div className="flex items-center justify-between">
							<span>{t(s.labelKey)}</span>
							<FakeInput
								type="number"
								step={0.1}
								unit={unit || undefined}
								$behaviour="click"
								$side="end"
								$size="xs"
								value={numericText}
								onChange={(val) => {
									if (val == null) return;
									const parsed = Number.parseFloat(val.trim());
									if (Number.isNaN(parsed)) return;
									const clamped = Math.min(s.max, Math.max(s.min, parsed));
									handleUpdate({
										[s.paramKey]: clamped / scale,
									});
								}}
							/>
						</div>
						<Slider
							min={s.min}
							max={s.max}
							step={s.step}
							value={displayValue}
							onValueChange={(val) =>
								handleUpdate({ [s.paramKey]: val / scale })
							}
						/>
					</div>
				);
			})}
			{children}
		</div>
	);
}
