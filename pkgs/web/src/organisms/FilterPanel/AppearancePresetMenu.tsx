import { Menu as BUIMenu } from "@base-ui/react/menu";
import { BookmarkPlus, Ellipsis, FileUp, Settings2 } from "lucide-react";
import { memo, useState } from "react";
import { Button } from "@/components/Button";
import { Dialog } from "@/components/Dialog";
import { IconButton } from "@/components/IconButton";
import { Input } from "@/components/Input";
import { Menu } from "@/components/Menu";
import { toastManager } from "@/components/Toast";
import { usePaplico } from "@/contexts/PaplicoContext";
import type { AnyArtObject } from "@/core/schema";
import type { useAppearancePresets } from "@/hooks/useAppearancePresets";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";

/** `…` menu of the appearance panel header: save the selection as a preset, import a JSON preset, manage presets. */
export const AppearancePresetMenu = memo(function AppearancePresetMenu({
	element,
	library,
	onManage,
	iconSize,
}: {
	element: AnyArtObject;
	library: ReturnType<typeof useAppearancePresets>;
	onManage: () => void;
	iconSize: number;
}) {
	const t = useTranslation();
	const { commands } = usePaplico();
	const [nameDialogOpen, setNameDialogOpen] = useState(false);

	const handleOpenNameDialog = useEventCallback(() => {
		setNameDialogOpen(true);
	});

	const handleSaveAs = useEventCallback((name: string) => {
		setNameDialogOpen(false);
		const uid = commands.createAppearancePresetFromElement(element.id, name);
		if (!uid) {
			toastManager.add({ title: t("filterPanel.presetNothingToSave") });
		}
	});

	const handleImport = useEventCallback(async () => {
		try {
			await library.importPresetJson();
		} catch {
			toastManager.add({ title: t("filterPanel.presetImportError") });
		}
	});

	return (
		<>
			<Menu.Root>
				<BUIMenu.Trigger
					render={
						<IconButton
							$size="xs"
							$variant="ghost"
							title={t("filterPanel.presetMenu")}
						>
							<Ellipsis size={iconSize} />
						</IconButton>
					}
				/>
				<Menu.Portal>
					<Menu.Positioner side="right" sideOffset={4}>
						<Menu.Popup>
							<Menu.Item onClick={handleOpenNameDialog}>
								<BookmarkPlus size={14} />
								{t("filterPanel.presetSaveAs")}
							</Menu.Item>
							<Menu.Separator />
							<Menu.Item onClick={handleImport}>
								<FileUp size={14} />
								{t("filterPanel.presetImportJson")}
							</Menu.Item>
							<Menu.Separator />
							<Menu.Item onClick={onManage}>
								<Settings2 size={14} />
								{t("filterPanel.presetManage")}
							</Menu.Item>
						</Menu.Popup>
					</Menu.Positioner>
				</Menu.Portal>
			</Menu.Root>

			<PresetNameDialog
				open={nameDialogOpen}
				onOpenChange={setNameDialogOpen}
				onSubmit={handleSaveAs}
			/>
		</>
	);
});

function PresetNameDialog({
	open,
	onOpenChange,
	onSubmit,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onSubmit: (name: string) => void;
}) {
	const t = useTranslation();
	const [name, setName] = useState("");

	const handleSubmit = useEventCallback(() => {
		onSubmit(name.trim() || t("filterPanel.presetDefaultName"));
		setName("");
	});

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Content className="w-[320px] p-4 space-y-3">
				<Dialog.Title className="text-sm font-medium">
					{t("filterPanel.presetSaveAsTitle")}
				</Dialog.Title>
				<Input
					autoFocus
					value={name}
					placeholder={t("filterPanel.presetDefaultName")}
					onChange={(e) => setName(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") handleSubmit();
					}}
				/>
				<div className="flex justify-end">
					<Button $size="sm" onClick={handleSubmit}>
						{t("filterPanel.presetSaveAs")}
					</Button>
				</div>
			</Dialog.Content>
		</Dialog.Root>
	);
}
