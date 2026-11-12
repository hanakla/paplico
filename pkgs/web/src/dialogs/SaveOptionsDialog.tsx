import { X } from "lucide-react";
import { useState } from "react";
import { createCallable } from "react-call";
import { Button } from "@/components/Button";
import { Checkbox } from "@/components/Checkbox";
import { Dialog } from "@/components/Dialog";
import { useTranslation } from "@/locales";
import type { DocumentSaveOptions } from "@/stores/documentSessionStore";
import { useEventCallback } from "@/utils/hooks";
import { twm } from "@/utils/tailwind";

/**
 * Asks what a document file holds before it is written. `null` means the
 * user called the save off.
 */
export const SaveOptionsDialog = createCallable<
	{ saveOptions: DocumentSaveOptions },
	DocumentSaveOptions | null
>(({ call, saveOptions }) => {
	const t = useTranslation();
	const [timelapse, setTimelapse] = useState(saveOptions.timelapse);
	const [keepLinks, setKeepLinks] = useState(saveOptions.keepLinks);

	const handleSave = useEventCallback(() => call.end({ timelapse, keepLinks }));
	const handleCancel = useEventCallback(() => call.end(null));
	const handleOpenChange = useEventCallback((open: boolean) => {
		if (!open) call.end(null);
	});

	return (
		<Dialog.Root open onOpenChange={handleOpenChange}>
			<Dialog.Content className="w-[400px] p-0 flex flex-col">
				<div className="flex items-center justify-between px-4 py-3 border-b border-border/30">
					<Dialog.Title className="text-sm font-medium mb-0">
						{t("saveOptionsDialog.title")}
					</Dialog.Title>
					<Dialog.Close
						className={twm(
							"p-1 rounded hover:bg-foreground/10 transition-colors",
							"outline-none focus-visible:ring-2 focus-visible:ring-accent",
						)}
					>
						<X size={16} />
					</Dialog.Close>
				</div>

				<div className="p-4 space-y-3">
					<OptionRow
						checked={timelapse}
						onCheckedChange={setTimelapse}
						label={t("saveOptionsDialog.timelapse")}
						description={t("saveOptionsDialog.timelapseDescription")}
					/>
					<OptionRow
						checked={keepLinks}
						onCheckedChange={setKeepLinks}
						label={t("saveOptionsDialog.keepLinks")}
						description={t("saveOptionsDialog.keepLinksDescription")}
					/>
				</div>

				<div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border/30">
					<Button $variant="ghost" $size="sm" onClick={handleCancel}>
						{t("common.cancel")}
					</Button>
					<Button $variant="default" $size="sm" onClick={handleSave}>
						{t("saveOptionsDialog.save")}
					</Button>
				</div>
			</Dialog.Content>
		</Dialog.Root>
	);
});

function OptionRow({
	checked,
	onCheckedChange,
	label,
	description,
}: {
	checked: boolean;
	onCheckedChange: (checked: boolean) => void;
	label: string;
	description: string;
}) {
	return (
		<div className="space-y-1">
			{/* biome-ignore lint/a11y/noLabelWithoutControl: custom checkbox component */}
			<label className="flex items-center gap-2 cursor-pointer">
				<Checkbox checked={checked} onCheckedChange={onCheckedChange} />
				<span className="text-xs">{label}</span>
			</label>
			<div className="pl-6 text-[10px] text-muted-foreground">
				{description}
			</div>
		</div>
	);
}
