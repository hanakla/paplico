import { Tooltip } from "@base-ui/react/tooltip";
import { Info } from "lucide-react";

export function InfoTooltip({
	text,
	size = 10,
}: {
	text: string;
	size?: number;
}) {
	return (
		<Tooltip.Provider delay={0}>
			<Tooltip.Root disableHoverablePopup>
				<Tooltip.Trigger
					render={
						<span className="cursor-default text-muted-foreground">
							<Info size={size} />
						</span>
					}
				/>
				<Tooltip.Portal>
					<Tooltip.Positioner side="top" sideOffset={4}>
						<Tooltip.Popup className="z-50 max-w-48 rounded bg-foreground px-2 py-1 text-[10px] leading-tight text-background shadow-md">
							{text}
						</Tooltip.Popup>
					</Tooltip.Positioner>
				</Tooltip.Portal>
			</Tooltip.Root>
		</Tooltip.Provider>
	);
}
