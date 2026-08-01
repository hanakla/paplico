import { Check, Copy } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { GradientStopsEditor } from "@/components/GradientPicker";
import { IconButton } from "@/components/IconButton";
import { SimpleSelect } from "@/components/SimpleSelect";
import { Tooltip } from "@/components/Tooltip";
import {
	GRADIENT_MAP_PRESET_STOPS,
	type HKGradientMapFilter,
} from "@/core/renderer/filters";
import type { ColorStop } from "@/core/schema";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";
import { type FilterSliderDef, FilterSliders } from "./FilterSliders";

/** Must match the stop capacity of the gradient map shader. */
const MAX_STOPS = 16;

const GRADIENT_MAP_SLIDERS: FilterSliderDef[] = [
	{
		labelKey: "filterPanel.gradMapStrength",
		paramKey: "strength",
		min: 0,
		max: 100,
		step: 1,
		defaultValue: 1,
		scale: 100,
	},
];

export const GradientMapFilterControls = memo(
	function GradientMapFilterControls({
		filter,
		onUpdate,
	}: {
		filter: HKGradientMapFilter;
		onUpdate: (p: Record<string, unknown>) => void;
	}) {
		const t = useTranslation();
		const handleUpdate = useEventCallback(onUpdate);
		const [copied, setCopied] = useState(false);
		const params = filter.paramData.params;

		const presetItems = useMemo(
			() => [
				{
					label: t("filterPanel.gradMapPresetBlackAndWhite"),
					value: "blackAndWhite",
				},
				{ label: t("filterPanel.gradMapPresetSepia"), value: "sepia" },
				{ label: t("filterPanel.gradMapPresetDuotone"), value: "duotone" },
				{ label: t("filterPanel.gradMapPresetRainbow"), value: "rainbow" },
				{ label: t("filterPanel.gradMapPresetCustom"), value: "custom" },
			],
			[t],
		);

		// Stored stops win; legacy documents without stops display the preset's
		// gradient (matching what the shader fallback renders).
		const stops = useMemo(() => {
			const parsed = parseStops(params.colorStops);
			if (parsed.length >= 2) return parsed;
			return params.preset === "custom"
				? GRADIENT_MAP_PRESET_STOPS.blackAndWhite
				: GRADIENT_MAP_PRESET_STOPS[params.preset];
		}, [params.colorStops, params.preset]);

		const stopsJson = useMemo(() => JSON.stringify(stops), [stops]);
		const [stopsText, setStopsText] = useState(stopsJson);
		const internalChange = useRef(false);

		useEffect(() => {
			if (internalChange.current) {
				internalChange.current = false;
				return;
			}
			setStopsText(stopsJson);
		}, [stopsJson]);

		const applyStops = useEventCallback((newStops: ColorStop[]) => {
			const sorted = [...newStops].sort((a, b) => a.offset - b.offset);
			handleUpdate({ preset: "custom", colorStops: JSON.stringify(sorted) });
		});

		const handlePresetChange = useEventCallback((value: string) => {
			// Presets just write their gradient into colorStops
			const presetStops =
				value === "custom"
					? stops
					: GRADIENT_MAP_PRESET_STOPS[
							value as keyof typeof GRADIENT_MAP_PRESET_STOPS
						];
			handleUpdate({ preset: value, colorStops: JSON.stringify(presetStops) });
		});

		const handleStopsChange = useEventCallback((newStops: ColorStop[]) => {
			applyStops(newStops);
		});

		const handleStopsTextChange = useEventCallback(
			(e: React.ChangeEvent<HTMLInputElement>) => {
				const val = e.target.value;
				setStopsText(val);
				const parsed = parseStops(val);
				if (parsed.length >= 2) {
					internalChange.current = true;
					applyStops(parsed);
				}
			},
		);

		const handleStopsTextBlur = useEventCallback(() => {
			setStopsText(stopsJson);
		});

		const handleCopyStops = useEventCallback(async () => {
			await navigator.clipboard.writeText(stopsJson);
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		});

		return (
			<FilterSliders
				sliders={GRADIENT_MAP_SLIDERS}
				params={params}
				onUpdate={onUpdate}
			>
				<div>
					<div className="text-muted-foreground text-xs mb-1">
						{t("filterPanel.gradMapPreset")}
					</div>
					<SimpleSelect
						$size="sm"
						items={presetItems}
						value={params.preset}
						onValueChange={handlePresetChange}
					/>
				</div>
				<GradientStopsEditor
					stops={stops}
					onStopsChange={handleStopsChange}
					maxStops={MAX_STOPS}
				/>
				<div className="flex items-center gap-1">
					<input
						type="text"
						value={stopsText}
						onChange={handleStopsTextChange}
						onBlur={handleStopsTextBlur}
						aria-label={t("toolbar.gradientStops")}
						className="w-full min-w-0 rounded border border-border bg-background px-1.5 py-0.5 text-xs font-mono text-foreground"
						spellCheck={false}
					/>
					<Tooltip content={t("filterPanel.gradMapCopyStops")}>
						<IconButton $variant="ghost" $size="xs" onClick={handleCopyStops}>
							{copied ? (
								<Check className="size-3.5" />
							) : (
								<Copy className="size-3.5" />
							)}
						</IconButton>
					</Tooltip>
				</div>
			</FilterSliders>
		);
	},
);

function parseStops(json: string): ColorStop[] {
	try {
		const parsed = JSON.parse(json);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(
			(stop): stop is ColorStop =>
				typeof stop === "object" &&
				stop !== null &&
				typeof stop.offset === "number" &&
				stop.color != null,
		);
	} catch {
		return [];
	}
}
