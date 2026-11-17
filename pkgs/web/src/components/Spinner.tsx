import { type CSSProperties, memo } from "react";
import { tv } from "tailwind-variants";

const variants = tv({
	base: "spinner",
	variants: {
		$size: {
			sm: "[--spinner-size:16px]",
			md: "[--spinner-size:24px]",
			lg: "[--spinner-size:32px]",
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
	return (
		<span className={variants({ $size })}>
			{Array.from({ length: 8 }, (_, index) => (
				<span
					key={index}
					className="spinner-bar"
					style={{ "--spinner-index": index } as CSSProperties}
				/>
			))}
		</span>
	);
});
