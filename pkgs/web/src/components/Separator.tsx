import { Separator as BUISeparator } from "@base-ui/react/separator";
import { memo } from "react";
import { twm } from "@/utils/tailwind";
import type { PropsWithNativeClassName } from "./types";

export const Separator = memo(SeparatorRoot);

function SeparatorRoot({
	className,
	orientation = "horizontal",
	...props
}: PropsWithNativeClassName<BUISeparator.Props>) {
	return (
		<BUISeparator
			orientation={orientation}
			className={twm(
				"bg-border",
				orientation === "horizontal" && "h-px w-full",
				orientation === "vertical" && "w-px h-full",
				className,
			)}
			{...props}
		/>
	);
}
