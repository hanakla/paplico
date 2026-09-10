import { memo } from "react";
import { FakeInput } from "@/components/FakeInput";
import { useEventCallback } from "@/utils/hooks";

/** Editable number grid; rows follow from `values.length / columns`. */
export const MatrixGrid = memo(function MatrixGrid({
	columns,
	values,
	onChange,
	step = 0.01,
}: {
	columns: number;
	values: readonly number[];
	onChange: (values: number[]) => void;
	step?: number;
}) {
	const handleCell = useEventCallback((index: number, raw?: string) => {
		const parsed = Number.parseFloat(raw ?? "");
		if (!Number.isFinite(parsed)) return;
		const next = [...values];
		next[index] = parsed;
		onChange(next);
	});
	return (
		<div
			className="grid gap-1"
			style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
		>
			{values.map((value, index) => (
				<FakeInput
					// biome-ignore lint/suspicious/noArrayIndexKey: cells are positional
					key={index}
					type="number"
					$size="xs"
					$behaviour="click"
					step={step}
					value={String(value)}
					onChange={(raw) => handleCell(index, raw)}
					className="text-muted-foreground"
				/>
			))}
		</div>
	);
});
