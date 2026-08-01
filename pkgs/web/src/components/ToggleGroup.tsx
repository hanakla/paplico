import { Toggle as BUIToggle } from "@base-ui/react/toggle";
import { ToggleGroup as BUIToggleGroup } from "@base-ui/react/toggle-group";
import { memo } from "react";
import { twm } from "@/utils/tailwind";
import type { PropsWithNativeClassName } from "./types";

export const ToggleGroup = {
	Root: memo(ToggleGroupRoot),
	Item: memo(ToggleItem),
};

function ToggleGroupRoot({
	children,
	className,
	...props
}: PropsWithNativeClassName<BUIToggleGroup.Props>) {
	return (
		<BUIToggleGroup
			className={twm(
				"flex w-max gap-px rounded-md border border-border bg-muted/30 p-0.5",
				"data-[orientation=vertical]:flex-col",
				"data-disabled:opacity-50",
				className,
			)}
			{...props}
		>
			{children}
		</BUIToggleGroup>
	);
}

function ToggleItem({
	children,
	className,
	...props
}: PropsWithNativeClassName<BUIToggle.Props>) {
	return (
		<BUIToggle
			className={twm(
				"flex size-8 items-center justify-center rounded-sm select-none",
				"text-muted-foreground",
				"hover:bg-muted-hover hover:text-foreground",
				"focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-accent",
				"active:bg-muted-active",
				"data-pressed:bg-muted-active data-pressed:text-foreground",
				"data-disabled:opacity-50 data-disabled:pointer-events-none",
				className,
			)}
			{...props}
		>
			{children}
		</BUIToggle>
	);
}
