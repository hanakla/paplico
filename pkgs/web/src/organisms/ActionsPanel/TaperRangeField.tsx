import { memo } from "react";
import { FakeInput } from "@/components/FakeInput";
import { InfiniteSlider } from "@/components/Slider";
import { useEventCallback } from "@/utils/hooks";

/** Half-width of each InfiniteSlider's visible window (track is -100..+100) */
const TAPER_SLIDER_RANGE = 100;

/**
 * Two independent infinite sliders for a start/end pair measured from
 * opposite ends of a stroke (e.g. brush taper in/out). They don't share a
 * track or clamp against each other — taper in and taper out are unrelated
 * distances, not a min/max range.
 */
export const TaperRangeField = memo(function TaperRangeField({
	startLabel,
	endLabel,
	startValue,
	endValue,
	min,
	max,
	step,
	onValueChange,
}: {
	startLabel: string;
	endLabel: string;
	startValue: number;
	endValue: number;
	min: number;
	max: number;
	step: number;
	onValueChange: (start: number, end: number) => void;
}) {
	const handleStartSliderChange = useEventCallback((val: number) => {
		onValueChange(val, endValue);
	});

	const handleEndSliderChange = useEventCallback((val: number) => {
		onValueChange(startValue, val);
	});

	const handleStartInputChange = useEventCallback((val: string | undefined) => {
		if (!val) return;
		const parsed = Number.parseFloat(val);
		if (!Number.isNaN(parsed)) {
			onValueChange(Math.min(Math.max(parsed, min), max), endValue);
		}
	});

	const handleEndInputChange = useEventCallback((val: string | undefined) => {
		if (!val) return;
		const parsed = Number.parseFloat(val);
		if (!Number.isNaN(parsed)) {
			onValueChange(startValue, Math.min(Math.max(parsed, min), max));
		}
	});

	return (
		<div className="flex flex-col gap-1 w-full">
			<div className="flex items-center gap-2 px-1">
				<span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide w-10 shrink-0">
					{startLabel}
				</span>
				<InfiniteSlider
					min={min}
					max={max}
					range={TAPER_SLIDER_RANGE}
					step={step}
					value={startValue}
					onValueChange={handleStartSliderChange}
					className="flex-1"
				/>
				<FakeInput
					$size="xs"
					type="number"
					min={min}
					max={max}
					step={step}
					value={String(startValue)}
					onChange={handleStartInputChange}
				/>
			</div>
			<div className="flex items-center gap-2 px-1">
				<span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide w-10 shrink-0">
					{endLabel}
				</span>
				<InfiniteSlider
					min={min}
					max={max}
					range={TAPER_SLIDER_RANGE}
					step={step}
					value={endValue}
					onValueChange={handleEndSliderChange}
					className="flex-1"
				/>
				<FakeInput
					$size="xs"
					type="number"
					min={min}
					max={max}
					step={step}
					value={String(endValue)}
					onChange={handleEndInputChange}
				/>
			</div>
		</div>
	);
});
