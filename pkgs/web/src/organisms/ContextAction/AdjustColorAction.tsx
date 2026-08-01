import { Palette } from "lucide-react";
import { useRef, useState } from "react";
import { IconButton } from "@/components/IconButton";
import { Popover } from "@/components/Popover";
import { Tooltip } from "@/components/Tooltip";
import { usePaplicoCommands } from "@/contexts/PaplicoContext";
import type { AdjustColorSession } from "@/core/PaplicoCommands";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";
import { ColorAdjustPanel } from "./ColorAdjustPanel";

/**
 * Opens the color adjustment panel. Opening starts a preview session on the
 * selection; closing applies it, the panel's cancel button reverts it.
 */
export function AdjustColorAction() {
	const t = useTranslation();
	const commands = usePaplicoCommands();
	const [adjustColorOpen, setAdjustColorOpen] = useState(false);
	const sessionRef = useRef<AdjustColorSession | null>(null);

	const handleAdjustColorOpenChange = useEventCallback((open: boolean) => {
		if (open) {
			const session = commands.startAdjustColorSession();
			if (!session) return;
			sessionRef.current = session;
			setAdjustColorOpen(true);
		} else {
			sessionRef.current?.apply();
			sessionRef.current = null;
			setAdjustColorOpen(false);
		}
	});

	const handleCancelAdjustColor = useEventCallback(() => {
		sessionRef.current?.cancel();
		sessionRef.current = null;
		setAdjustColorOpen(false);
	});

	return (
		<Popover.Root
			open={adjustColorOpen}
			onOpenChange={handleAdjustColorOpenChange}
		>
			<Tooltip content={t("contextActions.adjustColors")} side="bottom">
				<Popover.Trigger>
					<IconButton $size="md" $variant="ghost" className="text-foreground">
						<Palette size={18} />
					</IconButton>
				</Popover.Trigger>
			</Tooltip>
			<Popover.Content side="top" sideOffset={12} className="w-80">
				<div data-context-actions-popover>
					{sessionRef.current && (
						<ColorAdjustPanel
							session={sessionRef.current}
							onCancel={handleCancelAdjustColor}
						/>
					)}
				</div>
			</Popover.Content>
		</Popover.Root>
	);
}
