import { Select as BUISelect } from "@base-ui/react/select";
import { memo } from "react";
import { twm } from "@/utils/tailwind";
import { Select, type SelectSize } from "./Select";
import type { PropsWithNativeClassName } from "./types";

type SimpleSelectProps<T, Multiple extends boolean> = PropsWithNativeClassName<
	Pick<
		BUISelect.Root.Props<T, Multiple>,
		"value" | "onValueChange" | "disabled"
	>
> & {
	items: ReadonlyArray<{ label: string; value: string }>;
	label?: string;
	$size?: SelectSize;
};

export const SimpleSelect = memo(SimpleSelectRoot) as typeof SimpleSelectRoot;

function SimpleSelectRoot<T, Multiple extends boolean>({
	items,
	label,
	value,
	onValueChange,
	disabled,
	className,
	$size,
}: SimpleSelectProps<T, Multiple>) {
	return (
		<Select.Root
			value={value}
			onValueChange={onValueChange}
			disabled={disabled}
			items={items}
		>
			<div className={twm("flex flex-col gap-1", className)}>
				{label && (
					<span className="text-sm font-medium text-muted-foreground">
						{label}
					</span>
				)}
				<Select.Trigger $size={$size}>
					<Select.Value
						className="min-w-0 flex-1 truncate text-left"
						placeholder="Select..."
					/>
					<Select.Icon />
				</Select.Trigger>
			</div>

			<Select.Portal>
				<Select.Positioner>
					<Select.Popup>
						{items.map((item) => (
							<Select.Item key={item.value} value={item.value}>
								<Select.ItemIndicator />
								<BUISelect.ItemText className="col-start-2">
									{item.label}
								</BUISelect.ItemText>
							</Select.Item>
						))}
					</Select.Popup>
				</Select.Positioner>
			</Select.Portal>
		</Select.Root>
	);
}
