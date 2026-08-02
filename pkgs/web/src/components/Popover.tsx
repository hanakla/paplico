import { Popover as BUIPopover } from "@base-ui/react/popover";
import {
	type ComponentProps,
	memo,
	type ReactNode,
	type RefObject,
} from "react";
import { useEventCallback } from "@/utils/hooks";
import { twm } from "@/utils/tailwind";
import type { PropsWithNativeClassName } from "./types";

export const Popover = {
	Root: memo(PopoverRoot),
	Trigger: memo(PopoverTrigger),
	Content: memo(PopoverContent),
};

function PopoverRoot({
	children,
	open,
	onOpenChange,
}: {
	children: ReactNode;
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
}) {
	return (
		<BUIPopover.Root open={open} onOpenChange={onOpenChange}>
			{children}
		</BUIPopover.Root>
	);
}

function PopoverTrigger({
	children,
	className,
	...props
}: PropsWithNativeClassName<BUIPopover.Trigger.Props>) {
	return (
		<BUIPopover.Trigger
			className={twm("outline-none", className)}
			render={children as React.ReactElement}
			{...props}
		/>
	);
}

function PopoverContent({
	children,
	side = "bottom",
	sideOffset = 8,
	align = "center",
	positionMethod,
	anchor,
	className,
}: {
	children: ReactNode;
	side?: BUIPopover.Positioner.Props["side"];
	sideOffset?: BUIPopover.Positioner.Props["sideOffset"];
	align?: BUIPopover.Positioner.Props["align"];
	positionMethod?: BUIPopover.Positioner.Props["positionMethod"];
	anchor?: Element | RefObject<Element | null> | null;
	className?: string;
}) {
	// Stop event bubbling from Portal to parent component tree.
	// Base UI renders Popup via Portal, but React still propagates synthetic events
	// through the component tree. Additionally, native pointerdown events bubble
	// to document, triggering outside-click handlers in parent components.
	// See: https://github.com/mui/base-ui/issues/2195
	const stopPropagation = useEventCallback((e: React.SyntheticEvent) => {
		e.stopPropagation();
	});

	return (
		<BUIPopover.Portal>
			<BUIPopover.Positioner
				side={side}
				sideOffset={sideOffset}
				align={align}
				positionMethod={positionMethod}
				anchor={anchor ?? undefined}
			>
				<BUIPopover.Popup
					onClick={stopPropagation}
					onMouseDown={stopPropagation}
					onPointerDown={stopPropagation}
					className={twm(
						"max-w-(--available-width) rounded-lg border border-border/50 bg-background/80 backdrop-liquid p-3 shadow-lg outline-none",
						"origin-(--transform-origin) transition-[transform,scale,opacity] duration-150 ease-[cubic-bezier(0.34,1.56,0.64,1)]",
						"data-starting-style:opacity-0 data-starting-style:scale-50",
						"data-ending-style:opacity-0 data-ending-style:scale-50",
						className,
					)}
				>
					<BUIPopover.Arrow
						className={twm(
							"backdrop-liquid",
							"data-[side=bottom]:top-[-8px]",
							"data-[side=top]:bottom-[-8px] data-[side=top]:rotate-180",
							"data-[side=left]:right-[-13px] data-[side=left]:rotate-90",
							"data-[side=right]:left-[-13px] data-[side=right]:-rotate-90",
						)}
					>
						<PopoverArrowSvg />
					</BUIPopover.Arrow>
					<div className="max-h-[calc(var(--available-height,100dvh)-1.5rem)]">
						{children}
					</div>
				</BUIPopover.Popup>
			</BUIPopover.Positioner>
		</BUIPopover.Portal>
	);
}

function PopoverArrowSvg(props: ComponentProps<"svg">) {
	return (
		<svg
			width="20"
			height="10"
			viewBox="0 0 20 10"
			fill="none"
			aria-hidden="true"
			{...props}
		>
			<path
				d="M9.66437 2.60207L4.80758 6.97318C4.07308 7.63423 3.11989 8 2.13172 8H0V10H20V8H18.5349C17.5468 8 16.5936 7.63423 15.8591 6.97318L11.0023 2.60207C10.622 2.2598 10.0447 2.25979 9.66437 2.60207Z"
				className="fill-background/80"
			/>
			<path
				d="M8.99542 1.85876C9.75604 1.17425 10.9106 1.17422 11.6713 1.85878L16.5281 6.22989C17.0789 6.72568 17.7938 7.00001 18.5349 7.00001L15.89 7L11.0023 2.60207C10.622 2.2598 10.0447 2.2598 9.66436 2.60207L4.77734 7L2.13171 7.00001C2.87284 7.00001 3.58774 6.72568 4.13861 6.22989L8.99542 1.85876Z"
				className="fill-border/50"
			/>
		</svg>
	);
}
