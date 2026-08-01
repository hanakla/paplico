import { Contrast, Eye, EyeOff, Pencil, Squircle, Unlink } from "lucide-react";
import { Button } from "@/components/Button";
import { IconButton } from "@/components/IconButton";
import { Tooltip } from "@/components/Tooltip";
import { usePaplico } from "@/contexts/PaplicoContext";
import type { AnyArtObject } from "@/core/schema";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";

/**
 * Mask row of the element appearance popover: add a mask, open it for editing,
 * toggle it off, flip it, or release it.
 */
export function ElementMaskControls({ element }: { element: AnyArtObject }) {
	const paplico = usePaplico();
	const t = useTranslation();
	const mask = element.mask;
	const isEnabled = mask?.enabled !== false;

	const handleAdd = useEventCallback(() => {
		paplico.commands.addMaskToElement(element.id);
		paplico.maskEdit.enter(element.id);
	});

	const handleEdit = useEventCallback(() => {
		paplico.maskEdit.enter(element.id);
	});

	const handleRelease = useEventCallback(() => {
		paplico.commands.removeMaskFromElement(element.id);
	});

	const handleToggleEnabled = useEventCallback(() => {
		paplico.commands.setMaskEnabled(
			element.id,
			element.mask?.enabled === false,
		);
	});

	const handleToggleInverted = useEventCallback(() => {
		paplico.commands.setMaskInverted(
			element.id,
			element.mask?.inverted !== true,
		);
	});

	if (!mask) {
		return (
			<div className="flex items-center justify-between">
				<span className="text-muted-foreground text-xs">
					{t("filterPanel.mask")}
				</span>
				<Button $size="sm" $variant="ghost" onClick={handleAdd}>
					<Squircle size={12} />
					{t("filterPanel.maskAdd")}
				</Button>
			</div>
		);
	}

	// One row, laid out like the filter rows above it: label on the left, xs icon
	// buttons right-aligned, the words in their tooltips. Invert is a toggle
	// rather than a checkbox on a line of its own — it is a state of the mask,
	// the same as whether the mask is being applied at all.
	return (
		<div>
			<div className="flex items-center justify-between gap-2">
				<span className="text-muted-foreground text-xs">
					{t("filterPanel.mask")}
				</span>

				<div className="flex shrink-0 items-center gap-0.5">
					<Tooltip
						content={
							isEnabled
								? t("filterPanel.maskDisable")
								: t("filterPanel.maskEnable")
						}
						side="top"
					>
						<IconButton
							$size="xs"
							$variant="ghost"
							onClick={handleToggleEnabled}
						>
							{isEnabled ? <Eye size={12} /> : <EyeOff size={12} />}
						</IconButton>
					</Tooltip>
					<Tooltip content={t("filterPanel.maskInverted")} side="top">
						<IconButton
							$size="xs"
							$variant="ghost"
							$pressed={mask.inverted === true}
							onClick={handleToggleInverted}
						>
							<Contrast size={12} />
						</IconButton>
					</Tooltip>
					<Tooltip content={t("filterPanel.maskEdit")} side="top">
						<IconButton $size="xs" $variant="ghost" onClick={handleEdit}>
							<Pencil size={12} />
						</IconButton>
					</Tooltip>
					{/* Unlink, not a bin: releasing a mask keeps what was drawn into it
					    and puts it back beside the element. */}
					<Tooltip content={t("filterPanel.maskRelease")} side="top">
						<IconButton $size="xs" $variant="ghost" onClick={handleRelease}>
							<Unlink size={12} />
						</IconButton>
					</Tooltip>
				</div>
			</div>
		</div>
	);
}
