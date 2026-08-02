import { Dialog as BUIDialog } from "@base-ui/react/dialog";
import { memo, type ReactNode } from "react";
import { twm } from "@/utils/tailwind";
import type { PropsWithNativeClassName } from "./types";

export const Dialog = {
	Root: memo(DialogRoot),
	Trigger: memo(DialogTrigger),
	Content: memo(DialogContent),
	Title: memo(DialogTitle),
	Description: memo(DialogDescription),
	Close: memo(DialogClose),
};

function DialogRoot({
	children,
	open,
	onOpenChange,
}: {
	children: ReactNode;
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
}) {
	return (
		<BUIDialog.Root open={open} onOpenChange={onOpenChange}>
			{children}
		</BUIDialog.Root>
	);
}

function DialogTrigger({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<BUIDialog.Trigger
			className={twm("outline-none", className)}
			render={children as React.ReactElement}
		/>
	);
}

function DialogContent({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<BUIDialog.Portal>
			<BUIDialog.Backdrop
				className={twm(
					"fixed inset-0 min-h-dvh bg-background/30 backdrop-blur-xs",
					"transition-opacity duration-150",
					"data-starting-style]:opacity-0 data-ending-style:opacity-0",
				)}
			/>
			<BUIDialog.Popup
				className={twm(
					"fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2",
					"w-[400px] max-w-[calc(100vw-3rem)]",
					"rounded-lg bg-background/95 backdrop-liquid border border-border/50 p-6 shadow-xl",
					"outline-none",
					"transition-all duration-150",
					"data-[starting-style]:opacity-0 data-[starting-style]:scale-95",
					"data-[ending-style]:opacity-0 data-[ending-style]:scale-95",
					className,
				)}
			>
				{children}
			</BUIDialog.Popup>
		</BUIDialog.Portal>
	);
}

function DialogTitle({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<BUIDialog.Title
			className={twm("text-lg font-medium text-foreground mb-2", className)}
		>
			{children}
		</BUIDialog.Title>
	);
}

function DialogDescription({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<BUIDialog.Description
			className={twm("text-sm text-muted-foreground mb-6", className)}
		>
			{children}
		</BUIDialog.Description>
	);
}

function DialogClose({
	className,
	...props
}: PropsWithNativeClassName<BUIDialog.Close.Props>) {
	return (
		<BUIDialog.Close className={twm("outline-none", className)} {...props} />
	);
}
