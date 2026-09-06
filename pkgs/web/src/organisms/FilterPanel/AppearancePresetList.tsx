import { Menu as BUIMenu } from "@base-ui/react/menu";
import { useDraggable } from "@dnd-kit/core";
import {
	Bookmark,
	ChevronDown,
	ChevronRight,
	Ellipsis,
	FileDown,
	Library,
} from "lucide-react";
import { memo, useState } from "react";
import { IconButton } from "@/components/IconButton";
import { Menu } from "@/components/Menu";
import type { AppearancePreset } from "@/core/schema";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";

export const PRESET_DRAG_PREFIX = "preset:";
export const LIBRARY_PRESET_DRAG_PREFIX = "libpreset:";

/**
 * Presets available to the panel. Click applies at the end of the stack;
 * dragging a row onto the stack inserts it at that position.
 */
export const AppearancePresetList = memo(function AppearancePresetList({
	documentPresets,
	libraryPresets,
	onApplyDocumentPreset,
	onApplyLibraryPreset,
	onSaveToLibrary,
	onExportJson,
}: {
	documentPresets: readonly AppearancePreset[];
	libraryPresets: readonly AppearancePreset[];
	onApplyDocumentPreset: (uid: string) => void;
	onApplyLibraryPreset: (uid: string) => void;
	onSaveToLibrary: (preset: AppearancePreset) => void;
	onExportJson: (preset: AppearancePreset) => void;
}) {
	const t = useTranslation();
	const [open, setOpen] = useState(true);

	const handleToggle = useEventCallback(() => {
		setOpen((prev) => !prev);
	});

	return (
		<div>
			<button
				type="button"
				className="flex w-full items-center gap-1 px-1 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground"
				onClick={handleToggle}
			>
				{open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
				{t("filterPanel.presetList")}
			</button>
			{open && (
				<div className="space-y-1">
					<PresetGroup
						label={t("filterPanel.presetListDocument")}
						emptyLabel={t("filterPanel.presetNone")}
						presets={documentPresets}
						dragPrefix={PRESET_DRAG_PREFIX}
						onApply={onApplyDocumentPreset}
						onSaveToLibrary={onSaveToLibrary}
						onExportJson={onExportJson}
					/>
					<PresetGroup
						label={t("filterPanel.presetListLibrary")}
						emptyLabel={t("filterPanel.presetLibraryEmpty")}
						presets={libraryPresets}
						dragPrefix={LIBRARY_PRESET_DRAG_PREFIX}
						onApply={onApplyLibraryPreset}
						onExportJson={onExportJson}
					/>
				</div>
			)}
		</div>
	);
});

function PresetGroup({
	label,
	emptyLabel,
	presets,
	dragPrefix,
	onApply,
	onSaveToLibrary,
	onExportJson,
}: {
	label: string;
	emptyLabel: string;
	presets: readonly AppearancePreset[];
	dragPrefix: string;
	onApply: (uid: string) => void;
	/** Document presets only: offers "save to library" on the row menu. */
	onSaveToLibrary?: (preset: AppearancePreset) => void;
	onExportJson: (preset: AppearancePreset) => void;
}) {
	return (
		<div>
			<div className="px-1 text-[10px] text-muted-foreground/70">{label}</div>
			{presets.length === 0 ? (
				<p className="px-1 py-0.5 text-[11px] text-muted-foreground">
					{emptyLabel}
				</p>
			) : (
				presets.map((preset) => (
					<PresetRow
						key={preset.uid}
						preset={preset}
						dragId={`${dragPrefix}${preset.uid}`}
						onApply={onApply}
						onSaveToLibrary={onSaveToLibrary}
						onExportJson={onExportJson}
					/>
				))
			)}
		</div>
	);
}

function PresetRow({
	preset,
	dragId,
	onApply,
	onSaveToLibrary,
	onExportJson,
}: {
	preset: AppearancePreset;
	dragId: string;
	onApply: (uid: string) => void;
	onSaveToLibrary?: (preset: AppearancePreset) => void;
	onExportJson: (preset: AppearancePreset) => void;
}) {
	const t = useTranslation();
	const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
		id: dragId,
	});

	const handleClick = useEventCallback(() => {
		onApply(preset.uid);
	});

	return (
		<div
			className={`flex items-center rounded transition-colors hover:bg-accent/10 ${
				isDragging ? "opacity-50" : ""
			}`}
		>
			<button
				ref={setNodeRef}
				type="button"
				{...attributes}
				{...listeners}
				onClick={handleClick}
				className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1 text-left text-xs"
			>
				<Bookmark size={12} className="shrink-0 text-accent" />
				<span className="truncate">{preset.name}</span>
			</button>
			<Menu.Root>
				<BUIMenu.Trigger
					render={
						<IconButton
							$size="xs"
							$variant="ghost"
							className="mr-1 shrink-0"
							aria-label={t("filterPanel.presetMenu")}
						>
							<Ellipsis size={12} />
						</IconButton>
					}
				/>
				<Menu.Portal>
					<Menu.Positioner side="right" sideOffset={4}>
						<Menu.Popup>
							{onSaveToLibrary && (
								<Menu.Item onClick={() => onSaveToLibrary(preset)}>
									<Library size={14} />
									{t("filterPanel.presetSaveToLibrary")}
								</Menu.Item>
							)}
							<Menu.Item onClick={() => onExportJson(preset)}>
								<FileDown size={14} />
								{t("filterPanel.presetExportJson")}
							</Menu.Item>
						</Menu.Popup>
					</Menu.Positioner>
				</Menu.Portal>
			</Menu.Root>
		</div>
	);
}
