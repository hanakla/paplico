import { Switch as BUISwitch } from "@base-ui/react/switch";
import { memo } from "react";
import { twm } from "@/utils/tailwind";
import type { PropsWithNativeClassName } from "./types";

export const Switch = memo(function Switch({
	className,
	...props
}: PropsWithNativeClassName<BUISwitch.Root.Props>) {
	return (
		<BUISwitch.Root
			className={twm(
				"relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent",
				"bg-muted transition-colors",
				"data-checked:bg-accent",
				"focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
				"data-disabled:opacity-50 data-disabled:pointer-events-none",
				className,
			)}
			{...props}
		>
			<BUISwitch.Thumb
				className={twm(
					"pointer-events-none block size-4 rounded-full bg-white shadow-sm ring-0 transition-transform",
					"data-unchecked:translate-x-0",
					"data-checked:translate-x-4",
				)}
			/>
		</BUISwitch.Root>
	);
});
