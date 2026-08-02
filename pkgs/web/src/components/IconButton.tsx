import { Button as BUIButton } from "@base-ui/react/button";
import { memo, useRef } from "react";
import { tv } from "tailwind-variants";
import { useEventCallback } from "@/utils/hooks";
import { twm } from "@/utils/tailwind";

type BUIPropsExposed<T extends object> = Omit<T, "className"> & {
	className?: string;
};

const iconButtonVariants = tv({
	base: [
		"inline-flex items-center justify-center transition-colors",
		"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
		"disabled:pointer-events-none disabled:opacity-50",
	],
	variants: {
		$variant: {
			default:
				"text-accent hover:bg-accent-hover hover:text-accent-hover active:bg-accent-active active:text-accent-active",
			secondary: "bg-muted text-muted-foreground hover:bg-muted-hover",
			ghost: "text-foreground hover:bg-background",
			destructive:
				"bg-danger/60 text-danger-foreground hover:bg-danger-hover active:bg-danger-active",
		},
		$size: {
			xs: "h-5 w-5 rounded-sm",
			sm: "h-7 w-7 rounded",
			md: "h-9 w-9 rounded-md",
			lg: "h-11 w-11 rounded-lg",
		},
		$pressed: {
			true: "",
			false: "",
		},
	},
	compoundVariants: [
		{
			$variant: "ghost",
			$pressed: true,
			className: "bg-accent/60 text-accent-foreground hover:bg-accent-hover",
		},
		{
			$variant: "secondary",
			$pressed: true,
			className: "bg-accent/60 text-accent-foreground hover:bg-accent-hover",
		},
	],
	defaultVariants: {
		$variant: "secondary",
		$size: "md",
		$pressed: false,
	},
});

type IconButtonProps = BUIPropsExposed<BUIButton.Props> & {
	$variant?: keyof typeof iconButtonVariants.variants.$variant;
	$size?: keyof typeof iconButtonVariants.variants.$size;
	$pressed?: boolean;
	/** When true, fires onClick on pointerUp even if pointerDown didn't occur on this element */
	$clickOnPointerUpOnly?: boolean;
};

export const IconButton = memo(IconButtonRoot);

function IconButtonRoot({
	className,
	$variant,
	$size,
	$pressed = false,
	$clickOnPointerUpOnly,
	onClick,
	onPointerDown,
	onPointerUp,
	...props
}: IconButtonProps) {
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
			className={twm(
				iconButtonVariants({
					$variant,
					$size,
					$pressed,
				}),
				className,
			)}
			aria-pressed={$pressed}
			onClick={onClick}
			onPointerDown={handlePointerDown}
			onPointerUp={handlePointerUp}
			{...props}
		/>
	);
}
