import { Menu as BUIMenu } from "@base-ui/react/menu";
import { ChevronRight } from "lucide-react";
import { memo } from "react";
import { twm } from "@/utils/tailwind";
import type { PropsWithNativeClassName } from "./types";

export const Menu = {
	Root: memo(MenuRoot),
	Trigger: memo(MenuTrigger),
	Portal: BUIMenu.Portal,
	Positioner: memo(MenuPositioner),
	Popup: memo(MenuPopup),
	Item: memo(MenuItem),
	CheckboxItem: memo(MenuCheckboxItem),
	CheckboxItemIndicator: BUIMenu.CheckboxItemIndicator,
	RadioGroup: BUIMenu.RadioGroup,
	RadioItem: memo(MenuRadioItem),
	RadioItemIndicator: BUIMenu.RadioItemIndicator,
	Separator: memo(MenuSeparator),
	Group: BUIMenu.Group,
	GroupLabel: memo(MenuGroupLabel),
	SubmenuRoot: BUIMenu.SubmenuRoot,
	SubmenuTrigger: memo(MenuSubmenuTrigger),
};

function MenuRoot({ children, ...props }: BUIMenu.Root.Props) {
	return <BUIMenu.Root {...props}>{children}</BUIMenu.Root>;
}

function MenuTrigger({
	className,
	children,
	...props
}: PropsWithNativeClassName<BUIMenu.Trigger.Props>) {
	return (
		<BUIMenu.Trigger
			className={twm(
				"px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground hover:bg-muted rounded transition-colors data-popup-open:bg-muted data-popup-open:text-foreground",
				className,
			)}
			{...props}
		>
			{children}
		</BUIMenu.Trigger>
	);
}

function MenuPositioner({
	className,
	...props
}: PropsWithNativeClassName<BUIMenu.Positioner.Props>) {
	return (
		<BUIMenu.Positioner className={twm("outline-none", className)} {...props} />
	);
}

function MenuPopup({
	className,
	children,
	...props
}: PropsWithNativeClassName<BUIMenu.Popup.Props>) {
	return (
		<BUIMenu.Popup
			className={twm(
				"min-w-[180px] rounded-lg bg-background/80 backdrop-liquid border border-border/50 p-1 shadow-lg outline-none",
				"origin-(--transform-origin) transition-opacity",
				"data-ending-style:opacity-0",
				className,
			)}
			{...props}
		>
			{children}
		</BUIMenu.Popup>
	);
}

function MenuItem({
	className,
	children,
	...props
}: PropsWithNativeClassName<BUIMenu.Item.Props>) {
	return (
		<BUIMenu.Item
			className={twm(
				"flex cursor-default items-center gap-2 rounded px-3 py-1.5 text-sm text-foreground outline-none select-none",
				"not-hover:data-highlighted:bg-muted hover:bg-muted-hover",
				"data-disabled:pointer-events-none data-disabled:opacity-50",
				className,
			)}
			{...props}
		>
			{children}
		</BUIMenu.Item>
	);
}

function MenuCheckboxItem({
	className,
	children,
	...props
}: PropsWithNativeClassName<BUIMenu.CheckboxItem.Props>) {
	return (
		<BUIMenu.CheckboxItem
			className={twm(
				"flex cursor-default items-center gap-2 rounded px-3 py-1.5 text-sm text-foreground outline-none select-none",
				"not-hover:data-highlighted:bg-muted hover:bg-muted-hover",
				"data-disabled:pointer-events-none data-disabled:opacity-50",
				className,
			)}
			{...props}
		>
			{children}
		</BUIMenu.CheckboxItem>
	);
}

function MenuRadioItem({
	className,
	children,
	...props
}: PropsWithNativeClassName<BUIMenu.RadioItem.Props>) {
	return (
		<BUIMenu.RadioItem
			className={twm(
				"flex cursor-default items-center gap-2 rounded px-3 py-1.5 text-sm text-foreground outline-none select-none",
				"not-hover:data-highlighted:bg-muted hover:bg-muted-hover",
				"data-disabled:pointer-events-none data-disabled:opacity-50",
				className,
			)}
			{...props}
		>
			{children}
		</BUIMenu.RadioItem>
	);
}

function MenuSeparator({
	className,
	...props
}: PropsWithNativeClassName<BUIMenu.Separator.Props>) {
	return (
		<BUIMenu.Separator
			className={twm("mx-2 my-1 h-px bg-border/50", className)}
			{...props}
		/>
	);
}

function MenuGroupLabel({
	className,
	children,
	...props
}: PropsWithNativeClassName<BUIMenu.GroupLabel.Props>) {
	return (
		<BUIMenu.GroupLabel
			className={twm(
				"px-3 py-1.5 text-xs font-medium text-muted-foreground",
				className,
			)}
			{...props}
		>
			{children}
		</BUIMenu.GroupLabel>
	);
}

function MenuSubmenuTrigger({
	className,
	children,
	...props
}: PropsWithNativeClassName<BUIMenu.SubmenuTrigger.Props>) {
	return (
		<BUIMenu.SubmenuTrigger
			className={twm(
				"flex cursor-default items-center justify-between gap-4 rounded px-3 py-1.5 text-sm text-foreground outline-none select-none",
				"not-hover:data-highlighted:bg-muted hover:bg-muted-hover",
				"not-hover:data-popup-open:bg-muted",
				"data-disabled:pointer-events-none data-disabled:opacity-50",
				className,
			)}
			{...props}
		>
			{children}
			<ChevronRight size={12} />
		</BUIMenu.SubmenuTrigger>
	);
}
