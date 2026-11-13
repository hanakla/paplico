import { tv } from "tailwind-variants";

export const selectTriggerVariants = tv({
	base: [
		"flex w-full items-center justify-between gap-2 rounded-md border border-border bg-muted/50 text-foreground",
		"focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent",
		"disabled:cursor-not-allowed disabled:opacity-50",
	],
	variants: {
		$size: {
			xs: "h-6 px-1.5 text-xs",
			sm: "h-8 px-2.5 text-xs",
			md: "h-9 px-3 text-sm",
			lg: "h-10 px-3.5 text-sm",
		},
	},
	defaultVariants: {
		$size: "md",
	},
});
