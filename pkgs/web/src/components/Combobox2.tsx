import { Combobox as BUICombobox } from "@base-ui/react/combobox";
import { Check, ChevronDown, X } from "lucide-react";
import { memo, type ReactNode } from "react";
import { tv } from "tailwind-variants";
import { twm } from "@/utils/tailwind";
import type { PropsWithNativeClassName } from "./types";
export const Combobox2 = {
	Root: memo(ComboboxRoot) as typeof ComboboxRoot,
	Input: memo(ComboboxInput),
	Popup: memo(ComboboxPopup),
	List: memo(ComboboxList) as typeof ComboboxList,
	Item: memo(ComboboxItem),
	Empty: memo(ComboboxEmpty),
};

const variant = tv({
	slots: {
		root: "",
		input: [
			"w-full pl-2 pr-12 border border-border ",
			"bg-muted text-muted-foreground rounded",
			"placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring",
		],
		clear: "",
		trigger: "",
		item: [
			"grid cursor-default grid-cols-[1rem_1fr] items-center gap-2 py-2 px-3 text-sm/none outline-none select-none",
			"data-highlighted:bg-accent/10 data-highlighted:text-foreground",
		],
	},
	variants: {
		$size: {
			sm: {
				input: "text-xs h-7",
				clear: "w-4",
				trigger: "w-4",
				item: "py-1.5 px-2 text-xs",
			},
			md: {
				input: "text-base h-10",
				clear: "w-4",
				trigger: "w-4",
				item: "py-1.5 px-2 text-xs",
			},
		},
	},
	defaultVariants: {
		$size: "md",
	},
});

function ComboboxRoot<T, Multiple extends boolean | undefined = false>({
	children,
	...props
}: BUICombobox.Root.Props<T, Multiple>) {
	return <BUICombobox.Root {...props}>{children}</BUICombobox.Root>;
}

function ComboboxInput({
	className,
	$size,
	clearable = true,
	...props
}: PropsWithNativeClassName<BUICombobox.Input.Props> & {
	$size?: keyof typeof variant.variants.$size;
	/** Hide the clear (✗) button for pickers where an empty value is invalid */
	clearable?: boolean;
}) {
	const styles = variant({ $size });

	return (
		<div className="relative">
			<BUICombobox.Input className={styles.input({ className })} {...props} />

			<div className="absolute right-2 top-1/2 -translate-y-1/2 flex gap-2 h-7 items-center">
				{clearable && (
					<BUICombobox.Clear className={styles.clear()}>
						<X size={16} />
					</BUICombobox.Clear>
				)}

				<BUICombobox.Trigger className={styles.trigger()}>
					<ChevronDown size={16} />
				</BUICombobox.Trigger>
			</div>
		</div>
	);
}

function ComboboxPopup({
	className,
	children,
	sideOffset = 4,
	...props
}: PropsWithNativeClassName<BUICombobox.Popup.Props> & {
	sideOffset?: BUICombobox.Positioner.Props["sideOffset"];
}) {
	return (
		<BUICombobox.Portal>
			<BUICombobox.Positioner
				className={twm("outline-none z-50", className)}
				sideOffset={sideOffset}
			>
				<BUICombobox.Popup
					className={twm(
						"w-(--anchor-width) max-h-[min(var(--available-height),20rem)] max-w-(--available-width)",
						"rounded-lg bg-background/95 backdrop-liquid border border-border shadow-lg",
						"origin-[var(--transform-origin)] transition-all duration-100",
						"data-[starting-style]:opacity-0 data-[starting-style]:scale-95",
						"data-[ending-style]:opacity-0 data-[ending-style]:scale-95",
						className,
					)}
					{...props}
				>
					{children}
				</BUICombobox.Popup>
			</BUICombobox.Positioner>
		</BUICombobox.Portal>
	);
}

function ComboboxList<T>({
	className,
	children,
	...props
}: PropsWithNativeClassName<Omit<BUICombobox.List.Props, "children">> & {
	children: (item: T) => ReactNode;
}) {
	return (
		<BUICombobox.List
			className={twm(
				"overflow-y-auto overscroll-contain py-1 outline-none",
				"max-h-[min(20rem,var(--available-height))]",
				"data-[empty]:p-0",
				className,
			)}
			{...props}
		>
			{children as (item: unknown) => ReactNode}
		</BUICombobox.List>
	);
}

function ComboboxItem({
	className,
	children,
	$size,
	...props
}: PropsWithNativeClassName<BUICombobox.Item.Props> & {
	$size?: keyof typeof variant.variants.$size;
}) {
	const styles = variant({ $size });

	return (
		<BUICombobox.Item className={styles.item({ className })} {...props}>
			<BUICombobox.ItemIndicator className={twm("col-start-1 text-accent")}>
				<Check size={12} />
			</BUICombobox.ItemIndicator>

			<span className="col-start-2">{children}</span>
		</BUICombobox.Item>
	);
}

function ComboboxEmpty({
	className,
	children,
	...props
}: PropsWithNativeClassName<BUICombobox.Empty.Props>) {
	return (
		<BUICombobox.Empty
			className={twm(
				"px-3 py-2 text-xs text-muted-foreground empty:m-0 empty:p-0",
				className,
			)}
			{...props}
		>
			{children}
		</BUICombobox.Empty>
	);
}
