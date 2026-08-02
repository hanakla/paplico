import { ContextMenu as BUIContextMenu } from "@base-ui/react/context-menu";
import { ChevronRight } from "lucide-react";
import { memo } from "react";
import { twm } from "@/utils/tailwind";
import type { PropsWithNativeClassName } from "./types";

export const ContextMenu = {
	Root: memo(ContextMenuRoot),
	Trigger: memo(ContextMenuTrigger),
	Portal: BUIContextMenu.Portal,
	Positioner: memo(ContextMenuPositioner),
	Popup: memo(ContextMenuPopup),
	Item: memo(ContextMenuItem),
	Separator: memo(ContextMenuSeparator),
	Group: memo(ContextMenuGroup),
	GroupLabel: memo(ContextMenuGroupLabel),
	SubmenuRoot: BUIContextMenu.SubmenuRoot,
	SubmenuTrigger: memo(ContextMenuSubmenuTrigger),
};

function ContextMenuRoot({ children, ...props }: BUIContextMenu.Root.Props) {
	return <BUIContextMenu.Root {...props}>{children}</BUIContextMenu.Root>;
}

function ContextMenuTrigger({
	className,
	children,
	...props
}: PropsWithNativeClassName<BUIContextMenu.Trigger.Props>) {
	return (
		<BUIContextMenu.Trigger
			className={twm("select-none", className)}
			{...props}
		>
			{children}
		</BUIContextMenu.Trigger>
	);
}

function ContextMenuPositioner({
	className,
	...props
}: PropsWithNativeClassName<BUIContextMenu.Positioner.Props>) {
	return (
		<BUIContextMenu.Positioner
			className={twm("outline-none z-50", className)}
			{...props}
		/>
	);
}

function ContextMenuPopup({
	className,
	children,
	...props
}: PropsWithNativeClassName<BUIContextMenu.Popup.Props>) {
	return (
		<BUIContextMenu.Popup
			className={twm(
				"min-w-[180px] rounded-lg bg-background/95 backdrop-liquid border border-border/50 py-1 shadow-lg",
				"origin-[var(--transform-origin)] transition-opacity",
				"data-[ending-style]:opacity-0",
				className,
			)}
			{...props}
		>
			{children}
		</BUIContextMenu.Popup>
	);
}

function ContextMenuItem({
	className,
	children,
	...props
}: PropsWithNativeClassName<BUIContextMenu.Item.Props>) {
	return (
		<BUIContextMenu.Item
			className={twm(
				"flex cursor-default py-2 px-3 text-sm text-foreground outline-none select-none",
				"data-[highlighted]:bg-accent/10",
				"data-[disabled]:opacity-50 data-[disabled]:pointer-events-none",
				className,
			)}
			{...props}
		>
			{children}
		</BUIContextMenu.Item>
	);
}

function ContextMenuSeparator({
	className,
	...props
}: PropsWithNativeClassName<BUIContextMenu.Separator.Props>) {
	return (
		<BUIContextMenu.Separator
			className={twm("mx-2 my-1 h-px bg-border/50", className)}
			{...props}
		/>
	);
}

function ContextMenuGroup({
	className,
	children,
	...props
}: PropsWithNativeClassName<BUIContextMenu.Group.Props>) {
	return (
		<BUIContextMenu.Group className={className} {...props}>
			{children}
		</BUIContextMenu.Group>
	);
}

function ContextMenuGroupLabel({
	className,
	children,
	...props
}: PropsWithNativeClassName<BUIContextMenu.GroupLabel.Props>) {
	return (
		<BUIContextMenu.GroupLabel
			className={twm(
				"px-3 py-1.5 text-xs font-medium text-muted-foreground",
				className,
			)}
			{...props}
		>
			{children}
		</BUIContextMenu.GroupLabel>
	);
}

function ContextMenuSubmenuTrigger({
	className,
	children,
	...props
}: PropsWithNativeClassName<BUIContextMenu.SubmenuTrigger.Props>) {
	return (
		<BUIContextMenu.SubmenuTrigger
			className={twm(
				"flex cursor-default items-center justify-between gap-4 py-2 px-3 text-sm text-foreground outline-none select-none",
				"data-[highlighted]:bg-accent/10",
				"data-[popup-open]:bg-muted/50",
				"data-[disabled]:opacity-50 data-[disabled]:pointer-events-none",
				className,
			)}
			{...props}
		>
			{children}
			<ChevronRight size={12} />
		</BUIContextMenu.SubmenuTrigger>
	);
}
