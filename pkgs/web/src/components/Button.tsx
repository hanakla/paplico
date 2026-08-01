import { Button as BUIButton } from "@base-ui/react/button";
import { memo, useRef } from "react";
import { tv } from "tailwind-variants";
import { useEventCallback } from "@/utils/hooks";
import { twm } from "@/utils/tailwind";
import type { PropsWithNativeClassName } from "./types";

const buttonVariants = tv({
	base: [
		"inline-flex items-center justify-center gap-2 rounded-full",
		"font-medium transition-all",
		"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-within:scale-102",
		"disabled:pointer-events-none disabled:opacity-50",
	],
	variants: {
		$variant: {
			default:
				"bg-accent/80 text-accent-foreground hover:bg-accent-hover active:bg-accent-active",
			secondary: "bg-muted/80 text-muted-foreground hover:bg-muted-hover/80",
			ghost: "text-foreground hover:bg-muted-hover",
			destructive:
				"bg-danger/80 text-danger-foreground hover:bg-danger-hover active:bg-danger-active",
		},
		$size: {
			sm: "h-8 px-3 text-xs",
			md: "h-10 px-4 text-sm",
			lg: "h-12 px-6 text-base",
			icon: "h-10 w-10",
		},
	},
	defaultVariants: {
		$variant: "default",
		$size: "md",
	},
});

type Props = PropsWithNativeClassName<BUIButton.Props> & {
	$variant?: keyof typeof buttonVariants.variants.$variant;
	$size?: keyof typeof buttonVariants.variants.$size;
	/** When true, fires onClick on pointerUp even if pointerDown didn't occur on this element */
	$clickOnPointerUpOnly?: boolean;
};

export const Button = memo(ButtonRoot);

function ButtonRoot({
	className,
	$variant,
	$size,
	$clickOnPointerUpOnly,
	onClick,
	onPointerDown,
	onPointerUp,
	...props
}: Props) {
	const hadPointerDown = useRef(false);

	const handlePointerDown = useEventCallback(
		(e: Parameters<NonNullable<BUIButton.Props["onPointerDown"]>>[0]) => {
			hadPointerDown.current = true;
			onPointerDown?.(e);
		},
	);

	const handlePointerUp = useEventCallback(
		(e: Parameters<NonNullable<BUIButton.Props["onPointerUp"]>>[0]) => {
			if ($clickOnPointerUpOnly && !hadPointerDown.current && onClick) {
				onClick(e);
			}
			hadPointerDown.current = false;
			onPointerUp?.(e);
		},
	);

	return (
		<BUIButton
			className={twm(buttonVariants({ $variant, $size }), className)}
			onClick={onClick}
			onPointerDown={handlePointerDown}
			onPointerUp={handlePointerUp}
			{...props}
		/>
	);
}
