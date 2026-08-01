import { Select as BUISelect } from "@base-ui/react/select";
import { ChevronDown } from "lucide-react";
import { memo } from "react";
import { tv } from "tailwind-variants";
import { twm } from "@/utils/tailwind";
import { Select } from "./Select";
import type { PropsWithNativeClassName } from "./types";

const fakeSelectStyles = tv({
	base: [
		"flex w-fit max-w-full items-center gap-0.5 cursor-pointer text-inherit",
		"rounded-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-accent",
		"disabled:cursor-not-allowed disabled:opacity-50",
	],
	variants: {
		$size: {
			xs: "text-[11px]",
			sm: "text-xs",
			md: "text-sm",
			lg: "text-base",
		},
	},
	defaultVariants: {
		$size: "md",
	},
});

type FakeSelectProps<T, Multiple extends boolean> = PropsWithNativeClassName<
	Pick<
		BUISelect.Root.Props<T, Multiple>,
		"value" | "onValueChange" | "disabled"
	>
> & {
	items: ReadonlyArray<{ label: string; value: string }>;
	$size?: keyof typeof fakeSelectStyles.variants.$size;
};

/**
 * Select rendered as inline dotted-underline text — FakeInput's counterpart
 * for select boxes. Clicking the label opens the regular select popup.
 */
export const FakeSelect = memo(FakeSelectRoot) as typeof FakeSelectRoot;

function FakeSelectRoot<T, Multiple extends boolean>({
	items,
	value,
	onValueChange,
	disabled,
	className,
	$size,
}: FakeSelectProps<T, Multiple>) {
	return (
		<Select.Root
			value={value}
			onValueChange={onValueChange}
			disabled={disabled}
			items={items}
		>
			<BUISelect.Trigger
				className={twm(fakeSelectStyles({ $size }), className)}
			>
				<Select.Value
					className="min-w-0 truncate underline decoration-dotted"
					placeholder="Select..."
				/>
				<ChevronDown size={10} className="shrink-0 text-muted-foreground" />
			</BUISelect.Trigger>
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
