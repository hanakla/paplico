import { ScrollArea as BUIScrollArea } from "@base-ui/react/scroll-area";
import type { ReactNode } from "react";

export function ScrollArea({
	children,
	className = "",
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<BUIScrollArea.Root className={className}>
			<BUIScrollArea.Viewport className="h-full overflow-y-auto">
				{children}
			</BUIScrollArea.Viewport>
			<BUIScrollArea.Scrollbar className="flex w-1.5 justify-center rounded-full bg-surface-hover">
				<BUIScrollArea.Thumb className="w-full rounded-full bg-muted-foreground" />
			</BUIScrollArea.Scrollbar>
		</BUIScrollArea.Root>
	);
}
