"use client";
// Usage:
//   import { toastManager } from "@/components/Toast";
//   toastManager.add({ title: "Saved", description: "Your changes were saved." });

import { Toast as BUIToast } from "@base-ui/react/toast";
import { X } from "lucide-react";
import { memo } from "react";
import { twm } from "@/utils/tailwind";
import type { PropsWithNativeClassName } from "./types";

/** Singleton manager — use this to add toasts from anywhere, including outside React. */
export const toastManager = BUIToast.createToastManager();

export const Toast = {
	Provider: memo(ToastProvider),
	Portal: BUIToast.Portal,
	Viewport: memo(ToastViewport),
	Root: memo(ToastRoot),
	Content: memo(ToastContent),
	Title: memo(ToastTitle),
	Description: memo(ToastDescription),
	Action: memo(ToastAction),
	Close: memo(ToastClose),
	useToastManager: BUIToast.useToastManager,
};

function ToastProvider({
	children,
	...props
}: Omit<BUIToast.Provider.Props, "toastManager">) {
	return (
		<BUIToast.Provider toastManager={toastManager} {...props}>
			{children}
		</BUIToast.Provider>
	);
}

function ToastViewport({
	className,
	...props
}: PropsWithNativeClassName<BUIToast.Viewport.Props>) {
	return (
		<BUIToast.Viewport
			className={twm(
				"fixed top-[calc(2.5rem+var(--spacing-safe-top)+0.5rem)] left-1/2 z-50 flex w-[calc(100vw-2rem)] max-w-[360px] -translate-x-1/2 outline-none sm:w-[360px]",
				className,
			)}
			{...props}
		/>
	);
}

function ToastRoot({
	className,
	children,
	...props
}: PropsWithNativeClassName<BUIToast.Root.Props>) {
	return (
		<BUIToast.Root
			className={twm(
				"[--gap:0.75rem] [--peek:0.75rem] [--scale:calc(max(0,1-(var(--toast-index)*0.08)))] [--shrink:calc(1-var(--scale))] [--height:var(--toast-frontmost-height,var(--toast-height))] [--offset-y:calc(var(--toast-offset-y)+calc(var(--toast-index)*var(--gap))+var(--toast-swipe-movement-y))]",
				"absolute inset-x-0 top-0 z-[calc(1000-var(--toast-index))] w-full origin-top",
				"[transform:translateX(var(--toast-swipe-movement-x))_translateY(calc(var(--toast-swipe-movement-y)+(var(--toast-index)*var(--peek))+(var(--shrink)*var(--height))))_scale(var(--scale))]",
				"h-(--height) transition-[transform,opacity,height] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)]",
				"rounded-[1.75rem] border border-border bg-background/60 bg-clip-padding px-6 py-3 pr-12 shadow-lg backdrop-liquid outline-none select-none",
				"after:absolute after:top-full after:left-0 after:h-[calc(var(--gap)+1px)] after:w-full after:content-['']",
				"data-expanded:h-(--toast-height) data-expanded:[transform:translateX(var(--toast-swipe-movement-x))_translateY(var(--offset-y))]",
				"data-limited:opacity-0 data-ending-style:opacity-0 data-starting-style:translate-y-[-150%]",
				"[&[data-ending-style]:not([data-limited]):not([data-swipe-direction])]:translate-y-[-150%]",
				"data-ending-style:data-[swipe-direction=down]:translate-y-[calc(var(--toast-swipe-movement-y)+150%)]",
				"data-expanded:data-ending-style:data-[swipe-direction=down]:translate-y-[calc(var(--toast-swipe-movement-y)+150%)]",
				"data-ending-style:data-[swipe-direction=left]:translate-x-[calc(var(--toast-swipe-movement-x)-150%)] data-ending-style:data-[swipe-direction=left]:translate-y-(--offset-y)",
				"data-expanded:data-ending-style:data-[swipe-direction=left]:translate-x-[calc(var(--toast-swipe-movement-x)-150%)] data-expanded:data-ending-style:data-[swipe-direction=left]:translate-y-(--offset-y)",
				"data-ending-style:data-[swipe-direction=right]:translate-x-[calc(var(--toast-swipe-movement-x)+150%)] data-ending-style:data-[swipe-direction=right]:translate-y-(--offset-y)",
				"data-expanded:data-ending-style:data-[swipe-direction=right]:translate-x-[calc(var(--toast-swipe-movement-x)+150%)] data-expanded:data-ending-style:data-[swipe-direction=right]:translate-y-(--offset-y)",
				"data-ending-style:data-[swipe-direction=up]:translate-y-[calc(var(--toast-swipe-movement-y)-150%)]",
				"data-expanded:data-ending-style:data-[swipe-direction=up]:translate-y-[calc(var(--toast-swipe-movement-y)-150%)]",
				"data-[type=warning]:border-warn data-[type=warning]:bg-warn/60",
				"data-[type=info]:border-accent data-[type=info]:bg-accent/60",
				"data-[type=error]:border-danger data-[type=error]:bg-danger/60",
				className,
			)}
			{...props}
		>
			{children}
		</BUIToast.Root>
	);
}

function ToastContent({
	className,
	...props
}: PropsWithNativeClassName<BUIToast.Content.Props>) {
	return (
		<BUIToast.Content
			className={twm(
				"overflow-hidden transition-opacity duration-250",
				"data-behind:pointer-events-none data-behind:opacity-0",
				"data-expanded:pointer-events-auto data-expanded:opacity-100",
				className,
			)}
			{...props}
		/>
	);
}

function ToastTitle({
	className,
	...props
}: PropsWithNativeClassName<BUIToast.Title.Props>) {
	return (
		<BUIToast.Title
			className={twm(
				"text-sm leading-5 font-medium text-foreground",
				"data-[type=warning]:text-warn-foreground",
				"data-[type=info]:text-accent-foreground",
				"data-[type=error]:text-danger-foreground",
				className,
			)}
			{...props}
		/>
	);
}

function ToastDescription({
	className,
	...props
}: PropsWithNativeClassName<BUIToast.Description.Props>) {
	return (
		<BUIToast.Description
			className={twm("text-xs leading-5 text-muted-foreground", className)}
			{...props}
		/>
	);
}

function ToastAction({
	className,
	...props
}: PropsWithNativeClassName<BUIToast.Action.Props>) {
	return (
		<BUIToast.Action
			className={twm(
				"mt-1 inline-flex items-center text-xs font-medium text-accent hover:underline",
				className,
			)}
			{...props}
		/>
	);
}

function ToastClose({
	className,
	children,
	...props
}: PropsWithNativeClassName<BUIToast.Close.Props>) {
	return (
		<BUIToast.Close
			aria-label={props["aria-label"] ?? "Close notification"}
			className={twm(
				"absolute top-3 right-3 flex h-6 w-6 items-center justify-center rounded-full opacity-70 transition-colors transition-opacity hover:bg-foreground/8 hover:opacity-100",
				className,
			)}
			{...props}
		>
			{children ?? <X size={14} />}
		</BUIToast.Close>
	);
}
