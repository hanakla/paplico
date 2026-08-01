import { type FocusEvent, memo } from "react";
import { useEventCallback } from "@/utils/hooks";
import { twm } from "@/utils/tailwind";
import { Combobox } from "./Combobox";

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

	// Select the whole text on focus so typing replaces the current value
	// (natural type-to-narrow) instead of appending to it. Deferred to the next
	// frame so base-ui's own focus handling (which syncs the input value from the
	// selected item) runs first; selecting synchronously races with it.
	const handleFocus = useEventCallback((e: FocusEvent<HTMLInputElement>) => {
		const input = e.currentTarget;
		requestAnimationFrame(() => input.select());
	});

	const sizeHeight = $size === "sm" ? "h-8" : "h-10";
	const sizeFont = $size === "sm" ? "text-xs" : "text-sm";

	return (
		<Combobox.Root<ItemOrSeparator>
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
			<div className={twm("relative", className)}>
				<Combobox.Input
					placeholder={placeholder}
					onFocus={handleFocus}
					className={twm(sizeHeight, sizeFont)}
				/>
				<div
					className={twm(
						"absolute right-2 bottom-0 flex items-center gap-2",
						sizeHeight,
					)}
				>
					<Combobox.Clear className={sizeHeight} />
					<Combobox.Trigger className={sizeHeight} />
				</div>
			</div>

			<Combobox.Portal>
				<Combobox.Positioner>
					<Combobox.Popup className="w-auto min-w-(--anchor-width) max-w-[min(90vw,32rem)]">
						<Combobox.Empty>No match</Combobox.Empty>
						<Combobox.List<ItemOrSeparator>>
							{(item) =>
								"separator" in item ? (
									<Combobox.Separator key={item.id} />
								) : (
									<Combobox.Item key={item.value} value={item}>
										<Combobox.ItemIndicator />
										<span className="col-start-2 whitespace-nowrap">
											{item.label}
										</span>
									</Combobox.Item>
								)
							}
						</Combobox.List>
					</Combobox.Popup>
				</Combobox.Positioner>
			</Combobox.Portal>
		</Combobox.Root>
	);
});
