import { Combobox as BUICombobox } from "@base-ui/react/combobox";
import { Check, ChevronDown, X } from "lucide-react";
import { memo, type ReactNode } from "react";
import { twm } from "@/utils/tailwind";
import type { PropsWithNativeClassName } from "./types";
export const Combobox = {
	Root: memo(ComboboxRoot) as typeof ComboboxRoot,
	Input: memo(ComboboxInput),
	Trigger: memo(ComboboxTrigger),
	Clear: memo(ComboboxClear),
	Portal: BUICombobox.Portal,
	Positioner: memo(ComboboxPositioner),
	Popup: memo(ComboboxPopup),
	List: memo(ComboboxList) as typeof ComboboxList,
	Item: memo(ComboboxItem),
	ItemIndicator: memo(ComboboxItemIndicator),
	Separator: memo(ComboboxSeparator),
	Empty: memo(ComboboxEmpty),
};

function ComboboxRoot<T, Multiple extends boolean | undefined = false>({
	children,
	...props
}: BUICombobox.Root.Props<T, Multiple>) {
	return <BUICombobox.Root {...props}>{children}</BUICombobox.Root>;
}

function ComboboxInput({
	className,
	...props
}: PropsWithNativeClassName<BUICombobox.Input.Props>) {
	return (
		<BUICombobox.Input
			className={twm(
				"h-10 w-full rounded-md border border-border bg-transparent pl-3 pr-16 text-sm text-foreground placeholder:text-muted-foreground",
				"focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent",
				className,
			)}
			{...props}
		/>
	);
}

function ComboboxTrigger({
	className,
	children,
	...props
}: PropsWithNativeClassName<BUICombobox.Trigger.Props>) {
	return (
		<BUICombobox.Trigger
			className={twm(
				"flex h-10 w-6 items-center justify-center text-muted-foreground hover:text-foreground",
				className,
			)}
			aria-label="Open popup"
			{...props}
		>
			{children ?? <ChevronDown size={16} />}
		</BUICombobox.Trigger>
	);
}

function ComboboxClear({
	className,
	children,
	...props
}: PropsWithNativeClassName<BUICombobox.Clear.Props>) {
	return (
		<BUICombobox.Clear
			className={twm(
				"flex h-10 w-6 items-center justify-center text-muted-foreground hover:text-foreground",
				className,
			)}
			aria-label="Clear selection"
			{...props}
		>
			{children ?? <X size={16} />}
		</BUICombobox.Clear>
	);
}

function ComboboxPositioner({
	className,
	sideOffset = 4,
	...props
}: PropsWithNativeClassName<BUICombobox.Positioner.Props>) {
	return (
		<BUICombobox.Positioner
			className={twm("outline-none z-50", className)}
			sideOffset={sideOffset}
			{...props}
		/>
	);
}

function ComboboxPopup({
	className,
	children,
	...props
}: PropsWithNativeClassName<BUICombobox.Popup.Props>) {
	return (
		<BUICombobox.Popup
			className={twm(
				"w-(--anchor-width) max-h-[min(var(--available-height),20rem)] max-w-(--available-width)",
				"rounded-lg bg-background/95 backdrop-liquid border border-border/50 shadow-lg",
				"origin-[var(--transform-origin)] transition-all duration-100",
				"data-[starting-style]:opacity-0 data-[starting-style]:scale-95",
				"data-[ending-style]:opacity-0 data-[ending-style]:scale-95",
				className,
			)}
			{...props}
		>
			{children}
		</BUICombobox.Popup>
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
	...props
}: PropsWithNativeClassName<BUICombobox.Item.Props>) {
	return (
		<BUICombobox.Item
			className={twm(
				"grid cursor-default grid-cols-[1rem_1fr] items-center gap-2 py-2 px-3 text-sm/none outline-none select-none",
				"data-highlighted:bg-accent/10 data-highlighted:text-foreground",
				className,
			)}
			{...props}
		>
			{children}
		</BUICombobox.Item>
	);
}

function ComboboxItemIndicator({
	className,
	children,
	...props
}: PropsWithNativeClassName<BUICombobox.ItemIndicator.Props>) {
	return (
		<BUICombobox.ItemIndicator
			className={twm("col-start-1 text-accent", className)}
			{...props}
		>
			{children ?? <Check size={12} />}
		</BUICombobox.ItemIndicator>
	);
}

function ComboboxSeparator({
	className,
	...props
}: PropsWithNativeClassName<BUICombobox.Separator.Props>) {
	return (
		<BUICombobox.Separator
			className={twm("my-1 h-px bg-border/50", className)}
			{...props}
		/>
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
