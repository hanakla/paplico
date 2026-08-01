import { Tooltip as BUITooltip } from "@base-ui/react/tooltip";
import { memo, type ReactNode } from "react";
import { twm } from "@/utils/tailwind";

type TooltipProps = {
	children: ReactNode;
	content: ReactNode;
	side?: BUITooltip.Positioner.Props["side"];
	sideOffset?: number;
	delay?: number;
	disabled?: boolean;
};

export const Tooltip = memo(TooltipRoot);

function TooltipRoot({
	children,
	content,
	side = "top",
	sideOffset = 8,
	delay = 0,
	disabled = false,
}: TooltipProps) {
	return (
		<BUITooltip.Provider delay={delay}>
			<BUITooltip.Root disabled={disabled} disableHoverablePopup>
				<BUITooltip.Trigger render={children as React.ReactElement} />
				<BUITooltip.Portal>
					<BUITooltip.Positioner side={side} sideOffset={sideOffset}>
						<BUITooltip.Popup
							className={twm(
								"z-50 rounded bg-foreground px-2 py-1 text-xs text-background shadow-md",
								"origin-(--transform-origin) transition-[transform,scale,opacity] duration-150 ease-[cubic-bezier(0.34,1.56,0.64,1)]",
								"data-starting-style:opacity-0 data-starting-style:scale-50",
								"data-ending-style:opacity-0 data-ending-style:scale-50",
							)}
						>
							{content}
						</BUITooltip.Popup>
					</BUITooltip.Positioner>
				</BUITooltip.Portal>
			</BUITooltip.Root>
		</BUITooltip.Provider>
	);
}
