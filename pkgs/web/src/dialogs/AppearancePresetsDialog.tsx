import { Pencil, Plus, Trash2, X } from "lucide-react";
import { memo } from "react";
import { useSnapshot } from "valtio";
import { ConfirmDialog } from "@/components/AlertDialog";
import { Dialog } from "@/components/Dialog";
import { FakeInput } from "@/components/FakeInput";
import { IconButton } from "@/components/IconButton";
import { Tooltip } from "@/components/Tooltip";
import { usePaplico } from "@/contexts/PaplicoContext";
import {
	type AppearancePreset,
	type FilterEntry,
	isAppearancePresetRef,
} from "@/core/schema";
import type { useAppearancePresets } from "@/hooks/useAppearancePresets";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";
import { twm } from "@/utils/tailwind";

/** Rename / delete the document's appearance presets and the library's. */
export const AppearancePresetsDialog = memo(function AppearancePresetsDialog({
	open,
	onOpenChange,
	library,
	onEditPreset,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	library: ReturnType<typeof useAppearancePresets>;
	onEditPreset: (presetUid: string) => void;
}) {
	const t = useTranslation();
	const { uiState, commands } = usePaplico();
	const snap = useSnapshot(uiState);
	// Snapshots are deeply readonly; presets are only read here.
	const documentPresets = (snap.document.appearancePresets ??
		[]) as readonly AppearancePreset[];

	const usageCount = (presetUid: string) => {
		let count = 0;
		for (const element of Object.values(snap.document.objects)) {
			if (
				element.filters?.some((entry) => {
					const e = entry as FilterEntry;
					return isAppearancePresetRef(e) && e.presetUid === presetUid;
				})
			) {
				count++;
			}
		}
		return count;
	};

	const handleEditDocumentPreset = useEventCallback((presetUid: string) => {
		onEditPreset(presetUid);
		onOpenChange(false);
	});

	const handleDeleteDocumentPreset = useEventCallback(
		async (preset: AppearancePreset) => {
			if (
				usageCount(preset.uid) > 0 &&
				!(await ConfirmDialog.call({
					description: t("filterPanel.presetDeleteConfirm", {
						name: preset.name,
					}),
					confirmLabel: t("filterPanel.presetDelete"),
					destructive: true,
				}))
			) {
				return;
			}
			commands.deleteAppearancePreset(preset.uid);
		},
	);

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Content className="w-[420px] max-h-[80vh] p-0 flex flex-col">
				<div className="flex items-center justify-between px-4 py-3 border-b border-border/30">
					<Dialog.Title className="text-sm font-medium mb-0">
						{t("filterPanel.presetManageTitle")}
					</Dialog.Title>
					<Dialog.Close
						className={twm(
							"p-1 rounded hover:bg-foreground/10 transition-colors",
							"outline-none focus-visible:ring-2 focus-visible:ring-primary/50",
						)}
					>
						<X size={16} />
					</Dialog.Close>
				</div>

				<div className="flex-1 overflow-auto p-4 space-y-4">
					<section className="space-y-1">
						<h3 className="text-xs text-muted-foreground">
							{t("filterPanel.presetListDocument")}
						</h3>
						{documentPresets.length === 0 && (
							<p className="text-xs text-muted-foreground">
								{t("filterPanel.presetNone")}
							</p>
						)}
						{documentPresets.map((preset) => (
							<div key={preset.uid} className="flex items-center gap-2">
								<FakeInput
									value={preset.name}
									onChange={(value) =>
										value && commands.renameAppearancePreset(preset.uid, value)
									}
									$behaviour="click"
									$size="sm"
									$side="start"
									className="flex-1 min-w-0"
								/>
								<span className="shrink-0 text-[11px] text-muted-foreground">
									{t("filterPanel.presetUsageCount", {
										count: usageCount(preset.uid),
									})}
								</span>
								<Tooltip content={t("filterPanel.presetEdit")}>
									<IconButton
										$size="xs"
										$variant="ghost"
										aria-label={t("filterPanel.presetEdit")}
										onClick={() => handleEditDocumentPreset(preset.uid)}
									>
										<Pencil size={12} />
									</IconButton>
								</Tooltip>
								<Tooltip content={t("filterPanel.presetDelete")}>
									<IconButton
										$size="xs"
										$variant="ghost"
										aria-label={t("filterPanel.presetDelete")}
										onClick={() => handleDeleteDocumentPreset(preset)}
									>
										<Trash2 size={12} />
									</IconButton>
								</Tooltip>
							</div>
						))}
					</section>

					<section className="space-y-1">
						<h3 className="text-xs text-muted-foreground">
							{t("filterPanel.presetListLibrary")}
						</h3>
						{library.persistedPresets.length === 0 && (
							<p className="text-xs text-muted-foreground">
								{t("filterPanel.presetLibraryEmpty")}
							</p>
						)}
						{library.persistedPresets.map((preset) => (
							<div key={preset.uid} className="flex items-center gap-2">
								<FakeInput
									value={preset.name}
									onChange={(value) =>
										value && library.renameInLibrary(preset.uid, value)
									}
									$behaviour="click"
									$size="sm"
									$side="start"
									className="flex-1 min-w-0"
								/>
								<Tooltip content={t("filterPanel.presetAddFromLibrary")}>
									<IconButton
										$size="xs"
										$variant="ghost"
										aria-label={t("filterPanel.presetAddFromLibrary")}
										onClick={() => library.addToDocument(preset.uid)}
									>
										<Plus size={12} />
									</IconButton>
								</Tooltip>
								<Tooltip content={t("filterPanel.presetDelete")}>
									<IconButton
										$size="xs"
										$variant="ghost"
										aria-label={t("filterPanel.presetDelete")}
										onClick={() => library.deleteFromLibrary(preset.uid)}
									>
										<Trash2 size={12} />
									</IconButton>
								</Tooltip>
							</div>
						))}
					</section>
				</div>
			</Dialog.Content>
		</Dialog.Root>
	);
});
