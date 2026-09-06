import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
	Bookmark,
	ChevronDown,
	ChevronRight,
	Eye,
	EyeOff,
	Pencil,
	Trash2,
	Ungroup,
} from "lucide-react";
import { type CSSProperties, memo, useState } from "react";
import { IconButton } from "@/components/IconButton";
import { Tooltip } from "@/components/Tooltip";
import { usePaplico } from "@/contexts/PaplicoContext";
import type { AppearancePreset, AppearancePresetRef } from "@/core/schema";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";
import { FILTER_TEXT_KEYS, getFilterIcon } from "./constants";
import { useFilterStack } from "./FilterStackContext";
import type { FilterDropIndicator } from "./types";

/** Stack row for a preset ref: toggle, expand into plain filters, remove, and peek at the preset's filters. */
export const PresetRefItem = memo(function PresetRefItem({
	entry,
	preset,
	index,
	elementId,
	sortableId,
	dropIndicator,
	onEdit,
}: {
	entry: AppearancePresetRef;
	/** null when the document no longer has the preset. */
	preset: AppearancePreset | null;
	index: number;
	elementId: string;
	sortableId: string;
	dropIndicator: FilterDropIndicator;
	onEdit: (presetUid: string) => void;
}) {
	const { commands } = usePaplico();
	const stack = useFilterStack();
	const t = useTranslation();
	const [open, setOpen] = useState(false);
	const {
		attributes,
		listeners,
		setNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({ id: sortableId });

	const enabled = entry.enabled !== false;

	const handleToggle = useEventCallback(() => {
		stack.updateFilter(index, { enabled: !enabled });
	});
	const handleExpand = useEventCallback(() => {
		commands.expandAppearancePresetRef(elementId, index);
	});
	const handleEdit = useEventCallback(() => {
		onEdit(entry.presetUid);
	});
	const handleRemove = useEventCallback(() => {
		stack.removeFilter(index);
	});
	const handleToggleOpen = useEventCallback(() => {
		setOpen((prev) => !prev);
	});

	const dragStyle = {
		transform: CSS.Transform.toString(transform),
		transition,
		zIndex: isDragging ? 1 : undefined,
		opacity: isDragging ? 0.5 : undefined,
	} satisfies CSSProperties;

	const showIndicatorBefore =
		dropIndicator?.overId === sortableId && dropIndicator.position === "before";
	const showIndicatorAfter =
		dropIndicator?.overId === sortableId && dropIndicator.position === "after";

	return (
		<>
			{showIndicatorBefore && (
				<div className="h-0.5 bg-accent rounded-full mx-1" />
			)}
			<div style={dragStyle}>
				<div
					ref={setNodeRef}
					{...attributes}
					{...listeners}
					className="rounded hover:bg-accent/10 transition-colors"
				>
					<div className="flex items-center justify-between px-2 py-1">
						<div className="flex min-w-0 items-center gap-1.5">
							<IconButton
								$size="xs"
								$variant="ghost"
								className="shrink-0"
								onClick={handleToggleOpen}
								disabled={!preset}
							>
								{open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
							</IconButton>
							<Bookmark size={14} className="shrink-0 text-accent" />
							<span
								className={`truncate text-xs font-medium ${
									preset ? "text-foreground" : "text-muted-foreground"
								}`}
							>
								{preset?.name ?? t("filterPanel.presetMissing")}
							</span>
						</div>

						<div className="flex shrink-0 items-center gap-0.5">
							{preset && (
								<Tooltip content={t("filterPanel.presetEdit")}>
									<IconButton
										$size="xs"
										$variant="ghost"
										aria-label={t("filterPanel.presetEdit")}
										onClick={handleEdit}
									>
										<Pencil size={12} />
									</IconButton>
								</Tooltip>
							)}
							{preset && (
								<Tooltip content={t("filterPanel.presetExpand")}>
									<IconButton
										$size="xs"
										$variant="ghost"
										aria-label={t("filterPanel.presetExpand")}
										onClick={handleExpand}
									>
										<Ungroup size={12} />
									</IconButton>
								</Tooltip>
							)}
							<IconButton $size="xs" $variant="ghost" onClick={handleToggle}>
								{enabled ? <Eye size={12} /> : <EyeOff size={12} />}
							</IconButton>
							<IconButton $size="xs" $variant="ghost" onClick={handleRemove}>
								<Trash2 size={12} />
							</IconButton>
						</div>
					</div>

					{open && preset && (
						<div className="pb-1 pl-9 pr-2">
							{preset.filters.map((filter) => (
								<div
									key={filter.uid}
									className="flex items-center gap-1.5 py-0.5 text-[11px] text-muted-foreground"
								>
									{getFilterIcon(filter.processor)}
									<span className="truncate">
										{FILTER_TEXT_KEYS[
											filter.processor as keyof typeof FILTER_TEXT_KEYS
										]
											? t(
													FILTER_TEXT_KEYS[
														filter.processor as keyof typeof FILTER_TEXT_KEYS
													],
												)
											: filter.processor}
									</span>
								</div>
							))}
						</div>
					)}
				</div>
			</div>
			{showIndicatorAfter && (
				<div className="h-0.5 bg-accent rounded-full mx-1" />
			)}
		</>
	);
});
