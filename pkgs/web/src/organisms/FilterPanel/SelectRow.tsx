import { memo } from "react";
import { SimpleSelect } from "@/components/SimpleSelect";

/** "Label" over a small select; the layout every filter's enum parameter uses. */
export const SelectRow = memo(function SelectRow({
	label,
	items,
	value,
	onValueChange,
}: {
	label: string;
	items: ReadonlyArray<{ label: string; value: string }>;
	value: string;
	onValueChange: (value: string) => void;
}) {
	return (
		<div>
			<div className="text-muted-foreground text-xs mb-1">{label}</div>
			<SimpleSelect
				$size="sm"
				items={items}
				value={value}
				onValueChange={onValueChange}
			/>
		</div>
	);
});
