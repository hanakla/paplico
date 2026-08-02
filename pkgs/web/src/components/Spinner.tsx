import { memo } from "react";
import { tv } from "tailwind-variants";

const variants = tv({
	base: "spinner",
	variants: {
		$size: {
			sm: ["[--spinner-size:8px]", "[--spinner-gap:24px]"],
			md: ["[--spinner-size:16px]", "[--spinner-gap:28px]"],
			lg: ["[--spinner-size:24px]", "[--spinner-gap:32px]"],
		},
	},
	defaultVariants: {
		$size: "md",
	},
});

type Props = {
	$size: keyof typeof variants.variants.$size;
};

export const Spinner = memo(function Spinner({ $size }: Props) {
	return <span className={variants({ $size })} />;
});
