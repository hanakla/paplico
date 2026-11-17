import { Combobox as BUICombobox } from "@base-ui/react/combobox";
import { memo } from "react";
import { useEventCallback } from "@/utils/hooks";
import { Combobox2 } from "./Combobox2";

type Item = { label: string; value: string };
type SeparatorItem = { separator: true; id: string };
type ItemOrSeparator = Item | SeparatorItem;

export const SimpleCombobox = memo(function SimpleCombobox({
	items,
	value,
	onValueChange,
	placeholder,
	disabled,
	className,
	$size = "md",
}: {
	items: ItemOrSeparator[];
	value: string;
	onValueChange: (value: string) => void;
	placeholder?: string;
	disabled?: boolean;
	className?: string;
	$size?: "sm" | "md";
}) {
	// base-ui Combobox operates on item objects, not strings. Bridge the string
	// API by resolving the selected item from `value` and unwrapping back to a
	// string in onValueChange. Separator entries are layout-only and never match.
	const selectedItem =
		items.find((i): i is Item => "value" in i && i.value === value) ?? null;

	const handleValueChange = useEventCallback((item: ItemOrSeparator | null) => {
		onValueChange(item && "value" in item ? item.value : "");
	});

	return (
		<Combobox2.Root<ItemOrSeparator>
			items={items}
			value={selectedItem}
			onValueChange={handleValueChange}
			itemToStringLabel={(item) => (item && "value" in item ? item.label : "")}
			isItemEqualToValue={(item, val) =>
				"value" in item && "value" in val && item.value === val.value
			}
			filter={(item, query) =>
				"separator" in item ||
				item.label.toLowerCase().includes(query.toLowerCase())
			}
			disabled={disabled}
		>
			<div className={className}>
				<Combobox2.Input placeholder={placeholder} $size={$size} />
			</div>

			<Combobox2.Popup className="w-auto min-w-(--anchor-width) max-w-[min(90vw,32rem)]">
				<Combobox2.Empty>No match</Combobox2.Empty>
				<Combobox2.List<ItemOrSeparator>>
					{(item) =>
						"separator" in item ? (
							<BUICombobox.Separator
								key={item.id}
								className="my-1 h-px bg-border/50"
							/>
						) : (
							<Combobox2.Item
								key={item.value}
								value={item}
								$size={$size}
								className="whitespace-nowrap"
							>
								{item.label}
							</Combobox2.Item>
						)
					}
				</Combobox2.List>
			</Combobox2.Popup>
		</Combobox2.Root>
	);
});
