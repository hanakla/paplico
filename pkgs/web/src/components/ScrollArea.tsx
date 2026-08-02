import { ScrollArea as BUIScrollArea } from "@base-ui/react/scroll-area";
import { forwardRef, memo } from "react";
import { twm } from "@/utils/tailwind";
import type { PropsWithNativeClassName } from "./types";

export const ScrollArea = {
	Root: memo(forwardRef(ScrollAreaRoot)),
	Viewport: memo(forwardRef(ScrollAreaViewport)),
};

function ScrollAreaRoot(
	{
		className,
		children,
		...props
	}: PropsWithNativeClassName<BUIScrollArea.Root.Props>,
	ref: React.ForwardedRef<HTMLDivElement>,
) {
	return (
		<BUIScrollArea.Root
			ref={ref}
			className={twm("overflow-hidden", className)}
			{...props}
		>
			{children}
		</BUIScrollArea.Root>
	);
}

function ScrollAreaViewport(
	{
		className,
		contentClassName,
		children,
		$displayBars = false,
		$fade = false,
		...props
	}: PropsWithNativeClassName<BUIScrollArea.Viewport.Props> & {
		$displayBars?: boolean;
		$fade?: boolean;
		contentClassName?: string;
	},
	ref: React.ForwardedRef<HTMLDivElement>,
) {
	return (
		<BUIScrollArea.Viewport
			ref={ref}
			className={twm(
				"h-full w-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
				className,
			)}
			style={
				$fade
					? {
							maskImage:
								"linear-gradient(to bottom, transparent 0px, black min(40px, var(--scroll-area-overflow-y-start)), black calc(100% - min(40px, var(--scroll-area-overflow-y-end))), transparent 100%)",
						}
					: undefined
			}
			{...props}
		>
			<BUIScrollArea.Content className={contentClassName}>
				{children}
			</BUIScrollArea.Content>
			<BUIScrollArea.Scrollbar
				keepMounted={$displayBars}
				className={twm(
					"m-1.5 flex w-1 rounded-full",
					$displayBars
						? "bg-transparent pointer-events-auto opacity-100 data-hovering:opacity-100 data-scrolling:opacity-100"
						: "bg-transparent pointer-events-none opacity-0 transition-opacity duration-150 data-hovering:opacity-100 data-hovering:pointer-events-auto data-scrolling:opacity-100 data-scrolling:pointer-events-auto data-scrolling:duration-0",
				)}
			>
				<BUIScrollArea.Thumb className="w-full rounded-full bg-muted-foreground/50 hover:bg-muted-foreground/80" />
			</BUIScrollArea.Scrollbar>
			<BUIScrollArea.Scrollbar
				orientation="horizontal"
				keepMounted={$displayBars}
				className={twm(
					"m-1.5 flex h-1 rounded-full",
					$displayBars
						? "bg-transparent pointer-events-auto opacity-100 data-hovering:opacity-100 data-scrolling:opacity-100"
						: "bg-transparent pointer-events-none opacity-0 transition-opacity duration-150 data-hovering:opacity-100 data-hovering:pointer-events-auto data-scrolling:opacity-100 data-scrolling:pointer-events-auto data-scrolling:duration-0",
				)}
			>
				<BUIScrollArea.Thumb className="h-full rounded-full bg-muted-foreground/50 hover:bg-muted-foreground/80" />
			</BUIScrollArea.Scrollbar>
			<BUIScrollArea.Corner />
		</BUIScrollArea.Viewport>
	);
}
