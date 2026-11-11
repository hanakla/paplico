import { Select as BUISelect } from "@base-ui/react/select";
import { Check, ChevronDown } from "lucide-react";
import { memo, type ReactNode } from "react";
import { tv } from "tailwind-variants";
import { twm } from "@/utils/tailwind";

const selectTriggerVariants = tv({
	base: [
		"flex w-full items-center justify-between gap-2 rounded-md border border-border bg-transparent text-foreground",
		"focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent",
		"disabled:cursor-not-allowed disabled:opacity-50",
	],
	variants: {
		$size: {
			xs: "h-6 px-1.5 text-xs",
			sm: "h-8 px-2.5 text-xs",
			md: "h-9 px-3 text-sm",
			lg: "h-10 px-3.5 text-sm",
		},
	},
	defaultVariants: {
		$size: "md",
	},
});

const selectItemVariants = tv({
	base: [
		"grid cursor-default items-center outline-none select-none",
		"data-highlighted:bg-accent/10 data-highlighted:text-foreground",
	],
	variants: {
		$size: {
			xs: "grid-cols-[0.75rem_1fr] gap-1.5 py-1 px-1.5 text-xs",
			sm: "grid-cols-[1rem_1fr] gap-2 py-2 px-3 text-sm/none",
			md: "grid-cols-[1rem_1fr] gap-2 py-2 px-3 text-sm/none",
			lg: "grid-cols-[1rem_1fr] gap-2 py-2 px-3 text-sm/none",
		},
	},
	defaultVariants: {
		$size: "md",
	},
});

export type SelectSize = keyof typeof selectTriggerVariants.variants.$size;

export const Select = {
	Root: BUISelect.Root,
	Trigger: memo(SelectTrigger),
	Value: BUISelect.Value,
	Icon: memo(SelectIcon),
	Portal: BUISelect.Portal,
	Positioner: memo(SelectPositioner),
	Popup: memo(SelectPopup),
	Item: memo(SelectItem),
	ItemIndicator: memo(SelectItemIndicator),
	ItemText: BUISelect.ItemText,
};

function SelectTrigger({
	className,
	children,
	$size,
}: {
	className?: string;
	children: ReactNode;
	$size?: SelectSize;
}) {
	return (
		<BUISelect.Trigger
			className={twm(selectTriggerVariants({ $size }), className)}
		>
			{children}
		</BUISelect.Trigger>
	);
}

function SelectIcon({ className }: { className?: string }) {
	return (
		<BUISelect.Icon
			className={twm("shrink-0 text-muted-foreground", className)}
			render={<ChevronDown size={14} />}
		/>
	);
}

function SelectPositioner({
	className,
	children,
	sideOffset = 4,
}: {
	className?: string;
	children: ReactNode;
	sideOffset?: number;
}) {
	return (
		<BUISelect.Positioner
			className={twm("outline-none z-[9999]", className)}
			sideOffset={sideOffset}
		>
			{children}
		</BUISelect.Positioner>
	);
}

function SelectPopup({
	className,
	children,
}: {
	className?: string;
	children: ReactNode;
}) {
	return (
		<BUISelect.Popup
			className={twm(
				"min-w-(--anchor-width) max-w-[min(90vw,32rem)] max-h-[min(var(--available-height),20rem)]",
				"rounded-lg bg-background/95 backdrop-liquid border border-border/50 shadow-lg",
				"overflow-y-auto overscroll-contain py-1 outline-none",
				"origin-(--transform-origin) transition-all duration-100",
				"data-starting-style:opacity-0 data-starting-style:scale-95",
				"data-ending-style:opacity-0 data-ending-style:scale-95",
				className,
			)}
		>
			{children}
		</BUISelect.Popup>
	);
}

function SelectItem({
	className,
	children,
	value,
	$size,
}: {
	className?: string;
	children: ReactNode;
	value: string;
	$size?: SelectSize;
}) {
	return (
		<BUISelect.Item
			className={twm(selectItemVariants({ $size }), className)}
			value={value}
		>
			{children}
		</BUISelect.Item>
	);
}

function SelectItemIndicator({
	className,
	$size,
}: {
	className?: string;
	$size?: SelectSize;
}) {
	return (
		<BUISelect.ItemIndicator
			className={twm("col-start-1 text-accent", className)}
		>
			<Check size={$size === "xs" ? 10 : 12} />
		</BUISelect.ItemIndicator>
	);
}
