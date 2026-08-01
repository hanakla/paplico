import { Select as BUISelect } from "@base-ui/react/select";
import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";

export function Select({
	value,
	onValueChange,
	placeholder,
	children,
}: {
	value: string;
	onValueChange: (value: string) => void;
	placeholder?: string;
	children: ReactNode;
}) {
	return (
		<BUISelect.Root value={value} onValueChange={onValueChange}>
			<BUISelect.Trigger className="flex items-center gap-1 rounded border border-border bg-surface-hover px-2 py-1 text-xs text-foreground">
				<BUISelect.Value placeholder={placeholder} />
				<ChevronDown size={12} />
			</BUISelect.Trigger>
			<BUISelect.Portal>
				<BUISelect.Positioner>
					<BUISelect.Popup className="rounded border border-border bg-surface-hover py-1 shadow-lg">
						{children}
					</BUISelect.Popup>
				</BUISelect.Positioner>
			</BUISelect.Portal>
		</BUISelect.Root>
	);
}

export function SelectItem({
	value,
	children,
}: {
	value: string;
	children: ReactNode;
}) {
	return (
		<BUISelect.Item
			value={value}
			className="cursor-pointer px-3 py-1 text-xs text-foreground hover:bg-surface-active data-highlighted:bg-surface-active"
		>
			<BUISelect.ItemText>{children}</BUISelect.ItemText>
		</BUISelect.Item>
	);
}
