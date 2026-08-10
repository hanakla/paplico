import { Menu as BUIMenu } from "@base-ui/react/menu";
import {
	CopyPlus,
	Ellipsis,
	Grid3x3,
	LayoutGrid,
	Paintbrush,
	RemoveFormatting,
	Squircle,
	Ungroup,
} from "lucide-react";
import { IconButton } from "@/components/IconButton";
import { Menu } from "@/components/Menu";
import { toastManager } from "@/components/Toast";
import { usePaplico, usePaplicoCommands } from "@/contexts/PaplicoContext";
import { useTranslation } from "@/locales";
import { setSelectedBrushPresetUid } from "@/stores/uiStore";
import { useEventCallback } from "@/utils/hooks";

/** Overflow menu for the actions that don't earn a slot in the bar itself. */
export function MoreActionsMenu({
	selectedIds,
	hasTextInSelection,
	maskTargetId,
	meshWarpIdsInSelection,
}: {
	selectedIds: readonly string[];
	hasTextInSelection: boolean;
	/** The lone selected element that has no mask yet, or null. */
	maskTargetId: string | null;
	/** Selected mesh warp container ids (release targets). */
	meshWarpIdsInSelection: readonly string[];
}) {
	const t = useTranslation();
	const paplico = usePaplico();
	const commands = usePaplicoCommands();

	const handleOutlineText = useEventCallback(() => {
		paplico.commands.outlineTextElements([...selectedIds]);
	});

	const handleCreateMask = useEventCallback(() => {
		if (!maskTargetId) return;
		commands.addMaskToElement(maskTargetId);
		// A mask is born empty, and an empty mask hides nothing, so there is
		// nothing to look at until something is drawn into it.
		paplico.maskEdit.enter(maskTargetId);
	});

	const handleCreateRepeat = useEventCallback(() => {
		const repeatId = commands.createRepeatFromSelection();
		if (!repeatId) {
			toastManager.add({
				title: t("contextActions.repeatErrorTitle"),
				description: t("contextActions.repeatErrorEmpty"),
			});
			return;
		}
		// Stay in the select tool: it shows the repeat's box + grid count handles.
		paplico.tools.setCurrentTool("select");
	});

	const handleCreateMeshWarp = useEventCallback(() => {
		const meshId = commands.createMeshWarpFromSelection();
		if (!meshId) {
			toastManager.add({
				title: t("contextActions.meshWarpErrorTitle"),
				description: t("contextActions.meshWarpErrorEmpty"),
			});
			return;
		}
		// The cage is edited with the vertex edit tool.
		paplico.tools.setCurrentTool("path-edit");
	});

	const handleReleaseMeshWarp = useEventCallback(() => {
		for (const id of meshWarpIdsInSelection) {
			commands.releaseMeshWarp(id);
		}
	});

	const handleCreatePatternFromSelection = useEventCallback(() => {
		const newDefId = commands.createPatternDefFromSelection();
		if (!newDefId) {
			toastManager.add({
				title: t("contextActions.patternErrorTitle"),
				description: t("contextActions.patternErrorEmpty"),
			});
			return;
		}
		toastManager.add({
			title: t("contextActions.patternCreatedTitle"),
		});
	});

	const handleCreateBrushFromSelection = useEventCallback(() => {
		const defId = commands.createVectorBrushDefFromSelection();
		if (!defId) {
			toastManager.add({
				title: t("contextActions.brushErrorTitle"),
				description: t("contextActions.brushErrorEmpty"),
			});
			return;
		}
		toastManager.add({
			title: t("contextActions.brushCreatedTitle"),
		});
		// Immediately apply the new def as the current brush (mirrors the
		// texture picker in BrushTools).
		paplico.tools.setBrushSettings({
			tipSource: { kind: "def", defId },
			colorMode: "color",
		});
		setSelectedBrushPresetUid(null);
	});

	return (
		<Menu.Root>
			<BUIMenu.Trigger
				render={
					<IconButton
						$size="md"
						$variant="ghost"
						className="text-foreground"
						aria-label={t("contextActions.moreActions")}
					>
						<Ellipsis size={18} />
					</IconButton>
				}
			/>
			<Menu.Portal>
				<Menu.Positioner side="bottom" align="end" sideOffset={4}>
					<Menu.Popup>
						{hasTextInSelection && (
							<>
								<Menu.Item onClick={handleOutlineText}>
									<RemoveFormatting size={14} />
									{t("contextActions.outlineText")}
								</Menu.Item>
								<Menu.Separator />
							</>
						)}
						{maskTargetId && (
							<>
								<Menu.Item onClick={handleCreateMask}>
									<Squircle size={14} />
									{t("contextActions.createMask")}
								</Menu.Item>
								<Menu.Separator />
							</>
						)}
						<Menu.Item onClick={handleCreateRepeat}>
							<CopyPlus size={14} />
							{t("contextActions.createRepeat")}
						</Menu.Item>
						<Menu.Item onClick={handleCreateMeshWarp}>
							<Grid3x3 size={14} />
							{t("contextActions.createMeshWarp")}
						</Menu.Item>
						{meshWarpIdsInSelection.length > 0 && (
							<Menu.Item onClick={handleReleaseMeshWarp}>
								<Ungroup size={14} />
								{t("contextActions.releaseMeshWarp")}
							</Menu.Item>
						)}
						<Menu.Item onClick={handleCreatePatternFromSelection}>
							<LayoutGrid size={14} />
							{t("contextActions.createPatternFromSelection")}
						</Menu.Item>
						<Menu.Item onClick={handleCreateBrushFromSelection}>
							<Paintbrush size={14} />
							{t("contextActions.createBrushFromSelection")}
						</Menu.Item>
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
	);
}
