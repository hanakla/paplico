import { Input as BUIInput } from "@base-ui/react/input";
import { memo } from "react";
import { tv } from "tailwind-variants";
import type { PropsWithNativeClassName } from "./types";

const inputVariants = tv({
	slots: {
		root: [
			"flex items-center focus-within:ring-2",
			"border border-border rounded-md",
			"focus-within:ring-2 focus-within:ring-accent focus-within:border-transparent",
		],
		input: [
			"w-full bg-transparent text-foreground placeholder:text-muted-foreground",
			"transition-colors outline-none",
			"disabled:pointer-events-none disabled:opacity-50",
			"placeholder:text-muted-foreground",
			"data-invalid:border-danger data-invalid:focus:ring-danger",
		],
		unit: "border-l border-border pl-1.5 text-muted-foreground select-none shrink-0",
	},
	variants: {
		$size: {
			xs: { input: "h-6 px-1.5 text-[11px]", unit: "px-2 text-[11px]" },
			sm: { input: "h-8 px-2.5 text-xs", unit: "px-2 text-xs" },
			md: { input: "h-10 px-3 text-sm", unit: "px-2 text-sm" },
			lg: { input: "h-12 px-4 text-base", unit: "px-2 text-base" },
		},
	},
	defaultVariants: {
		$size: "md",
	},
});

type InputProps = PropsWithNativeClassName<BUIInput.Props> & {
	$size?: "xs" | "sm" | "md" | "lg";
	unit?: string;
};

export const Input = memo(InputRoot);

export namespace Input {
	export type Props = InputProps;
}

function InputRoot({ className, $size, unit, ...props }: InputProps) {
	const styles = inputVariants({ $size });

	return (
		<div className={styles.root()}>
			<BUIInput className={styles.input({ className })} {...props} />
			{unit && <span className={styles.unit()}>{unit}</span>}
		</div>
	);
}
