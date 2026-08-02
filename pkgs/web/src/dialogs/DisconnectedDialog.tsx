import { Unplug } from "lucide-react";
import { createCallable } from "react-call";
import { AlertDialog } from "@/components/AlertDialog";
import { Button } from "@/components/Button";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";

/**
 * Reports that a session ended from the other side. A toast would slide away
 * on its own, and the canvas looks unchanged afterwards — nothing else on
 * screen says the strokes have stopped travelling anywhere.
 */
export const DisconnectedDialog = createCallable<
	{
		title: string;
		description: string;
	},
	void
>(({ call, title, description }) => {
	const t = useTranslation();

	const handleClose = useEventCallback(() => call.end());
	const handleOpenChange = useEventCallback((open: boolean) => {
		if (!open) call.end();
	});

	return (
		<AlertDialog.Root open onOpenChange={handleOpenChange}>
			<AlertDialog.Portal>
				<AlertDialog.Backdrop />
				<AlertDialog.Popup>
					<div className="mb-3 flex size-11 items-center justify-center rounded-full bg-muted/60">
						{/* The cable is drawn pulled apart, which is the whole message */}
						<Unplug size={20} className="text-muted-foreground" />
					</div>

					<AlertDialog.Title>{title}</AlertDialog.Title>
					<AlertDialog.Description>{description}</AlertDialog.Description>

					<div className="flex items-center justify-end">
						<Button $variant="default" $size="sm" onClick={handleClose}>
							{t("common.ok")}
						</Button>
					</div>
				</AlertDialog.Popup>
			</AlertDialog.Portal>
		</AlertDialog.Root>
	);
});
