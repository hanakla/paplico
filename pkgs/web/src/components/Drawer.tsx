import { Drawer as BUIDrawer } from "@base-ui/react/drawer";
import { memo, type ReactNode } from "react";
import { twm } from "@/utils/tailwind";

export namespace Drawer {
	export namespace Root {
		export type Props = BUIDrawer.Root.Props;
	}
}

export const Drawer = {
	Root: memo(DrawerRoot),
	Content: memo(DrawerContent),
	Close: memo(DrawerClose),
};

function DrawerRoot({
	children,
	...props
}: BUIDrawer.Root.Props & { children: ReactNode }) {
	return <BUIDrawer.Root {...props}>{children}</BUIDrawer.Root>;
}

function DrawerContent({
	children,
	modal = true,
	mode = "side",
	side = "right",
	bottomOffset = 0,
	leftOffset = 0,
	rightOffset = 0,
	className,
}: {
	children: ReactNode;
	/** Show backdrop overlay when true */
	modal?: boolean;
	mode?: "side" | "bottom";
	/** Which side to slide in from (only for mode="side") */
	side?: "left" | "right";
	/** Offset from the bottom edge (e.g. tab bar height): px number or CSS length */
	bottomOffset?: number | string;
	/** Offset from the left edge (e.g. toolbar rail): px number or CSS length */
	leftOffset?: number | string;
	/** Offset from the right edge (e.g. toolbar rail): px number or CSS length */
	rightOffset?: number | string;
	className?: string;
}) {
	const isSide = mode === "side";
	const isLeft = side === "left";

	return (
		<BUIDrawer.Portal>
			{modal && (
				<BUIDrawer.Backdrop
					className={twm(
						"fixed inset-0 bg-black/40",
						"transition-[opacity] duration-300",
						"data-starting-style:opacity-0 data-ending-style:opacity-0",
						"data-swiping:transition-none",
					)}
					style={{
						opacity: `calc(0.4 * (1 - var(--drawer-swipe-progress, 0)))`,
					}}
				/>
			)}
			<BUIDrawer.Viewport
				// The popup slides past its resting position while opening and
				// closing, so the viewport stops where the surrounding chrome (a tab
				// bar, a toolbar rail) begins and clips it there instead of letting it
				// travel over that chrome.
				style={{
					left: leftOffset,
					right: rightOffset,
					bottom: isSide ? 0 : bottomOffset,
				}}
				className="fixed inset-0 z-50 pointer-events-none overflow-hidden"
			>
				<BUIDrawer.Popup
					className={twm(
						"bg-background outline-none pointer-events-auto",
						"transition-transform duration-300 ease-out",
						"data-ending-style:duration-[calc(var(--drawer-swipe-strength,1)*400ms)]",
						isSide
							? [
									"absolute top-0 bottom-0 w-64 flex flex-col",
									"data-swiping:transition-none data-swiping:translate-x-(--drawer-swipe-movement-x)",
									isLeft
										? "left-0 border-r border-border data-starting-style:-translate-x-full data-ending-style:-translate-x-full"
										: "right-0 border-l border-border data-starting-style:translate-x-full data-ending-style:translate-x-full",
								]
							: [
									"absolute left-0 right-0 bottom-0 max-h-[85dvh] border-t border-border rounded-t-xl flex flex-col",
									// Resting on something else (a tab bar) already clears the
									// home indicator, so padding again would double the gap.
									!bottomOffset && "pb-safe-bottom",
									"data-swiping:transition-none data-swiping:translate-y-(--drawer-swipe-movement-y)",
									"data-starting-style:translate-y-full data-ending-style:translate-y-full",
								],
						className,
					)}
				>
					<BUIDrawer.SwipeArea>
						{isSide ? (
							<div
								className={twm(
									"absolute top-0 bottom-0 w-3 flex items-center justify-center shrink-0",
									isLeft ? "right-0" : "left-0",
								)}
							>
								<div className="h-8 w-1 rounded-full bg-border" />
							</div>
						) : (
							<div className="flex justify-center py-2 shrink-0">
								<div className="w-8 h-1 rounded-full bg-border" />
							</div>
						)}
					</BUIDrawer.SwipeArea>
					<BUIDrawer.Content className="flex flex-col flex-1 min-h-0">
						{children}
					</BUIDrawer.Content>
				</BUIDrawer.Popup>
			</BUIDrawer.Viewport>
		</BUIDrawer.Portal>
	);
}

function DrawerClose({
	children,
	className,
}: {
	children?: ReactNode;
	className?: string;
}) {
	return (
		<BUIDrawer.Close className={twm("outline-none", className)}>
			{children}
		</BUIDrawer.Close>
	);
}
