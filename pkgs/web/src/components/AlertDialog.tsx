import { AlertDialog as BUIAlertDialog } from "@base-ui/react/alert-dialog";
import { memo } from "react";
import { createCallable } from "react-call";
import { Button } from "@/components/Button";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";
import { twm } from "@/utils/tailwind";
import type { PropsWithNativeClassName } from "./types";

export const AlertDialog = {
	Root: BUIAlertDialog.Root,
	Trigger: memo(AlertDialogTrigger),
	Portal: BUIAlertDialog.Portal,
	Backdrop: memo(AlertDialogBackdrop),
	Viewport: memo(AlertDialogViewport),
	Popup: memo(AlertDialogPopup),
	Title: memo(AlertDialogTitle),
	Description: memo(AlertDialogDescription),
	Close: memo(AlertDialogClose),
	createHandle: BUIAlertDialog.createHandle,
};

function AlertDialogTrigger({
	className,
	children,
	...props
}: PropsWithNativeClassName<BUIAlertDialog.Trigger.Props>) {
	return (
		<BUIAlertDialog.Trigger
			className={twm(
				"flex h-10 items-center justify-center rounded-md px-3.5 text-sm font-medium select-none",
				"bg-muted/50 text-foreground",
				"hover:bg-muted/80",
				"focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-accent",
				"active:bg-muted",
				"data-[disabled]:opacity-50 data-[disabled]:pointer-events-none",
				className,
			)}
			{...props}
		>
			{children}
		</BUIAlertDialog.Trigger>
	);
}

function AlertDialogBackdrop({
	className,
	...props
}: PropsWithNativeClassName<BUIAlertDialog.Backdrop.Props>) {
	return (
		<BUIAlertDialog.Backdrop
			className={twm(
				"fixed inset-0 min-h-dvh bg-black/50 transition-opacity duration-150",
				"data-[starting-style]:opacity-0",
				"data-[ending-style]:opacity-0",
				"supports-[-webkit-touch-callout:none]:absolute",
				className,
			)}
			{...props}
		/>
	);
}

function AlertDialogViewport({
	className,
	children,
	...props
}: PropsWithNativeClassName<BUIAlertDialog.Viewport.Props>) {
	return (
		<BUIAlertDialog.Viewport
			className={twm("fixed inset-0 overflow-y-auto", className)}
			{...props}
		>
			{children}
		</BUIAlertDialog.Viewport>
	);
}

function AlertDialogPopup({
	className,
	children,
	...props
}: PropsWithNativeClassName<BUIAlertDialog.Popup.Props>) {
	return (
		<BUIAlertDialog.Popup
			className={twm(
				"fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2",
				"w-96 max-w-[calc(100vw-3rem)] -mt-8 p-6 rounded-lg",
				"bg-background/95 backdrop-liquid border border-border/50 shadow-lg",
				"text-foreground",
				"transition-all duration-150",
				"data-[starting-style]:opacity-0 data-[starting-style]:scale-90",
				"data-[ending-style]:opacity-0 data-[ending-style]:scale-90",
				"data-[nested-dialog-open]:after:absolute data-[nested-dialog-open]:after:inset-0",
				"data-[nested-dialog-open]:after:rounded-[inherit] data-[nested-dialog-open]:after:bg-black/5",
				className,
			)}
			{...props}
		>
			{children}
		</BUIAlertDialog.Popup>
	);
}

function AlertDialogTitle({
	className,
	children,
	...props
}: PropsWithNativeClassName<BUIAlertDialog.Title.Props>) {
	return (
		<BUIAlertDialog.Title
			className={twm(
				"-mt-1.5 mb-1 text-lg font-medium text-foreground",
				className,
			)}
			{...props}
		>
			{children}
		</BUIAlertDialog.Title>
	);
}

function AlertDialogDescription({
	className,
	children,
	...props
}: PropsWithNativeClassName<BUIAlertDialog.Description.Props>) {
	return (
		<BUIAlertDialog.Description
			className={twm("mb-6 text-sm text-muted-foreground", className)}
			{...props}
		>
			{children}
		</BUIAlertDialog.Description>
	);
}

function AlertDialogClose({
	className,
	children,
	...props
}: PropsWithNativeClassName<BUIAlertDialog.Close.Props>) {
	return (
		<BUIAlertDialog.Close
			className={twm(
				"flex h-10 items-center justify-center rounded-md px-3.5 text-sm font-medium select-none",
				"bg-muted/50 text-foreground",
				"hover:bg-muted/80",
				"focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-accent",
				"active:bg-muted",
				"data-[disabled]:opacity-50 data-[disabled]:pointer-events-none",
				className,
			)}
			{...props}
		>
			{children}
		</BUIAlertDialog.Close>
	);
}

// --- react-call confirm dialog ---

export const ConfirmDialog = createCallable<
	{
		title?: string;
		description: string;
		confirmLabel?: string;
		cancelLabel?: string;
		destructive?: boolean;
	},
	boolean
>(({ call, title, description, confirmLabel, cancelLabel, destructive }) => {
	const t = useTranslation();

	const handleConfirm = useEventCallback(() => call.end(true));
	const handleCancel = useEventCallback(() => call.end(false));
	const handleOpenChange = useEventCallback((open: boolean) => {
		if (!open) call.end(false);
	});

	return (
		<AlertDialog.Root open onOpenChange={handleOpenChange}>
			<AlertDialog.Portal>
				<AlertDialog.Backdrop />
				<AlertDialog.Popup>
					{title && <AlertDialog.Title>{title}</AlertDialog.Title>}
					<AlertDialog.Description>{description}</AlertDialog.Description>
					<div className="flex items-center justify-end gap-2">
						<Button $variant="ghost" $size="sm" onClick={handleCancel}>
							{cancelLabel ?? t("common.cancel")}
						</Button>
						<Button
							$variant={destructive ? "destructive" : "default"}
							$size="sm"
							onClick={handleConfirm}
						>
							{confirmLabel ?? t("common.ok")}
						</Button>
					</div>
				</AlertDialog.Popup>
			</AlertDialog.Portal>
		</AlertDialog.Root>
	);
});
