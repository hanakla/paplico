import { Checkbox as BUICheckbox } from "@base-ui/react/checkbox";
import { Check } from "lucide-react";
import { memo } from "react";
import { twm } from "@/utils/tailwind";
import type { PropsWithNativeClassName } from "./types";

export const Checkbox = memo(CheckboxComponent);

function CheckboxComponent({
	className,
	children,
	...props
}: PropsWithNativeClassName<BUICheckbox.Root.Props>) {
	return (
		<BUICheckbox.Root
			className={twm(
				"flex size-4 items-center justify-center rounded border border-border bg-transparent outline-none",
				"transition-colors duration-100",
				"hover:border-foreground/50",
				"data-checked:bg-accent data-checked:border-accent",
				"data-indeterminate:bg-accent data-indeterminate:border-accent",
				"data-disabled:pointer-events-none data-disabled:opacity-50",
				"focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-accent",
				className,
			)}
			{...props}
		>
			<BUICheckbox.Indicator className="flex items-center justify-center text-accent-foreground transition-[opacity,transform] duration-100 data-starting-style:scale-75 data-starting-style:opacity-0 data-ending-style:scale-75 data-ending-style:opacity-0">
				{children ?? <Check size={10} strokeWidth={3} />}
			</BUICheckbox.Indicator>
		</BUICheckbox.Root>
	);
}
