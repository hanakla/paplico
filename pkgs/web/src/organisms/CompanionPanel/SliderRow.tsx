import { memo } from "react";
import { Slider } from "@/components/Slider";

/**
 * A labelled slider sized for a fingertip. The row is what a finger has to
 * land on, so it is the row that is 44px tall rather than the track.
 */
export const SliderRow = memo(function SliderRow({
	label,
	value,
	display,
	min,
	max,
	step,
	onValueChange,
}: {
	label: string;
	value: number;
	display: string;
	min: number;
	max: number;
	step: number;
	onValueChange: (value: number) => void;
}) {
	return (
		// biome-ignore lint/a11y/noLabelWithoutControl: custom slider component
		<label className="flex flex-col gap-1">
			<span className="flex items-baseline justify-between text-xs text-muted-foreground">
				{label}
				<span className="font-mono text-foreground">{display}</span>
			</span>
			<Slider
				$size="lg"
				className="h-11"
				value={value}
				min={min}
				max={max}
				step={step}
				onValueChange={(next) =>
					onValueChange(Array.isArray(next) ? next[0] : (next as number))
				}
			/>
		</label>
	);
});
