import {
	ArrowDown,
	ArrowDownUp,
	ArrowUp,
	Copy,
	GitCommitHorizontal,
	Group,
	PenLine,
	Shuffle,
	Squircle,
	Ungroup,
	Unlink,
} from "lucide-react";
import { useSnapshot } from "valtio";
import { IconButton } from "@/components/IconButton";
import { toastManager } from "@/components/Toast";
import { Tooltip } from "@/components/Tooltip";
import {
	usePaplico,
	usePaplicoCommands,
	usePaplicoStore,
} from "@/contexts/PaplicoContext";
import type { AnyArtObject } from "@/core/schema";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";
import { AlignActionsMenu } from "./AlignActionsMenu";

/**
 * Structural actions on the selected elements: grouping, blends, 3D lineart,
 * z-order and duplication.
 */
export function ElementActions({
	selectedIds,
	selectedElements,
	hasElementSelection,
}: {
	selectedIds: readonly string[];
	selectedElements: readonly AnyArtObject[];
	hasElementSelection: boolean;
}) {
	const t = useTranslation();
	const store = usePaplicoStore();
	const commands = usePaplicoCommands();
	const paplico = usePaplico();
	const snap = useSnapshot(store);

	const hasMultipleSelection = selectedIds.length >= 2;
	const hasSingleSelection = selectedIds.length === 1;
	const hasGroupInSelection = selectedElements.some(
		(el) => el.type === "group",
	);
	const pathsInSelection = selectedElements.filter((el) => el.type === "path");
	const blendsInSelection = selectedElements.filter(
		(el) => el.type === "blend",
	);
	const references3dInSelection = selectedElements.filter(
		(el) => el.type === "reference3d",
	);
	const firstReference3d = references3dInSelection[0];
	const lineartEnabled =
		firstReference3d?.type === "reference3d" &&
		firstReference3d.displayMode === "lineart";
	const canCreateBlend =
		blendsInSelection.length === 0 && pathsInSelection.length >= 2;
	const hasBlendInSelection = blendsInSelection.length > 0;
	const canReplaceBlendSpine =
		blendsInSelection.length === 1 && pathsInSelection.length === 1;
	// Mask content sits on no layer, so selecting it on canvas is impossible —
	// entering the mask is the only way to reach it, and this is the one place
	// that offers it without opening the appearance popover first.
	const maskedElement =
		hasSingleSelection && selectedElements[0]?.mask
			? selectedElements[0]
			: null;

	const handleEditMask = useEventCallback(() => {
		if (maskedElement) paplico.maskEdit.enter(maskedElement.id);
	});

	const handleGroup = useEventCallback(() => {
		commands.groupSelectedElements([...selectedIds]);
	});

	const handleUngroup = useEventCallback(() => {
		for (const el of selectedElements) {
			if (el.type === "group") {
				commands.ungroupElements(el.id);
			}
		}
	});

	const handleCreateBlend = useEventCallback(() => {
		const result = commands.createBlendFromSelection();
		if (!result.ok && result.reason === "different-parent") {
			toastManager.add({
				title: t("contextActions.blendErrorTitle"),
				description: t("contextActions.blendErrorDifferentParent"),
			});
		}
	});

	const handleReplaceBlendSpine = useEventCallback(() => {
		const blend = blendsInSelection[0];
		const path = pathsInSelection[0];
		if (!blend || !path) return;
		commands.replaceBlendSpine(blend.id, path.id);
	});

	const handleReverseBlend = useEventCallback(() => {
		for (const el of blendsInSelection) commands.reverseBlend(el.id);
	});

	const handleReleaseBlend = useEventCallback(() => {
		for (const el of blendsInSelection) commands.releaseBlend(el.id);
	});

	const handleToggleLineart = useEventCallback(() => {
		const layerId = snap.currentLayerId;
		if (!layerId) return;
		const target = lineartEnabled ? "flat" : "lineart";
		for (const el of references3dInSelection) {
			commands.updateElement(layerId, el.id, { displayMode: target });
		}
	});

	const handleArrangeForward = useEventCallback(() => {
		commands.moveElementForward(selectedIds[0]);
	});

	const handleArrangeBackward = useEventCallback(() => {
		commands.moveElementBackward(selectedIds[0]);
	});

	const handleDuplicate = useEventCallback(() => {
		commands.duplicateElements();
	});

	return (
		<>
			{hasMultipleSelection && (
				<Tooltip content={t("contextActions.grouping")} side="bottom">
					<IconButton
						$size="md"
						$variant="ghost"
						className="text-foreground"
						onClick={handleGroup}
					>
						<Group size={18} />
					</IconButton>
				</Tooltip>
			)}
			{hasMultipleSelection && <AlignActionsMenu selectedIds={selectedIds} />}
			{hasGroupInSelection && (
				<Tooltip content={t("contextActions.ungroup")} side="bottom">
					<IconButton
						$size="md"
						$variant="ghost"
						className="text-foreground"
						onClick={handleUngroup}
					>
						<Ungroup size={18} />
					</IconButton>
				</Tooltip>
			)}
			{canCreateBlend && (
				<Tooltip content={t("contextActions.createBlend")} side="bottom">
					<IconButton
						$size="md"
						$variant="ghost"
						className="text-foreground"
						onClick={handleCreateBlend}
					>
						<Shuffle size={18} />
					</IconButton>
				</Tooltip>
			)}
			{canReplaceBlendSpine && (
				<Tooltip content={t("contextActions.replaceBlendSpine")} side="bottom">
					<IconButton
						$size="md"
						$variant="ghost"
						className="text-foreground"
						onClick={handleReplaceBlendSpine}
					>
						<GitCommitHorizontal size={18} />
					</IconButton>
				</Tooltip>
			)}
			{hasBlendInSelection && (
				<>
					<Tooltip content={t("contextActions.reverseBlend")} side="bottom">
						<IconButton
							$size="md"
							$variant="ghost"
							className="text-foreground"
							onClick={handleReverseBlend}
						>
							<ArrowDownUp size={18} />
						</IconButton>
					</Tooltip>
					<Tooltip content={t("contextActions.releaseBlend")} side="bottom">
						<IconButton
							$size="md"
							$variant="ghost"
							className="text-foreground"
							onClick={handleReleaseBlend}
						>
							<Unlink size={18} />
						</IconButton>
					</Tooltip>
				</>
			)}
			{references3dInSelection.length > 0 && (
				<Tooltip content={t("contextActions.toggleLineart")} side="bottom">
					<IconButton
						$size="md"
						$variant="ghost"
						$pressed={lineartEnabled}
						className="text-foreground"
						onClick={handleToggleLineart}
					>
						<PenLine size={18} />
					</IconButton>
				</Tooltip>
			)}
			{maskedElement && (
				<Tooltip content={t("contextActions.editMask")} side="bottom">
					<IconButton
						$size="md"
						$variant="ghost"
						className="text-foreground"
						onClick={handleEditMask}
					>
						<Squircle size={18} />
					</IconButton>
				</Tooltip>
			)}
			{hasSingleSelection && (
				<>
					<Tooltip content={t("shortcutCmd.arrangeForward")} side="bottom">
						<IconButton
							$size="md"
							$variant="ghost"
							className="text-foreground"
							onClick={handleArrangeForward}
						>
							<ArrowUp size={18} />
						</IconButton>
					</Tooltip>
					<Tooltip content={t("shortcutCmd.arrangeBackward")} side="bottom">
						<IconButton
							$size="md"
							$variant="ghost"
							className="text-foreground"
							onClick={handleArrangeBackward}
						>
							<ArrowDown size={18} />
						</IconButton>
					</Tooltip>
				</>
			)}
			{hasElementSelection && (
				<Tooltip content={t("contextActions.duplicate")} side="bottom">
					<IconButton
						$size="md"
						$variant="ghost"
						className="text-foreground"
						onClick={handleDuplicate}
					>
						<Copy size={18} />
					</IconButton>
				</Tooltip>
			)}
		</>
	);
}
