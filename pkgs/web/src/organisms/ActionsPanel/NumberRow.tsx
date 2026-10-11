import { FakeInput } from "@/components/FakeInput";
import { Slider } from "@/components/Slider";

/** Labelled slider with a typed number field, for one numeric tool or element parameter. */
export function NumberRow({
	label,
	min,
	max,
	step,
	value,
	onChange,
}: {
	label: string;
	min: number;
	max: number;
	step: number;
	value: number;
	onChange: (value: number) => void;
}) {
	return (
		<div className="flex items-center gap-2">
			<span className="text-[10px] text-muted-foreground shrink-0 w-12">
				{label}
			</span>
			<Slider
				min={min}
				max={max}
				step={step}
				value={value}
				onValueChange={onChange}
				className="flex-1"
			/>
			<FakeInput
				$size="xs"
				type="number"
				step={step}
				min={min}
				max={max}
				value={String(value)}
				onChange={(v) => onChange(v ? Number(v) : min)}
				className="w-12 text-right tabular-nums"
			/>
		</div>
	);
}
